import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Plus, Search, Sparkles, X } from 'lucide-react';
import type { AiMode } from '../lib/types';
import { classNames } from '../lib/utils';

interface SearchBarProps {
  initialValue: string;
  onSearch: (query: string) => void;
  variant: 'hero' | 'compact';
  /** 首页左侧「+」按钮：打开高级搜索页。 */
  onAdvanced?: () => void;
  /** 首页右侧 AI 模式药丸状态（settings.aiMode）。 */
  aiMode?: AiMode;
  onToggleAiMode?: () => void;
}

const MAX_INPUT_LENGTH = 256;

/**
 * Google 式搜索框：
 * - hero：首页宽胶囊（左侧 + 高级搜索、右侧清除 X + AI 模式药丸 + 放大镜提交）。
 * - compact：结果页/高级页页头紧凑栏（左侧放大镜 + 内嵌搜索按钮）。
 * 键盘快捷键：`/` 或 Ctrl/Cmd+K 聚焦（弹窗打开时禁用）。
 */
export function SearchBar({
  initialValue,
  onSearch,
  variant,
  onAdvanced,
  aiMode,
  onToggleAiMode,
}: SearchBarProps) {
  const [value, setValue] = useState(initialValue);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    const focusInput = (): void => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;

      const target = event.target instanceof HTMLElement ? event.target : null;
      const isTyping =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      const isCommandK =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        (event.key === 'k' || event.key === 'K');
      if (isCommandK) {
        event.preventDefault();
        focusInput();
        return;
      }

      if (event.key === '/' && !isTyping && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        focusInput();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const query = value.trim();
    if (!query) {
      inputRef.current?.focus();
      return;
    }
    onSearch(query);
  };

  const clear = (): void => {
    setValue('');
    inputRef.current?.focus();
  };

  const showAiPill = variant === 'hero' && aiMode !== undefined && onToggleAiMode !== undefined;

  return (
    <form
      className={classNames('search-form', `search-form--${variant}`)}
      role="search"
      onSubmit={submit}
    >
      <div
        className={classNames(
          'searchbar',
          `searchbar--${variant}`,
          focused && 'searchbar--focused',
        )}
      >
        {variant === 'hero' ? (
          onAdvanced ? (
            <button
              type="button"
              className="searchbar__plus"
              data-testid="search-plus-button"
              onClick={onAdvanced}
              aria-label="高级搜索"
              title="高级搜索"
            >
              <Plus size={22} aria-hidden="true" />
            </button>
          ) : null
        ) : (
          <Search className="searchbar__icon" size={20} aria-hidden="true" />
        )}

        <input
          ref={inputRef}
          className="searchbar__input"
          data-testid="search-input"
          type="text"
          inputMode="search"
          enterKeyHint="search"
          value={value}
          maxLength={MAX_INPUT_LENGTH}
          onChange={(event) => setValue(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={variant === 'hero' ? '搜索网页，可用 site: 限定站点' : '搜索网页…'}
          aria-label="搜索关键词"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />

        {value.length > 0 ? (
          <button
            type="button"
            className="searchbar__clear"
            aria-label="清除搜索内容"
            onClick={clear}
          >
            <X size={18} aria-hidden="true" />
          </button>
        ) : null}

        {showAiPill ? (
          <button
            type="button"
            className={classNames(
              'searchbar__ai-pill',
              aiMode === 'auto' && 'searchbar__ai-pill--active',
            )}
            data-testid="ai-mode-pill"
            aria-pressed={aiMode === 'auto'}
            aria-label="AI 模式：开启后搜索完自动生成 AI 总结"
            title="开启后搜索完自动生成 AI 总结"
            onClick={onToggleAiMode}
          >
            <Sparkles size={15} aria-hidden="true" />
            AI 模式
          </button>
        ) : null}

        {variant === 'compact' ? (
          <button
            type="submit"
            className="searchbar__submit"
            data-testid="search-submit"
            aria-label="搜索"
          >
            <Search size={18} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            className="searchbar__home-submit"
            data-testid="home-search-submit"
            aria-label="搜索"
            disabled={value.trim().length === 0}
          >
            <Search size={20} aria-hidden="true" />
          </button>
        )}
      </div>
    </form>
  );
}
