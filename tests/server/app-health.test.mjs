import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { COUNT_LIMIT } from '../../server/config.mjs';
import { createTestApp, disposeApp, testConfig } from './helpers.mjs';

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('GET /api/health（契约 §2）', () => {
  it('返回契约规定的完整结构', async () => {
    const { app } = createTestApp();
    try {
      const response = await request(app).get('/api/health');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).toEqual({
        ok: true,
        name: 'deepsearch',
        version: '1.0.0',
        features: { search: true, fetch: true, ai: true },
        auth: { accessTokenRequired: false },
        limits: { count: { min: COUNT_LIMIT.min, max: COUNT_LIMIT.max, default: COUNT_LIMIT.default } },
        upstream: 'https://api.deepseek.com',
      });
    } finally {
      disposeApp(app);
    }
  });

  it('配置访问口令后 accessTokenRequired=true', async () => {
    const { app } = createTestApp({ config: testConfig({ accessToken: 'secret' }) });
    try {
      const response = await request(app).get('/api/health');
      expect(response.body.auth.accessTokenRequired).toBe(true);
      expect(response.body.upstream).toBe('https://api.deepseek.com');
    } finally {
      disposeApp(app);
    }
  });

  it('无鉴权即可访问', async () => {
    const { app } = createTestApp();
    try {
      expect((await request(app).get('/api/health')).status).toBe(200);
    } finally {
      disposeApp(app);
    }
  });
});

describe('通用响应头（契约 §0 / §7）', () => {
  it('每个响应都带 X-Request-Id', async () => {
    const { app } = createTestApp();
    try {
      const first = await request(app).get('/api/health');
      const second = await request(app).get('/api/health');
      expect(first.headers['x-request-id']).toMatch(REQUEST_ID_PATTERN);
      expect(second.headers['x-request-id']).toMatch(REQUEST_ID_PATTERN);
      expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
    } finally {
      disposeApp(app);
    }
  });

  it('安全头齐全且隐藏 x-powered-by', async () => {
    const { app } = createTestApp();
    try {
      for (const path of ['/api/health', '/']) {
        const response = await request(app).get(path);
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
        expect(response.headers['x-frame-options']).toBe('DENY');
        expect(response.headers['content-security-policy']).toContain("script-src 'self'");
        expect(response.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'");
        expect(response.headers['content-security-policy']).toContain("img-src 'self' data: https:");
        expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
        expect(response.headers['x-powered-by']).toBeUndefined();
        expect(response.headers['x-request-id']).toMatch(REQUEST_ID_PATTERN);
      }
    } finally {
      disposeApp(app);
    }
  });

  it('/api 响应一律 Cache-Control: no-store', async () => {
    const { app } = createTestApp();
    try {
      for (const path of ['/api/health', '/api/does-not-exist']) {
        const response = await request(app).get(path);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    } finally {
      disposeApp(app);
    }
  });
});

describe('未知接口与非法请求体', () => {
  it('未知 /api 路径 → 404 not_found JSON', async () => {
    const { app } = createTestApp();
    try {
      const response = await request(app).get('/api/nope');
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
      expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
      expect(response.body.error).not.toHaveProperty('upstreamStatus');
    } finally {
      disposeApp(app);
    }
  });

  it('错误方法（GET /api/search）→ 404 JSON 而不是 HTML', async () => {
    const { app } = createTestApp();
    try {
      const response = await request(app).get('/api/search');
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
    } finally {
      disposeApp(app);
    }
  });

  it('非法 JSON → 400 invalid_request', async () => {
    const { app } = createTestApp();
    try {
      const response = await request(app)
        .post('/api/search')
        .set('Content-Type', 'application/json')
        .send('{"query": "unterminated');
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('invalid_request');
      expect(response.body.error.message).toContain('JSON');
      expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
    } finally {
      disposeApp(app);
    }
  });

  it('请求体超过 MAX_BODY_BYTES → 413', async () => {
    const { app } = createTestApp({ config: testConfig({ maxBodyBytes: 64 }) });
    try {
      const response = await request(app)
        .post('/api/search')
        .send({ query: 'x'.repeat(500) });
      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe('invalid_request');
      expect(response.body.error.message).toMatch(/[\u4e00-\u9fa5]/);
    } finally {
      disposeApp(app);
    }
  });
});
