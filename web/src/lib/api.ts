import type {
  FetchResponse,
  HealthResponse,
  SearchResponse,
  SearchResult,
  ValidateKeyResponse,
} from './types';
import { clamp, isRecord, readNullableString, readNumber, readString } from './utils';

export const API_BASE = '/api';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly upstreamStatus: number | null;
  readonly retryAfter: number | null;

  constructor(
    code: string,
    status: number,
    message: string,
    requestId: string | null = null,
    upstreamStatus: number | null = null,
    retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.upstreamStatus = upstreamStatus;
    this.retryAfter = retryAfter;
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (isAbortError(error)) return new ApiError('aborted', 0, '请求已取消');
  if (error instanceof TypeError) {
    return new ApiError('network_error', 0, '无法连接本站服务，请确认服务已启动或稍后重试。');
  }
  return new ApiError(
    'unknown_error',
    0,
    error instanceof Error && error.message ? error.message : '发生未知错误，请稍后重试。',
  );
}

function defaultMessageForStatus(status: number): string {
  if (status === 400) return '请求参数不合法。';
  if (status === 401) return 'API Key 无效或未设置。';
  if (status === 402) return 'DeepSeek 账户余额不足。';
  if (status === 403) return '当前请求被拒绝。';
  if (status === 404) return '请求的内容不存在。';
  if (status === 429) return '请求过于频繁，请稍后重试。';
  if (status >= 500) return '本站服务暂时不可用，请稍后重试。';
  return `请求失败（HTTP ${status}）。`;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

interface ErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
    upstreamStatus?: unknown;
  };
}

/** 把非 2xx 响应转成 ApiError；供 JSON 接口与 SSE 接口共用。 */
export async function readApiErrorResponse(response: Response): Promise<ApiError> {
  const headerRequestId = response.headers.get('x-request-id');
  let envelope: ErrorEnvelope | null = null;
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    envelope = null;
  }
  const body = envelope && isRecord(envelope.error) ? envelope.error : null;
  const code = body && typeof body.code === 'string' && body.code ? body.code : `http_${response.status}`;
  const message =
    body && typeof body.message === 'string' && body.message
      ? body.message
      : defaultMessageForStatus(response.status);
  const requestId =
    body && typeof body.requestId === 'string' && body.requestId ? body.requestId : headerRequestId;
  const upstreamStatus =
    body && typeof body.upstreamStatus === 'number' ? body.upstreamStatus : null;
  return new ApiError(
    code,
    response.status,
    message,
    requestId,
    upstreamStatus,
    parseRetryAfter(response.headers.get('retry-after')),
  );
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  apiKey?: string;
  accessToken?: string;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  if (options.accessToken) headers['X-Access-Token'] = options.accessToken;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw toApiError(error);
  }

  if (!response.ok) throw await readApiErrorResponse(response);

  try {
    return (await response.json()) as T;
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError(
      'invalid_response',
      response.status,
      '服务返回了无法解析的数据，请稍后重试。',
      response.headers.get('x-request-id'),
    );
  }
}

function normalizeHealth(raw: unknown): HealthResponse {
  const record = isRecord(raw) ? raw : {};
  const features = isRecord(record.features) ? record.features : {};
  const auth = isRecord(record.auth) ? record.auth : {};
  const limits = isRecord(record.limits) ? record.limits : {};
  const count = isRecord(limits.count) ? limits.count : {};
  return {
    ok: record.ok === true,
    name: readString(record, 'name', 'deepsearch'),
    version: readString(record, 'version', ''),
    // 缺省视为可用；仅当服务端显式声明 false 时禁用。
    features: {
      search: features.search !== false,
      fetch: features.fetch !== false,
      ai: features.ai !== false,
    },
    auth: { accessTokenRequired: auth.accessTokenRequired === true },
    limits: {
      count: {
        min: clamp(readNumber(count, 'min', 1), 1, 50),
        max: clamp(readNumber(count, 'max', 50), 1, 50),
        default: clamp(readNumber(count, 'default', 10), 1, 50),
      },
    },
    upstream: readString(record, 'upstream', ''),
  };
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return normalizeHealth(await request<unknown>('/health', { signal }));
}

function normalizeModel(value: unknown): { id: string; name: string | null; contextWindow: number | null } | null {
  const record = isRecord(value) ? value : {};
  const id = readString(record, 'id');
  if (!id) return null;
  return {
    id,
    name: readNullableString(record, 'name'),
    contextWindow: typeof record.contextWindow === 'number' ? record.contextWindow : null,
  };
}

export async function validateApiKey(options: {
  apiKey: string;
  accessToken?: string;
  signal?: AbortSignal;
}): Promise<ValidateKeyResponse> {
  const raw = await request<unknown>('/validate-key', {
    method: 'POST',
    body: {},
    apiKey: options.apiKey,
    accessToken: options.accessToken,
    signal: options.signal,
  });
  const record = isRecord(raw) ? raw : {};
  const models = Array.isArray(record.models)
    ? record.models.map(normalizeModel).filter((model): model is NonNullable<typeof model> => model !== null)
    : [];
  return { ok: record.ok !== false, models };
}

function normalizeSearchResult(value: unknown): SearchResult | null {
  const record = isRecord(value) ? value : {};
  const url = readString(record, 'url');
  if (!url) return null;
  const title = readString(record, 'title', url);
  return {
    title: title || url,
    url,
    snippet: readString(record, 'snippet'),
    summary: readString(record, 'summary'),
    content: readString(record, 'content'),
    siteName: readNullableString(record, 'siteName'),
    siteIcon: readNullableString(record, 'siteIcon'),
    date: readNullableString(record, 'date'),
    authority: clamp(readNumber(record, 'authority', 0), -1, 4),
    rerankScore: readNumber(record, 'rerankScore', 0),
  };
}

function normalizeSearchResponse(raw: unknown, fallbackQuery: string, fallbackCount: number): SearchResponse {
  const record = isRecord(raw) ? raw : {};
  const resultsRaw = Array.isArray(record.results) ? record.results : [];
  const results = resultsRaw
    .map(normalizeSearchResult)
    .filter((result): result is SearchResult => result !== null);
  const metaRaw = isRecord(record.meta) ? record.meta : {};
  return {
    results,
    meta: {
      query: readString(metaRaw, 'query', fallbackQuery),
      count: readNumber(metaRaw, 'count', results.length || fallbackCount),
      tookMs: readNumber(metaRaw, 'tookMs', 0),
    },
  };
}

export async function searchWeb(options: {
  query: string;
  count: number;
  apiKey: string;
  accessToken?: string;
  signal?: AbortSignal;
}): Promise<SearchResponse> {
  const raw = await request<unknown>('/search', {
    method: 'POST',
    body: {
      query: options.query,
      count: options.count,
      needContent: false,
      oriQuestion: null,
      localization: null,
    },
    apiKey: options.apiKey,
    accessToken: options.accessToken,
    signal: options.signal,
  });
  return normalizeSearchResponse(raw, options.query, options.count);
}

export async function fetchPageContent(options: {
  url: string;
  apiKey: string;
  accessToken?: string;
  signal?: AbortSignal;
}): Promise<FetchResponse> {
  const raw = await request<unknown>('/fetch', {
    method: 'POST',
    body: { url: options.url },
    apiKey: options.apiKey,
    accessToken: options.accessToken,
    signal: options.signal,
  });
  const record = isRecord(raw) ? raw : {};
  return {
    url: readString(record, 'url', options.url),
    title: readString(record, 'title'),
    content: readString(record, 'content'),
    fetchedAt: readString(record, 'fetchedAt', new Date().toISOString()),
  };
}
