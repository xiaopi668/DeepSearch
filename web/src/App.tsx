import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { AdvancedView } from './components/AdvancedView';
import { HomeView } from './components/HomeView';
import { ResultsView } from './components/ResultsView';
import { SettingsModal } from './components/SettingsModal';
import { useMaterialRipple } from './hooks/useMaterialRipple';
import { ToastProvider, useToast } from './components/Toasts';
import { getHealth, isAbortError } from './lib/api';
import {
  clearLocalData,
  hasSeenWelcome,
  loadAccessToken,
  loadApiKey,
  loadSettings,
  loadTheme,
  loadThemeSeed,
  markWelcomeSeen,
  rememberSearch,
  saveAccessToken,
  saveApiKey,
  saveSettings,
  saveTheme,
  saveThemeSeed,
} from './lib/storage';
import { applyMaterialYou, DEFAULT_THEME_SEED, normalizeThemeSeed } from './lib/theme';
import { DEFAULT_SETTINGS } from './lib/types';
import type {
  AiMode,
  AiSettings,
  BackendStatus,
  HealthResponse,
  Route,
  Theme,
} from './lib/types';
import { clamp } from './lib/utils';

function resolveAiMode(aiParam: string | null, fallback: AiMode): AiMode {
  if (aiParam === 'auto' || aiParam === '1' || aiParam === 'true') return 'auto';
  if (aiParam === 'manual' || aiParam === '0' || aiParam === 'false') return 'manual';
  return fallback;
}

/** 从 URL 解析路由（/ 首页，/advanced 高级搜索，/search?q=…&count=…&ai=… 结果页）。 */
function readRoute(): Route {
  const { pathname, search } = window.location;
  if (pathname === '/advanced' || pathname === '/advanced/') {
    return { view: 'advanced' };
  }
  if (pathname === '/search' || pathname === '/search/') {
    const params = new URLSearchParams(search);
    const query = (params.get('q') ?? '').trim();
    const rawCount = params.get('count');
    const parsedCount = rawCount === null ? Number.NaN : Number.parseInt(rawCount, 10);
    const storedSettings = loadSettings();
    const count = Number.isFinite(parsedCount) ? clamp(parsedCount, 1, 50) : storedSettings.count;
    const aiParam = params.get('ai');
    return {
      view: 'search',
      query,
      count,
      ai: resolveAiMode(aiParam, storedSettings.aiMode),
      aiParam,
    };
  }
  return { view: 'home' };
}

