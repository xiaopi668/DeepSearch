import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';
import { Settings } from 'lucide-react';
import {
  ADVANCED_QUERY_LIMIT,
  buildAdvancedQuery,
  countCodepoints,
  normalizeLanguage,
} from '../lib/advanced';
import { clearAdvancedDraft, loadAdvancedDraft, saveAdvancedDraft } from '../lib/storage';
import { ADVANCED_LANGUAGES, ALLOWED_COUNTS, DEFAULT_ADVANCED_DRAFT } from '../lib/types';
import type { AdvancedDraft, Theme } from '../lib/types';
import { classNames } from '../lib/utils';
import { Logo } from './Logo';
import { SearchBar } from './SearchBar';
import { ThemeToggle } from './ThemeToggle';

interface AdvancedViewProps {
  theme: Theme;
  onToggleTheme: () => void;
  onSearch: (query: string) => void;
  onHome: () => void;
  onOpenSettings: () => void;
  onSubmit: (query: string, count: number) => void;
}

type TextFieldKey =
  | 'terms'
  | 'phrases'
  | 'excludeWords'
  | 'excludePhrases'
  | 'sites'
  | 'excludeSites';

/**
 * Google 高级搜索式表单：左标签右输入，组合出 DeepSeek 搜索操作符，
 * 提交后复用现有 /search 结果页（不新增后端接口）。
 */
