/**
 * 服务启动入口
 * ---------------------------------------------------------------------------
 *  - 加载 .env（若存在）与进程环境变量，构造配置；
 *  - 创建 Express 应用并监听 HOST:PORT；
 *  - 启动日志包含端口、上游地址、是否开启访问口令（绝不打印 Key）；
 *  - SIGTERM/SIGINT 优雅退出：停止接收新请求，5 秒后强制退出。
 *
 * 运行：node server/index.mjs（或 pnpm start）
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.mjs';
import { loadConfig, loadDotEnv } from './config.mjs';
import { createLogger } from './logger.mjs';

const FORCE_EXIT_MS = 5000;

/**
 * 创建 HTTP 服务器（不启动监听），便于测试 / 复用。
 * @param {{ config: object, logger?: object, app?: import('express').Express }} options
 */
export function createServer({ config, logger, app }) {
  const log = logger ?? createLogger({ level: config.logLevel });
  const application = app ?? createApp({ config, logger: log });
  const server = http.createServer(application);
  // SSE 场景下放宽 keep-alive，避免连接被提前回收；请求头超时保持默认保护
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  return { server, app: application, logger: log };
}

/**
 * 启动服务（main 可测试地拆出来）。
 * @returns {{ server: http.Server, config: object, logger: object, log: object }}
 */
export function start(config, logger) {
  const log = logger ?? createLogger({ level: config.logLevel });
  const { server, app } = createServer({ config, logger: log });

  const shutdown = createShutdownHandler({ server, config, logger: log });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      log.error('端口已被占用，无法启动', { host: config.host, port: config.port });
    } else {
      log.error('服务启动失败', { error });
    }
    process.exitCode = 1;
    // 启动失败无法继续提供服务
    setTimeout(() => process.exit(1), 50).unref();
  });

  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : config.port;
    log.info('DeepSearch 服务已启动', {
      host: config.host,
      port,
      upstream: config.deepseekBaseUrl,
      accessTokenRequired: Boolean(config.accessToken),
      staticReady: Boolean(app?.locals?.staticReady),
      logLevel: config.logLevel,
    });
  });

  return { server, config, log };
}

/**
 * 优雅退出处理器：停止接收新请求，最多等 5 秒后强制退出。
 * 重复收到信号时立即退出。
 */
export function createShutdownHandler({ server, config, logger }) {
  let shuttingDown = false;
  return function shutdown(signal) {
    if (shuttingDown) {
      logger.warn('再次收到退出信号，立即退出', { signal });
      process.exit(1);
    }
    shuttingDown = true;
    logger.info('收到退出信号，正在优雅关闭服务', { signal, forceExitMs: FORCE_EXIT_MS });

    const forceTimer = setTimeout(() => {
      logger.warn('关闭超时，强制退出', { forceExitMs: FORCE_EXIT_MS });
      process.exit(1);
    }, FORCE_EXIT_MS);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    // 立即停止接收新连接 / 请求
    try {
      server.close((error) => {
        clearTimeout(forceTimer);
        if (error) {
          logger.error('关闭服务时出错', { error });
          process.exit(1);
        }
        logger.info('服务已关闭', {});
        process.exit(0);
      });
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    } catch (error) {
      clearTimeout(forceTimer);
      logger.error('关闭服务时出错', { error });
      process.exit(1);
    }
  };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const selfPath = fileURLToPath(import.meta.url);
    const entryPath = path.resolve(entry);
    const normalize = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
    return normalize(selfPath) === normalize(entryPath);
  } catch {
    return false;
  }
}

function main() {
  // 1) 若 CWD 存在 .env 则加载（已存在的进程环境变量优先）
  const dotenvVars = loadDotEnv(process.cwd(), process.env);
  const config = loadConfig(process.env);
  const logger = createLogger({ level: config.logLevel });

  // 直连暴露 + 信任代理头 = 访客可伪造 X-Forwarded-For 绕过限流，启动时给出明确告警
  if (config.trustProxy && (config.host === '0.0.0.0' || config.host === '::')) {
    logger.warn(
      '已开启 TRUST_PROXY 且监听所有网卡：请确认前方存在可信反向代理，否则 X-Forwarded-For 可被伪造以绕过按 IP 限流',
      { trustProxy: config.trustProxy, host: config.host },
    );
  }

  if (Object.keys(dotenvVars).length > 0) {
    logger.debug('已加载 .env 配置文件', { keys: Object.keys(dotenvVars).sort() });
  }

  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常，进程退出', { error });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝，进程退出', { error: reason });
    process.exit(1);
  });

  start(config, logger);
}

if (isMainModule()) main();
