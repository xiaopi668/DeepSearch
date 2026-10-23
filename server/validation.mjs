/**
 * 请求参数校验（契约 §1 / §2）
 * ---------------------------------------------------------------------------
 * 所有校验失败都抛出 400 invalid_request / 401 missing_api_key / 401 invalid_api_key，
 * message 为面向用户的中文文案。
 * Unicode 长度（query / 各类文本）统一按「码点」计数（Array.from），而不是 UTF-16 长度。
 */
import {
  API_KEY_PATTERN,
  COUNT_LIMIT,
  SUMMARIZE_LIMITS,
  SUPPORTED_MODELS,
  DEFAULT_MODEL,
} from './config.mjs';
import { invalidApiKey, invalidRequest, missingApiKey } from './errors.mjs';

/** 按 Unicode 码点计数（emoji 等代理对算 1 个字符）。 */
export function countCodePoints(text) {
  return Array.from(String(text ?? '')).length;
}

/** 按码点截断到 max 个字符（不破坏代理对）。 */
export function truncateCodePoints(text, max) {
  if (typeof text !== 'string') return '';
  if (max <= 0) return '';
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

/** 是否空白（含全角空格等 Unicode 空白）。 */
export function isBlank(text) {
  return typeof text !== 'string' || text.trim().length === 0;
}

/** 确保请求体是普通 JSON 对象。 */
export function ensurePlainObject(body, label = '请求体') {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest(`${label}必须是 JSON 对象`);
  }
  return body;
}

/* ------------------------------------------------------------------------- */
/* Key 校验（契约 §1）                                                        */
/* ------------------------------------------------------------------------- */

/**
 * 从 Authorization 头提取并校验访客 API Key。
 * 缺 Key → 401 missing_api_key；格式非法 → 401 invalid_api_key（不发起上游请求）。
 * @param {string|undefined} authorizationHeader
 * @returns {string} 合法 Key
 */
export function extractApiKey(authorizationHeader) {
  const raw = typeof authorizationHeader === 'string' ? authorizationHeader.trim() : '';
  if (!raw) throw missingApiKey();

  const matched = /^Bearer[ \t]+(.+)$/i.exec(raw);
  if (!matched) {
    // "Bearer" 后没有携带任何内容：按缺少 Key 处理
    if (/^Bearer[ \t]*$/i.test(raw)) throw missingApiKey();
    throw invalidApiKey('Authorization 头格式应为 Bearer <DeepSeek API Key>');
  }
  const key = matched[1].trim();
  if (!key) throw missingApiKey();
  if (!API_KEY_PATTERN.test(key)) throw invalidApiKey('API Key 格式不正确，应以 sk- 开头');

  return key;
}

/* ------------------------------------------------------------------------- */
/* 通用文本字段                                                               */
/* ------------------------------------------------------------------------- */

/**
 * 校验必填字符串字段（默认 query）：1–128 码点、不能全空白。
 * 返回去除首尾空白后的文本（保留 site: / lang: 等操作符原文）。
 */
export function validateQuery(value, { field = 'query', max = 128, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw invalidRequest(`${field} 不能为空`);
    return null;
  }
  if (typeof value !== 'string') throw invalidRequest(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) throw invalidRequest(`${field} 不能为空`);
  if (countCodePoints(trimmed) > max) throw invalidRequest(`${field} 长度不能超过 ${max} 个字符`);
  return trimmed;
}

/** 校验 1–128 码点的可选文本字段；空串 / null 归一化为 null。 */
function validateOptionalText(value, field, max = 128) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidRequest(`${field} 必须是字符串或 null`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (countCodePoints(trimmed) > max) throw invalidRequest(`${field} 长度不能超过 ${max} 个字符`);
  return trimmed;
}

/* ------------------------------------------------------------------------- */
/* POST /api/search（契约 §2）                                                */
/* ------------------------------------------------------------------------- */

/**
 * @param {unknown} body
 * @returns {{ query: string, count: number, needContent: boolean,
 *             oriQuestion: string|null, localization: string|null }}
 */
