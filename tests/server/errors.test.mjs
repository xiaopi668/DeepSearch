import { describe, expect, it } from 'vitest';

import {
  AppError,
  accessDenied,
  clientAborted,
  fetchForbidden,
  fetchUnavailable,
  insufficientBalance,
  internal,
  invalidApiKey,
  invalidRequest,
  isAppError,
  mapUpstreamError,
  missingApiKey,
  notFound,
  rateLimited,
  toErrorPayload,
  toSseError,
  upstreamError,
  upstreamTimeout,
  upstreamUnreachable,
} from '../../server/errors.mjs';

describe('AppError 与错误工厂', () => {
  it('默认状态与字段', () => {
    const error = new AppError('boom', '出错了');
    expect(error).toBeInstanceOf(Error);
    expect(isAppError(error)).toBe(true);
    expect(error.code).toBe('boom');
    expect(error.status).toBe(500);
    expect(error.upstreamStatus).toBeNull();
    expect(error.retryAfter).toBeNull();
  });

  it('isAppError 对普通错误返回 false', () => {
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError({ isAppError: true, status: 400, code: 'x', message: 'y' })).toBe(true);
  });

  it('工厂状态码符合契约', () => {
    expect(invalidRequest()).toMatchObject({ code: 'invalid_request', status: 400 });
    expect(missingApiKey()).toMatchObject({ code: 'missing_api_key', status: 401 });
    expect(invalidApiKey()).toMatchObject({ code: 'invalid_api_key', status: 401 });
    expect(accessDenied()).toMatchObject({ code: 'access_denied', status: 403 });
    expect(insufficientBalance()).toMatchObject({ code: 'insufficient_balance', status: 402 });
    expect(fetchForbidden()).toMatchObject({ code: 'fetch_forbidden', status: 403 });
    expect(fetchUnavailable()).toMatchObject({ code: 'fetch_unavailable', status: 404 });
    expect(rateLimited(2)).toMatchObject({ code: 'rate_limited', status: 429, retryAfter: 2 });
    expect(upstreamError(503)).toMatchObject({ code: 'upstream_error', status: 502, upstreamStatus: 503 });
    expect(upstreamTimeout()).toMatchObject({ code: 'upstream_timeout', status: 504 });
    expect(upstreamUnreachable()).toMatchObject({ code: 'upstream_unreachable', status: 502 });
    expect(notFound()).toMatchObject({ code: 'not_found', status: 404 });
    expect(internal()).toMatchObject({ code: 'internal_error', status: 500 });
    expect(clientAborted()).toMatchObject({ code: 'client_aborted', status: 499 });
  });

  it('中文文案', () => {
    expect(missingApiKey().message).toContain('API Key');
    expect(insufficientBalance().message).toBe('DeepSeek 账户余额不足');
    expect(fetchForbidden().message).toBe('该网页被目标站点或安全策略拒绝');
    expect(fetchUnavailable().message).toBe('无法抓取该网页正文');
  });
});

describe('mapUpstreamError（契约 §3）', () => {
  it('400 → 400 invalid_request 并透传上游 message', () => {
    const error = mapUpstreamError(400, { error: { message: 'query is too long', type: 'invalid_request_error' } });
    expect(error).toMatchObject({ code: 'invalid_request', status: 400, upstreamStatus: 400 });
    expect(error.message).toBe('query is too long');
  });

  it('400 无上游 message 时使用中文默认文案', () => {
    const error = mapUpstreamError(400, null);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toMatch(/[\u4e00-\u9fa5]/);
  });

  it('401 → 401 invalid_api_key', () => {
    const error = mapUpstreamError(401, { error: { message: 'invalid key' } });
    expect(error).toMatchObject({ code: 'invalid_api_key', status: 401, upstreamStatus: 401 });
  });

  it('402 → 402 insufficient_balance', () => {
    const error = mapUpstreamError(402, { error: { message: 'insufficient balance' } });
    expect(error).toMatchObject({ code: 'insufficient_balance', status: 402, upstreamStatus: 402 });
  });

  it('403/404 仅在 fetch 端点映射为抓取错误', () => {
    const forbidden = mapUpstreamError(403, null, { endpoint: 'fetch' });
    expect(forbidden).toMatchObject({ code: 'fetch_forbidden', status: 403, upstreamStatus: 403 });
    const unavailable = mapUpstreamError(404, null, { endpoint: 'fetch' });
    expect(unavailable).toMatchObject({ code: 'fetch_unavailable', status: 404, upstreamStatus: 404 });

    expect(mapUpstreamError(403, null, { endpoint: 'search' }).code).toBe('upstream_error');
    expect(mapUpstreamError(404, null, { endpoint: 'chat' }).code).toBe('upstream_error');
  });

  it('408 / 5xx → 502 upstream_error', () => {
    for (const status of [408, 500, 502, 503, 504]) {
      const error = mapUpstreamError(status, null);
      expect(error).toMatchObject({ code: 'upstream_error', status: 502, upstreamStatus: status });
      expect(error.message).toBe('DeepSeek 暂时不可用，请稍后重试');
    }
  });

  it('429 → 429 rate_limited 并携带 Retry-After 秒数', () => {
    const error = mapUpstreamError(429, null, { retryAfter: 3 });
    expect(error).toMatchObject({ code: 'rate_limited', status: 429, retryAfter: 3, upstreamStatus: 429 });
    // 没有上游 Retry-After 时至少给 1 秒
    expect(mapUpstreamError(429, null).retryAfter).toBe(1);
  });

  it('其它 4xx 兜底为 invalid_request', () => {
    const error = mapUpstreamError(422, { error: { message: 'unprocessable' } });
    expect(error).toMatchObject({ code: 'invalid_request', status: 400, upstreamStatus: 422 });
    expect(error.message).toBe('unprocessable');
  });
});

describe('响应序列化', () => {
  it('toErrorPayload 输出契约 §0 结构', () => {
    const payload = toErrorPayload(invalidApiKey(undefined, { upstreamStatus: 401 }), 'req-123');
    expect(payload).toEqual({
      error: {
        code: 'invalid_api_key',
        message: 'API Key 无效，请检查后重试',
        requestId: 'req-123',
        upstreamStatus: 401,
      },
    });
  });

  it('非上游错误不包含 upstreamStatus', () => {
    const payload = toErrorPayload(invalidRequest('query 不能为空'), 'req-1');
    expect(payload.error).not.toHaveProperty('upstreamStatus');
    expect(payload.error.code).toBe('invalid_request');
  });

  it('普通 Error 兜底为 internal_error 且不泄漏内部信息', () => {
    const payload = toErrorPayload(new Error('数据库密码是 xxx'), 'req-2');
    expect(payload.error.code).toBe('internal_error');
    expect(payload.error.message).toBe('服务器内部错误');
    expect(JSON.stringify(payload)).not.toContain('数据库');
  });

  it('toSseError 只输出 code/message', () => {
    expect(toSseError(insufficientBalance())).toEqual({
      code: 'insufficient_balance',
      message: 'DeepSeek 账户余额不足',
    });
  });
});
