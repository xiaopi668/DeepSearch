import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { capturingLogger, createTestApp, disposeApp, testConfig } from './helpers.mjs';

const VALID_KEY = `sk-${'k'.repeat(24)}`;
const VALID_HEADER = `Bearer ${VALID_KEY}`;
const auth = (req) => req.set('Authorization', VALID_HEADER);

describe('API Key 鉴权（契约 §1）', () => {
  it('缺少 Authorization → 401 missing_api_key，且不请求上游', async () => {
    const { app, client } = createTestApp();
    try {
      const response = await request(app).post('/api/search').send({ query: 'q' });
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('missing_api_key');
      expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(client.calls.search).toHaveLength(0);
    } finally {
      disposeApp(app);
    }
  });

  it('Key 格式非法 → 401 invalid_api_key，且不请求上游', async () => {
    const { app, client } = createTestApp();
    try {
      for (const header of ['Bearer sk-short', 'Bearer not-a-key-at-all', VALID_KEY, 'Basic abc']) {
        const response = await request(app).post('/api/search').set('Authorization', header).send({ query: 'q' });
        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('invalid_api_key');
      }
      expect(client.calls.search).toHaveLength(0);
    } finally {
      disposeApp(app);
    }
  });

  it('合法 Key 透传给客户端（上游），且不出现在响应里', async () => {
    const { app, client } = createTestApp();
    try {
      const response = await auth(request(app).post('/api/search')).send({ query: 'q' });
      expect(response.status).toBe(200);
      expect(client.calls.search).toHaveLength(1);
      expect(client.calls.search[0].apiKey).toBe(VALID_KEY);
      expect(JSON.stringify(response.body)).not.toContain(VALID_KEY);
      expect(JSON.stringify(response.headers)).not.toContain(VALID_KEY);
    } finally {
      disposeApp(app);
    }
  });

  it('所有受保护端点都要求 Key', async () => {
    const { app } = createTestApp();
    try {
      const endpoints = [
        ['/api/validate-key', {}],
        ['/api/search', { query: 'q' }],
        ['/api/fetch', { url: 'https://example.com/' }],
        ['/api/summarize', { query: 'q', results: [{ title: 't', url: 'https://example.com/' }] }],
      ];
      for (const [path, body] of endpoints) {
        const response = await request(app).post(path).send(body);
        expect(response.status, path).toBe(401);
        expect(response.body.error.code, path).toBe('missing_api_key');
      }
    } finally {
      disposeApp(app);
    }
  });
  it('请求日志不包含 API Key（契约 §7）', async () => {
    const logger = capturingLogger();
    const { app } = createTestApp({ logger });
    try {
      await auth(request(app).post('/api/search')).send({ query: 'q' });
      const logText = logger.lines.join('\n');
      expect(logger.lines.length).toBeGreaterThan(0);
      expect(logText).toContain('http_request');
      expect(logText).not.toContain(VALID_KEY);
      expect(logText).not.toContain('Bearer');
    } finally {
      disposeApp(app);
    }
  });
});

describe('POST /api/validate-key（契约 §2）', () => {
  it('返回契约形状 { ok, models[] }', async () => {
    const { app, client } = createTestApp();
    try {
      // 契约允许空请求体（{} 亦可），这里不发送 body
      const response = await auth(request(app).post('/api/validate-key'));
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576 },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1048576 },
        ],
      });
      expect(client.calls.validateKey).toHaveLength(1);
      expect(client.calls.validateKey[0].apiKey).toBe(VALID_KEY);
    } finally {
      disposeApp(app);
    }
  });
});

describe('可选 ACCESS_TOKEN 门（契约 §1）', () => {
  it('未配置时完全关闭（忽略该头）', async () => {
    const { app } = createTestApp({ config: testConfig({ accessToken: '' }) });
    try {
      const response = await auth(request(app).post('/api/search'))
        .set('X-Access-Token', 'anything')
        .send({ query: 'q' });
      expect(response.status).toBe(200);
    } finally {
      disposeApp(app);
    }
  });

  it('配置后缺失/错误口令 → 403 access_denied', async () => {
    const { app, client } = createTestApp({ config: testConfig({ accessToken: 'secret-token' }) });
    try {
      const missing = await auth(request(app).post('/api/search')).send({ query: 'q' });
      expect(missing.status).toBe(403);
      expect(missing.body.error.code).toBe('access_denied');
      expect(missing.body.error.message).toMatch(/[\u4e00-\u9fa5]/);

      const wrong = await auth(request(app).post('/api/search'))
        .set('X-Access-Token', 'wrong')
        .send({ query: 'q' });
      expect(wrong.status).toBe(403);
      expect(wrong.body.error.code).toBe('access_denied');

      expect(client.calls.search).toHaveLength(0);
    } finally {
      disposeApp(app);
    }
  });

  it('正确口令 + 合法 Key 才能通过', async () => {
    const { app, client } = createTestApp({ config: testConfig({ accessToken: 'secret-token' }) });
    try {
      // 有口令但没 Key → 仍然是 401
      const noKey = await request(app).post('/api/search').set('X-Access-Token', 'secret-token').send({ query: 'q' });
      expect(noKey.status).toBe(401);
      expect(noKey.body.error.code).toBe('missing_api_key');

      const ok = await auth(request(app).post('/api/search'))
        .set('X-Access-Token', 'secret-token')
        .send({ query: 'q' });
      expect(ok.status).toBe(200);
      expect(client.calls.search).toHaveLength(1);
    } finally {
      disposeApp(app);
    }
  });

  it('/api/health 不受访问口令影响', async () => {
    const { app } = createTestApp({ config: testConfig({ accessToken: 'secret-token' }) });
    try {
      const response = await request(app).get('/api/health');
      expect(response.status).toBe(200);
      expect(response.body.auth.accessTokenRequired).toBe(true);
    } finally {
      disposeApp(app);
    }
  });

  it('口令校验适用于 validate-key / fetch / summarize', async () => {
    const { app } = createTestApp({ config: testConfig({ accessToken: 'secret-token' }) });
    try {
      for (const path of ['/api/validate-key', '/api/fetch', '/api/summarize']) {
        const response = await auth(request(app).post(path)).send({});
        expect(response.status, path).toBe(403);
        expect(response.body.error.code, path).toBe('access_denied');
      }
    } finally {
      disposeApp(app);
    }
  });
});
