import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  COUNT_LIMIT,
  SUMMARIZE_LIMITS,
  loadConfig,
  loadDotEnv,
  normalizeBaseUrl,
  parseByteSize,
  parseEnvFile,
  parseLogLevel,
  parseTrustProxy,
  toInt,
} from '../../server/config.mjs';
import { makeTempDir } from './helpers.mjs';

const tempDirs = [];
function tempDir() {
  const dir = makeTempDir('deepsearch-config-');
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }
});

describe('parseEnvFile', () => {
  it('解析注释、空行、export、引号与行尾注释', () => {
    const vars = parseEnvFile(`# 这是注释
HOST=0.0.0.0

export PORT=9000
ACCESS_TOKEN="hello world"
QUOTED='single # 原样保留'
WITH_COMMENT=value # 行尾注释
EMPTY=
NOVALUE
=bad
"bad key"=1
`);
    expect(vars).toEqual({
      HOST: '0.0.0.0',
      PORT: '9000',
      ACCESS_TOKEN: 'hello world',
      QUOTED: 'single # 原样保留',
      WITH_COMMENT: 'value',
      EMPTY: '',
    });
  });

  it('解析双引号转义', () => {
    const vars = parseEnvFile('A="line1\\nline2"\nB="quote\\"x"\nC="path\\\\tmp"');
    expect(vars.A).toBe('line1\nline2');
    expect(vars.B).toBe('quote"x');
    expect(vars.C).toBe('path\\tmp');
  });
});

describe('loadDotEnv', () => {
  it('只填充缺失的环境变量（进程环境优先）', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, '.env'),
      ['HOST=127.0.0.1', 'PORT=1234', 'ACCESS_TOKEN=from-file'].join('\n'),
      'utf8',
    );
    const env = { PORT: '9999' };
    const loaded = loadDotEnv(dir, env);
    expect(loaded).toMatchObject({ HOST: '127.0.0.1', PORT: '1234' });
    expect(env.PORT).toBe('9999');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.ACCESS_TOKEN).toBe('from-file');
  });

  it('没有 .env 时返回空对象且不报错', () => {
    const dir = tempDir();
    const env = {};
    expect(loadDotEnv(dir, env)).toEqual({});
    expect(env).toEqual({});
  });
});

