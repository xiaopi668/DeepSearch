/**
 * 轻量结构化日志
 * ---------------------------------------------------------------------------
 * 要求（契约 §7）：
 *  - Authorization / API Key 一律脱敏为 ***，绝不落盘、绝不打印；
 *  - 不记录请求正文（业务侧只记录 method/path/status/耗时等元数据）；
 *  - 支持级别、requestId、耗时字段。
 *
 * 输出为单行 JSON，便于容器 / journald 收集。
 */

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

/** 字段名命中即整体脱敏 */
const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|api[-_]?key|apikey|key|access[-_]?token|x-access-token|token|secret|password|cookie|set-cookie)$/i;
/** 文本中的 sk- 形态 Key 脱敏 */
const KEY_IN_TEXT = /sk-[A-Za-z0-9_-]{10,200}/g;

/** 文本脱敏：把可能出现的 API Key 替换为 sk-***。 */
export function redactString(value) {
  return String(value).replace(KEY_IN_TEXT, 'sk-***');
}

/** 递归脱敏对象（限制深度与数组长度，避免日志放大）。 */
export function redactValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    const serialized = { name: value.name || 'Error', message: redactString(value.message || '') };
    if (value.code !== undefined) serialized.code = typeof value.code === 'string' ? redactString(value.code) : value.code;
    if (value.stack) serialized.stack = redactString(value.stack);
    return serialized;
  }
  if (depth >= 5) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '***' : redactValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function defaultSink(line, level) {
  const target = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  target.write(`${line}\n`);
}

/**
 * 创建 logger。
 * @param {{ level?: string, sink?: (line: string, level: string) => void,
 *           bindings?: Record<string, unknown>, now?: () => number }} [options]
 */
export function createLogger(options = {}) {
  const { level = 'info', sink, bindings = {}, now = () => Date.now() } = options;
  return makeLogger(level, sink, { ...bindings }, now);
}

function makeLogger(level, sink, bindings, now) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = sink ?? defaultSink;

  const emit = (lvl, message, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const record = {
      time: new Date(now()).toISOString(),
      level: lvl,
      msg: redactString(String(message ?? '')),
    };
    // 先合并固定绑定（如 requestId），再合并本次字段；敏感字段统一 ***
    for (const [key, value] of Object.entries(bindings)) {
      record[key] = SENSITIVE_KEY.test(key) ? '***' : redactValue(value);
    }
    if (fields && typeof fields === 'object') {
      for (const [key, value] of Object.entries(fields)) {
        record[key] = SENSITIVE_KEY.test(key) ? '***' : redactValue(value);
      }
    }
    let line;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ time: record.time, level: lvl, msg: record.msg, warning: '日志序列化失败' });
    }
    try {
      write(line, lvl);
    } catch {
      // 日志失败绝不影响业务请求
    }
  };

  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    /** 派生带额外固定字段的 logger（如 requestId） */
    child(extra = {}) {
      return makeLogger(level, sink, { ...bindings, ...extra }, now);
    },
  };
}
