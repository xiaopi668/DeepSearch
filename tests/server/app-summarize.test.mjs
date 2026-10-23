import { describe, expect, it } from 'vitest';

import { AppError } from '../../server/errors.mjs';
import { SYSTEM_PROMPT } from '../../server/prompt.mjs';
import {
  createTestApp,
  disposeApp,
  parseSseText,
  startHttpServer,
  testConfig,
  waitFor,
} from './helpers.mjs';

const VALID_KEY = `sk-${'a'.repeat(24)}`;
const AUTH = `Bearer ${VALID_KEY}`;

const validBody = {
  query: 'DeepSeek V4 发布',
  results: [
    {
      title: 'DeepSeek V4 模型发布',
      url: 'https://example.com/a',
      siteName: 'Example News',
      date: '2026-06-01T00:00:00+00:00',
      snippet: '短摘要',
      summary: '长摘要',
    },
  ],
  model: 'deepseek-flash',
  thinking: false,
};

function postSummarize(url, body = validBody, { headers = {}, signal } = {}) {
  return fetch(`${url}/api/summarize`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: AUTH,
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function readSseResponse(response) {
  const text = await response.text();
  return { text, ...parseSseText(text) };
}

describe('POST /api/summarize SSE 事件序列（契约 §2）', () => {
  it('返回 200 + 正确 SSE 头，并依次输出 meta/delta/usage/done', async () => {
    const { app, client } = createTestApp({
      handlers: {
        chatStream: () => [
          { type: 'delta', text: '你' },
          { type: 'delta', text: '好' },
          { type: 'usage', usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 } },
          { type: 'done', finishReason: 'stop' },
        ],
      },
    });
    const server = await startHttpServer(app);
    try {
      const response = await postSummarize(server.url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('content-type')).toContain('charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-accel-buffering')).toBe('no');
      expect(response.headers.get('connection')).toBe('keep-alive');

      const { events } = await readSseResponse(response);
      expect(events.map((event) => event.event)).toEqual(['meta', 'delta', 'delta', 'usage', 'done']);

      const requestId = response.headers.get('x-request-id');
      expect(events[0].data).toEqual({ model: 'deepseek-flash', requestId });
      expect(events[1].data).toEqual({ text: '你' });
      expect(events[2].data).toEqual({ text: '好' });
      expect(events[3].data).toEqual({ promptTokens: 8, completionTokens: 2, totalTokens: 10 });
      expect(events[4].data).toEqual({ finishReason: 'stop' });

      // 客户端收到的是 system + user 两条消息，thinking=false
      const call = client.calls.chatStream[0];
      expect(call.params.thinking).toBe(false);
      expect(call.params.model).toBe('deepseek-flash');
      expect(call.params.messages).toHaveLength(2);
      expect(call.params.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
      expect(call.params.messages[1].content).toContain('问题：DeepSeek V4 发布');
      expect(call.params.messages[1].content).toContain('[1] 标题：DeepSeek V4 模型发布');
    } finally {
      await server.close();
      disposeApp(app);
    }
  });

  it('thinking=true 时透传并输出 reasoning 事件', async () => {
    const { app, client } = createTestApp({
      handlers: {
        chatStream: () => [
          { type: 'reasoning', text: '先分析' },
          { type: 'delta', text: '结论' },
          { type: 'done', finishReason: 'stop' },
        ],
      },
    });
    const server = await startHttpServer(app);
    try {
      const response = await postSummarize(server.url, { ...validBody, thinking: true, model: 'deepseek-v4-pro' });
      const { events } = await readSseResponse(response);
      expect(events.map((event) => event.event)).toEqual(['meta', 'reasoning', 'delta', 'done']);
      expect(events[0].data.model).toBe('deepseek-v4-pro');
      expect(events[1].data).toEqual({ text: '先分析' });
      expect(client.calls.chatStream[0].params.thinking).toBe(true);
      expect(client.calls.chatStream[0].params.model).toBe('deepseek-v4-pro');
    } finally {
      await server.close();
      disposeApp(app);
    }
  });

  it('上游没有发送 done 时补一个 done 事件', async () => {
    const { app } = createTestApp({
      handlers: { chatStream: () => [{ type: 'delta', text: '仅增量' }] },
    });
    const server = await startHttpServer(app);
    try {
      const response = await postSummarize(server.url);
      const { events } = await readSseResponse(response);
      expect(events.map((event) => event.event)).toEqual(['meta', 'delta', 'done']);
      expect(events[2].data).toEqual({ finishReason: 'stop' });
    } finally {
      await server.close();
      disposeApp(app);
    }
  });
});

describe('POST /api/summarize 校验与错误', () => {
  it('校验失败返回普通 JSON 400，不进入 SSE、不请求上游', async () => {
    const { app, client } = createTestApp();
    const server = await startHttpServer(app);
    try {
      const invalidBodies = [
        { ...validBody, results: [] },
        { ...validBody, results: Array(16).fill(validBody.results[0]) },
        { ...validBody, model: 'gpt-4' },
        { ...validBody, thinking: 'yes' },
        { ...validBody, query: '' },
      ];
      for (const body of invalidBodies) {
        const response = await postSummarize(server.url, body);
        expect(response.status).toBe(400);
        expect(response.headers.get('content-type')).toContain('application/json');
        const payload = await response.json();
        expect(payload.error.code).toBe('invalid_request');
        expect(payload.error.requestId).toBe(response.headers.get('x-request-id'));
      }
      expect(client.calls.chatStream).toHaveLength(0);
    } finally {
      await server.close();
      disposeApp(app);
    }
  });

  it('上游开始输出前失败 → SSE 200 + error 事件（code/message）', async () => {
    const { app } = createTestApp({
      handlers: {
        chatStream: () => {
          throw new AppError('insufficient_balance', 'DeepSeek 账户余额不足', { status: 402 });
        },
      },
    });
    const server = await startHttpServer(app);
    try {
      const response = await postSummarize(server.url);
      expect(response.status).toBe(200);
      const { events } = await readSseResponse(response);
      expect(events.map((event) => event.event)).toEqual(['meta', 'error']);
      expect(events[1].data).toEqual({ code: 'insufficient_balance', message: 'DeepSeek 账户余额不足' });
    } finally {
      await server.close();
      disposeApp(app);
    }
  });

  it('输出中途失败 → 已发送 delta 后以 error 事件收尾', async () => {
    const { app } = createTestApp({
      handlers: {
        chatStream: () =>
          (async function* broken() {
            yield { type: 'delta', text: '部分内容' };
            throw new AppError('upstream_error', 'DeepSeek 暂时不可用，请稍后重试', { status: 502 });
          })(),
      },
    });
    const server = await startHttpServer(app);
    try {
      const response = await postSummarize(server.url);
      const { events } = await readSseResponse(response);
      expect(events.map((event) => event.event)).toEqual(['meta', 'delta', 'error']);
      expect(events[2].data.code).toBe('upstream_error');
    } finally {
      await server.close();
      disposeApp(app);
    }
  });

  it('15 秒心跳（测试配置为 30ms）以注释行输出', async () => {
    const { app } = createTestApp({
      config: testConfig({ sseHeartbeatMs: 30 }),
      handlers: {
        chatStream: () =>
          (async function* slow() {
            yield { type: 'delta', text: '慢' };
            await new Promise((resolve) => setTimeout(resolve, 120));
            yield { type: 'done', finishReason: 'stop' };
          })(),
      },
    });
    const server = await startHttpServer(app);
    try {
      const response = await postSummarize(server.url);
      const { text, events, comments } = await readSseResponse(response);
      expect(text).toContain(': ping');
      expect(comments.length).toBeGreaterThanOrEqual(1);
      expect(events.map((event) => event.event)).toEqual(['meta', 'delta', 'done']);
    } finally {
      await server.close();
      disposeApp(app);
    }
  });
});

describe('客户端断开', () => {
  it('SSE 客户端断开后立即 abort 上游请求', async () => {
    let capturedSignal = null;
    const { app } = createTestApp({
      config: testConfig({ sseHeartbeatMs: 5000 }),
      handlers: {
        chatStream: (apiKey, params) => {
          capturedSignal = params.signal;
          return (async function* hanging() {
            yield { type: 'delta', text: '第一段' };
            await new Promise((resolve, reject) => {
              const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              if (params.signal?.aborted) return onAbort();
              params.signal?.addEventListener('abort', onAbort, { once: true });
            });
            yield { type: 'delta', text: '不应到达' };
          })();
        },
      },
    });
    const server = await startHttpServer(app);
    const controller = new AbortController();
    try {
      const response = await postSummarize(server.url, validBody, { signal: controller.signal });
      expect(response.status).toBe(200);
      const reader = response.body.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('event: meta');
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal.aborted).toBe(false);

      controller.abort(); // 模拟浏览器关闭连接

      await waitFor(() => capturedSignal?.aborted === true);
      expect(capturedSignal.aborted).toBe(true);
      try {
        await reader.cancel();
      } catch {
        // 连接已断开
      }
    } finally {
      controller.abort();
      await server.close();
      disposeApp(app);
    }
  });
});
