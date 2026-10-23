import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createRateLimiters, createSlidingWindowLimiter } from '../../server/rate-limit.mjs';
import { createTestApp, disposeApp, testConfig } from './helpers.mjs';

const VALID_KEY = `sk-${'r'.repeat(20)}`;
const auth = (req) => req.set('Authorization', `Bearer ${VALID_KEY}`);

describe('滑动窗口限流器', () => {
  it('额度内放行，超限拒绝并给出 Retry-After 秒数', () => {
    let now = 1_000;
    const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 2, now: () => now });

    expect(limiter.hit('1.2.3.4')).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.hit('1.2.3.4')).toMatchObject({ allowed: true, remaining: 0 });
    const denied = limiter.hit('1.2.3.4');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfter).toBe(1);
    expect(limiter.size()).toBe(1);
  });

  it('窗口滑过后自动释放额度', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 1, now: () => now });
    expect(limiter.hit('ip').allowed).toBe(true);
    expect(limiter.hit('ip').allowed).toBe(false);
    now = 999;
    expect(limiter.hit('ip').allowed).toBe(false);
    now = 1000; // 第一条命中滑出窗口
    expect(limiter.hit('ip').allowed).toBe(true);
  });

  it('不同 IP / 不同限流器相互独立', () => {
    const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 1 });
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
    expect(limiter.hit('b').allowed).toBe(true);

    const other = createSlidingWindowLimiter({ windowMs: 1000, max: 1 });
    expect(other.hit('a').allowed).toBe(true);
  });

  it('cleanup 清理过期 IP，dispose 释放资源', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 5, now: () => now });
    limiter.hit('a');
    limiter.hit('b');
    expect(limiter.size()).toBe(2);
    now = 5000;
    limiter.cleanup();
    expect(limiter.size()).toBe(0);
    limiter.dispose();
    expect(limiter.size()).toBe(0);
  });

  it('reset 清空记录', () => {
    const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 1 });
    limiter.hit('a');
    expect(limiter.size()).toBe(1);
    limiter.reset();
    expect(limiter.size()).toBe(0);
  });

  it('非法配置抛错', () => {
    expect(() => createSlidingWindowLimiter({ windowMs: 0, max: 1 })).toThrow();
    expect(() => createSlidingWindowLimiter({ windowMs: 1000, max: 0 })).toThrow();
  });
});

describe('createRateLimiters', () => {
  it('三类额度取自配置且彼此独立', () => {
    const config = testConfig({ rateLimitWindowMs: 1000, searchRateLimitMax: 3, fetchRateLimitMax: 4, aiRateLimitMax: 5 });
    const limiters = createRateLimiters(config);
    expect(limiters.search.max).toBe(3);
    expect(limiters.fetch.max).toBe(4);
    expect(limiters.ai.max).toBe(5);
    expect(limiters.search).not.toBe(limiters.fetch);
    limiters.dispose();
  });
});

describe('HTTP 限流集成（契约 §4）', () => {
  it('超限返回 429 rate_limited + Retry-After，且 health 不受限流影响', async () => {
    const { app, client } = createTestApp({
      config: testConfig({ searchRateLimitMax: 2, rateLimitWindowMs: 60000 }),
    });
    try {
      const first = await auth(request(app).post('/api/search')).send({ query: 'a' });
      expect(first.status).toBe(200);
      expect(first.headers['x-ratelimit-limit']).toBe('2');
      expect(first.headers['x-ratelimit-remaining']).toBe('1');

      const second = await auth(request(app).post('/api/search')).send({ query: 'b' });
      expect(second.status).toBe(200);

      const third = await auth(request(app).post('/api/search')).send({ query: 'c' });
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('rate_limited');
      expect(third.body.error.message).toMatch(/[\u4e00-\u9fa5]/);
      expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(client.calls.search).toHaveLength(2); // 被限流的请求没有打到上游

      // /api/health 不参与限流
      for (let index = 0; index < 5; index += 1) {
        const health = await request(app).get('/api/health');
        expect(health.status).toBe(200);
      }
    } finally {
      disposeApp(app);
    }
  });

  it('search / fetch / ai 额度互相独立', async () => {
    const { app } = createTestApp({
      config: testConfig({
        searchRateLimitMax: 5,
        fetchRateLimitMax: 1,
        aiRateLimitMax: 5,
        rateLimitWindowMs: 60000,
      }),
    });
    try {
      // search 两次都放行
      expect((await auth(request(app).post('/api/search')).send({ query: 'a' })).status).toBe(200);
      expect((await auth(request(app).post('/api/search')).send({ query: 'b' })).status).toBe(200);

      // fetch 自己的额度只有 1
      expect((await auth(request(app).post('/api/fetch')).send({ url: 'https://example.com/a' })).status).toBe(200);
      const fetchLimited = await auth(request(app).post('/api/fetch')).send({ url: 'https://example.com/b' });
      expect(fetchLimited.status).toBe(429);
      expect(fetchLimited.body.error.code).toBe('rate_limited');
    } finally {
      disposeApp(app);
    }
  });
});
