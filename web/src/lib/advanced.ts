import type { AdvancedDraft } from './types';

/** 按行拆分多值输入（精确短语 / 排除词语 / 排除短语）。 */
export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 站点输入支持逗号 / 中文逗号 / 换行 / 空格分隔，并去掉重复的 site: 前缀。 */
export function splitSites(value: string): string[] {
  return value
    .split(/[\s,，]+/)
    .map((item) => item.trim().replace(/^site:/i, '').trim())
    .filter((item) => item.length > 0);
}

function stripQuotes(value: string): string {
  return value.replace(/"/g, '').trim();
}

/**
 * 把高级搜索表单组合成 DeepSeek 搜索语法（单空格连接）：
 * 包含词语 → 精确短语 → 排除词语 → 排除短语 → site: → -site: → lang: → after: → before:
 *
 * 示例：精确短语 "DeepSeek V4" + site github.com + lang en + after 2025-01-01
 *   => `"DeepSeek V4" site:github.com lang:en after:2025-01-01`
 */
export function buildAdvancedQuery(draft: AdvancedDraft): string {
  const parts: string[] = [];

  const terms = draft.terms.trim();
  if (terms) parts.push(terms);

  for (const phrase of splitLines(draft.phrases)) {
    const cleaned = stripQuotes(phrase);
    if (cleaned) parts.push(`"${cleaned}"`);
  }

  for (const word of splitLines(draft.excludeWords)) {
    const cleaned = stripQuotes(word);
    if (cleaned) parts.push(`-${cleaned}`);
  }

  for (const phrase of splitLines(draft.excludePhrases)) {
    const cleaned = stripQuotes(phrase);
    if (cleaned) parts.push(`-"${cleaned}"`);
  }

  const sites = splitSites(draft.sites);
  if (sites.length === 1) {
    parts.push(`site:${sites[0]}`);
  } else if (sites.length > 1) {
    parts.push(`site:${sites.join(' OR site:')}`);
  }

  for (const site of splitSites(draft.excludeSites)) {
    parts.push(`-site:${site}`);
  }

  const languages = Array.from(new Set(draft.languages.filter((item) => item.trim().length > 0)));
  if (languages.length > 0) parts.push(`lang:${languages.join(',')}`);

  if (draft.after) parts.push(`after:${draft.after}`);
  if (draft.before) parts.push(`before:${draft.before}`);

  return parts.join(' ');
}

/** 按 Unicode 码点计数（DeepSeek query 限制 1–128 个字符）。 */
export function countCodepoints(value: string): number {
  return Array.from(value).length;
}

export const ADVANCED_QUERY_LIMIT = 128;

/** 自定义语言代码做最小规范化：小写、仅保留字母/连字符。 */
export function normalizeLanguage(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z-]/g, '');
}
