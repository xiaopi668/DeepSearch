/**
 * Express 应用装配（契约 §0 / §1 / §2 / §5 / §7）
 * ---------------------------------------------------------------------------
 * 中间件顺序：
 *   请求 ID / 安全头 / no-store → 压缩（排除 SSE）→ /api/health
 *   → 可选 ACCESS_TOKEN 门 → JSON body 解析
 *   → /api/validate-key、/api/search、/api/fetch、/api/summarize(SSE)
 *   → /api 404 → 静态托管 + SPA 回退（未构建时 503）→ 统一错误处理
 *
 * 访客 API Key 只在请求生命周期内存在（req.apiKey），不写日志、不落盘、不缓存。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import compression from 'compression';
import express from 'express';

import { COUNT_LIMIT } from './config.mjs';
import { DeepSeekClient } from './deepseek.mjs';
import {
  AppError,
  accessDenied,
  clientAborted,
  internal,
  invalidRequest,
  isAppError,
  notFound,
  rateLimited,
  toErrorPayload,
  toSseError,
} from './errors.mjs';
import { createLogger } from './logger.mjs';
import { buildSummarizeMessages } from './prompt.mjs';
import { createRateLimiters } from './rate-limit.mjs';
import {
  extractApiKey,
  validateFetchBody,
  validateSearchBody,
  validateSummarizeBody,
} from './validation.mjs';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 生产环境静态资源目录：<项目根>/dist/web */
export const DEFAULT_STATIC_DIR = path.resolve(SERVER_DIR, '..', 'dist', 'web');

/** 基础 CSP（契约 §7） */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const NOT_BUILT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeepSearch 尚未构建</title>
  <style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:42rem;margin:12vh auto;padding:0 1.5rem;line-height:1.7;color:#1f2328}h1{font-size:1.5rem}a{color:#0969da}</style>
</head>
<body>
  <h1>DeepSearch 前端尚未构建</h1>
  <p>服务端已经启动，但未找到 <code>dist/web</code> 静态资源。</p>
  <p>请在项目根目录执行 <code>pnpm build</code> 生成前端产物后刷新本页。</p>
  <p>API 不受影响：<a href="/api/health">/api/health</a></p>
