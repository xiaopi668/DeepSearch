import { describe, expect, it } from 'vitest';

import {
  API_KEY_PATTERN,
  COUNT_LIMIT,
  SUMMARIZE_LIMITS,
} from '../../server/config.mjs';
import { AppError } from '../../server/errors.mjs';
import {
  countCodePoints,
  ensurePlainObject,
  extractApiKey,
  truncateCodePoints,
  validateFetchBody,
  validateQuery,
  validateSearchBody,
  validateSummarizeBody,
} from '../../server/validation.mjs';

/** 断言抛出 AppError 并校验 code/status/message。 */
function expectError(fn, code, status) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.message).toMatch(/[\u4e00-\u9fa5]/); // 中文文案
    return error;
  }
  throw new Error('预期抛出错误，但没有抛出');
}

describe('基础工具', () => {
  it('countCodePoints 按 Unicode 码点计数', () => {
    expect(countCodePoints('abc')).toBe(3);
    expect(countCodePoints('中文')).toBe(2);
    expect(countCodePoints('😀😀')).toBe(2);
    expect(countCodePoints('')).toBe(0);
  });

  it('truncateCodePoints 不破坏代理对', () => {
    expect(truncateCodePoints('😀😀😀', 2)).toBe('😀😀');
    expect(truncateCodePoints('abcdef', 0)).toBe('');
    expect(truncateCodePoints('abc', 10)).toBe('abc');
  });
});

describe('API Key 校验（契约 §1）', () => {
  const validKey = `sk-${'a'.repeat(16)}`;

  it('合法 Bearer Key 通过', () => {
    expect(extractApiKey(`Bearer ${validKey}`)).toBe(validKey);
    expect(extractApiKey(`bearer   ${validKey}`)).toBe(validKey);
    expect(API_KEY_PATTERN.test(`sk-${'a'.repeat(200)}`)).toBe(true);
    expect(API_KEY_PATTERN.test(validKey)).toBe(true);
  });

  it('缺少 Authorization → 401 missing_api_key', () => {
    expectError(() => extractApiKey(undefined), 'missing_api_key', 401);
    expectError(() => extractApiKey(''), 'missing_api_key', 401);
    expectError(() => extractApiKey('Bearer   '), 'missing_api_key', 401);
  });

  it('格式错误 → 401 invalid_api_key', () => {
    expectError(() => extractApiKey(validKey), 'invalid_api_key', 401); // 缺 Bearer
    expectError(() => extractApiKey('Basic abc'), 'invalid_api_key', 401);
    expectError(() => extractApiKey('Bearer sk-short'), 'invalid_api_key', 401); // 不足 10 位
    expectError(() => extractApiKey(`Bearer sk-${'a'.repeat(201)}`), 'invalid_api_key', 401);
    expectError(() => extractApiKey('Bearer sk-abc def'), 'invalid_api_key', 401);
    expectError(() => extractApiKey('Bearer pk-abcdefghijkl'), 'invalid_api_key', 401);
  });
});

describe('query 校验（契约 §2）', () => {
  it('合法 query 保留操作符原文并去掉首尾空白', () => {
    expect(validateQuery('  site:example.com DeepSeek V4  ')).toBe('site:example.com DeepSeek V4');
  });

  it('128 码点通过，129 码点拒绝（按码点计，emoji 算 1）', () => {
    expect(validateQuery('😀'.repeat(128))).toBe('😀'.repeat(128));
    expectError(() => validateQuery('😀'.repeat(129)), 'invalid_request', 400);
    expect(validateQuery('中'.repeat(128))).toBe('中'.repeat(128));
    expectError(() => validateQuery('中'.repeat(129)), 'invalid_request', 400);
  });

  it('空 / 全空白 / 非字符串 / 超长拒绝', () => {
    expectError(() => validateQuery(''), 'invalid_request', 400);
    expectError(() => validateQuery('   \t\n '), 'invalid_request', 400);
    expectError(() => validateQuery(123), 'invalid_request', 400);
    expectError(() => validateQuery(null), 'invalid_request', 400);
  });
});

