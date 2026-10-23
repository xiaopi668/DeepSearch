/** 与 docs/API-CONTRACT.md v1 对齐的类型定义。 */

export type AiModel = 'deepseek-flash' | 'deepseek-v4-pro';
export type AiMode = 'manual' | 'auto';
export type BackendStatus = 'unknown' | 'online' | 'offline';
/** 界面主题：默认深色（Google Material Dark）。 */
export type Theme = 'dark' | 'light';

export interface AiSettings {
  model: AiModel;
  thinking: boolean;
  aiMode: AiMode;
  count: number;
}

export const DEFAULT_SETTINGS: AiSettings = {
  model: 'deepseek-flash',
  thinking: false,
  aiMode: 'manual',
  count: 10,
};

/** 设置面板里可选的条数（契约允许 1–50，这里提供常用档位）。 */
export const ALLOWED_COUNTS = [5, 10, 20, 50] as const;

/** 高级搜索：语言 chips。 */
export const ADVANCED_LANGUAGES = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt'] as const;

export interface AdvancedDraft {
  terms: string;
  phrases: string;
  excludeWords: string;
  excludePhrases: string;
  sites: string;
  excludeSites: string;
  languages: string[];
  customLanguage: string;
  after: string;
  before: string;
  count: number;
}

export const DEFAULT_ADVANCED_DRAFT: AdvancedDraft = {
  terms: '',
  phrases: '',
  excludeWords: '',
  excludePhrases: '',
  sites: '',
  excludeSites: '',
  languages: [],
  customLanguage: '',
  after: '',
  before: '',
  count: 10,
};

export const AI_MODELS: ReadonlyArray<{ id: AiModel; name: string; description: string }> = [
  { id: 'deepseek-flash', name: 'DeepSeek Flash', description: '响应更快，适合日常搜索总结' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: '推理更充分，总结更细致，但更慢' },
];

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  siteName: string | null;
  siteIcon: string | null;
  date: string | null;
  authority: number;
  rerankScore: number;
}

export interface SearchMeta {
  query: string;
  count: number;
  tookMs: number;
}

export interface SearchResponse {
  results: SearchResult[];
  meta: SearchMeta;
}

export interface FetchResponse {
  url: string;
  title: string;
  content: string;
  fetchedAt: string;
}

export interface ModelInfo {
  id: string;
  name: string | null;
  contextWindow: number | null;
}

export interface ValidateKeyResponse {
  ok: boolean;
  models: ModelInfo[];
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface HealthResponse {
  ok: boolean;
  name: string;
  version: string;
  features: { search: boolean; fetch: boolean; ai: boolean };
  auth: { accessTokenRequired: boolean };
  limits: { count: { min: number; max: number; default: number } };
  upstream: string;
}

/** POST /api/summarize 的 results 入参（服务端会自行截断）。 */
export interface SummaryResultInput {
  title: string;
  url: string;
  siteName: string | null;
  date: string | null;
  snippet: string;
  summary: string;
}

export type Route =
  | { view: 'home' }
  | { view: 'advanced' }
  | { view: 'search'; query: string; count: number; ai: AiMode; aiParam: string | null };

export interface SearchFormParams {
  query: string;
  count: number;
  ai: AiMode;
}