function AppShell() {
  const { pushToast } = useToast();
  useMaterialRipple();

  const [route, setRoute] = useState<Route>(readRoute);
  const [reloadToken, setReloadToken] = useState(0);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [themeSeed, setThemeSeed] = useState<string>(() => loadThemeSeed());
  const [apiKey, setApiKey] = useState<string>(() => loadApiKey());
  const [accessToken, setAccessToken] = useState<string>(() => loadAccessToken());
  const [settings, setSettings] = useState<AiSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>('unknown');
  const welcomeCheckedRef = useRef(false);

  // 主题：同步 <html data-theme> 与 meta theme-color。
  // index.html 静态 data-theme="dark" 兜底首屏；useLayoutEffect 在绘制前应用已存主题，避免闪烁。
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    const { surface } = applyMaterialYou(themeSeed, theme);
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = surface;
  }, [theme, themeSeed]);

  const handleChangeThemeSeed = useCallback((seed: string): void => {
    const next = normalizeThemeSeed(seed);
    saveThemeSeed(next);
    setThemeSeed(next);
  }, []);

  const handleToggleTheme = useCallback((): void => {
    setTheme((previous) => {
      const next: Theme = previous === 'dark' ? 'light' : 'dark';
      saveTheme(next);
      return next;
    });
  }, []);

  // 浏览器前进/后退。
  useEffect(() => {
    const handlePopState = (): void => setRoute(readRoute());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // 未知路径回落到首页（生产环境由后端 SPA 回退兜底）。
  useEffect(() => {
    const { pathname } = window.location;
    if (
      pathname !== '/' &&
      pathname !== '/search' &&
      pathname !== '/search/' &&
      pathname !== '/advanced' &&
      pathname !== '/advanced/'
    ) {
      window.history.replaceState(null, '', '/');
    }
  }, []);

  // 启动探活（无鉴权），用于设置面板展示服务状态与访问口令需求。
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await getHealth(controller.signal);
        if (controller.signal.aborted) return;
        setHealth(result);
        setBackendStatus(result.ok ? 'online' : 'offline');
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        setHealth(null);
        setBackendStatus('offline');
      }
    })();
    return () => controller.abort();
  }, []);

  // 首次访问且没有 Key：自动打开一次设置（welcomeSeen 标记只弹一次）。
  useEffect(() => {
    if (welcomeCheckedRef.current) return;
    welcomeCheckedRef.current = true;
    if (!apiKey && !hasSeenWelcome()) {
      markWelcomeSeen();
      setSettingsOpen(true);
    }
  }, [apiKey]);

  const navigate = useCallback((to: string): void => {
    const current = `${window.location.pathname}${window.location.search}`;
    if (current === to) {
      setReloadToken((token) => token + 1);
      return;
    }
    window.history.pushState(null, '', to);
    setRoute(readRoute());
  }, []);

  const goHome = useCallback((): void => {
    window.scrollTo(0, 0);
    navigate('/');
  }, [navigate]);

  const goAdvanced = useCallback((): void => {
    window.scrollTo(0, 0);
    navigate('/advanced');
  }, [navigate]);

  const handleAdvancedSubmit = useCallback(
    (query: string, count: number): void => {
      const trimmed = query.trim();
      if (!trimmed) return;
      if (Array.from(trimmed).length > 128) {
        pushToast('搜索词最多 128 个字符', 'error');
        return;
      }
      if (!apiKey) {
        setSettingsOpen(true);
        pushToast('请先设置 DeepSeek API Key', 'error');
        return;
      }
      rememberSearch(trimmed);
      const params = new URLSearchParams({
        q: trimmed,
        count: String(count),
        ai: settings.aiMode,
      });
      window.scrollTo(0, 0);
      navigate(`/search?${params.toString()}`);
    },
    [apiKey, navigate, pushToast, settings.aiMode],
  );

  const handleSearch = useCallback(
    (rawQuery: string): void => {
      const query = rawQuery.trim();
      if (!query) {
        pushToast('请输入搜索内容', 'info');
        return;
      }
      if (Array.from(query).length > 128) {
        pushToast('搜索词最多 128 个字符', 'error');
        return;
      }
      if (!apiKey) {
        setSettingsOpen(true);
        pushToast('请先设置 DeepSeek API Key', 'error');
        return;
      }
      rememberSearch(query);
      const params = new URLSearchParams({
        q: query,
        count: String(settings.count),
        ai: settings.aiMode,
      });
      window.scrollTo(0, 0);
      navigate(`/search?${params.toString()}`);
    },
    [apiKey, navigate, pushToast, settings.aiMode, settings.count],
  );

  const handleOpenSettings = useCallback((): void => setSettingsOpen(true), []);
  const handleCloseSettings = useCallback((): void => setSettingsOpen(false), []);

  const handleSaveKey = useCallback(
    (key: string): void => {
      const trimmed = key.trim();
      const hadKey = apiKey.length > 0;
      saveApiKey(trimmed);
      setApiKey(trimmed);
      if (trimmed) pushToast('API Key 已保存到本浏览器', 'success');
      else if (hadKey) pushToast('已移除 API Key', 'success');
    },
    [apiKey, pushToast],
  );

  const handleSaveAccessToken = useCallback((token: string): void => {
    const trimmed = token.trim();
    saveAccessToken(trimmed);
    setAccessToken(trimmed);
  }, []);

  const handleChangeSettings = useCallback((patch: Partial<AiSettings>): void => {
    setSettings((previous) => {
      const next = { ...previous, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  // 首页搜索框右侧「AI 模式」药丸：切换并持久化 settings.aiMode。
  const handleToggleAiMode = useCallback((): void => {
    setSettings((previous) => {
      const next: AiSettings = {
        ...previous,
        aiMode: previous.aiMode === 'auto' ? 'manual' : 'auto',
      };
      saveSettings(next);
      return next;
    });
  }, []);

  const handleClearData = useCallback((): void => {
    clearLocalData();
    setApiKey('');
    setAccessToken('');
    setSettings({ ...DEFAULT_SETTINGS });
    setTheme('dark');
    setThemeSeed(DEFAULT_THEME_SEED);
    setSettingsOpen(false);
    pushToast('已清空本地数据', 'success');
    if (route.view === 'search') goHome();
  }, [goHome, pushToast, route.view]);

  return (
    <MotionConfig reducedMotion="user">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>
      <div className="app">
        {route.view === 'home' ? (
          <HomeView
            theme={theme}
            aiMode={settings.aiMode}
            onToggleTheme={handleToggleTheme}
            onToggleAiMode={handleToggleAiMode}
            onSearch={handleSearch}
            onOpenSettings={handleOpenSettings}
            onAdvanced={goAdvanced}
          />
        ) : route.view === 'advanced' ? (
          <AdvancedView
            theme={theme}
            onToggleTheme={handleToggleTheme}
            onSearch={handleSearch}
            onHome={goHome}
            onOpenSettings={handleOpenSettings}
            onSubmit={handleAdvancedSubmit}
          />
        ) : (
          <ResultsView
            query={route.query}
            count={route.count}
            aiMode={route.ai}
            reloadToken={reloadToken}
            apiKey={apiKey}
            accessToken={accessToken}
            settings={settings}
            health={health}
            theme={theme}
            onToggleTheme={handleToggleTheme}
            onSearch={handleSearch}
            onHome={goHome}
            onOpenSettings={handleOpenSettings}
            onAdvanced={goAdvanced}
          />
        )}

        <SettingsModal
          open={settingsOpen}
          apiKey={apiKey}
          accessToken={accessToken}
          accessTokenRequired={health?.auth.accessTokenRequired ?? false}
          settings={settings}
          backendStatus={backendStatus}
          backendVersion={health?.version ?? ''}
          onClose={handleCloseSettings}
          onSaveKey={handleSaveKey}
          onSaveAccessToken={handleSaveAccessToken}
          themeSeed={themeSeed}
          onChangeThemeSeed={handleChangeThemeSeed}
          onChangeSettings={handleChangeSettings}
          onClearData={handleClearData}
        />
      </div>
    </MotionConfig>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}
