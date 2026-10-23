import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../server/app.mjs';
import {
  NO_BUILD_DIR,
  disposeApp,
  fetchSequence,
  hangingFetch,
  jsonResponse,
  silentLogger,
  testConfig,
} from './helpers.mjs';

const VALID_KEY = `sk-${'s'.repeat(24)}`;
const AUTH = `Bearer ${VALID_KEY}`;

/** 用真实 DeepSeekClient + fake fetch 组装 app（端到端覆盖 snake→camel 映射与错误映射）。 */
function createIntegrationApp(fetchImpl, config = testConfig()) {
  return createApp({
    config,
    fetchImpl,
    sleep: async () => {}, // 重试不真正等待
    random: () => 0,
    logger: silentLogger(),
    staticDir: NO_BUILD_DIR,
  });
}

const auth = (req) => req.set('Authorization', AUTH);

const upstreamResult = {
  rerank_score: 2.4,
  title: 'DeepSeek V4 模型发布',
  url: 'https://example.com/a',
  snippet: '短摘要',
  summary: '长摘要',
  content: '',
  site_name: 'Example News',
  site_icon: 'https://example.com/favicon.ico',
  date: '2026-06-01T00:00:00+00:00',
  authority: 3,
};

describe('POST /api/search 成功路径', () => {
  it('把上游 snake_case 映射为 camelCase，并返回 meta', async () => {
    const fetchImpl = fetchSequence([jsonResponse({ results: [upstreamResult] })]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const response = await auth(request(app).post('/api/search')).send({
        query: 'DeepSeek V4 发布',
        count: 10,
        needContent: false,
        oriQuestion: 'DeepSeek V4 发布了吗',
        localization: null,
      });

      expect(response.status).toBe(200);
      expect(response.body.results).toHaveLength(1);
      expect(response.body.results[0]).toEqual({
        title: 'DeepSeek V4 模型发布',
        url: 'https://example.com/a',
        snippet: '短摘要',
        summary: '长摘要',
        content: '',
        siteName: 'Example News',
        siteIcon: 'https://example.com/favicon.ico',
        date: '2026-06-01T00:00:00+00:00',
        authority: 3,
        rerankScore: 2.4,
      });
      expect(response.body.meta.query).toBe('DeepSeek V4 发布');
      expect(response.body.meta.count).toBe(1); // count 是结果条数，不是请求参数
      expect(typeof response.body.meta.tookMs).toBe('number');

      // 上游收到 snake_case 请求体
      expect(fetchImpl.calls).toHaveLength(1);
      const payload = JSON.parse(fetchImpl.calls[0].options.body);
      expect(payload).toEqual({
        query: 'DeepSeek V4 发布',
        count: 10,
        need_content: false,
        ori_question: 'DeepSeek V4 发布了吗',
      });
      expect(fetchImpl.calls[0].url).toBe('https://api.deepseek.com/v1/tools/search');
      expect(fetchImpl.calls[0].options.headers.authorization).toBe(AUTH);
    } finally {
      disposeApp(app);
    }
  });

  it('无结果返回 200 + results: []', async () => {
    const fetchImpl = fetchSequence([jsonResponse({ results: [] })]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const response = await auth(request(app).post('/api/search')).send({ query: '没有结果的问题' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ results: [], meta: { count: 0 } });
    } finally {
      disposeApp(app);
    }
  });
});