describe('loadConfig', () => {
  it('在空环境下返回契约默认值', () => {
    const config = loadConfig({});
    expect(config.name).toBe('deepsearch');
    expect(config.version).toBe('1.0.0');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8787);
    expect(config.deepseekBaseUrl).toBe('https://api.deepseek.com');
    expect(config.searchTimeoutMs).toBe(20000);
    expect(config.fetchTimeoutMs).toBe(60000);
    expect(config.chatTimeoutMs).toBe(120000);
    expect(config.maxBodyBytes).toBe(1024 * 1024);
    expect(config.rateLimitWindowMs).toBe(60000);
    expect(config.searchRateLimitMax).toBe(90);
    expect(config.fetchRateLimitMax).toBe(30);
    expect(config.aiRateLimitMax).toBe(20);
    expect(config.accessToken).toBe('');
    expect(config.trustProxy).toBe(false);
    expect(config.logLevel).toBe('info');
    expect(config.sseHeartbeatMs).toBe(15000);
    expect(config.retry.maxRetries).toBe(2);
    expect(config.retry.baseDelayMs).toBe(500);
    expect(config.retry.maxRetryAfterMs).toBe(10000);
    expect(COUNT_LIMIT).toEqual({ min: 1, max: 50, default: 10 });
    expect(SUMMARIZE_LIMITS.maxContextChars).toBe(12000);
    expect(config.defaultModel).toBe('deepseek-flash');
  });

  it('读取并转换环境变量', () => {
    const config = loadConfig({
      HOST: ' 127.0.0.1 ',
      PORT: '9999',
      DEEPSEEK_BASE_URL: 'https://gateway.example.com/deepseek/',
      SEARCH_TIMEOUT_MS: '1234',
      FETCH_TIMEOUT_MS: '2345',
      CHAT_TIMEOUT_MS: '3456',
      MAX_BODY_BYTES: '2mb',
      RATE_LIMIT_WINDOW_MS: '30000',
      SEARCH_RATE_LIMIT_MAX: '5',
      FETCH_RATE_LIMIT_MAX: '6',
      AI_RATE_LIMIT_MAX: '7',
      ACCESS_TOKEN: '  s3cret  ',
      TRUST_PROXY: '1',
      LOG_LEVEL: 'DEBUG',
      SSE_HEARTBEAT_MS: '250',
    });
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(9999);
    expect(config.deepseekBaseUrl).toBe('https://gateway.example.com/deepseek');
    expect(config.searchTimeoutMs).toBe(1234);
    expect(config.fetchTimeoutMs).toBe(2345);
    expect(config.chatTimeoutMs).toBe(3456);
    expect(config.maxBodyBytes).toBe(2 * 1024 * 1024);
    expect(config.rateLimitWindowMs).toBe(30000);
    expect(config.searchRateLimitMax).toBe(5);
    expect(config.fetchRateLimitMax).toBe(6);
    expect(config.aiRateLimitMax).toBe(7);
    expect(config.accessToken).toBe('s3cret');
    expect(config.trustProxy).toBe(1);
    expect(config.logLevel).toBe('debug');
    expect(config.sseHeartbeatMs).toBe(250);
  });

  it('非法值回退默认值而不是崩溃', () => {
    const config = loadConfig({
      PORT: 'abc',
      SEARCH_TIMEOUT_MS: '-5',
      FETCH_TIMEOUT_MS: '0',
      MAX_BODY_BYTES: 'wat',
      RATE_LIMIT_WINDOW_MS: '1',
      SEARCH_RATE_LIMIT_MAX: '-2',
      DEEPSEEK_BASE_URL: 'not-a-url',
      LOG_LEVEL: 'verbose',
      TRUST_PROXY: 'false',
    });
    expect(config.port).toBe(8787);
    expect(config.searchTimeoutMs).toBe(20000);
    expect(config.fetchTimeoutMs).toBe(60000);
    expect(config.maxBodyBytes).toBe(1024 * 1024);
    expect(config.rateLimitWindowMs).toBe(60000);
    expect(config.searchRateLimitMax).toBe(90);
    expect(config.deepseekBaseUrl).toBe('https://api.deepseek.com');
    expect(config.logLevel).toBe('info');
    expect(config.trustProxy).toBe(false);
  });

  it('端口越界回退默认值', () => {
    expect(loadConfig({ PORT: '0' }).port).toBe(8787);
    expect(loadConfig({ PORT: '70000' }).port).toBe(8787);
    expect(loadConfig({ PORT: '8787' }).port).toBe(8787);
  });
});

describe('辅助解析函数', () => {
  it('toInt 处理边界', () => {
    expect(toInt(undefined, 5)).toBe(5);
    expect(toInt('12', 5)).toBe(12);
    expect(toInt('12.9', 5)).toBe(12);
    expect(toInt('x', 5)).toBe(5);
    expect(toInt('100', 5, 1, 10)).toBe(5);
  });

  it('parseByteSize 支持多种写法', () => {
    expect(parseByteSize('1mb')).toBe(1024 * 1024);
    expect(parseByteSize('512kb')).toBe(512 * 1024);
    expect(parseByteSize('1mib')).toBe(1024 * 1024);
    expect(parseByteSize('1048576')).toBe(1048576);
    expect(parseByteSize(2048)).toBe(2048);
    expect(parseByteSize('bad', 7)).toBe(7);
    expect(parseByteSize('', 7)).toBe(7);
  });

  it('normalizeBaseUrl 去除尾部斜杠并回退非法地址', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com');
    expect(normalizeBaseUrl('https://gw.example.com/base///')).toBe('https://gw.example.com/base');
    expect(normalizeBaseUrl('ftp://example.com')).toBe('https://api.deepseek.com');
    expect(normalizeBaseUrl('wat')).toBe('https://api.deepseek.com');
    expect(normalizeBaseUrl('')).toBe('https://api.deepseek.com');
  });

  it('parseTrustProxy 处理各种写法', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('loopback')).toBe('loopback');
  });

  it('parseLogLevel 回退 info', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('verbose')).toBe('info');
    expect(parseLogLevel(undefined)).toBe('info');
  });
});
