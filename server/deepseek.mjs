/**
 * DeepSeek 上游客户端
 * ---------------------------------------------------------------------------
 * 职责：
 *  - 封装上游四个 HTTP 接口：GET /models、POST /v1/tools/search、
 *    POST /v1/tools/fetch、POST /chat/completions（SSE 流式）；
 *  - 统一认证头、超时（AbortSignal.timeout）与外部取消信号组合；
 *  - 上游错误统一归一化为 AppError（契约 §3）；
 *  - search / fetch / models 对 408、429、5xx 最多重试 2 次（指数退避 + 抖动，
 *    尊重 Retry-After 且上限 10s）；chat 流式请求永不重试；
 *  - 上游 snake_case 字段转成契约要求的 camelCase。
 *
 * 依赖注入：构造参数 fetchImpl / sleep / random / logger 便于测试，
 * 测试中全部使用 fake fetch，绝不访问真实 DeepSeek。
 */
import { DEFAULT_RETRY } from './config.mjs';
import {
  clientAborted,
  isAppError,
  mapUpstreamError,
  upstreamError,
  upstreamTimeout,
  upstreamUnreachable,
} from './errors.mjs';

const FINISH_REASONS = new Set([
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'insufficient_system_resource',
  'aborted',
]);

/** 默认 sleep（测试可注入，避免真的等待） */
export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function joinUrl(base, pathname) {
  return `${String(base).replace(/\/+$/, '')}${pathname}`;
}

/** 组合多个 AbortSignal（优先用原生 AbortSignal.any，兼容老版本）。 */
export function combineSignals(signals) {
  const list = signals.filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * 解析上游 Retry-After 头，返回毫秒数；无法解析返回 null。
 * 支持秒数（可带小数）与 HTTP 日期两种格式。
 */
export function parseRetryAfter(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Math.ceil(Number(text) * 1000));
  const dateMs = Date.parse(text);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

/**
 * 计算第 attempt 次重试前的等待时间（契约 §3）。
 * 有 Retry-After 时优先尊重它，但上限 maxRetryAfterMs（10s）；
 * 否则指数退避 500ms → 1200ms，并叠加最多 25% 的随机抖动。
 */
export function computeRetryDelay(attempt, retryAfterMs, retryConfig = DEFAULT_RETRY, random = Math.random) {
  const { baseDelayMs = 500, secondDelayMs = 1200, maxRetryAfterMs = 10000 } = retryConfig;
  if (retryAfterMs !== null && retryAfterMs !== undefined && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, maxRetryAfterMs);
  }
  const base = attempt <= 0 ? baseDelayMs : secondDelayMs;
  const jitter = Math.floor(random() * base * 0.25);
  return base + jitter;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asNullableString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toFiniteInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** 上游搜索结果 snake_case → 契约 camelCase（契约 §2 /api/search）。 */
export function mapSearchResult(raw = {}) {
  const authorityValue = Number.isInteger(raw?.authority) ? raw.authority : -1;
  const rerankScore = typeof raw?.rerank_score === 'number' && Number.isFinite(raw.rerank_score) ? raw.rerank_score : 0;
  return {
    title: asString(raw?.title),
    url: asString(raw?.url),
    snippet: asString(raw?.snippet),
    summary: asString(raw?.summary),
    content: asString(raw?.content),
    siteName: asNullableString(raw?.site_name),
    siteIcon: asNullableString(raw?.site_icon),
    date: asNullableString(raw?.date),
    authority: Math.max(-1, Math.min(4, authorityValue)),
    rerankScore,
  };
}

/** 上游模型条目精简（契约 §2 /api/validate-key：缺失字段用 null）。 */
export function mapModel(raw = {}) {
  const contextWindow = Number.isFinite(raw?.context_window)
    ? raw.context_window
    : Number.isFinite(raw?.contextWindow)
      ? raw.contextWindow
      : null;
  return {
    id: typeof raw?.id === 'string' ? raw.id : null,
    name: typeof raw?.name === 'string' ? raw.name : null,
    contextWindow,
  };
}

/** 静默消费响应体（重试前必须丢弃，避免连接泄漏）。 */
async function discardBody(response) {
  try {
    if (response?.body && typeof response.body.cancel === 'function') await response.body.cancel();
  } catch {
    // 忽略：上下文环境（测试替身）可能没有标准 body
  }
}

/** 安全读取 JSON 响应体，失败返回 null。 */
async function readJsonSafely(response) {
  try {
    const text = await response.text();
    if (!text || !text.trim()) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从流中读取一块；同时和 abort 信号竞争，保证取消能立刻生效。 */
function readStreamChunk(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** 从缓冲区里取出一个完整的 SSE 帧（\n\n 或 \r\n\r\n 分隔）。 */
function extractFrame(buffer) {
  const lfIndex = buffer.indexOf('\n\n');
  const crlfIndex = buffer.indexOf('\r\n\r\n');
  let index = -1;
  let separatorLength = 0;
  if (crlfIndex !== -1 && (lfIndex === -1 || crlfIndex < lfIndex)) {
    index = crlfIndex;
    separatorLength = 4;
  } else if (lfIndex !== -1) {
    index = lfIndex;
    separatorLength = 2;
  }
  if (index === -1) return null;
  return { frame: buffer.slice(0, index), rest: buffer.slice(index + separatorLength) };
}

/**
 * 解析一个 SSE 帧文本，返回若干增量事件。
 * 上游每个事件形如 `data: {json}`，流以 `data: [DONE]` 结束。
 */
export function parseSseFrame(frameText) {
  const output = { done: false, content: '', reasoning: '', usage: null, finishReason: null };
  for (const rawLine of String(frameText).split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line.startsWith('data:')) continue; // 忽略注释心跳 `: ping` 与 event: 行
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      output.done = true;
      continue;
    }
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue; // 单帧解析失败不中断整条流
    }
    const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
    const delta = choice?.delta ?? {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      output.reasoning += delta.reasoning_content;
    }
    if (typeof delta.content === 'string' && delta.content) {
      output.content += delta.content;
    }
    if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
      output.finishReason = choice.finish_reason;
    }
    if (json?.usage && typeof json.usage === 'object') {
      output.usage = {
        promptTokens: toFiniteInt(json.usage.prompt_tokens),
        completionTokens: toFiniteInt(json.usage.completion_tokens),
        totalTokens: toFiniteInt(json.usage.total_tokens),
      };
    }
  }
  return output;
}

