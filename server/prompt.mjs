/**
 * AI 总结 Prompt 构造（契约 §6）
 * ---------------------------------------------------------------------------
 * System prompt 固定为契约要求的五条中文指令；User prompt 拼接「问题 + 编号搜索结果」。
 * 总上下文（system + user）严格不超过 12000 字符：先按契约截断单字段，
 * 仍超限时逐步压缩摘要长度，极端情况下从末尾丢弃结果条目。
 */
import { SUMMARIZE_LIMITS } from './config.mjs';
import { countCodePoints, truncateCodePoints } from './validation.mjs';

export const MAX_CONTEXT_CHARS = SUMMARIZE_LIMITS.maxContextChars;

/** 契约 §6 规定的 system prompt（逐字保留）。 */
export const SYSTEM_PROMPT = [
  '你是一个中文搜索助手。基于给定的搜索结果（编号 [1]…[n]）回答用户问题。',
  '要求：① 先给 2–3 句直接结论；② 再用 Markdown 要点补充关键事实，使用 `[编号]` 标注来源；',
  '③ 只依据给定结果，不编造；信息不足或来源冲突时明确说明；',
  '④ 不要输出"根据搜索结果"之类的废话开头；⑤ 总长度 300–500 字，语言与问题一致。',
].join('\n');

/** 摘要文本的初始上限（与契约 §2 的 summary ≤ 2000 对齐）。 */
const INITIAL_TEXT_CAP = 2000;
const MIN_TEXT_CAP = 80;

function textOf(value, fallback = '') {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * 构造 user message。
 * @param {string} query
 * @param {Array<{title?: string|null, siteName?: string|null, date?: string|null,
 *                snippet?: string|null, summary?: string|null}>} results
 * @param {number} textCap 单条摘要的最大字符数（用于压缩上下文）
 */
export function buildUserMessage(query, results, textCap = INITIAL_TEXT_CAP) {
  const lines = [`问题：${query}`, '', '搜索结果：'];
  results.forEach((result, index) => {
    const summary = truncateCodePoints(textOf(result.summary, textOf(result.snippet)), textCap);
    lines.push(`[${index + 1}] 标题：${textOf(result.title, '未命名')}`);
    lines.push(`站点：${textOf(result.siteName, '未知')}`);
    lines.push(`时间：${textOf(result.date, '未知')}`);
    lines.push(`摘要：${summary}`);
  });
  return lines.join('\n');
}

function totalChars(userMessage) {
  return countCodePoints(SYSTEM_PROMPT) + countCodePoints(userMessage);
}

/**
 * 构造 chat/completions 的 messages。
 * @param {{ query: string, results: Array<object>, maxChars?: number }} params
 * @returns {{ messages: Array<{role:'system'|'user', content:string}>, truncated: boolean, chars: number }}
 */
export function buildSummarizeMessages({ query, results, maxChars = MAX_CONTEXT_CHARS }) {
  const allResults = Array.isArray(results) ? results : [];
  let usable = allResults.slice();
  let cap = INITIAL_TEXT_CAP;
  let userMessage = buildUserMessage(query, usable, cap);

  // 逐步压缩：先缩摘要，再丢尾部结果，直到满足上下文预算
  while (usable.length > 0 && totalChars(userMessage) > maxChars) {
    if (cap > MIN_TEXT_CAP) {
      cap = Math.max(MIN_TEXT_CAP, Math.floor(cap * 0.7));
    } else if (usable.length > 1) {
      usable = usable.slice(0, -1);
    } else {
      break;
    }
    userMessage = buildUserMessage(query, usable, cap);
  }

  // 最终硬性保证 system + user ≤ maxChars
  const budget = Math.max(0, maxChars - countCodePoints(SYSTEM_PROMPT));
  if (countCodePoints(userMessage) > budget) {
    userMessage = truncateCodePoints(userMessage, budget);
  }

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    truncated: usable.length < allResults.length || countCodePoints(userMessage) < countCodePoints(buildUserMessage(query, usable, INITIAL_TEXT_CAP)),
    chars: countCodePoints(SYSTEM_PROMPT) + countCodePoints(userMessage),
  };
}
