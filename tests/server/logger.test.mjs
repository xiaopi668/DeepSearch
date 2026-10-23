import { describe, expect, it } from 'vitest';

import { createLogger, redactString, redactValue } from '../../server/logger.mjs';

function makeLogger(level = 'debug') {
  const lines = [];
  const logger = createLogger({ level, sink: (line) => lines.push(line) });
  const records = () => lines.map((line) => JSON.parse(line));
  return { logger, lines, records };
}

describe('日志脱敏', () => {
  it('文本中的 sk- Key 统一替换为 sk-***', () => {
    expect(redactString('Authorization: Bearer sk-abcdefghijklmnop')).toBe('Authorization: Bearer sk-***');
    expect(redactString('no key here')).toBe('no key here');
  });

  it('敏感字段名整体脱敏，普通字段保留', () => {
    const redacted = redactValue({
      authorization: 'Bearer sk-abcdefghijklmnop',
      apiKey: 'sk-abcdefghijklmnop',
      api_key: 'x',
      'x-access-token': 'secret',
      accessToken: 'secret',
      password: 'p',
      query: 'DeepSeek V4',
      count: 3,
    });
    expect(redacted.authorization).toBe('***');
    expect(redacted.apiKey).toBe('***');
    expect(redacted.api_key).toBe('***');
    expect(redacted['x-access-token']).toBe('***');
    expect(redacted.accessToken).toBe('***');
    expect(redacted.password).toBe('***');
    expect(redacted.query).toBe('DeepSeek V4');
    expect(redacted.count).toBe(3);
  });

  it('嵌套对象 / 数组 / Error 中的 Key 也会脱敏', () => {
    const redacted = redactValue({
      headers: { authorization: 'Bearer sk-abcdefghijklmnop', accept: 'application/json' },
      list: ['sk-abcdefghijklmnop', 'ok'],
      error: new Error('调用失败 sk-abcdefghijklmnop'),
    });
    expect(redacted.headers.authorization).toBe('***');
    expect(redacted.headers.accept).toBe('application/json');
    expect(redacted.list[0]).toBe('sk-***');
    expect(redacted.list[1]).toBe('ok');
    expect(redacted.error.message).toBe('调用失败 sk-***');
  });

  it('实际输出的日志行绝不含完整 Key', () => {
    const { logger, lines, records } = makeLogger();
    logger.info('请求 Bearer sk-abcdefghijklmnop', {
      authorization: 'Bearer sk-abcdefghijklmnop',
      apiKey: 'sk-abcdefghijklmnop',
      headers: { 'x-access-token': 'sk-abcdefghijklmnop' },
      requestId: 'req-1',
      ms: 12,
    });
    expect(lines).toHaveLength(1);
    const record = records()[0];
    expect(record.authorization).toBe('***');
    expect(record.apiKey).toBe('***');
    expect(record.headers['x-access-token']).toBe('***');
    expect(record.msg).toContain('sk-***');
    expect(record.requestId).toBe('req-1');
    expect(record.ms).toBe(12);
    expect(lines[0]).not.toContain('sk-abcdefghijklmnop');
  });
});

describe('日志级别与字段', () => {
  it('info 级别过滤 debug', () => {
    const { logger, records } = makeLogger('info');
    logger.debug('被过滤');
    logger.info('保留');
    expect(records()).toHaveLength(1);
    expect(records()[0].msg).toBe('保留');
    expect(records()[0].level).toBe('info');
  });

  it('warn/error 正常输出且带时间字段', () => {
    const { logger, records } = makeLogger('debug');
    logger.warn('警告');
    logger.error('错误', { code: 'upstream_error' });
    const list = records();
    expect(list).toHaveLength(2);
    expect(list[0].level).toBe('warn');
    expect(list[1].code).toBe('upstream_error');
    expect(new Date(list[0].time).toISOString()).toBe(list[0].time);
  });

  it('child 绑定 requestId，且不影响父 logger', () => {
    const { logger, records } = makeLogger();
    const child = logger.child({ requestId: 'abc-123' });
    child.info('子日志', { status: 200 });
    logger.info('父日志');
    const list = records();
    expect(list[0]).toMatchObject({ requestId: 'abc-123', status: 200 });
    expect(list[1].requestId).toBeUndefined();
  });

  it('日志 sink 抛错不影响业务', () => {
    const logger = createLogger({
      level: 'debug',
      sink: () => {
        throw new Error('sink 坏了');
      },
    });
    expect(() => logger.info('hello')).not.toThrow();
  });

  it('可注入时间源', () => {
    const lines = [];
    const logger = createLogger({
      level: 'debug',
      sink: (line) => lines.push(line),
      now: () => Date.UTC(2026, 9, 20, 4, 0, 0),
    });
    logger.info('固定时间');
    expect(JSON.parse(lines[0]).time).toBe('2026-10-20T04:00:00.000Z');
  });
});