function normalizeFinishReason(value) {
  return typeof value === 'string' && FINISH_REASONS.has(value) ? value : 'stop';
}

/**
 * DeepSeek 客户端。
 */
export class DeepSeekClient {
  /**
   * @param {{ config: object, fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>,
   *           random?: () => number, logger?: object }} options
   */
  constructor(options = {}) {
    const { config, fetchImpl = globalThis.fetch, sleep = defaultSleep, random = Math.random, logger = null } = options;
    if (!config) throw new Error('DeepSeekClient 需要 config');
    if (typeof fetchImpl !== 'function') throw new Error('DeepSeekClient 的 fetchImpl 必须是函数');
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.random = random;
    this.logger = logger;
    this.retry = { ...DEFAULT_RETRY, ...(config.retry ?? {}) };
  }

  #headers(apiKey, hasBody) {
    const headers = { accept: 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (hasBody) headers['content-type'] = 'application/json';
    return headers;
  }

  /**
   * 发送 JSON 请求（含重试）。成功返回解析后的 JSON；失败抛 AppError。
   * @private
   */
  async #requestJson(pathname, { method = 'POST', apiKey, body, timeoutMs, signal, endpoint = 'generic' } = {}) {
    const url = joinUrl(this.config.deepseekBaseUrl, pathname);
    const headers = this.#headers(apiKey, body !== undefined);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const { maxRetries = 0 } = this.retry;

    let attempt = 0;
    for (;;) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = combineSignals([timeoutSignal, signal]);
      let response;
      try {
        response = await this.fetchImpl(url, { method, headers, body: payload, signal: combined });
      } catch (error) {
        if (signal?.aborted) throw clientAborted();
        if (timeoutSignal.aborted) throw upstreamTimeout();
        throw upstreamUnreachable(undefined, { cause: error });
      }

