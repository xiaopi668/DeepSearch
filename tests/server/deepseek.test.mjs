import { describe, expect, it } from 'vitest';

import {
  DeepSeekClient,
  combineSignals,
  computeRetryDelay,
  defaultSleep,
  mapModel,
  mapSearchResult,
  parseRetryAfter,
  parseSseFrame,
} from '../../server/deepseek.mjs';
import { isAppError } from '../../server/errors.mjs';
import {
  collectAsync,
  fetchSequence,
  hangingFetch,
  hangingSseResponse,
  jsonResponse,
  silentLogger,
  sseEvents,
  sseResponse,
  testConfig,
} from './helpers.mjs';

const VALID_KEY = `sk-${'t'.repeat(20)}`;

function retryConfig(overrides = {}) {
  return {
    ...testConfig({ searchTimeoutMs: 100, fetchTimeoutMs: 100, chatTimeoutMs: 150 }),
    ...overrides,
  };
}

function makeClient(fetchImpl, { configOverrides = {}, collectDelays = true } = {}) {
  const delays = [];
  const client = new DeepSeekClient({
    config: retryConfig(configOverrides),
    fetchImpl,
    sleep: async (ms) => {
      if (collectDelays) delays.push(ms);
    },
    random: () => 0,
    logger: silentLogger(),
  });
  return { client, delays };
}

async function expectAppError(promise, expected) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, '预期抛出错误').toBeTruthy();
  expect(isAppError(caught)).toBe(true);
  expect(caught).toMatchObject(expected);
  return caught;
}

describe('工具函数', () => {
  it('parseRetryAfter 支持秒数与 HTTP 日期', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('1.5')).toBe(1500);
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('not-a-date')).toBeNull();
    const future = new Date(Date.now() + 5000).toUTCString();
    expect(parseRetryAfter(future)).toBeGreaterThan(0);
    expect(parseRetryAfter(future)).toBeLessThanOrEqual(5000);
  });

  it('computeRetryDelay 指数退避 + 抖动 + Retry-After 上限', () => {
    const config = { baseDelayMs: 500, secondDelayMs: 1200, maxRetryAfterMs: 10000 };
    expect(computeRetryDelay(0, null, config, () => 0)).toBe(500);
    expect(computeRetryDelay(1, null, config, () => 0)).toBe(1200);
    expect(computeRetryDelay(0, null, config, () => 1)).toBe(625);
    expect(computeRetryDelay(0, 3000, config, () => 0)).toBe(3000);
    expect(computeRetryDelay(1, 60000, config, () => 0)).toBe(10000); // 上限 10s
  });

  it('combineSignals 支持单个/多个 signal', () => {
    expect(combineSignals([])).toBeUndefined();
    const controller = new AbortController();
    expect(combineSignals([controller.signal])).toBe(controller.signal);
    const combined = combineSignals([controller.signal, AbortSignal.timeout(1000)]);
    expect(combined).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(combined.aborted).toBe(true);
  });

  it('mapSearchResult snake_case → camelCase，缺失字段有默认值', () => {
    const mapped = mapSearchResult({
      rerank_score: 2.4,
      title: '标题',
      url: 'https://example.com/a',
      snippet: '短摘要',
      summary: '长摘要',
      content: '正文',
      site_name: 'Example News',
      site_icon: 'https://example.com/favicon.ico',
      date: '2026-06-01T00:00:00+00:00',
      authority: 3,
    });
    expect(mapped).toEqual({
      title: '标题',
      url: 'https://example.com/a',
      snippet: '短摘要',
      summary: '长摘要',
      content: '正文',
      siteName: 'Example News',
      siteIcon: 'https://example.com/favicon.ico',
      date: '2026-06-01T00:00:00+00:00',
      authority: 3,
      rerankScore: 2.4,
    });
    expect(mapSearchResult({})).toEqual({
      title: '',
      url: '',
      snippet: '',
      summary: '',
      content: '',
      siteName: null,
      siteIcon: null,
      date: null,
      authority: -1,
      rerankScore: 0,
    });
    expect(mapSearchResult({ authority: 9 }).authority).toBe(4);
    expect(mapSearchResult({ authority: -5 }).authority).toBe(-1);
  });

  it('mapModel 精简字段，缺失用 null', () => {
    expect(mapModel({ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1048576 })).toEqual({
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      contextWindow: 1048576,
    });
    expect(mapModel({ id: 'deepseek-v4-pro' })).toEqual({ id: 'deepseek-v4-pro', name: null, contextWindow: null });
    expect(mapModel({})).toEqual({ id: null, name: null, contextWindow: null });
  });

  it('parseSseFrame 解析 content/reasoning/usage/finish_reason/[DONE]', () => {
    const frame = [
      `data: ${JSON.stringify({
        choices: [{ delta: { content: '你好', reasoning_content: '思考' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}`,
    ].join('\n');
    expect(parseSseFrame(frame)).toEqual({
      done: false,
      content: '你好',
      reasoning: '思考',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
    });
    expect(parseSseFrame('data: [DONE]').done).toBe(true);
    expect(parseSseFrame(': ping')).toEqual({
      done: false,
      content: '',
      reasoning: '',
      usage: null,
      finishReason: null,
    });
  });
});

