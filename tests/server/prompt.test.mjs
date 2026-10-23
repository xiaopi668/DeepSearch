import { describe, expect, it } from 'vitest';

import { SUMMARIZE_LIMITS } from '../../server/config.mjs';
import {
  MAX_CONTEXT_CHARS,
  SYSTEM_PROMPT,
  buildSummarizeMessages,
  buildUserMessage,
} from '../../server/prompt.mjs';
import { countCodePoints } from '../../server/validation.mjs';

const baseResult = {
  title: 'DeepSeek V4 发布',
  url: 'https://example.com/a',
  siteName: 'Example News',
  date: '2026-06-01T00:00:00+00:00',
  snippet: '短摘要',
  summary: '长摘要',
};

describe('SYSTEM_PROMPT（契约 §6）', () => {
  it('包含契约要求的全部要点', () => {
    expect(SYSTEM_PROMPT).toContain('你是一个中文搜索助手');
    expect(SYSTEM_PROMPT).toContain('① 先给 2–3 句直接结论');
    expect(SYSTEM_PROMPT).toContain('② 再用 Markdown 要点补充关键事实');
    expect(SYSTEM_PROMPT).toContain('使用 `[编号]` 标注来源');
    expect(SYSTEM_PROMPT).toContain('③ 只依据给定结果，不编造');
    expect(SYSTEM_PROMPT).toContain('信息不足或来源冲突时明确说明');
    expect(SYSTEM_PROMPT).toContain('④ 不要输出"根据搜索结果"之类的废话开头');
    expect(SYSTEM_PROMPT).toContain('⑤ 总长度 300–500 字，语言与问题一致');
  });
});

describe('buildUserMessage', () => {
  it('严格按契约格式拼接', () => {
    const message = buildUserMessage('问题内容', [baseResult]);
    expect(message).toBe(
      [
        '问题：问题内容',
        '',
        '搜索结果：',
        '[1] 标题：DeepSeek V4 发布',
        '站点：Example News',
        '时间：2026-06-01T00:00:00+00:00',
        '摘要：长摘要',
      ].join('\n'),
    );
  });

  it('摘要缺失时回退到 snippet，标题/站点/时间缺失时用占位文案', () => {
    const message = buildUserMessage('Q', [{ snippet: '只要摘要', summary: '' }]);
    expect(message).toContain('[1] 标题：未命名');
    expect(message).toContain('站点：未知');
    expect(message).toContain('时间：未知');
    expect(message).toContain('摘要：只要摘要');
  });

  it('多条结果按编号递增', () => {
    const message = buildUserMessage('Q', [baseResult, { ...baseResult, title: '第二条' }]);
    expect(message).toContain('[1] 标题：DeepSeek V4 发布');
    expect(message).toContain('[2] 标题：第二条');
  });
});

describe('buildSummarizeMessages', () => {
  it('返回 system + user 两条消息', () => {
    const { messages, chars } = buildSummarizeMessages({ query: 'DeepSeek V4', results: [baseResult] });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('问题：DeepSeek V4');
    expect(chars).toBe(countCodePoints(messages[0].content) + countCodePoints(messages[1].content));
    expect(chars).toBeLessThanOrEqual(SUMMARIZE_LIMITS.maxContextChars);
  });

  it('15 条超长结果也能压到 12000 字符内', () => {
    const results = Array.from({ length: 15 }, (_, index) => ({
      ...baseResult,
      title: `标题${'t'.repeat(290)}`,
      snippet: 's'.repeat(500),
      summary: 'm'.repeat(2000),
      siteName: 'n'.repeat(120),
    }));
    const { messages } = buildSummarizeMessages({ query: 'Q'.repeat(128), results });
    const total = countCodePoints(messages[0].content) + countCodePoints(messages[1].content);
    expect(total).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(messages[0].content).toBe(SYSTEM_PROMPT);
    expect(messages[1].content).toContain('[1] 标题：');
  });

  it('可自定义更小的 maxChars 并丢弃尾部结果', () => {
    const results = Array.from({ length: 15 }, () => ({
      ...baseResult,
      summary: 'm'.repeat(2000),
    }));
    const { messages } = buildSummarizeMessages({ query: 'Q', results, maxChars: 1200 });
    const total = countCodePoints(messages[0].content) + countCodePoints(messages[1].content);
    expect(total).toBeLessThanOrEqual(1200);
    expect(messages[1].content).toContain('[1] 标题：');
    expect(messages[1].content).not.toContain('[15] 标题：');
  });

  it('即使 query 很长也保证总长度上限', () => {
    const results = [baseResult];
    const { messages } = buildSummarizeMessages({
      query: 'q'.repeat(128),
      results,
      maxChars: SYSTEM_PROMPT.length + 20,
    });
    const total = countCodePoints(messages[0].content) + countCodePoints(messages[1].content);
    expect(total).toBeLessThanOrEqual(SYSTEM_PROMPT.length + 20);
  });

  it('按码点计算长度（emoji 不膨胀计数）', () => {
    const { messages } = buildSummarizeMessages({ query: '😀'.repeat(100), results: [baseResult] });
    // 100 个 emoji = 100 码点；若按 UTF-16 会算成 200
    const userChars = countCodePoints(messages[1].content);
    expect(userChars).toBeLessThan(1000);
    expect(messages[1].content).toContain('😀');
  });
});
