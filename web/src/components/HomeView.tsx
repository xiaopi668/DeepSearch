import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import { Grip, Info, Keyboard, Moon, Settings, Sun } from 'lucide-react';
import type { AiMode, Theme } from '../lib/types';
import { InfoDialog } from './InfoDialog';
import { Logo } from './Logo';
import { SearchBar } from './SearchBar';
import { ThemeToggle } from './ThemeToggle';

/** 首页快捷入口的「更多」菜单与信息弹窗；不包含任何外部计费链接。 */
type InfoDialogKind = 'shortcuts' | 'about' | null;

interface HomeViewProps {
  theme: Theme;
  aiMode: AiMode;
  onToggleTheme: () => void;
  onToggleAiMode: () => void;
  onSearch: (query: string) => void;
  onOpenSettings: () => void;
  onAdvanced: () => void;
}

const containerVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } },
};

/**
 * Google 深色首页式布局（映射为真实功能）：
 * 顶栏快捷链接 + 更多菜单 + 设置药丸；主区只保留白色字标与宽搜索框
 * （左侧高级搜索、右侧清除 X + AI 模式药丸 + 放大镜提交），搜索框下方无其他内容。
 */
export function HomeView({
  theme,
  aiMode,
  onToggleTheme,
  onToggleAiMode,
  onSearch,
  onOpenSettings,
  onAdvanced,
}: HomeViewProps) {
  const [appsOpen, setAppsOpen] = useState(false);
  const [infoDialog, setInfoDialog] = useState<InfoDialogKind>(null);
  const appsRootRef = useRef<HTMLDivElement>(null);
  const appsButtonRef = useRef<HTMLButtonElement>(null);
  const appsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!appsOpen) return;

    const handlePointerDown = (event: PointerEvent): void => {
      if (appsRootRef.current?.contains(event.target as Node)) return;
      setAppsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setAppsOpen(false);
      appsButtonRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    const rafId = window.requestAnimationFrame(() => {
      appsMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.cancelAnimationFrame(rafId);
    };
  }, [appsOpen]);

  const openInfoDialog = (kind: Exclude<InfoDialogKind, null>): void => {
    setAppsOpen(false);
    setInfoDialog(kind);
  };

  return (
    <div className="home-view">
      <header className="home-topbar" aria-label="首页快捷入口">
        <a
          className="home-topbar__link"
          href="/advanced"
          data-testid="advanced-search-link"
          onClick={(event) => {
            event.preventDefault();
            onAdvanced();
          }}
        >
          高级搜索
        </a>

        <div className="home-topbar__apps" ref={appsRootRef}>
          <button
            ref={appsButtonRef}
            type="button"
            className="icon-btn apps-button"
            data-testid="apps-menu-button"
            aria-haspopup="menu"
            aria-expanded={appsOpen}
            aria-label="更多"
            title="更多"
            onClick={() => setAppsOpen((previous) => !previous)}
          >
            <Grip size={20} aria-hidden="true" />
          </button>

          {appsOpen ? (
            <div
              ref={appsMenuRef}
              className="apps-menu"
              role="menu"
              aria-label="更多选项"
              data-testid="apps-menu"
            >
              <button
                type="button"
                role="menuitem"
                className="apps-menu__item"
                data-testid="apps-menu-settings"
                onClick={() => {
                  setAppsOpen(false);
                  onOpenSettings();
                }}
              >
                <Settings size={16} aria-hidden="true" />
                设置
              </button>
              <button
                type="button"
                role="menuitem"
                className="apps-menu__item"
                data-testid="apps-menu-theme"
                onClick={() => {
                  setAppsOpen(false);
                  onToggleTheme();
                }}
              >
                {theme === 'dark' ? (
                  <Sun size={16} aria-hidden="true" />
                ) : (
                  <Moon size={16} aria-hidden="true" />
                )}
                切换主题
              </button>
              <button
                type="button"
                role="menuitem"
                className="apps-menu__item"
                data-testid="apps-menu-shortcuts"
                onClick={() => openInfoDialog('shortcuts')}
              >
                <Keyboard size={16} aria-hidden="true" />
                键盘快捷键
              </button>
              <button
                type="button"
                role="menuitem"
                className="apps-menu__item"
                data-testid="apps-menu-about"
                onClick={() => openInfoDialog('about')}
              >
                <Info size={16} aria-hidden="true" />
                关于 DeepSearch
              </button>
            </div>
          ) : null}
        </div>

        <ThemeToggle theme={theme} onToggle={onToggleTheme} />

        <button
          type="button"
          className="settings-pill"
          data-testid="settings-button"
          onClick={onOpenSettings}
        >
          设置
        </button>
      </header>

      <main id="main" className="home-main" tabIndex={-1}>
        <motion.div className="home-content" variants={containerVariants} initial="hidden" animate="show">
          <motion.div variants={itemVariants} className="home-logo">
            <Logo size="lg" />
          </motion.div>

          <motion.div variants={itemVariants} className="home-search">
            <SearchBar
              variant="hero"
              initialValue=""
              onSearch={onSearch}
              onAdvanced={onAdvanced}
              aiMode={aiMode}
              onToggleAiMode={onToggleAiMode}
            />
          </motion.div>
        </motion.div>
      </main>

      <InfoDialog
        open={infoDialog === 'shortcuts'}
        title="键盘快捷键"
        onClose={() => setInfoDialog(null)}
        testId="shortcuts-dialog"
      >
        <ul className="shortcut-list">
          <li>
            <span>聚焦搜索框</span>
            <span className="shortcut-keys">
              <kbd>/</kbd>
              <span>或</span>
              <kbd>Ctrl</kbd>
              <kbd>K</kbd>
            </span>
          </li>
          <li>
            <span>提交搜索</span>
            <span className="shortcut-keys">
              <kbd>Enter</kbd>
            </span>
          </li>
          <li>
            <span>关闭弹窗 / 抽屉</span>
            <span className="shortcut-keys">
              <kbd>Esc</kbd>
            </span>
          </li>
        </ul>
        <p className="info-dialog__hint">在首页与结果页均可使用这些快捷键。</p>
      </InfoDialog>

      <InfoDialog
        open={infoDialog === 'about'}
        title="关于 DeepSearch"
        onClose={() => setInfoDialog(null)}
        testId="about-dialog"
      >
        <p>
          DeepSearch 是一个调用 DeepSeek 搜索 API 的网页搜索引擎，支持普通搜索与高级搜索操作符。
        </p>
        <p>
          每位访客使用自己的 DeepSeek API Key（BYOK）：Key 只保存在本浏览器，搜索时经本站服务转发给
          DeepSeek，不写入服务器。
        </p>
        <p className="info-dialog__meta">版本 v1 · 按成功请求计费</p>
      </InfoDialog>
    </div>
  );
}
