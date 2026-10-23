import { ALLOWED_COUNTS, DEFAULT_ADVANCED_DRAFT, DEFAULT_SETTINGS } from './types';
import type { AdvancedDraft, AiMode, AiModel, AiSettings, Theme } from './types';
import { isRecord, readString } from './utils';

/**
 * 本地存储命名空间（与 Lead 的端到端脚本约定一致，勿改键名）。
 * Key 只保存在浏览器 localStorage，不写入服务器。
 */
export const STORAGE_KEYS = {
  apiKey: 'deepsearch:v1:apiKey',
  settings: 'deepsearch:v1:settings',
  history: 'deepsearch:v1:history',
  welcomeSeen: 'deepsearch:v1:welcomeSeen',
  accessToken: 'deepsearch:v1:accessToken',
  theme: 'deepsearch:v1:theme',
} as const;

export const MAX_HISTORY = 8;
export const API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{10,200}$/;
/** 高级搜索表单草稿（sessionStorage，仅当前标签页会话）。 */
export const ADVANCED_DRAFT_KEY = 'deepsearch:v1:advancedDraft';

function getRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // localStorage 不可用（隐私模式 / 配额满）时静默降级，不影响页面使用。
  }
}

function removeRaw(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 同上。
  }
}

function getSessionRaw(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function setSessionRaw(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // sessionStorage 不可用时静默降级。
  }
}

function removeSessionRaw(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // 同上。
  }
}

export function isValidApiKeyFormat(value: string): boolean {
  return API_KEY_PATTERN.test(value.trim());
}

export function loadApiKey(): string {
  const raw = getRaw(STORAGE_KEYS.apiKey);
  return raw ? raw.trim() : '';
}

export function saveApiKey(value: string): void {
  const trimmed = value.trim();
  if (trimmed) setRaw(STORAGE_KEYS.apiKey, trimmed);
  else removeRaw(STORAGE_KEYS.apiKey);
}

export function loadAccessToken(): string {
  const raw = getRaw(STORAGE_KEYS.accessToken);
  return raw ? raw.trim() : '';
}

export function saveAccessToken(value: string): void {
  const trimmed = value.trim();
  if (trimmed) setRaw(STORAGE_KEYS.accessToken, trimmed);
  else removeRaw(STORAGE_KEYS.accessToken);
}

function isAllowedCount(value: unknown): value is number {
  return typeof value === 'number' && (ALLOWED_COUNTS as readonly number[]).includes(value);
}

function isAiModel(value: unknown): value is AiModel {
  return value === 'deepseek-flash' || value === 'deepseek-v4-pro';
}

function isAiMode(value: unknown): value is AiMode {
  return value === 'manual' || value === 'auto';
}

export function loadSettings(): AiSettings {
  const raw = getRaw(STORAGE_KEYS.settings);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { ...DEFAULT_SETTINGS };
    return {
      model: isAiModel(parsed.model) ? parsed.model : DEFAULT_SETTINGS.model,
      thinking: parsed.thinking === true,
      aiMode: isAiMode(parsed.aiMode) ? parsed.aiMode : DEFAULT_SETTINGS.aiMode,
      count: isAllowedCount(parsed.count) ? parsed.count : DEFAULT_SETTINGS.count,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AiSettings): void {
  setRaw(STORAGE_KEYS.settings, JSON.stringify(settings));
}

export function loadHistory(): string[] {
  const raw = getRaw(STORAGE_KEYS.history);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const list: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      list.push(trimmed);
      if (list.length >= MAX_HISTORY) break;
    }
    return list;
  } catch {
    return [];
  }
}

export function saveHistory(history: string[]): void {
  setRaw(STORAGE_KEYS.history, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

/** 记录一次搜索，返回新的历史列表（去重、最新在前、最多 8 条）。 */
export function rememberSearch(term: string): string[] {
  const trimmed = term.trim();
  if (!trimmed) return loadHistory();
  const next = [trimmed, ...loadHistory().filter((item) => item !== trimmed)].slice(0, MAX_HISTORY);
  saveHistory(next);
  return next;
}

export function forgetSearch(term: string): string[] {
  const next = loadHistory().filter((item) => item !== term);
  saveHistory(next);
  return next;
}

/** 清空本地搜索历史。 */
export function clearHistory(): void {
  removeRaw(STORAGE_KEYS.history);
}

export function hasSeenWelcome(): boolean {
  return getRaw(STORAGE_KEYS.welcomeSeen) === '1';
}

export function markWelcomeSeen(): void {
  setRaw(STORAGE_KEYS.welcomeSeen, '1');
}

/** 主题：默认深色；非法/缺失值回退 dark。 */
export function loadTheme(): Theme {
  return getRaw(STORAGE_KEYS.theme) === 'light' ? 'light' : 'dark';
}

export function saveTheme(theme: Theme): void {
  setRaw(STORAGE_KEYS.theme, theme);
}

function isAllowedAdvancedCount(value: unknown): value is number {
  return typeof value === 'number' && (ALLOWED_COUNTS as readonly number[]).includes(value);
}

/** 读取高级搜索草稿；无草稿或损坏时返回 null。 */
export function loadAdvancedDraft(): AdvancedDraft | null {
  const raw = getSessionRaw(ADVANCED_DRAFT_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const languages = Array.isArray(parsed.languages)
      ? parsed.languages.filter((item): item is string => typeof item === 'string').slice(0, 24)
      : [];
    return {
      terms: readString(parsed, 'terms'),
      phrases: readString(parsed, 'phrases'),
      excludeWords: readString(parsed, 'excludeWords'),
      excludePhrases: readString(parsed, 'excludePhrases'),
      sites: readString(parsed, 'sites'),
      excludeSites: readString(parsed, 'excludeSites'),
      languages,
      customLanguage: readString(parsed, 'customLanguage'),
      after: readString(parsed, 'after'),
      before: readString(parsed, 'before'),
      count: isAllowedAdvancedCount(parsed.count) ? parsed.count : DEFAULT_ADVANCED_DRAFT.count,
    };
  } catch {
    return null;
  }
}

export function saveAdvancedDraft(draft: AdvancedDraft): void {
  setSessionRaw(ADVANCED_DRAFT_KEY, JSON.stringify(draft));
}

export function clearAdvancedDraft(): void {
  removeSessionRaw(ADVANCED_DRAFT_KEY);
}

/** 清空本应用写入的全部本地数据。 */
export function clearLocalData(): void {
  for (const key of Object.values(STORAGE_KEYS)) removeRaw(key);
  clearAdvancedDraft();
}