export function AdvancedView({
  theme,
  onToggleTheme,
  onSearch,
  onHome,
  onOpenSettings,
  onSubmit,
}: AdvancedViewProps) {
  const [draft, setDraft] = useState<AdvancedDraft>(
    () => loadAdvancedDraft() ?? { ...DEFAULT_ADVANCED_DRAFT, languages: [] },
  );
  const [customLanguage, setCustomLanguage] = useState(draft.customLanguage);

  // 表单草稿：sessionStorage，返回 /advanced 时恢复。
  useEffect(() => {
    saveAdvancedDraft(draft);
  }, [draft]);

  const query = useMemo(() => buildAdvancedQuery(draft), [draft]);
  const codepoints = countCodepoints(query);
  const overLimit = codepoints > ADVANCED_QUERY_LIMIT;
  const isEmpty = query.trim().length === 0;
  const canSubmit = !isEmpty && !overLimit;

  const updateDraft = <K extends keyof AdvancedDraft>(key: K, value: AdvancedDraft[K]): void => {
    setDraft((previous) => ({ ...previous, [key]: value }));
  };

  const handleTextChange =
    (key: TextFieldKey) =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      updateDraft(key, event.target.value);
    };

  const toggleLanguage = (code: string): void => {
    setDraft((previous) => {
      const selected = previous.languages.includes(code);
      return {
        ...previous,
        languages: selected
          ? previous.languages.filter((item) => item !== code)
          : [...previous.languages, code],
      };
    });
  };

  const handleCustomLanguageChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setCustomLanguage(event.target.value);
    updateDraft('customLanguage', event.target.value);
  };

  const addCustomLanguage = (): void => {
    const code = normalizeLanguage(customLanguage);
    if (!code) return;
    setDraft((previous) => ({
      ...previous,
      customLanguage: '',
      languages: previous.languages.includes(code)
        ? previous.languages
        : [...previous.languages, code],
    }));
    setCustomLanguage('');
  };

  const handleCustomLanguageKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addCustomLanguage();
  };

  const handleReset = (): void => {
    clearAdvancedDraft();
    setDraft({ ...DEFAULT_ADVANCED_DRAFT, languages: [] });
    setCustomLanguage('');
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit(query, draft.count);
  };

  return (
    <div className="advanced-view" data-testid="advanced-page">
      <header className="serp-header advanced-header">
        <div className="serp-header__inner">
          <div className="serp-header__bar">
            <button
              type="button"
              className="serp-logo"
              onClick={onHome}
              aria-label="返回 DeepSearch 首页"
              title="DeepSearch 首页"
            >
              <Logo size="sm" />
            </button>
            <div className="serp-search">
              <SearchBar variant="compact" initialValue="" onSearch={onSearch} />
            </div>
            <div className="serp-header__actions">
              <ThemeToggle theme={theme} onToggle={onToggleTheme} />
              <button
                type="button"
                className="icon-btn"
                data-testid="settings-button"
                onClick={onOpenSettings}
                aria-label="设置"
                title="设置"
              >
                <Settings size={20} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main id="main" className="advanced-main" tabIndex={-1}>
        <button
          type="button"
          className="advanced-back"
          data-testid="advanced-back"
          onClick={onHome}
        >
          ← 返回普通搜索
        </button>
        <h1 className="advanced-title">高级搜索</h1>
        <p className="advanced-subtitle">
          使用 DeepSeek 搜索操作符精确筛选网页，提交后复用普通搜索的结果页。
        </p>

        <form className="advanced-form" onSubmit={handleSubmit} noValidate>
          <div className="advanced-row">
            <label className="advanced-row__label" htmlFor="advanced-terms">
              包含全部词语
            </label>
            <div className="advanced-row__control">
              <input
                id="advanced-terms"
                className="advanced-input"
                data-testid="advanced-terms"
                type="text"
                value={draft.terms}
                onChange={handleTextChange('terms')}
                placeholder="例如：DeepSeek V4 发布"
              />
              <p className="advanced-hint">用空格分隔；会原样加入查询。</p>
            </div>
          </div>

          <div className="advanced-row">
            <label className="advanced-row__label" htmlFor="advanced-phrases">
              精确短语
            </label>
            <div className="advanced-row__control">
              <textarea
                id="advanced-phrases"
                className="advanced-textarea"
                data-testid="advanced-phrases"
                rows={2}
                value={draft.phrases}
                onChange={handleTextChange('phrases')}
                placeholder={'每行一条，例如：\nDeepSeek V4'}
              />
              <p className="advanced-hint">每行生成一个精确匹配片段（加双引号），支持多条。</p>
            </div>
          </div>

          <div className="advanced-row">
            <label className="advanced-row__label" htmlFor="advanced-exclude-words">
              排除词语
            </label>
            <div className="advanced-row__control">
              <textarea
                id="advanced-exclude-words"
                className="advanced-textarea"
                data-testid="advanced-exclude-words"
                rows={2}
                value={draft.excludeWords}
                onChange={handleTextChange('excludeWords')}
                placeholder={'每行一条，例如：\n广告'}
              />
              <p className="advanced-hint">每行生成一个排除词（-词）。</p>
            </div>
          </div>

          <div className="advanced-row">
            <label className="advanced-row__label" htmlFor="advanced-exclude-phrases">
              排除短语
            </label>
            <div className="advanced-row__control">
              <textarea
                id="advanced-exclude-phrases"
                className="advanced-textarea"
                data-testid="advanced-exclude-phrases"
                rows={2}
                value={draft.excludePhrases}
                onChange={handleTextChange('excludePhrases')}
                placeholder={'每行一条，例如：\n优惠活动'}
              />
              <p className="advanced-hint">每行生成一个排除短语（-"短语"）。</p>
            </div>
          </div>

          <div className="advanced-row">
            <label className="advanced-row__label" htmlFor="advanced-sites">
              限定站点
            </label>
            <div className="advanced-row__control">
              <textarea
                id="advanced-sites"
                className="advanced-textarea"
                data-testid="advanced-sites"
                rows={2}
                value={draft.sites}
                onChange={handleTextChange('sites')}
                placeholder={'例如：github.com\n或 github.com, arxiv.org'}
              />
              <p className="advanced-hint">
                支持逗号 / 换行分隔；多个站点生成 site:a OR site:b。
              </p>
            </div>
          </div>

          <div className="advanced-row">
            <label className="advanced-row__label" htmlFor="advanced-exclude-sites">
              排除站点
            </label>
            <div className="advanced-row__control">
              <textarea
                id="advanced-exclude-sites"
                className="advanced-textarea"
                data-testid="advanced-exclude-sites"
                rows={2}
                value={draft.excludeSites}
                onChange={handleTextChange('excludeSites')}
                placeholder={'例如：example.com'}
              />
              <p className="advanced-hint">支持空格 / 逗号 / 换行分隔；每个站点生成 -site:x。</p>
            </div>
          </div>

          <div className="advanced-row">
            <span className="advanced-row__label" id="advanced-lang-label">
              语言
            </span>
            <div className="advanced-row__control">
              <div className="advanced-chips" role="group" aria-labelledby="advanced-lang-label">
                {ADVANCED_LANGUAGES.map((language) => {
                  const selected = draft.languages.includes(language);
                  return (
                    <button
                      key={language}
                      type="button"
                      className={classNames('advanced-chip', selected && 'advanced-chip--selected')}
                      data-testid={`advanced-lang-${language}`}
                      aria-pressed={selected}
                      onClick={() => toggleLanguage(language)}
                    >
                      {language}
                    </button>
                  );
                })}
              </div>
              <div className="advanced-custom-lang">
                <input
                  className="advanced-input advanced-custom-lang__input"
                  data-testid="advanced-lang-custom"
                  type="text"
                  value={customLanguage}
                  onChange={handleCustomLanguageChange}
                  onKeyDown={handleCustomLanguageKeyDown}
                  placeholder="自定义语言代码，如 it"
                  aria-label="自定义语言代码"
                />
                <button
                  type="button"
                  className="advanced-custom-lang__add"
                  onClick={addCustomLanguage}
                >
                  添加
                </button>
              </div>
              <p className="advanced-hint">可多选；多个语言生成 lang:zh,en。</p>
            </div>
          </div>

          <div className="advanced-row">
            <span className="advanced-row__label" id="advanced-date-label">
              发布时间
            </span>
            <div className="advanced-row__control">
              <div className="advanced-date-row" role="group" aria-labelledby="advanced-date-label">
                <label className="advanced-date-field" htmlFor="advanced-after">
                  <span className="advanced-date-field__label">起始日期（after:）</span>
                  <input
                    id="advanced-after"
                    className="advanced-input advanced-date-input"
                    data-testid="advanced-after"
                    type="date"
                    value={draft.after}
                    onChange={(event) => updateDraft('after', event.target.value)}
                  />
                </label>
                <label className="advanced-date-field" htmlFor="advanced-before">
                  <span className="advanced-date-field__label">结束日期（before:）</span>
                  <input
                    id="advanced-before"
                    className="advanced-input advanced-date-input"
                    data-testid="advanced-before"
                    type="date"
                    value={draft.before}
                    onChange={(event) => updateDraft('before', event.target.value)}
                  />
                </label>
              </div>
              <p className="advanced-hint">
                会分别生成 after:YYYY-MM-DD 与 before:YYYY-MM-DD。
              </p>
            </div>
          </div>

          <div className="advanced-row">
            <span className="advanced-row__label" id="advanced-count-label">
              结果条数
            </span>
            <div className="advanced-row__control">
              <div
                className="advanced-chips"
                role="group"
                aria-labelledby="advanced-count-label"
                data-testid="advanced-count"
              >
                {ALLOWED_COUNTS.map((count) => (
                  <button
                    key={count}
                    type="button"
                    className={classNames(
                      'advanced-chip',
                      draft.count === count && 'advanced-chip--selected',
                    )}
                    data-testid={`advanced-count-${count}`}
                    aria-pressed={draft.count === count}
                    onClick={() => updateDraft('count', count)}
                  >
                    {count} 条
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="advanced-preview">
            <div className="advanced-preview__head">
              <label className="advanced-preview__label" htmlFor="advanced-preview">
                查询预览
              </label>
              <span
                className={classNames(
                  'advanced-preview__counter',
                  overLimit && 'advanced-preview__counter--error',
                )}
              >
                {codepoints} / {ADVANCED_QUERY_LIMIT} 个字符
              </span>
            </div>
            <textarea
              id="advanced-preview"
              className="advanced-preview__value"
              data-testid="advanced-preview"
              readOnly
              rows={2}
              value={query}
              placeholder="填写条件后这里会实时生成最终搜索语法"
              aria-describedby="advanced-validation"
            />
            <p
              className={classNames(
                'advanced-validation',
                overLimit && 'advanced-validation--error',
              )}
              id="advanced-validation"
              role={overLimit ? 'alert' : undefined}
            >
              {overLimit
                ? `查询超过 ${ADVANCED_QUERY_LIMIT} 个字符（当前 ${codepoints}），请精简条件后再提交。`
                : isEmpty
                  ? '请至少填写一个筛选条件后才能提交。'
                  : '将按「包含词语 → 短语 → 排除词 → site: → lang: → after:/before:」的顺序用单个空格拼成最终查询。'}
            </p>
          </div>

          <div className="advanced-actions">
            <button
              type="button"
              className="advanced-reset"
              data-testid="advanced-reset"
              onClick={handleReset}
            >
              重置
            </button>
            <button
              type="submit"
              className="advanced-submit"
              data-testid="advanced-submit"
              disabled={!canSubmit}
            >
              搜索
            </button>
          </div>
        </form>
      </main>

      <footer className="serp-footer">
        <p>由 DeepSeek Search API 提供 · 按成功请求计费</p>
      </footer>
    </div>
  );
}