describe('POST /api/search 参数校验（400 invalid_request）', () => {
  it('非法参数返回 400 且不请求上游', async () => {
    const fetchImpl = fetchSequence([]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const invalidBodies = [
        {},
        { query: '' },
        { query: '   ' },
        { query: 'q', count: 0 },
        { query: 'q', count: 51 },
        { query: 'q', count: 1.5 },
        { query: 'q', needContent: 'true' },
        { query: 'x'.repeat(129) },
      ];
      for (const body of invalidBodies) {
        const response = await auth(request(app).post('/api/search')).send(body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(response.body.error.code, JSON.stringify(body)).toBe('invalid_request');
        expect(response.body.error.message, JSON.stringify(body)).toMatch(/[\u4e00-\u9fa5]/);
      }
      expect(fetchImpl.calls).toHaveLength(0);
    } finally {
      disposeApp(app);
    }
  });
});

describe('POST /api/search 上游错误映射（契约 §3）', () => {
  it('上游 401 → 401 invalid_api_key', async () => {
    const fetchImpl = fetchSequence([jsonResponse({ error: { message: 'bad key' } }, { status: 401 })]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const response = await auth(request(app).post('/api/search')).send({ query: 'q' });
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('invalid_api_key');
      expect(response.body.error.upstreamStatus).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      disposeApp(app);
    }
  });

  it('上游 402 → 402 insufficient_balance', async () => {
    const fetchImpl = fetchSequence([jsonResponse({ error: { message: 'balance' } }, { status: 402 })]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const response = await auth(request(app).post('/api/search')).send({ query: 'q' });
      expect(response.status).toBe(402);
      expect(response.body.error.code).toBe('insufficient_balance');
      expect(response.body.error.message).toBe('DeepSeek 账户余额不足');
    } finally {
      disposeApp(app);
    }
  });

  it('上游 429（重试耗尽）→ 429 rate_limited + Retry-After', async () => {
    const fetchImpl = fetchSequence([
      jsonResponse({}, { status: 429, headers: { 'retry-after': '3' } }),
      jsonResponse({}, { status: 429, headers: { 'retry-after': '3' } }),
      jsonResponse({}, { status: 429, headers: { 'retry-after': '3' } }),
    ]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const response = await auth(request(app).post('/api/search')).send({ query: 'q' });
      expect(response.status).toBe(429);
      expect(response.body.error.code).toBe('rate_limited');
      expect(response.body.error.upstreamStatus).toBe(429);
      expect(response.headers['retry-after']).toBe('3');
      expect(fetchImpl.calls).toHaveLength(3);
    } finally {
      disposeApp(app);
    }
  });

  it('上游 200 但响应体非法 JSON → 502 upstream_error，且不带 upstreamStatus', async () => {
    const fetchImpl = fetchSequence([jsonResponse('this is not json')]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const response = await auth(request(app).post('/api/search')).send({ query: 'q' });
      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('upstream_error');
      expect(response.body.error).not.toHaveProperty('upstreamStatus');
    } finally {
      disposeApp(app);
    }
  });

  it('上游 5xx → 502 upstream_error', async () => {
    const fetchImpl = fetchSequence([
      jsonResponse({}, { status: 500 }),
      jsonResponse({}, { status: 500 }),
      jsonResponse({}, { status: 500 }),
    ]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const response = await auth(request(app).post('/api/search')).send({ query: 'q' });
      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('upstream_error');
      expect(response.body.error.upstreamStatus).toBe(500);
      expect(fetchImpl.calls).toHaveLength(3);
    } finally {
      disposeApp(app);
    }
  });

  it('上游超时 → 504 upstream_timeout', async () => {
    const fetchImpl = hangingFetch();
    const app = createIntegrationApp(fetchImpl, testConfig({ searchTimeoutMs: 30 }));
    try {
      const response = await auth(request(app).post('/api/search')).send({ query: 'q' });
      expect(response.status).toBe(504);
      expect(response.body.error.code).toBe('upstream_timeout');
      expect(fetchImpl.calls).toHaveLength(1);
    } finally {
      disposeApp(app);
    }
  });

  it('网络错误 → 502 upstream_unreachable', async () => {
    const fetchImpl = fetchSequence([new TypeError('fetch failed')]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const response = await auth(request(app).post('/api/search')).send({ query: 'q' });
      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('upstream_unreachable');
    } finally {
      disposeApp(app);
    }
  });
});
