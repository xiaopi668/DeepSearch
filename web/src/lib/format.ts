import type { SearchResult } from './types';

const absoluteDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const numberFormatter = new Intl.NumberFormat('zh-CN');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 7 天内显示相对时间，更早显示 zh-CN 绝对日期；无法解析返回 null。 */
export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return null;
  const diff = Date.now() - timestamp;
  if (diff < 0) return absoluteDateFormatter.format(new Date(timestamp));
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 7 * DAY) {
    const days = Math.floor(diff / DAY);
    return days === 1 ? '昨天' : `${days} 天前`;
  }
  return absoluteDateFormatter.format(new Date(timestamp));
}

export function formatTook(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
  return `${(milliseconds / 1000).toFixed(2)} 秒`;
}

export function formatNumber(value: number): string {
  return Number.isFinite(value) ? numberFormatter.format(value) : '0';
}

export function formatRerankScore(score: number): string | null {
  if (!Number.isFinite(score) || score === 0) return null;
  return score.toFixed(2);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

export function siteNameOf(result: Pick<SearchResult, 'siteName' | 'url'>): string {
  return result.siteName?.trim() || hostnameOf(result.url);
}

/** 面包屑：域名 › 路径片段（最多 3 段），用于低调展示 URL。 */
export function breadcrumbOf(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '');
    const segments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 3)
      .map((segment) => safeDecode(segment));
    return [host, ...segments].join(' › ');
  } catch {
    return url;
  }
}

export function initialsOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '·';
}

const AVATAR_COLORS: readonly string[] = [
  '#4285f4',
  '#34a853',
  '#ea4335',
  '#fbbc05',
  '#5f6368',
  '#1a73e8',
];

/** 用站点名/域名生成稳定的纯色字母头像背景（无渐变）。 */
export function avatarColorFor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 9973;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? '#5f6368';
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 继续走 execCommand 兜底。
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}
