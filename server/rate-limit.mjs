/**
 * 按 IP 的滑动窗口限流（契约 §4）
 * ---------------------------------------------------------------------------
 * - search / fetch / ai 三类端点各自独立额度；
 * - 超限返回 429 rate_limited，Retry-After 为剩余秒数；
 * - 定期清理过期 IP，避免内存无限增长；
 * - `/api/health` 不参与限流（在 app.mjs 中不挂 guard）。
 */

/**
 * 创建单个滑动窗口限流器。
 * @param {{ windowMs: number, max: number, now?: () => number,
 *           autoCleanup?: boolean, cleanupIntervalMs?: number }} options
 */
export function createSlidingWindowLimiter(options) {
  const { windowMs, max, now = () => Date.now(), autoCleanup = false } = options;
  if (!(windowMs > 0)) throw new Error('windowMs 必须为正数');
  if (!(max > 0)) throw new Error('max 必须为正数');

  /** @type {Map<string, number[]>} ip -> 命中时间戳（升序） */
  const hits = new Map();
  let cleanupTimer = null;

  /** 清理所有窗口内已无命中的 IP。 */
  function cleanup() {
    const cutoff = now() - windowMs;
    for (const [key, timestamps] of hits) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) hits.delete(key);
    }
  }

  /**
   * 记录一次命中并判断是否放行。
   * @param {string} key 通常是访客 IP
   * @returns {{ allowed: boolean, remaining: number, limit: number, retryAfter: number }}
   */
  function hit(key) {
    const current = now();
    const normalized = String(key ?? 'unknown');
    let timestamps = hits.get(normalized);
    if (!timestamps) {
      timestamps = [];
      hits.set(normalized, timestamps);
    }
    // 移除滑出窗口的历史命中
    const cutoff = current - windowMs;
    let pruned = 0;
    while (pruned < timestamps.length && timestamps[pruned] <= cutoff) pruned += 1;
    if (pruned > 0) timestamps.splice(0, pruned);

    if (timestamps.length >= max) {
      const waitMs = Math.max(0, timestamps[0] + windowMs - current);
      return {
        allowed: false,
        remaining: 0,
        limit: max,
        retryAfter: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    }

    timestamps.push(current);
    return { allowed: true, remaining: max - timestamps.length, limit: max, retryAfter: 0 };
  }

  if (autoCleanup) {
    cleanupTimer = setInterval(cleanup, Math.min(windowMs, 60000));
    // unref：清理定时器不应阻止进程退出
    if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
  }

  return {
    hit,
    cleanup,
    windowMs,
    max,
    /** 当前记录的 IP 数（测试 / 观测用） */
    size: () => hits.size,
    /** 清空全部记录（测试用） */
    reset() {
      hits.clear();
    },
    /** 停止清理定时器并释放记录 */
    dispose() {
      if (cleanupTimer) clearInterval(cleanupTimer);
      cleanupTimer = null;
      hits.clear();
    },
  };
}

/**
 * 依据配置创建三类限流器（search / fetch / ai）。
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 */
export function createRateLimiters(config) {
  const windowMs = config.rateLimitWindowMs;
  return {
    search: createSlidingWindowLimiter({ windowMs, max: config.searchRateLimitMax, autoCleanup: true }),
    fetch: createSlidingWindowLimiter({ windowMs, max: config.fetchRateLimitMax, autoCleanup: true }),
    ai: createSlidingWindowLimiter({ windowMs, max: config.aiRateLimitMax, autoCleanup: true }),
    /** 统一释放（优雅退出时调用） */
    dispose() {
      this.search.dispose();
      this.fetch.dispose();
      this.ai.dispose();
    },
  };
}