describe('validateSearchBody（契约 §2 /api/search）', () => {
  it('默认值：count 10、needContent false、可选字段 null', () => {
    const result = validateSearchBody({ query: 'DeepSeek V4 发布' });
    expect(result).toEqual({
      query: 'DeepSeek V4 发布',
      count: COUNT_LIMIT.default,
      needContent: false,
      oriQuestion: null,
      localization: null,
    });
  });

  it('接受边界值 count=1/50 与布尔 needContent', () => {
    expect(validateSearchBody({ query: 'q', count: 1 }).count).toBe(1);
    expect(validateSearchBody({ query: 'q', count: 50 }).count).toBe(50);
    expect(validateSearchBody({ query: 'q', needContent: true }).needContent).toBe(true);
    expect(validateSearchBody({ query: 'q', needContent: false }).needContent).toBe(false);
  });

  it('拒绝非法 count', () => {
    for (const count of [0, 51, -1, 1.5, '10', Number.NaN]) {
      expectError(() => validateSearchBody({ query: 'q', count }), 'invalid_request', 400);
    }
    expectError(() => validateSearchBody({ query: 'q', count: Number.POSITIVE_INFINITY }), 'invalid_request', 400);
  });

  it('拒绝非布尔 needContent', () => {
    for (const needContent of ['true', 1, {}, []]) {
      expectError(() => validateSearchBody({ query: 'q', needContent }), 'invalid_request', 400);
    }
  });

  it('oriQuestion / localization 可选，空串归一化为 null', () => {
    expect(validateSearchBody({ query: 'q', oriQuestion: '原始问题' }).oriQuestion).toBe('原始问题');
    expect(validateSearchBody({ query: 'q', oriQuestion: '   ' }).oriQuestion).toBeNull();
    expect(validateSearchBody({ query: 'q', localization: 'CN' }).localization).toBe('CN');
    expect(validateSearchBody({ query: 'q', localization: '' }).localization).toBeNull();
    expectError(() => validateSearchBody({ query: 'q', oriQuestion: 'x'.repeat(129) }), 'invalid_request', 400);
    expectError(() => validateSearchBody({ query: 'q', localization: 42 }), 'invalid_request', 400);
  });

  it('请求体不是对象 → 400 invalid_request', () => {
    for (const body of [undefined, null, [], 'query', 42]) {
      expectError(() => validateSearchBody(body), 'invalid_request', 400);
    }
  });
});

describe('validateFetchBody（契约 §2 /api/fetch）', () => {
  it('接受合法 http/https URL 并原样返回', () => {
    expect(validateFetchBody({ url: 'https://example.com/article' }).url).toBe('https://example.com/article');
    expect(validateFetchBody({ url: 'http://example.com/a?b=1#c' }).url).toBe('http://example.com/a?b=1#c');
    expect(validateFetchBody({ url: '  https://example.com/  ' }).url).toBe('https://example.com/');
  });

  it('拒绝非 http/https、无 host、带认证信息与超长 URL', () => {
    expectError(() => validateFetchBody({ url: 'ftp://example.com/a' }), 'invalid_request', 400);
    expectError(() => validateFetchBody({ url: 'javascript:alert(1)' }), 'invalid_request', 400);
    expectError(() => validateFetchBody({ url: 'file:///etc/passwd' }), 'invalid_request', 400);
    expectError(() => validateFetchBody({ url: 'not-a-url' }), 'invalid_request', 400);
    expectError(() => validateFetchBody({ url: 'https://' }), 'invalid_request', 400);
    expectError(() => validateFetchBody({ url: 'https://user:pass@example.com/' }), 'invalid_request', 400);
    expectError(() => validateFetchBody({ url: 'https://user@example.com/' }), 'invalid_request', 400);
    expectError(() => validateFetchBody({ url: `https://example.com/${'a'.repeat(8192)}` }), 'invalid_request', 400);
    expectError(() => validateFetchBody({ url: '' }), 'invalid_request', 400);
    expectError(() => validateFetchBody({ url: 123 }), 'invalid_request', 400);
  });
});

