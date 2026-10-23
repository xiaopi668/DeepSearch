/**
 * 统一错误模型与上游错误映射
 * ---------------------------------------------------------------------------
 * 所有对用户可见的错误都以 AppError 表示，错误响应结构遵循契约 §0：
 *   { error: { code, message, requestId, upstreamStatus? } }
 * `upstreamStatus` 仅当错误来自 DeepSeek 上游时出现。
 * 前端按 code 分支，message 仅用于展示。
 */

/** 业务错误：携带 HTTP 状态码、错误码、可选上游状态码与 Retry-After。 */
export class AppError extends Error {
  /**
   * @param {string} code 稳定错误码（前端按此分支）
   * @param {string} message 中文用户文案
   * @param {{ status?: number, upstreamStatus?: number|null, retryAfter?: number|null,
   *           expose?: boolean, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    const { status = 500, upstreamStatus = null, retryAfter = null, expose = true, cause } = options;
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
    this.retryAfter = retryAfter;
    this.expose = expose;
    this.isAppError = true;
  }
}

export function isAppError(value) {
  return value instanceof AppError || Boolean(value && value.isAppError === true);
}

/* ------------------------------------------------------------------------- */
/* 错误工厂                                                                   */
/* ------------------------------------------------------------------------- */

/** 400 请求参数不合法（可透传上游 message） */
export function invalidRequest(message = '请求参数不合法', options = {}) {
  return new AppError('invalid_request', message, { status: 400, ...options });
}

/** 401 缺少 API Key */
export function missingApiKey(message = '缺少 API Key，请先在设置中填写 DeepSeek API Key') {
  return new AppError('missing_api_key', message, { status: 401 });
}

/** 401 Key 无效（格式错误或上游判定无效） */
export function invalidApiKey(message = 'API Key 无效，请检查后重试', options = {}) {
  return new AppError('invalid_api_key', message, { status: 401, ...options });
}

/** 403 站点访问口令缺失或错误 */
export function accessDenied(message = '访问口令错误或缺失，请重新输入') {
  return new AppError('access_denied', message, { status: 403 });
}

/** 402 上游账户余额不足 */
export function insufficientBalance(message = 'DeepSeek 账户余额不足', options = {}) {
  return new AppError('insufficient_balance', message, { status: 402, ...options });
}

/** 403 目标网页拒绝抓取（fetch 专用） */
export function fetchForbidden(message = '该网页被目标站点或安全策略拒绝', options = {}) {
  return new AppError('fetch_forbidden', message, { status: 403, ...options });
}

/** 404 目标网页不可抓取（fetch 专用） */
export function fetchUnavailable(message = '无法抓取该网页正文', options = {}) {
  return new AppError('fetch_unavailable', message, { status: 404, ...options });
}

/** 429 限流（本服务或上游） */
export function rateLimited(retryAfter = 1, message = '请求太频繁，请稍后再试') {
  return new AppError('rate_limited', message, { status: 429, retryAfter });
}

/** 502 DeepSeek 返回 408/5xx 等暂时性错误 */
export function upstreamError(upstreamStatus = null, message = 'DeepSeek 暂时不可用，请稍后重试') {
  return new AppError('upstream_error', message, { status: 502, upstreamStatus: upstreamStatus ?? null });
}

/** 504 上游超时 */
export function upstreamTimeout(message = '上游请求超时，请稍后重试') {
  return new AppError('upstream_timeout', message, { status: 504 });
}

/** 502 无法连接上游（DNS/网络错误） */
export function upstreamUnreachable(message = '无法连接 DeepSeek，请检查网络后重试', options = {}) {
  return new AppError('upstream_unreachable', message, { status: 502, ...options });
}

/** 客户端主动断开（内部使用，不返回响应体） */
export function clientAborted(message = '客户端已断开') {
  return new AppError('client_aborted', message, { status: 499, expose: false });
}

/** 404 接口不存在 */
export function notFound(message = '接口不存在') {
  return new AppError('not_found', message, { status: 404 });
}

/** 500 服务器内部错误（不泄漏内部细节） */
export function internal(message = '服务器内部错误') {
  return new AppError('internal_error', message, { status: 500, expose: true });
}

/* ------------------------------------------------------------------------- */
/* 上游错误映射（契约 §3）                                                    */
/* ------------------------------------------------------------------------- */

/** 从上游响应体中提取可选 message（仅用于 400 透传）。 */
function upstreamMessageOf(body) {
  if (!body || typeof body !== 'object') return '';
  const candidates = [body?.error?.message, body?.message];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return '';
}

/**
 * 把上游 HTTP 错误映射成本服务的 AppError。
 * @param {number} status 上游 HTTP 状态码
 * @param {unknown} body 上游 JSON 响应体（可能为 null）
 * @param {{ endpoint?: 'search'|'fetch'|'chat'|'models'|'generic',
 *           retryAfter?: number|null }} [options]
 *        retryAfter：上游 Retry-After（秒），用于 429 响应
 */
export function mapUpstreamError(status, body, options = {}) {
  const { endpoint = 'generic', retryAfter = null } = options;
  const passthrough = upstreamMessageOf(body);

  if (status === 400) {
    // §3：400 → 400 invalid_request，透传上游 message
    return invalidRequest(passthrough || '请求参数不合法', { upstreamStatus: 400 });
  }
  if (status === 401) {
    return invalidApiKey(undefined, { upstreamStatus: 401 });
  }
  if (status === 402) {
    return insufficientBalance(undefined, { upstreamStatus: 402 });
  }
  if (status === 403) {
    if (endpoint === 'fetch') return fetchForbidden(undefined, { upstreamStatus: 403 });
    return upstreamError(403);
  }
  if (status === 404) {
    if (endpoint === 'fetch') return fetchUnavailable(undefined, { upstreamStatus: 404 });
    return upstreamError(404);
  }
  if (status === 408 || status >= 500) {
    return upstreamError(status);
  }
  if (status === 429) {
    const error = rateLimited(retryAfter ?? 1);
    error.upstreamStatus = 429;
    return error;
  }
  // 其它 4xx：按参数错误处理，保证前端有可展示的中文 message
  if (status >= 400 && status < 500) {
    return invalidRequest(passthrough || '请求参数不合法', { upstreamStatus: status });
  }
  return upstreamError(status);
}

/* ------------------------------------------------------------------------- */
/* 响应序列化                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * 生成契约 §0 的错误响应体。
 * @param {unknown} error
 * @param {string|null} requestId
 */
export function toErrorPayload(error, requestId = null) {
  const err = isAppError(error) ? error : internal();
  const payload = {
    error: {
      code: err.code || 'internal_error',
      message: err.message || '服务器内部错误',
      requestId: requestId ?? null,
    },
  };
  if (err.upstreamStatus !== null && err.upstreamStatus !== undefined) {
    payload.error.upstreamStatus = err.upstreamStatus;
  }
  return payload;
}

/**
 * SSE 流内错误事件数据（契约 §2：event: error, data: {code, message}）。
 * @param {unknown} error
 */
export function toSseError(error) {
  const err = isAppError(error) ? error : internal();
  return { code: err.code || 'internal_error', message: err.message || '服务器内部错误' };
}
