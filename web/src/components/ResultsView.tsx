import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import { Settings } from 'lucide-react';
import { useAiSummary } from '../hooks/useAiSummary';
import { searchWeb, toApiError } from '../lib/api';
import type { ApiError } from '../lib/api';
import { describeError } from '../lib/errors';
import { formatNumber, formatTook } from '../lib/format';
import type {
  AiMode,
  AiSettings,
  HealthResponse,
  SearchResponse,
  SearchResult,
  Theme,
} from '../lib/types';
import { classNames } from '../lib/utils';
import { AiSummaryCard } from './AiSummaryCard';
import { Button } from './Button';
import { ErrorCard } from './ErrorCard';
import { FetchDrawer } from './FetchDrawer';
import { KeyNotice } from './KeyNotice';
import { Logo } from './Logo';
import { ResultCard } from './ResultCard';
import { ResultSkeletons } from './Skeletons';
import { SearchBar } from './SearchBar';
import { ThemeToggle } from './ThemeToggle';

type SearchState =
  | { status: 'loading' }
  | { status: 'success'; data: SearchResponse }
  | { status: 'error'; error: ApiError }
  | { status: 'no-key' }
  | { status: 'empty-query' };

type SerpTab = 'all' | 'ai';

const listVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
};

interface ResultsViewProps {
  query: string;
  count: number;
  aiMode: AiMode;
  reloadToken: number;
  apiKey: string;
  accessToken: string;
  settings: AiSettings;
  health: HealthResponse | null;
  theme: Theme;
  onToggleTheme: () => void;
  onSearch: (query: string) => void;
  onHome: () => void;
  onOpenSettings: () => void;
  onAdvanced: () => void;
}

function preferredScrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/** Google SERP：sticky 搜索头 + tabs + 扁平结果列表 + AI Overview 区块。 */
export function ResultsView({
  query,
  count,
  aiMode,
  reloadToken,
  apiKey,
  accessToken,
  settings,
  health,
  theme,
  onToggleTheme,
  onSearch,
  onHome,
  onOpenSettings,
  onAdvanced,
}: ResultsViewProps) {
  const trimmedQuery = query.trim();
  const [searchState, setSearchState] = useState<SearchState>({ status: 'loading' });
  const [retryToken, setRetryToken] = useState(0);
  const [drawerResult, setDrawerResult] = useState<SearchResult | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SerpTab>('all');
  const [scrolled, setScrolled] = useState(false);
  const autoRunRef = useRef<string | null>(null);
  const aiRef = useRef<HTMLDivElement>(null);

  // 滚动后压缩 header，让液态玻璃层从“浮起”过渡到“贴顶”。
  useEffect(() => {
    const handleScroll = (): void => setScrolled(window.scrollY > 6);
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const ai = useAiSummary({
    apiKey,
    accessToken,
    model: settings.model,
    thinking: settings.thinking,
  });
  const { reset: resetAi, start: startAi } = ai;
  const aiEnabled = health === null || health.features.ai !== false;

  // 搜索：URL(q/count) 变化、显式重试或同 URL 重新提交时请求。
  useEffect(() => {
    resetAi();
    if (!trimmedQuery) {
      setSearchState({ status: 'empty-query' });
      return;
    }
    if (!apiKey) {
      setSearchState({ status: 'no-key' });
      return;
    }

    const controller = new AbortController();
    setSearchState({ status: 'loading' });
    window.scrollTo({ top: 0 });

    void (async () => {
      try {
        const data = await searchWeb({
          query: trimmedQuery,
          count,
          apiKey,
          accessToken: accessToken || undefined,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSearchState({ status: 'success', data });
      } catch (error) {
        if (controller.signal.aborted) return;
        setSearchState({ status: 'error', error: toApiError(error) });
      }
    })();

    return () => controller.abort();
  }, [trimmedQuery, count, reloadToken, retryToken, apiKey, accessToken, resetAi]);

  // 自动模式：搜索成功后自动生成一次 AI 总结（同一请求只触发一次）。
  useEffect(() => {
    if (searchState.status !== 'success') return;
    if (searchState.data.results.length === 0) return;
    if (aiMode !== 'auto' || !aiEnabled) return;
    const runKey = [trimmedQuery, count, reloadToken, retryToken].join('|');
    if (autoRunRef.current === runKey) return;
    autoRunRef.current = runKey;
    void startAi(trimmedQuery, searchState.data.results);
  }, [searchState, aiMode, aiEnabled, trimmedQuery, count, reloadToken, retryToken, startAi]);

  // 换一次搜索时关闭抓取抽屉（抽屉退出动画结束后再清空 result）。
  useEffect(() => {
    setDrawerOpen(false);
    setActiveTab('all');
  }, [trimmedQuery, count, reloadToken, retryToken]);

  const handleGenerate = useCallback((): void => {
    if (!aiEnabled || searchState.status !== 'success') return;
    if (searchState.data.results.length === 0) return;
    void startAi(trimmedQuery, searchState.data.results);
  }, [aiEnabled, searchState, startAi, trimmedQuery]);

  const openDrawer = useCallback((result: SearchResult): void => {
    setDrawerResult(result);
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback((): void => {
    setDrawerOpen(false);
  }, []);

  const handleDrawerExited = useCallback((): void => {
    setDrawerResult(null);
  }, []);

  const focusSearch = (): void => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="search-input"]');
    input?.focus();
    input?.select();
  };

  const results = searchState.status === 'success' ? searchState.data.results : [];
  const showAiCard = searchState.status === 'success' && results.length > 0;

  const handleAllTab = (): void => {
    setActiveTab('all');
    window.scrollTo({ top: 0, behavior: preferredScrollBehavior() });
  };

  const handleAiTab = (): void => {
    if (!showAiCard) return;
    setActiveTab('ai');
    aiRef.current?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' });
  };

  return (
    <div className="results-view">
      <header className={classNames('serp-header', scrolled && 'serp-header--scrolled')}>
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
              <SearchBar variant="compact" initialValue={trimmedQuery} onSearch={onSearch} />
            </div>
            <div className="serp-header__actions">
              <ThemeToggle theme={theme} onToggle={onToggleTheme} />
              <button
                type="button"
                className="icon-btn serp-settings"
                data-testid="settings-button"
                onClick={onOpenSettings}
                aria-label="设置"
                title="设置"
              >
                <Settings size={20} aria-hidden="true" />
              </button>
            </div>
          </div>

          <nav className="serp-tabs" aria-label="结果分类">
            <button
              type="button"
              className={classNames('serp-tab', activeTab === 'all' && 'serp-tab--active')}
              aria-current={activeTab === 'all' ? 'page' : undefined}
              onClick={handleAllTab}
            >
              全部
            </button>
            <button
              type="button"
              className={classNames('serp-tab', activeTab === 'ai' && 'serp-tab--active')}
              aria-current={activeTab === 'ai' ? 'page' : undefined}
              onClick={handleAiTab}
              disabled={!showAiCard}
            >
              AI 总结
            </button>
            <button
              type="button"
              className="serp-advanced-link"
              data-testid="advanced-search-link-header"
              onClick={onAdvanced}
            >
              高级搜索
            </button>
          </nav>
        </div>
      </header>

      <main id="main" className="results-main" tabIndex={-1}>
        <div className="serp-column">
          <div className="serp-stats" aria-live="polite">
            {searchState.status === 'loading' ? (
              <p className="serp-stats__loading">
                <span className="serp-spinner" aria-hidden="true" />
                正在搜索 “{trimmedQuery}”…
              </p>
            ) : null}

            {searchState.status === 'success' ? (
              <>
                <h1 className="visually-hidden">“{trimmedQuery}” 的搜索结果</h1>
                <p className="serp-stats__text">
                  找到约 {formatNumber(searchState.data.meta.count)} 条结果
                  {formatTook(searchState.data.meta.tookMs)
                    ? `（用时 ${formatTook(searchState.data.meta.tookMs)}）`
                    : ''}
                </p>
              </>
            ) : null}

            {searchState.status === 'error' ? (
              <h1 className="visually-hidden">“{trimmedQuery}” 的搜索结果</h1>
            ) : null}

            {searchState.status === 'no-key' || searchState.status === 'empty-query' ? (
              <h1 className="visually-hidden">搜索</h1>
            ) : null}
          </div>

          {showAiCard ? (
            <div className="serp-ai" ref={aiRef}>
              <AiSummaryCard
                state={ai.state}
                aiEnabled={aiEnabled}
                thinking={settings.thinking}
                onGenerate={handleGenerate}
                onStop={ai.stop}
                onOpenSettings={onOpenSettings}
              />
            </div>
          ) : null}

          {searchState.status === 'loading' ? (
            <ResultSkeletons count={Math.min(5, Math.max(1, count))} />
          ) : null}

          {searchState.status === 'no-key' ? (
            <div className="serp-empty">
              <p className="serp-empty__text">尚未配置 DeepSeek API Key，搜索已被阻止。</p>
              <KeyNotice compact onOpenSettings={onOpenSettings} />
            </div>
          ) : null}

          {searchState.status === 'empty-query' ? (
            <div className="serp-empty" role="status">
              <h2 className="serp-empty__title">输入关键词开始搜索</h2>
              <p className="serp-empty__text">
                支持 <code>site:example.com</code>、<code>lang:zh</code> 等搜索操作符。
              </p>
              <div className="serp-empty__actions">
                <Button variant="secondary" onClick={focusSearch}>
                  开始搜索
                </Button>
                <Button variant="primary" className="serp-empty__link" onClick={onHome}>
                  回首页
                </Button>
              </div>
            </div>
          ) : null}

          {searchState.status === 'error' ? (
            <ErrorCard
              description={describeError(searchState.error)}
              onRetry={() => setRetryToken((token) => token + 1)}
              onOpenSettings={onOpenSettings}
            />
          ) : null}

          {searchState.status === 'success' && results.length === 0 ? (
            <div className="serp-empty" role="status">
              <h2 className="serp-empty__title">
                没有找到与 “{trimmedQuery}” 相关的结果
              </h2>
              <p className="serp-empty__text">
                建议：检查拼写、尝试更短的关键词，或去掉 <code>site:</code> 等限定条件。
              </p>
              <div className="serp-empty__actions">
                <Button variant="secondary" onClick={focusSearch}>
                  修改搜索
                </Button>
                <Button variant="primary" className="serp-empty__link" onClick={onHome}>
                  回首页
                </Button>
              </div>
            </div>
          ) : null}

          {searchState.status === 'success' && results.length > 0 ? (
            <motion.div
              key={`${trimmedQuery}|${count}|${reloadToken}|${retryToken}`}
              className="serp-result-list"
              aria-label="搜索结果"
              variants={listVariants}
              initial="hidden"
              animate="show"
            >
              {results.map((result, index) => (
                <ResultCard
                  key={`${result.url}-${index}`}
                  result={result}
                  index={index}
                  onOpenFetch={openDrawer}
                />
              ))}
            </motion.div>
          ) : null}
        </div>
      </main>

      <footer className="serp-footer">
        <p>由 DeepSeek Search API 提供 · 按成功请求计费</p>
      </footer>

      <FetchDrawer
        open={drawerOpen}
        result={drawerResult}
        apiKey={apiKey}
        accessToken={accessToken}
        onClose={closeDrawer}
        onExited={handleDrawerExited}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}
