/**
 * 配置加载模块
 * ---------------------------------------------------------------------------
 * 职责：
 *  1. 零依赖解析 .env 文件（不引入 dotenv）；
 *  2. 读取进程环境变量，做类型转换、范围校验与默认值兜底；
 *  3. 导出常量供其它模块复用（限流、路径、模型、重试参数等）。
 *
 * 说明：本服务采用 BYOK（访客自带 Key）模式，配置里永远不包含访客 API Key。
 * 测试可通过 loadConfig(自定义 env 对象) 注入配置，避免依赖真实 process.env。
 */
import fs from 'node:fs';
import path from 'node:path';

export const APP_NAME = 'deepsearch';
export const APP_VERSION = '1.0.0';

/** 搜索条数约束（契约 §2 /api/search） */
export const COUNT_LIMIT = Object.freeze({ min: 1, max: 50, default: 10 });
/** AI 总结约束（契约 §2 /api/summarize、§6） */
export const SUMMARIZE_LIMITS = Object.freeze({
  minResults: 1,
  maxResults: 15,
  maxContextChars: 12000,
  maxTokens: 1200,
});
/** 上游可用的模型 id（契约 §2 /api/summarize） */
export const SUPPORTED_MODELS = Object.freeze(['deepseek-flash', 'deepseek-v4-pro']);
export const DEFAULT_MODEL = 'deepseek-flash';
/** 重试策略（契约 §3）：search/fetch/validate-key 对 408/429/5xx 最多重试 2 次 */
export const DEFAULT_RETRY = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 500,
  secondDelayMs: 1200,
  maxRetryAfterMs: 10000,
});
/** Key 格式（契约 §1） */
export const API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{10,200}$/;
export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

/**
 * 解析 .env 文本，返回键值对象。
 * 支持的语法：注释行、空行、`export KEY=VALUE`、单/双引号、双引号内转义、行尾注释。
 * @param {string} content
 * @returns {Record<string,string>}
 */
export function parseEnvFile(content) {
  /** @type {Record<string,string>} */
  const result = {};
  const lines = String(content ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      // 单遍处理双引号内转义，避免"\\t"被误当成制表符
      const escapes = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
      value = value.slice(1, -1).replace(/\\(["\\nrt])/g, (_match, char) => escapes[char]);
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const commentAt = value.indexOf(' #');
      if (commentAt !== -1) value = value.slice(0, commentAt).trim();
      else if (value.startsWith('#')) value = '';
    }
    result[key] = value;
  }
  return result;
}

/**
 * 若 cwd 下存在 .env 则加载到 env（已存在的环境变量优先，方便容器/系统环境覆盖）。
 * @param {string} cwd
 * @param {Record<string,string|undefined>} env
 * @param {{ file?: string, fsImpl?: Pick<typeof fs,'readFileSync'> }} [options]
 * @returns {Record<string,string>} 从 .env 中读取到的键值（可能为空对象）
 */
export function loadDotEnv(cwd = process.cwd(), env = process.env, options = {}) {
  const { file = '.env', fsImpl = fs } = options;
  const filePath = path.resolve(cwd, file);
  let content;
  try {
    content = fsImpl.readFileSync(filePath, 'utf8');
  } catch {
    // 文件不存在 / 不可读 / 是目录：静默跳过，用默认配置启动
    return {};
  }
  const vars = parseEnvFile(content);
  for (const [key, value] of Object.entries(vars)) {
    if (env[key] === undefined) env[key] = value;
  }
  return vars;
}

/** 解析整数，非法或超范围时回退默认值。 */
export function toInt(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed)) return fallback;
  const int = Math.trunc(parsed);
  if (int < min || int > max) return fallback;
  return int;
}

/**
 * 解析请求体大小，如 1mb / 512kb / 1048576。
 * 返回字节数（整数），非法时回退默认值。
 */
export function parseByteSize(value, fallback = 1024 * 1024) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value);
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return fallback;
  const matched = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/.exec(text);
  if (!matched) return fallback;
  const amount = Number(matched[1]);
  const unit = matched[2] ?? 'b';
  const multipliers = {
    b: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
  };
  const bytes = Math.trunc(amount * multipliers[unit]);
  return bytes > 0 ? bytes : fallback;
}

/** 归一化上游 Base URL：去空白、去尾部斜杠，非法时回退默认值。 */
export function normalizeBaseUrl(value, fallback = 'https://api.deepseek.com') {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

/**
 * 解析反向代理信任设置（TRUST_PROXY）。
 * 空 / 0 / false / off → false（默认不信任，防止伪造 X-Forwarded-For 绕过限流）；
 * 数字 → 信任前 N 跳；其它字符串（如 loopback、10.0.0.0/8）原样交给 express。
 */
export function parseTrustProxy(value) {
  const raw = String(value ?? '').trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === '0' || lower === 'false' || lower === 'off' || lower === 'no') return false;
  if (lower === 'true' || lower === 'on' || lower === 'yes') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** 解析日志级别，非法回退 info。 */
export function parseLogLevel(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return LOG_LEVELS.includes(text) ? text : 'info';
}

/**
 * 从环境变量对象构造服务配置（纯函数，不做 IO，方便测试）。
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} env
 */
export function loadConfig(env = process.env) {
  const e = env ?? {};
  return Object.freeze({
    name: APP_NAME,
    version: APP_VERSION,
    host: String(e.HOST ?? '').trim() || '0.0.0.0',
    port: toInt(e.PORT, 8787, 1, 65535),
    deepseekBaseUrl: normalizeBaseUrl(e.DEEPSEEK_BASE_URL, 'https://api.deepseek.com'),
    searchTimeoutMs: toInt(e.SEARCH_TIMEOUT_MS, 20000, 1, 600000),
    fetchTimeoutMs: toInt(e.FETCH_TIMEOUT_MS, 60000, 1, 600000),
    chatTimeoutMs: toInt(e.CHAT_TIMEOUT_MS, 120000, 1, 1800000),
    maxBodyBytes: parseByteSize(e.MAX_BODY_BYTES, 1024 * 1024),
    rateLimitWindowMs: toInt(e.RATE_LIMIT_WINDOW_MS, 60000, 100, 3600000),
    searchRateLimitMax: toInt(e.SEARCH_RATE_LIMIT_MAX, 90, 1, 1000000),
    fetchRateLimitMax: toInt(e.FETCH_RATE_LIMIT_MAX, 30, 1, 1000000),
    aiRateLimitMax: toInt(e.AI_RATE_LIMIT_MAX, 20, 1, 1000000),
    accessToken: String(e.ACCESS_TOKEN ?? '').trim(),
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    logLevel: parseLogLevel(e.LOG_LEVEL),
    // SSE 心跳间隔（契约 §2 规定 15 秒；测试可注入更小值）
    sseHeartbeatMs: toInt(e.SSE_HEARTBEAT_MS, 15000, 10, 600000),
    retry: DEFAULT_RETRY,
    countLimit: COUNT_LIMIT,
    summarize: SUMMARIZE_LIMITS,
    supportedModels: SUPPORTED_MODELS,
    defaultModel: DEFAULT_MODEL,
  });
}
