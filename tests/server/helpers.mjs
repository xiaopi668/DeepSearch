/**
 * 测试辅助工具：全部上游调用使用 fake fetch / stub client，
 * 绝不访问真实 DeepSeek，也不消耗任何额度。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../../server/app.mjs';
import { loadConfig } from '../../server/config.mjs';
import { createLogger } from '../../server/logger.mjs';

/** 绝对不存在的静态目录，保证「未构建」行为不受前端构建产物影响。 */
export const NO_BUILD_DIR = path.join(os.tmpdir(), 'deepsearch-test', `no-build-${process.pid}`, 'missing');

/** 测试配置：基于默认配置覆盖（不读取真实 process.env）。 */
export function testConfig(overrides = {}) {
  const base = loadConfig({});
  return {
    ...base,
    logLevel: 'error',
    accessToken: '',
    sseHeartbeatMs: 100,
    searchTimeoutMs: 200,
    fetchTimeoutMs: 200,
    chatTimeoutMs: 200,
    ...overrides,
  };
}

/** 不输出任何日志的 logger（可断言 lines，但默认静默）。 */
export function silentLogger() {
  return createLogger({ level: 'silent', sink: () => {} });
}

/** 收集日志行的 logger，便于断言脱敏。 */
export function capturingLogger(level = 'debug') {
  const lines = [];
  const logger = createLogger({ level, sink: (line) => lines.push(line) });
  logger.lines = lines;
  return logger;
}

/* ------------------------------ fake fetch 工具 ------------------------------ */

/** 构造 JSON 响应。body 为字符串时原样作为响应文本。 */
export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** 把若干 SSE data 事件拼成上游流文本。 */
export function sseEvents(list) {
  return list
    .map((item) => (typeof item === 'string' ? item : `data: ${JSON.stringify(item)}`))
    .map((line) => `${line}\n\n`)
    .join('');
}

/** 构造 SSE 响应（body 文本按 chunkSize 切块，模拟真实网络分片）。 */
export function sseResponse(text, { status = 200, chunkSize = 0, headers = {} } = {}) {
  const encoder = new TextEncoder();
  const chunks = [];
  if (chunkSize > 0) {
    for (let index = 0; index < text.length; index += chunkSize) chunks.push(text.slice(index, index + chunkSize));
  } else {
    chunks.push(text);
  }
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', ...headers },
  });
}

/** 永不结束的 SSE 响应（用于超时/取消测试）。 */
export function hangingSseResponse() {
  const stream = new ReadableStream({
    start() {
      // 故意不 enqueue / 不 close
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 按顺序返回预设响应的 fake fetch；记录全部调用。 */
export function fetchSequence(responses) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (next === undefined) throw new Error('fake fetch: 没有更多预设响应');
    if (typeof next === 'function') return next(url, options);
    if (next instanceof Error) throw next;
    return next;
  };
  impl.calls = calls;
  return impl;
}

/** 永不 resolve 的 fake fetch（等 signal abort 才 reject），用于超时测试。 */
export function hangingFetch() {
  const calls = [];
  const impl = (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Promise((_resolve, reject) => {
      const signal = options.signal;
      if (!signal) return;
      const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  impl.calls = calls;
  return impl;
}

/* ------------------------------ stub client ------------------------------ */

/**
 * 构造可注入 createApp 的桩客户端。
 * handlers: { validateKey, search, fetchPage, chatStream }，
 * chatStream 返回数组或异步生成器（元素为契约事件对象）。
 */
export function createStubClient(handlers = {}) {
  const calls = { validateKey: [], search: [], fetchPage: [], chatStream: [] };
  return {
    calls,
    async validateKey(apiKey, options = {}) {
      calls.validateKey.push({ apiKey, options });
      if (handlers.validateKey) return handlers.validateKey(apiKey, options);
      return {
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576 },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1048576 },
        ],
      };
    },
    async search(apiKey, params, options = {}) {
      calls.search.push({ apiKey, params, options });
      if (handlers.search) return handlers.search(apiKey, params, options);
      return { results: [], tookMs: 5 };
    },
    async fetchPage(apiKey, url, options = {}) {
      calls.fetchPage.push({ apiKey, url, options });
      if (handlers.fetchPage) return handlers.fetchPage(apiKey, url, options);
      return { title: '示例文章', content: '# 正文', tookMs: 3 };
    },
    async *chatStream(apiKey, params = {}) {
      calls.chatStream.push({ apiKey, params });
      const events = handlers.chatStream
        ? handlers.chatStream(apiKey, params)
        : [
            { type: 'delta', text: '你' },
            { type: 'delta', text: '好' },
            { type: 'done', finishReason: 'stop' },
          ];
      for await (const event of events) yield event;
    },
  };
}

/** 创建注入 stub client 的测试 app（默认禁用静态构建）。 */
export function createTestApp({ config = testConfig(), handlers = {}, staticDir = NO_BUILD_DIR, logger } = {}) {
  const client = createStubClient(handlers);
  const app = createApp({ config, client, logger: logger ?? silentLogger(), staticDir });
  return { app, client, config };
}

/** 释放 app 内部的限流清理定时器。 */
export function disposeApp(app) {
  try {
    app?.locals?.limiters?.dispose?.();
  } catch {
    // 忽略
  }
}

/* ------------------------------ HTTP / SSE 工具 ------------------------------ */

/** 在随机端口启动 app，返回访问地址与关闭函数。 */
export async function startHttpServer(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  return {
    server,
    url,
    close: () =>
      new Promise((resolve) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 解析 SSE 响应文本，返回事件列表与注释（心跳）行。 */
export function parseSseText(text) {
  const events = [];
  const comments = [];
  for (const rawFrame of String(text).split(/\r?\n\r?\n/)) {
    if (!rawFrame.trim()) continue;
    let event = 'message';
    const dataLines = [];
    for (const line of rawFrame.split(/\r?\n/)) {
      if (line.startsWith(':')) {
        comments.push(line);
      } else if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    if (dataLines.length === 0) continue;
    const dataText = dataLines.join('\n');
    let data;
    try {
      data = JSON.parse(dataText);
    } catch {
      data = dataText;
    }
    events.push({ event, data });
  }
  return { events, comments };
}

/** 轮询等待条件成立。 */
export async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 等待超时');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** 收集异步可迭代对象全部元素。 */
export async function collectAsync(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** 断言函数抛出 AppError 并返回它。 */
export function captureAppError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出错误，但没有抛出');
}

/** 创建临时目录（测试结束手动清理）。 */
export function makeTempDir(prefix = 'deepsearch-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