</body>
</html>`;

function isApiPath(req) {
  return req.path === '/api' || req.path.startsWith('/api/');
}

/** 定长比较，避免通过响应时间猜测访问口令。 */
function constantTimeEqual(provided, expected) {
  const left = crypto.createHash('sha256').update(String(provided ?? '')).digest();
  const right = crypto.createHash('sha256').update(String(expected ?? '')).digest();
  return crypto.timingSafeEqual(left, right);
}

function buildHealthPayload(config) {
  return {
    ok: true,
    name: config.name,
    version: config.version,
    features: { search: true, fetch: true, ai: true },
    auth: { accessTokenRequired: Boolean(config.accessToken) },
    limits: { count: { min: COUNT_LIMIT.min, max: COUNT_LIMIT.max, default: COUNT_LIMIT.default } },
    upstream: config.deepseekBaseUrl,
  };
}

function normalizeUsage(value) {
  const source = value && typeof value === 'object' ? value : {};
  const promptTokens = Number.isFinite(source.promptTokens) ? source.promptTokens : 0;
  const completionTokens = Number.isFinite(source.completionTokens) ? source.completionTokens : 0;
  const totalTokens = Number.isFinite(source.totalTokens) ? source.totalTokens : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/** 把 body-parser / Express 抛出的原始错误归一化为 AppError。 */
function normalizeError(error) {
  if (isAppError(error)) return error;
  const type = error?.type;
  if (type === 'entity.parse.failed') return invalidRequest('请求体不是合法的 JSON');
  if (type === 'entity.too.large') {
    return new AppError('invalid_request', '请求体超过大小限制', { status: 413 });
  }
  if (type === 'request.aborted') return clientAborted();
  if (error?.status === 415) return invalidRequest('Content-Type 不受支持，请使用 application/json');
  return internal();
}

/**
 * 创建 Express 应用。
 * @param {{ config: object, client?: object, logger?: object, staticDir?: string,
 *           fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>,
 *           random?: () => number }} options
 */
export function createApp(options = {}) {
  const { config } = options;
  if (!config) throw new Error('createApp 需要 config');

  const logger = options.logger ?? createLogger({ level: config.logLevel });
  const client =
    options.client ??
    new DeepSeekClient({
      config,
      logger,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      random: options.random,
    });
  const staticDir = options.staticDir ?? DEFAULT_STATIC_DIR;
  const limiters = options.limiters ?? createRateLimiters(config);

  const indexHtmlPath = path.join(staticDir, 'index.html');
  const staticReady = fs.existsSync(indexHtmlPath);

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);

  /* ----------------------------- 基础中间件 ----------------------------- */

  // 1) 请求 ID + 访问日志（不记录请求正文 / 查询串 / Key）
  app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    req.id = requestId;
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    req.log = typeof logger.child === 'function' ? logger.child({ requestId }) : logger;
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const fields = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(elapsedMs * 10) / 10,
      };
      const level = req.path === '/api/health' || !isApiPath(req) ? 'debug' : 'info';
      req.log?.[level]?.('http_request', fields);
    });
    next();
  });

  // 2) 安全响应头（契约 §7：API 与静态响应都带）
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    next();
  });

  // 3) API 响应禁止缓存（契约 §7）
  app.use((req, res, next) => {
    if (isApiPath(req)) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // 4) gzip/br 压缩；SSE 必须跳过，否则会破坏流式与心跳
  app.use(
    compression({
      filter(req, res) {
        // Express 5 默认匹配尾斜杠，SSE 路径要归一化后再判断，避免被 gzip 缓冲
        if (req.path.replace(/\/+$/, '') === '/api/summarize') return false;
        return compression.filter(req, res);
      },
    }),
  );

  /* --------------------------- 健康检查（无鉴权） ------------------------ */

  app.get('/api/health', (req, res) => {
    res.status(200).json(buildHealthPayload(config));
  });

  /* --------------------------- 可选访问口令门 --------------------------- */

  app.use((req, res, next) => {
    if (!config.accessToken) return next();
    // 未配置口令时完全关闭；/api/health 永远豁免
    if (!isApiPath(req) || req.path === '/api/health') return next();
    const provided = req.get('x-access-token') ?? '';
    if (!constantTimeEqual(provided, config.accessToken)) return next(accessDenied());
    next();
  });

  /* ------------------------------ body 解析 ----------------------------- */

  app.use(express.json({ limit: config.maxBodyBytes }));

  /* ------------------------------- 鉴权/限流 ---------------------------- */

  function requireApiKey(req, res, next) {
    try {
      req.apiKey = extractApiKey(req.get('authorization'));
      next();
    } catch (error) {
      next(error);
    }
  }

  function rateLimitGuard(kind) {
    const limiter = limiters[kind];
    return (req, res, next) => {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      const result = limiter.hit(ip);
      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      if (!result.allowed) return next(rateLimited(result.retryAfter));
      next();
    };
  }

  /** 客户端断开时中止上游请求（针对普通 JSON 端点）。 */
  function upstreamSignal(res) {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    return controller.signal;
  }

  /* ------------------------------- 业务端点 ----------------------------- */

  // POST /api/validate-key：校验访客 Key（上游 GET /models）
  app.post('/api/validate-key', requireApiKey, rateLimitGuard('search'), async (req, res) => {
    const { models } = await client.validateKey(req.apiKey, { signal: upstreamSignal(res) });
    res.status(200).json({ ok: true, models });
  });

  // POST /api/search：上游 POST /v1/tools/search
  app.post('/api/search', requireApiKey, rateLimitGuard('search'), async (req, res) => {
    const params = validateSearchBody(req.body);
    const { results, tookMs } = await client.search(req.apiKey, params, { signal: upstreamSignal(res) });
    res.status(200).json({
      results,
      meta: {
        query: params.query,
        count: results.length,
        tookMs: Math.max(0, Math.round(tookMs)),
      },
    });
  });

  // POST /api/fetch：上游 POST /v1/tools/fetch
  app.post('/api/fetch', requireApiKey, rateLimitGuard('fetch'), async (req, res) => {
    const { url } = validateFetchBody(req.body);
    const { title, content } = await client.fetchPage(req.apiKey, url, { signal: upstreamSignal(res) });
    res.status(200).json({ url, title, content, fetchedAt: new Date().toISOString() });
  });

  // POST /api/summarize：SSE 流式输出（契约 §2 / §6）
  app.post('/api/summarize', requireApiKey, rateLimitGuard('ai'), async (req, res, next) => {
    // 校验失败时还没发送 SSE 头，仍返回普通 JSON 400
    let params;
    try {
      params = validateSummarizeBody(req.body);
    } catch (error) {
      return next(error);
    }

    const { messages } = buildSummarizeMessages({ query: params.query, results: params.results });

    // 校验通过后立刻返回 200（契约要求），上游首包慢不影响前端拿到响应
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const controller = new AbortController();
    let clientGone = false;
    const onClose = () => {
      if (res.writableEnded) return;
      clientGone = true;
      controller.abort(); // 客户端断开 → 立刻中止上游请求
    };
    // 注：使用 res 的 close 事件判断连接断开；req 的 close 在请求体读完时就可能触发
    res.on('close', onClose);

    const send = (event, data) => {
      if (clientGone || res.writableEnded || res.destroyed) return false;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch {
        return false;
      }
    };

    // 每 15 秒注释心跳，防止中间代理断流
    const heartbeat = setInterval(() => {
      if (clientGone || res.writableEnded || res.destroyed) return;
      try {
        res.write(': ping\n\n');
      } catch {
        // 连接已断开，关闭逻辑会处理
      }
    }, config.sseHeartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    let usage = null;
    let doneSent = false;

    try {
      send('meta', { model: params.model, requestId: req.id });
      for await (const item of client.chatStream(req.apiKey, {
        messages,
        model: params.model,
        thinking: params.thinking,
        signal: controller.signal,
      })) {
        if (clientGone) break;
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'reasoning') {
          send('reasoning', { text: String(item.text ?? '') });
        } else if (item.type === 'delta') {
          send('delta', { text: String(item.text ?? '') });
        } else if (item.type === 'usage') {
          usage = normalizeUsage(item.usage ?? item.data ?? item);
        } else if (item.type === 'done') {
          if (!doneSent) {
            if (usage) send('usage', usage);
            send('done', { finishReason: item.finishReason || 'stop' });
            doneSent = true;
          }
        }
      }
      // 上游正常结束但没给 done（例如实现差异）：补齐事件序列
      if (!clientGone && !doneSent) {
        if (usage) send('usage', usage);
        send('done', { finishReason: 'stop' });
      }
    } catch (error) {
      if (!clientGone) {
        const appError = isAppError(error) ? error : internal('AI 总结生成失败');
        if (appError.code === 'client_aborted') {
          clientGone = true;
        } else {
          // 中断只能以 error 事件收尾（契约 §2）
          send('error', toSseError(appError));
          req.log?.warn?.('AI 总结流式输出中断', { code: appError.code, upstreamStatus: appError.upstreamStatus });
        }
      }
    } finally {
      clearInterval(heartbeat);
      res.removeListener('close', onClose);
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          // 连接已断开
        }
      }
    }
  });

  /* ------------------------------ 静态资源 ------------------------------ */

  // /api 下未匹配的路径统一返回 404 JSON
  app.use('/api', (req, res, next) => next(notFound()));

  if (staticReady) {
    app.use(express.static(staticDir, { index: false, fallthrough: true }));
  }

  // 非 /api 的 GET/HEAD → SPA 回退；未构建时返回 503 说明页
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (isApiPath(req)) return next();
    if (staticReady) {
      return res.sendFile(indexHtmlPath, (error) => {
        if (error) next(error);
      });
    }
    res.status(503).type('html').send(NOT_BUILT_HTML);
  });

  // 其余未匹配路径
  app.use((req, res, next) => next(notFound()));

  /* ------------------------------ 错误处理 ------------------------------ */

  app.use((error, req, res, _next) => {
    if (res.headersSent) {
      // SSE 等已开始响应：只能结束连接
      if (!res.writableEnded) res.end();
      return;
    }
    const appError = normalizeError(error);

    if (appError.code === 'client_aborted') {
      req.log?.debug?.('客户端已断开，终止请求', {});
      if (!res.writableEnded) res.end();
      return;
    }

    if (appError.retryAfter !== null && appError.retryAfter !== undefined) {
      res.setHeader('Retry-After', String(appError.retryAfter));
    }
    const status = appError.status >= 400 && appError.status <= 599 ? appError.status : 500;
    const payload = toErrorPayload(appError, req.id ?? null);
    if (status >= 500) {
      req.log?.error?.('请求处理失败', {
        code: appError.code,
        status,
        upstreamStatus: appError.upstreamStatus,
        error,
      });
    } else {
      req.log?.warn?.('请求被拒绝', {
        code: appError.code,
        status,
        upstreamStatus: appError.upstreamStatus,
      });
    }
    res.status(status).json(payload);
  });

  // 暴露内部对象，便于启动入口优雅退出与测试检查
  app.locals.config = config;
  app.locals.client = client;
  app.locals.logger = logger;
  app.locals.limiters = limiters;
  app.locals.staticDir = staticDir;
  app.locals.staticReady = staticReady;
  return app;
}