describe('search（POST /v1/tools/search）', () => {
  it('成功：请求体 snake_case、认证头、结果映射 camelCase', async () => {
    const fetchImpl = fetchSequence([
      jsonResponse({
        results: [
          {
            rerank_score: 2.4,
            title: 'DeepSeek V4 发布',
            url: 'https://example.com/a',
            snippet: '短摘要',
            summary: '长摘要',
            content: '',
            site_name: 'Example News',
            site_icon: 'https://example.com/favicon.ico',
            date: '2026-06-01T00:00:00+00:00',
            authority: 3,
          },
          { title: '只有标题' },
        ],
      }),
    ]);
    const { client } = makeClient(fetchImpl);

    const { results, tookMs } = await client.search(VALID_KEY, { query: 'DeepSeek V4 发布', count: 10, needContent: false });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'DeepSeek V4 发布',
      url: 'https://example.com/a',
      siteName: 'Example News',
      siteIcon: 'https://example.com/favicon.ico',
      date: '2026-06-01T00:00:00+00:00',
      authority: 3,
      rerankScore: 2.4,
    });
    expect(results[1]).toMatchObject({ title: '只有标题', authority: -1, rerankScore: 0, siteName: null });
    expect(typeof tookMs).toBe('number');

    expect(fetchImpl.calls).toHaveLength(1);
    const { url, options } = fetchImpl.calls[0];
    expect(url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(options.method).toBe('POST');
    expect(options.headers.authorization).toBe(`Bearer ${VALID_KEY}`);
    expect(options.headers['content-type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({ query: 'DeepSeek V4 发布', count: 10, need_content: false });
  });

  it('oriQuestion/localization 透传为 snake_case，null 不发送', async () => {
    const fetchImpl = fetchSequence([jsonResponse({ results: [] })]);
    const { client } = makeClient(fetchImpl);
    await client.search(VALID_KEY, {
      query: 'Q',
      count: 3,
      needContent: true,
      oriQuestion: '原始问题',
      localization: 'CN',
    });
    expect(JSON.parse(fetchImpl.calls[0].options.body)).toEqual({
      query: 'Q',
      count: 3,
      need_content: true,
      ori_question: '原始问题',
      localization: 'CN',
    });
  });

  it('无结果返回空数组（200 语义）', async () => {
    const fetchImpl = fetchSequence([jsonResponse({ results: [] })]);
    const { client } = makeClient(fetchImpl);
    const { results } = await client.search(VALID_KEY, { query: 'Q' });
    expect(results).toEqual([]);
  });
});

describe('validateKey（GET /models）', () => {
  it('映射模型列表，缺失字段为 null', async () => {
    const fetchImpl = fetchSequence([
      jsonResponse({
        object: 'list',
        data: [
          { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1048576 },
          { id: 'deepseek-v4-pro' },
        ],
      }),
    ]);
    const { client } = makeClient(fetchImpl);
    const { models } = await client.validateKey(VALID_KEY);
    expect(models).toEqual([
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576 },
      { id: 'deepseek-v4-pro', name: null, contextWindow: null },
    ]);
    expect(fetchImpl.calls[0].url).toBe('https://api.deepseek.com/models');
    expect(fetchImpl.calls[0].options.method).toBe('GET');
    expect(fetchImpl.calls[0].options.headers.authorization).toBe(`Bearer ${VALID_KEY}`);
  });

  it('data 缺失时返回空模型列表', async () => {
    const fetchImpl = fetchSequence([jsonResponse({ object: 'list' })]);
    const { client } = makeClient(fetchImpl);
    expect(await client.validateKey(VALID_KEY)).toEqual({ models: [] });
  });
});