      if (response.ok) {
        try {
          const text = await response.text();
          if (!text || !text.trim()) return {};
          return JSON.parse(text);
        } catch (error) {
          if (isAppError(error)) throw error;
          if (signal?.aborted) throw clientAborted();
          if (timeoutSignal.aborted) throw upstreamTimeout();
          // 上游 200 但响应体非法：按 502 处理，且不把 200 写进 upstreamStatus（契约 §3）
          throw upstreamError(null, '上游响应格式异常');
        }
      }

      const status = response.status;
      const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
      if (attempt < maxRetries && isRetryableStatus(status)) {
        await discardBody(response);
        const delay = computeRetryDelay(attempt, retryAfterMs, this.retry, this.random);
        attempt += 1;
        this.logger?.debug?.('上游请求失败，准备重试', {
          endpoint,
          status,
          retry: attempt,
          delayMs: delay,
        });
        await this.sleep(delay);
        continue;
      }

      const errorBody = await readJsonSafely(response);
      const retryAfterSeconds = retryAfterMs === null ? null : Math.max(1, Math.ceil(retryAfterMs / 1000));
      throw mapUpstreamError(status, errorBody, { endpoint, retryAfter: retryAfterSeconds });
    }
  }

  /**
   * 校验 Key 并返回精简后的模型列表。对应上游 GET /models。
   * @param {string} apiKey
   * @param {{ signal?: AbortSignal }} [options]
   */
  async validateKey(apiKey, { signal } = {}) {
    const body = await this.#requestJson('/models', {
      method: 'GET',
      apiKey,
      timeoutMs: this.config.searchTimeoutMs,
      signal,
      endpoint: 'models',
    });
    const data = Array.isArray(body?.data) ? body.data : [];
    const models = data.filter((item) => item && typeof item === 'object').map((item) => mapModel(item));
    return { models };
  }

  /**
   * 搜索。对应上游 POST /v1/tools/search。
   * @param {string} apiKey
   * @param {{ query: string, count?: number, needContent?: boolean,
   *           oriQuestion?: string|null, localization?: string|null }} params
   * @param {{ signal?: AbortSignal }} [options]
   */
  async search(apiKey, params = {}, { signal } = {}) {
    const startedAt = Date.now();
    const payload = {
      query: params.query,
      count: params.count ?? this.config.countLimit?.default ?? 10,
      need_content: params.needContent === true,
    };
    // 契约：oriQuestion / localization 默认不传
    if (params.oriQuestion !== undefined && params.oriQuestion !== null) payload.ori_question = params.oriQuestion;
    if (params.localization !== undefined && params.localization !== null) payload.localization = params.localization;

    const body = await this.#requestJson('/v1/tools/search', {
      method: 'POST',
      apiKey,
      body: payload,
      timeoutMs: this.config.searchTimeoutMs,
      signal,
      endpoint: 'search',
    });
    const rawResults = Array.isArray(body?.results) ? body.results : [];
    return {
      results: rawResults.filter((item) => item && typeof item === 'object').map((item) => mapSearchResult(item)),
      tookMs: Date.now() - startedAt,
    };
  }

  /**
   * 抓取网页正文。对应上游 POST /v1/tools/fetch。
   * @param {string} apiKey
   * @param {string} url
   * @param {{ signal?: AbortSignal }} [options]
   */
  async fetchPage(apiKey, url, { signal } = {}) {
    const startedAt = Date.now();
    const body = await this.#requestJson('/v1/tools/fetch', {
      method: 'POST',
      apiKey,
      body: { url },
      timeoutMs: this.config.fetchTimeoutMs,
      signal,
      endpoint: 'fetch',
    });
    return {
      title: asString(body?.title),
      content: asString(body?.content),
      tookMs: Date.now() - startedAt,
    };
  }

  /**
   * 流式总结。对应上游 POST /chat/completions（注意没有 /v1 前缀）。
   * 返回异步生成器，逐个产出契约 §2 的事件对象：
   *   { type: 'delta', text } | { type: 'reasoning', text }
   *   | { type: 'usage', usage: { promptTokens, completionTokens, totalTokens } }
   *   | { type: 'done', finishReason }
   * 上游未开始输出前失败抛 AppError；中断只能由调用方以 SSE error 事件收尾。
   *
   * @param {string} apiKey
   * @param {{ messages: Array<{role:string,content:string}>, model?: string,
   *           thinking?: boolean, maxTokens?: number, signal?: AbortSignal }} params
   */
  async *chatStream(apiKey, params = {}) {
    const {
      messages,
      model = this.config.defaultModel ?? 'deepseek-flash',
      thinking = false,
      maxTokens = this.config.summarize?.maxTokens ?? 1200,
      signal,
    } = params;

    const payload = {
      model,
      messages,
      stream: true,
      thinking: { type: thinking ? 'enabled' : 'disabled' },
      max_tokens: maxTokens,
    };
    // 契约 §6：thinking 开启时 reasoning_effort 为 low；不传 temperature
    if (thinking) payload.reasoning_effort = 'low';

    const url = joinUrl(this.config.deepseekBaseUrl, '/chat/completions');
    const timeoutSignal = AbortSignal.timeout(this.config.chatTimeoutMs);
    const combined = combineSignals([timeoutSignal, signal]);

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.#headers(apiKey, true),
        body: JSON.stringify(payload),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw clientAborted();
      if (timeoutSignal.aborted) throw upstreamTimeout();
      throw upstreamUnreachable(undefined, { cause: error });
    }

    if (!response.ok) {
      const errorBody = await readJsonSafely(response);
      const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
      throw mapUpstreamError(response.status, errorBody, {
        endpoint: 'chat',
        retryAfter: retryAfterMs === null ? null : Math.max(1, Math.ceil(retryAfterMs / 1000)),
      });
    }
    if (!response.body) throw upstreamError(response.status ?? 502, '上游未返回流式响应');

    yield* this.#parseSseStream(response.body, { signal: combined, externalSignal: signal, timeoutSignal });
  }

  /** @private 解析上游 SSE 流，按契约事件逐个产出。 */
  async *#parseSseStream(stream, { signal, externalSignal, timeoutSignal }) {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finishReason = null;
    let doneSent = false;

    const abortError = () => {
      if (externalSignal?.aborted) return clientAborted();
      if (timeoutSignal?.aborted) return upstreamTimeout();
      return null;
    };

    try {
      for (;;) {
        let chunk;
        try {
          chunk = await readStreamChunk(reader, signal);
        } catch (error) {
          const aborted = abortError();
          if (aborted) throw aborted;
          if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw upstreamTimeout();
          throw upstreamError(502, '上游流式响应中断');
        }
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        let extracted;
        while ((extracted = extractFrame(buffer)) !== null) {
          buffer = extracted.rest;
          const parsed = parseSseFrame(extracted.frame);
          // 同一帧可能同时含正文与 usage：先正文，后 usage，保证事件顺序自然
          if (parsed.reasoning) yield { type: 'reasoning', text: parsed.reasoning };
          if (parsed.content) yield { type: 'delta', text: parsed.content };
          if (parsed.usage) yield { type: 'usage', usage: parsed.usage };
          if (parsed.finishReason) finishReason = parsed.finishReason;
          if (parsed.done && !doneSent) {
            doneSent = true;
            yield { type: 'done', finishReason: normalizeFinishReason(finishReason) };
          }
        }
      }

      // 处理流末尾没有空行分隔的残余帧
      if (!doneSent && buffer.trim()) {
        const parsed = parseSseFrame(buffer);
        if (parsed.reasoning) yield { type: 'reasoning', text: parsed.reasoning };
        if (parsed.content) yield { type: 'delta', text: parsed.content };
        if (parsed.usage) yield { type: 'usage', usage: parsed.usage };
        if (parsed.finishReason) finishReason = parsed.finishReason;
        if (parsed.done) doneSent = true;
      }
      // 上游正常关闭但没有 [DONE]：补一个 done 事件收尾
      if (!doneSent) yield { type: 'done', finishReason: normalizeFinishReason(finishReason) };
    } finally {
      try {
        await reader.cancel();
      } catch {
        // 流已关闭 / 已被取消，忽略
      }
    }
  }
}
