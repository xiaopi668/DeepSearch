import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../server/app.mjs';
import {
  NO_BUILD_DIR,
  disposeApp,
  fetchSequence,
  jsonResponse,
  silentLogger,
  testConfig,
} from './helpers.mjs';

const VALID_KEY = `sk-${'f'.repeat(24)}`;
const AUTH = `Bearer ${VALID_KEY}`;
const auth = (req) => req.set('Authorization', AUTH);

function createIntegrationApp(fetchImpl, config = testConfig()) {
  return createApp({
    config,
    fetchImpl,
    sleep: async () => {},
    random: () => 0,
    logger: silentLogger(),
    staticDir: NO_BUILD_DIR,
  });
}

describe('POST /api/fetch 成功路径（契约 §2）', () => {
  it('返回 url/title/content/fetchedAt，并调用上游 /v1/tools/fetch', async () => {
    const fetchImpl = fetchSequence([jsonResponse({ title: 'Example article', content: '# Example article\n\n正文 Markdown…' })]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const response = await auth(request(app).post('/api/fetch')).send({ url: 'https://example.com/article' });
      expect(response.status).toBe(200);
      expect(response.body.url).toBe('https://example.com/article');
      expect(response.body.title).toBe('Example article');
      expect(response.body.content).toBe('# Example article\n\n正文 Markdown…');
      expect(new Date(response.body.fetchedAt).toISOString()).toBe(response.body.fetchedAt);

      expect(fetchImpl.calls).toHaveLength(1);
      expect(fetchImpl.calls[0].url).toBe('https://api.deepseek.com/v1/tools/fetch');
      expect(JSON.parse(fetchImpl.calls[0].options.body)).toEqual({ url: 'https://example.com/article' });
    } finally {
      disposeApp(app);
    }
  });
});

describe('POST /api/fetch 参数校验', () => {
  it('非法 url → 400 invalid_request 且不请求上游', async () => {
    const fetchImpl = fetchSequence([]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const invalidUrls = [undefined, '', 'not-a-url', 'ftp://example.com/a', 'javascript:alert(1)', 'https://', 'https://user:pass@example.com/'];
      for (const url of invalidUrls) {
        const response = await auth(request(app).post('/api/fetch')).send(url === undefined ? {} : { url });
        expect(response.status, String(url)).toBe(400);
        expect(response.body.error.code, String(url)).toBe('invalid_request');
      }
      expect(fetchImpl.calls).toHaveLength(0);
    } finally {
      disposeApp(app);
    }
  });
});

describe('POST /api/fetch 上游错误映射（契约 §3）', () => {
  it('上游 403 → 403 fetch_forbidden', async () => {
    const fetchImpl = fetchSequence([jsonResponse({}, { status: 403 })]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const response = await auth(request(app).post('/api/fetch')).send({ url: 'https://example.com/a' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('fetch_forbidden');
      expect(response.body.error.message).toBe('该网页被目标站点或安全策略拒绝');
    } finally {
      disposeApp(app);
    }
  });

  it('上游 404 → 404 fetch_unavailable', async () => {
    const fetchImpl = fetchSequence([jsonResponse({}, { status: 404 })]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const response = await auth(request(app).post('/api/fetch')).send({ url: 'https://example.com/missing' });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('fetch_unavailable');
      expect(response.body.error.message).toBe('无法抓取该网页正文');
    } finally {
      disposeApp(app);
    }
  });

  it('上游 5xx → 502 upstream_error', async () => {
    const fetchImpl = fetchSequence([
      jsonResponse({}, { status: 502 }),
      jsonResponse({}, { status: 502 }),
      jsonResponse({}, { status: 502 }),
    ]);
    const app = createIntegrationApp(fetchImpl);
    try {
      const response = await auth(request(app).post('/api/fetch')).send({ url: 'https://example.com/a' });
      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('upstream_error');
    } finally {
      disposeApp(app);
    }
  });
});