describe('fetchPage（POST /v1/tools/fetch）', () => {
  it('返回 title/content', async () => {
    const fetchImpl = fetchSequence([jsonResponse({ title: 'Example', content: '# 正文\n\nMarkdown' })]);
    const { client } = makeClient(fetchImpl);
    const page = await client.fetchPage(VALID_KEY, 'https://example.com/article');
    expect(page.title).toBe('Example');
    expect(page.content).toBe('# 正文\n\nMarkdown');
    expect(fetchImpl.calls[0].url).toBe('https://api.deepseek.com/v1/tools/fetch');
    expect(JSON.parse(fetchImpl.calls[0].options.body)).toEqual({ url: 'https://example.com/article' });
  });
});

describe('上游错误映射（契约 §3）', () => {
  it('401 → invalid_api_key，且不重试', async () => {
    const fetchImpl = fetchSequence([jsonResponse({ error: { message: 'bad key' } }, { status: 401 })]);
    const { client } = makeClient(fetchImpl);
    await expectAppError(client.search(VALID_KEY, { query: 'Q' }), {
      code: 'invalid_api_key',
      status: 401,
      upstreamStatus: 401,
    });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('402 → insufficient_balance', async () => {
    const fetchImpl = fetchSequence([jsonResponse({ error: { message: 'balance' } }, { status: 402 })]);
    const { client } = makeClient(fetchImpl);
    await expectAppError(client.validateKey(VALID_KEY), {
      code: 'insufficient_balance',
      status: 402,
      upstreamStatus: 402,
    });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('fetch 403/404 → fetch_forbidden / fetch_unavailable', async () => {
    const forbiddenFetch = fetchSequence([jsonResponse({}, { status: 403 })]);
    const forbidden = makeClient(forbiddenFetch).client;
    await expectAppError(forbidden.fetchPage(VALID_KEY, 'https://example.com'), {
      code: 'fetch_forbidden',
      status: 403,
    });
    expect(forbiddenFetch.calls).toHaveLength(1);

    const missingFetch = fetchSequence([jsonResponse({}, { status: 404 })]);
    const missing = makeClient(missingFetch).client;
    await expectAppError(missing.fetchPage(VALID_KEY, 'https://example.com'), {
      code: 'fetch_unavailable',
      status: 404,
    });
    expect(missingFetch.calls).toHaveLength(1);
  });

  it('400 透传上游 message', async () => {
    const fetchImpl = fetchSequence([
      jsonResponse({ error: { message: 'query too long', type: 'invalid_request_error' } }, { status: 400 }),
    ]);
    const { client } = makeClient(fetchImpl);
    const error = await expectAppError(client.search(VALID_KEY, { query: 'Q' }), {
      code: 'invalid_request',
      status: 400,
      upstreamStatus: 400,
    });
    expect(error.message).toBe('query too long');
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('500 重试 2 次后返回 upstream_error（退避 500ms → 1200ms）', async () => {
    const fetchImpl = fetchSequence([
      jsonResponse({}, { status: 500 }),
      jsonResponse({}, { status: 500 }),
      jsonResponse({}, { status: 500 }),
    ]);
    const { client, delays } = makeClient(fetchImpl);
    await expectAppError(client.search(VALID_KEY, { query: 'Q' }), {
      code: 'upstream_error',
      status: 502,
      upstreamStatus: 500,
    });
    expect(fetchImpl.calls).toHaveLength(3);
    expect(delays).toEqual([500, 1200]);
  });

  it('500 重试成功则正常返回', async () => {
    const fetchImpl = fetchSequence([
      jsonResponse({}, { status: 500 }),
      jsonResponse({ results: [] }),
    ]);
    const { client, delays } = makeClient(fetchImpl);
    const { results } = await client.search(VALID_KEY, { query: 'Q' });
    expect(results).toEqual([]);
    expect(fetchImpl.calls).toHaveLength(2);
    expect(delays).toEqual([500]);
  });

  it('408 也会重试', async () => {
    const fetchImpl = fetchSequence([
      jsonResponse({}, { status: 408 }),
      jsonResponse({ results: [] }),
    ]);
    const { client } = makeClient(fetchImpl);
    await client.search(VALID_KEY, { query: 'Q' });
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('429 尊重 Retry-After 秒数', async () => {
    const fetchImpl = fetchSequence([
      jsonResponse({}, { status: 429, headers: { 'retry-after': '3' } }),
      jsonResponse({}, { status: 429, headers: { 'retry-after': '3' } }),
      jsonResponse({ results: [] }),
    ]);
    const { client, delays } = makeClient(fetchImpl);
    await client.search(VALID_KEY, { query: 'Q' });
    expect(fetchImpl.calls).toHaveLength(3);
    expect(delays).toEqual([3000, 3000]);
  });

  it('Retry-After 超过 10s 被截断', async () => {
    const fetchImpl = fetchSequence([
      jsonResponse({}, { status: 429, headers: { 'retry-after': '60' } }),
      jsonResponse({}, { status: 429, headers: { 'retry-after': '60' } }),
      jsonResponse({ results: [] }),
    ]);
    const { client, delays } = makeClient(fetchImpl);
    await client.search(VALID_KEY, { query: 'Q' });
    expect(delays).toEqual([10000, 10000]);
  });

  it('429 重试耗尽后仍返回 429 rate_limited 并带 Retry-After', async () => {
    const fetchImpl = fetchSequence([
      jsonResponse({}, { status: 429, headers: { 'retry-after': '2' } }),
      jsonResponse({}, { status: 429, headers: { 'retry-after': '2' } }),
      jsonResponse({}, { status: 429, headers: { 'retry-after': '2' } }),
    ]);
    const { client } = makeClient(fetchImpl);
    await expectAppError(client.search(VALID_KEY, { query: 'Q' }), {
      code: 'rate_limited',
      status: 429,
      upstreamStatus: 429,
      retryAfter: 2,
    });
    expect(fetchImpl.calls).toHaveLength(3);
  });
});

describe('超时与网络错误', () => {
  it('连接超时 → 504 upstream_timeout（不重试）', async () => {
    const fetchImpl = hangingFetch();
    const { client } = makeClient(fetchImpl, { configOverrides: { searchTimeoutMs: 30 } });
    await expectAppError(client.search(VALID_KEY, { query: 'Q' }), {
      code: 'upstream_timeout',
      status: 504,
    });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('网络错误 → 502 upstream_unreachable', async () => {
    const fetchImpl = fetchSequence([new TypeError('fetch failed')]);
    const { client } = makeClient(fetchImpl);
    await expectAppError(client.search(VALID_KEY, { query: 'Q' }), {
      code: 'upstream_unreachable',
      status: 502,
    });
  });

  it('上游返回非法 JSON → upstream_error，且不携带 upstreamStatus', async () => {
    const fetchImpl = fetchSequence([jsonResponse('this is not json')]);
    const { client } = makeClient(fetchImpl);
    const error = await expectAppError(client.search(VALID_KEY, { query: 'Q' }), {
      code: 'upstream_error',
      status: 502,
    });
    // 契约 §3：上游 200 但响应体非法时，不把 200 写进 upstreamStatus
    expect(error.upstreamStatus).toBeNull();
  });

  it('外部 signal abort → client_aborted', async () => {
    const fetchImpl = hangingFetch();
    const { client } = makeClient(fetchImpl);
    const controller = new AbortController();
    const promise = client.search(VALID_KEY, { query: 'Q' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expectAppError(promise, { code: 'client_aborted', status: 499 });
  });
});

describe('chatStream（SSE）', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'user' },
  ];

  function upstreamSse() {
    return sseEvents([
      { choices: [{ delta: { content: '你好' } }] },
      { choices: [{ delta: { reasoning_content: '思考中' } }] },
      {
        choices: [{ delta: { content: '世界' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      '[DONE]',
    ]);
  }

  it('解析事件序列 delta/reasoning/usage/done', async () => {
    const fetchImpl = fetchSequence([sseResponse(upstreamSse())]);
    const { client } = makeClient(fetchImpl);
    const events = await collectAsync(client.chatStream(VALID_KEY, { messages }));
    expect(events).toEqual([
      { type: 'delta', text: '你好' },
      { type: 'reasoning', text: '思考中' },
      { type: 'delta', text: '世界' },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      { type: 'done', finishReason: 'stop' },
    ]);

    const { url, options } = fetchImpl.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(options.method).toBe('POST');
    expect(options.headers.authorization).toBe(`Bearer ${VALID_KEY}`);
    const payload = JSON.parse(options.body);
    expect(payload).toEqual({
      model: 'deepseek-flash',
      messages,
      stream: true,
      thinking: { type: 'disabled' },
      max_tokens: 1200,
    });
    expect(payload).not.toHaveProperty('temperature');
    expect(payload).not.toHaveProperty('reasoning_effort');
  });

  it('thinking=true 时发送 enabled + reasoning_effort=low + 指定 model', async () => {
    const fetchImpl = fetchSequence([sseResponse(upstreamSse())]);
    const { client } = makeClient(fetchImpl);
    await collectAsync(client.chatStream(VALID_KEY, { messages, model: 'deepseek-v4-pro', thinking: true }));
    const payload = JSON.parse(fetchImpl.calls[0].options.body);
    expect(payload.model).toBe('deepseek-v4-pro');
    expect(payload.thinking).toEqual({ type: 'enabled' });
    expect(payload.reasoning_effort).toBe('low');
  });

  it('跨 chunk 分片仍能正确解析（含 \\r\\n 分隔）', async () => {
    const text = upstreamSse().replace(/\n/g, '\r\n');
    const fetchImpl = fetchSequence([sseResponse(text, { chunkSize: 7 })]);
    const { client } = makeClient(fetchImpl);
    const events = await collectAsync(client.chatStream(VALID_KEY, { messages }));
    expect(events.map((event) => event.type)).toEqual(['delta', 'reasoning', 'delta', 'usage', 'done']);
  });

  it('上游流结束但没有 [DONE] 时补 done', async () => {
    const text = sseEvents([{ choices: [{ delta: { content: 'a' }, finish_reason: 'length' }] }]);
    const fetchImpl = fetchSequence([sseResponse(text)]);
    const { client } = makeClient(fetchImpl);
    const events = await collectAsync(client.chatStream(VALID_KEY, { messages }));
    expect(events).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'done', finishReason: 'length' },
    ]);
  });

  it('上游 402 → insufficient_balance，不重试', async () => {
    const fetchImpl = fetchSequence([jsonResponse({ error: { message: 'balance' } }, { status: 402 })]);
    const { client } = makeClient(fetchImpl);
    await expectAppError(collectAsync(client.chatStream(VALID_KEY, { messages })), {
      code: 'insufficient_balance',
      status: 402,
    });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('上游 500 → upstream_error，不重试（chat 不重试）', async () => {
    const fetchImpl = fetchSequence([jsonResponse({}, { status: 500 })]);
    const { client } = makeClient(fetchImpl);
    await expectAppError(collectAsync(client.chatStream(VALID_KEY, { messages })), {
      code: 'upstream_error',
      status: 502,
    });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('流读取超时 → upstream_timeout', async () => {
    const fetchImpl = fetchSequence([hangingSseResponse()]);
    const { client } = makeClient(fetchImpl, { configOverrides: { chatTimeoutMs: 30 } });
    await expectAppError(collectAsync(client.chatStream(VALID_KEY, { messages })), {
      code: 'upstream_timeout',
      status: 504,
    });
  });

  it('外部取消 → client_aborted（用于客户端断开）', async () => {
    const fetchImpl = fetchSequence([hangingSseResponse()]);
    const { client } = makeClient(fetchImpl);
    const controller = new AbortController();
    const promise = collectAsync(
      client.chatStream(VALID_KEY, { messages, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 10);
    await expectAppError(promise, { code: 'client_aborted', status: 499 });
  });
});

describe('defaultSleep', () => {
  it('可被等待', async () => {
    const started = Date.now();
    await defaultSleep(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(0);
  });
});
