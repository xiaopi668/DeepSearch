import { API_BASE, ApiError, isAbortError, readApiErrorResponse, toApiError } from './api';
import type { AiModel, SearchResult, SummaryResultInput, UsageInfo } from './types';
import { isRecord, readNumber, readString } from './utils';

export interface SummaryMeta {
  model: string;
  requestId: string;
}

export interface SummaryStreamHandlers {
  onMeta?: (meta: SummaryMeta) => void;
  onReasoning?: (text: string) => void;
  onDelta?: (text: string) => void;
  onUsage?: (usage: UsageInfo) => void;
  onDone?: (finishReason: string) => void;
}

export interface SummarizeStreamOptions {
  query: string;
  results: SearchResult[];
  model: AiModel;
  thinking: boolean;
  apiKey: string;
  accessToken?: string;
  signal: AbortSignal;
  handlers?: SummaryStreamHandlers;
}

/** 契约限制 results 1–15 条。 */
export function toSummaryInputs(results: SearchResult[], limit = 15): SummaryResultInput[] {
  return results.slice(0, limit).map((result) => ({
    title: result.title,
    url: result.url,
    siteName: result.siteName,
    date: result.date,
    snippet: result.snippet,
    summary: result.summary,
  }));
}

function parseJsonRecord(data: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseUsage(record: Record<string, unknown>): UsageInfo | null {
  const promptTokens = readNumber(record, 'promptTokens', -1);
  const completionTokens = readNumber(record, 'completionTokens', -1);
  const totalTokens = readNumber(record, 'totalTokens', -1);
  if (promptTokens < 0 || completionTokens < 0 || totalTokens < 0) return null;
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * 解析单个 SSE 帧。返回非 null 表示收到 done 事件。
 * 未知 event（以及 `: ping` 心跳注释）按契约忽略。
 */
function processFrame(frame: string, handlers: SummaryStreamHandlers): string | null {
  let eventName = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    // 以冒号开头的是注释（含 `: ping` 心跳）。
    if (line.length === 0 || line.startsWith(':')) continue;
    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n');

  switch (eventName) {
    case 'meta': {
      const record = parseJsonRecord(data);
      handlers.onMeta?.({
        model: readString(record, 'model'),
        requestId: readString(record, 'requestId'),
      });
      return null;
    }
    case 'reasoning': {
      const text = readString(parseJsonRecord(data), 'text');
      if (text) handlers.onReasoning?.(text);
      return null;
    }
    case 'delta': {
      const text = readString(parseJsonRecord(data), 'text');
      if (text) handlers.onDelta?.(text);
      return null;
    }
    case 'usage': {
      const usage = parseUsage(parseJsonRecord(data));
      if (usage) handlers.onUsage?.(usage);
      return null;
    }
    case 'done': {
      const finishReason = readString(parseJsonRecord(data), 'finishReason', 'stop');
      handlers.onDone?.(finishReason);
      return finishReason;
    }
    case 'error': {
      const record = parseJsonRecord(data);
      const code = readString(record, 'code', 'upstream_error');
      const message = readString(record, 'message', 'AI 总结生成失败，请重试。');
      throw new ApiError(code, 0, message, readString(record, 'requestId') || null);
    }
    default:
      return null;
  }
}

/**
 * 用 fetch + ReadableStream 消费 POST /api/summarize 的 SSE 流
 * （EventSource 无法携带 Authorization 自定义头）。
 *
 * 正常结束时返回 finishReason；服务端 error 事件或 HTTP 错误抛出 ApiError；
 * 用户主动 abort 时抛出 AbortError（调用方用 signal.aborted / isAbortError 判断）。
 */
export async function summarizeStream(options: SummarizeStreamOptions): Promise<string> {
  const { signal } = options;
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
  };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  if (options.accessToken) headers['X-Access-Token'] = options.accessToken;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/summarize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: options.query,
        results: toSummaryInputs(options.results),
        model: options.model,
        thinking: options.thinking,
      }),
      signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw toApiError(error);
  }

  if (!response.ok) throw await readApiErrorResponse(response);

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    // 200 却不是 SSE（后端异常/中间层错误页）：尽量从 JSON 里读 error，否则给统一提示。
    let envelope: unknown = null;
    const text = await response.text().catch(() => '');
    try {
      envelope = JSON.parse(text) as unknown;
    } catch {
      envelope = null;
    }
    if (isRecord(envelope) && isRecord(envelope.error)) {
      const body = envelope.error;
      throw new ApiError(
        readString(body, 'code', 'invalid_response'),
        response.status,
        readString(body, 'message', 'AI 总结服务返回异常，请稍后重试。'),
        readString(body, 'requestId') || response.headers.get('x-request-id'),
      );
    }
    throw new ApiError(
      'invalid_response',
      response.status,
      'AI 总结服务返回了非预期格式，请稍后重试。',
      response.headers.get('x-request-id'),
    );
  }

  const stream = response.body;
  if (!stream) {
    throw new ApiError(
      'invalid_response',
      response.status,
      'AI 总结服务未返回可读取的数据流。',
      response.headers.get('x-request-id'),
    );
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  const handlers = options.handlers ?? {};
  let buffer = '';
  let finishReason: string | null = null;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();
      // SSE 允许 CRLF；`\r` 可能恰好落在两个 chunk 边界，下一次拼接后仍会被替换。
      buffer = buffer.replace(/\r\n/g, '\n');

      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const reason = processFrame(frame, handlers);
        if (reason !== null) {
          finishReason = reason;
          await reader.cancel().catch(() => undefined);
          return finishReason;
        }
        separatorIndex = buffer.indexOf('\n\n');
      }

      if (done) break;
    }

    // 流已结束但最后一帧可能没有尾部空行，宽松处理一次。
    const leftover = buffer.trim();
    if (leftover) {
      const reason = processFrame(leftover, handlers);
      if (reason !== null) return reason;
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof ApiError) throw error;
    throw toApiError(error);
  } finally {
    reader.cancel().catch(() => undefined);
  }

  if (signal.aborted) throw new DOMException('请求已中止', 'AbortError');
  throw new ApiError(
    'stream_interrupted',
    0,
    'AI 总结连接意外中断，请点击重试。',
    response.headers.get('x-request-id'),
  );
}