export function validateSearchBody(body) {
  const input = ensurePlainObject(body);

  const query = validateQuery(input.query);

  let count = COUNT_LIMIT.default;
  if (input.count !== undefined && input.count !== null) {
    if (!Number.isInteger(input.count) || input.count < COUNT_LIMIT.min || input.count > COUNT_LIMIT.max) {
      throw invalidRequest(`count 必须是 ${COUNT_LIMIT.min}–${COUNT_LIMIT.max} 之间的整数`);
    }
    count = input.count;
  }

  let needContent = false;
  if (input.needContent !== undefined && input.needContent !== null) {
    if (typeof input.needContent !== 'boolean') throw invalidRequest('needContent 必须是布尔值');
    needContent = input.needContent;
  }

  const oriQuestion = validateOptionalText(input.oriQuestion, 'oriQuestion', 128);
  const localization = validateOptionalText(input.localization, 'localization', 128);

  return { query, count, needContent, oriQuestion, localization };
}

/* ------------------------------------------------------------------------- */
/* POST /api/fetch（契约 §2）                                                 */
/* ------------------------------------------------------------------------- */

/**
 * 校验抓取 URL：http/https、含 host、长度 ≤ 8192、不能含用户名/密码。
 * @param {unknown} body
 * @returns {{ url: string }}
 */
export function validateFetchBody(body) {
  const input = ensurePlainObject(body);
  const value = input.url;
  if (typeof value !== 'string') throw invalidRequest('url 必须是字符串');
  const url = value.trim();
  if (!url) throw invalidRequest('url 不能为空');
  if (countCodePoints(url) > 8192) throw invalidRequest('url 长度不能超过 8192 个字符');

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidRequest('url 不是合法的 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidRequest('url 只支持 http/https 协议');
  }
  if (!parsed.hostname) throw invalidRequest('url 缺少 host');
  if (parsed.username || parsed.password) throw invalidRequest('url 不能包含用户名或密码');

  // 原样返回（保留查询参数等原文），上游抓取的就是用户看到的链接
  return { url };
}

/* ------------------------------------------------------------------------- */
/* POST /api/summarize（契约 §2 / §6）                                        */
/* ------------------------------------------------------------------------- */

function clipText(value, field, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalidRequest(`${field} 必须是字符串`);
  return truncateCodePoints(value.trim(), max);
}

/** 单条搜索结果的字段截断规则（契约 §2 表格） */
const RESULT_FIELD_LIMITS = Object.freeze({
  title: 300,
  url: 8192,
  siteName: 120,
  date: 64,
  snippet: 500,
  summary: 2000,
});

function normalizeSummarizeResult(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidRequest(`results[${index}] 必须是对象`);
  }
  const siteName = clipText(raw.siteName, `results[${index}].siteName`, RESULT_FIELD_LIMITS.siteName);
  const date = clipText(raw.date, `results[${index}].date`, RESULT_FIELD_LIMITS.date) || null;
  return {
    title: clipText(raw.title, `results[${index}].title`, RESULT_FIELD_LIMITS.title),
    url: clipText(raw.url, `results[${index}].url`, RESULT_FIELD_LIMITS.url),
    siteName: siteName || null,
    date,
    snippet: clipText(raw.snippet, `results[${index}].snippet`, RESULT_FIELD_LIMITS.snippet),
    summary: clipText(raw.summary, `results[${index}].summary`, RESULT_FIELD_LIMITS.summary),
  };
}

/**
 * @param {unknown} body
 * @returns {{ query: string, results: Array<object>, model: string, thinking: boolean }}
 */
export function validateSummarizeBody(body) {
  const input = ensurePlainObject(body);

  const query = validateQuery(input.query);

  if (!Array.isArray(input.results)) throw invalidRequest('results 必须是数组');
  if (input.results.length < SUMMARIZE_LIMITS.minResults || input.results.length > SUMMARIZE_LIMITS.maxResults) {
    throw invalidRequest(`results 必须包含 ${SUMMARIZE_LIMITS.minResults}–${SUMMARIZE_LIMITS.maxResults} 条搜索结果`);
  }
  const results = input.results.map((item, index) => normalizeSummarizeResult(item, index));

  let model = DEFAULT_MODEL;
  if (input.model !== undefined && input.model !== null) {
    if (typeof input.model !== 'string' || !SUPPORTED_MODELS.includes(input.model)) {
      throw invalidRequest(`model 必须是 ${SUPPORTED_MODELS.join(' 或 ')}`);
    }
    model = input.model;
  }

  let thinking = false;
  if (input.thinking !== undefined && input.thinking !== null) {
    if (typeof input.thinking !== 'boolean') throw invalidRequest('thinking 必须是布尔值');
    thinking = input.thinking;
  }

  return { query, results, model, thinking };
}