describe('validateSummarizeBody（契约 §2 /api/summarize）', () => {
  const result = {
    title: '标题',
    url: 'https://example.com/a',
    siteName: '站点',
    date: '2026-06-01T00:00:00+00:00',
    snippet: '摘要',
    summary: '长摘要',
  };
  const validBody = { query: 'DeepSeek V4', results: [result] };

  it('默认 model=deepseek-flash、thinking=false', () => {
    const normalized = validateSummarizeBody(validBody);
    expect(normalized.model).toBe('deepseek-flash');
    expect(normalized.thinking).toBe(false);
    expect(normalized.results).toHaveLength(1);
    expect(normalized.results[0]).toMatchObject({ title: '标题', siteName: '站点' });
  });

  it('results 1–15 条边界', () => {
    expect(validateSummarizeBody({ query: 'q', results: [result] }).results).toHaveLength(1);
    expect(validateSummarizeBody({ query: 'q', results: Array(15).fill(result) }).results).toHaveLength(15);
    expectError(() => validateSummarizeBody({ query: 'q', results: [] }), 'invalid_request', 400);
    expectError(() => validateSummarizeBody({ query: 'q', results: Array(16).fill(result) }), 'invalid_request', 400);
    expectError(() => validateSummarizeBody({ query: 'q', results: 'x' }), 'invalid_request', 400);
    expectError(() => validateSummarizeBody({ query: 'q', results: [null] }), 'invalid_request', 400);
    expectError(() => validateSummarizeBody({ query: 'q', results: [42] }), 'invalid_request', 400);
  });

  it('按契约截断 title/url/siteName/snippet/summary', () => {
    const normalized = validateSummarizeBody({
      query: 'q',
      results: [
        {
          title: 't'.repeat(400),
          url: `https://example.com/${'u'.repeat(9000)}`,
          siteName: 's'.repeat(200),
          snippet: 'n'.repeat(600),
          summary: 'm'.repeat(2500),
        },
      ],
    });
    const item = normalized.results[0];
    expect(item.title).toHaveLength(300);
    expect(item.url.length).toBe(8192);
    expect(item.siteName).toHaveLength(120);
    expect(item.snippet).toHaveLength(500);
    expect(item.summary).toHaveLength(2000);
  });

  it('缺失字段归一化为空串或 null', () => {
    const normalized = validateSummarizeBody({ query: 'q', results: [{}] });
    expect(normalized.results[0]).toEqual({
      title: '',
      url: '',
      siteName: null,
      date: null,
      snippet: '',
      summary: '',
    });
  });

  it('校验 model 与 thinking', () => {
    expect(validateSummarizeBody({ ...validBody, model: 'deepseek-v4-pro' }).model).toBe('deepseek-v4-pro');
    expect(validateSummarizeBody({ ...validBody, thinking: true }).thinking).toBe(true);
    expectError(() => validateSummarizeBody({ ...validBody, model: 'gpt-4' }), 'invalid_request', 400);
    expectError(() => validateSummarizeBody({ ...validBody, thinking: 'true' }), 'invalid_request', 400);
    expectError(() => validateSummarizeBody({ ...validBody, thinking: 1 }), 'invalid_request', 400);
  });

  it('query 必填，请求体必须是对象', () => {
    expectError(() => validateSummarizeBody({ query: '', results: [result] }), 'invalid_request', 400);
    expectError(() => validateSummarizeBody({ results: [result] }), 'invalid_request', 400);
    expectError(() => validateSummarizeBody(undefined), 'invalid_request', 400);
  });

  it('SUMMARIZE_LIMITS 常量与契约一致', () => {
    expect(SUMMARIZE_LIMITS).toMatchObject({ minResults: 1, maxResults: 15, maxContextChars: 12000, maxTokens: 1200 });
  });
});

describe('ensurePlainObject', () => {
  it('只接受普通对象', () => {
    expect(ensurePlainObject({ a: 1 })).toEqual({ a: 1 });
    for (const value of [null, undefined, [], 'x', 1, true]) {
      expectError(() => ensurePlainObject(value), 'invalid_request', 400);
    }
  });
});
