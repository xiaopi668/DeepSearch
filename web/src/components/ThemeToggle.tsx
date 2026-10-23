import { Moon, Sun } from 'lucide-react';
import type { Theme } from '../lib/types';
import { classNames } from '../lib/utils';

interface ThemeToggleProps {
  theme: Theme;
  onToggle: () => void;
  className?: string;
}

/**
 * 明暗主题切换（日/月图标）。
 * 深色主题下显示太阳（点击切浅色），浅色主题下显示月亮（点击切深色）。
 */
export function ThemeToggle({ theme, onToggle, className }: ThemeToggleProps) {
  const isDark = theme === 'dark';
  const label = isDark ? '切换到浅色主题' : '切换到深色主题';

  return (
    <button
      type="button"
      className={classNames('icon-btn', 'theme-toggle', className)}
      data-testid="theme-toggle"
      onClick={onToggle}
      aria-label={label}
      title={label}
    >
      {isDark ? <Sun size={20} aria-hidden="true" /> : <Moon size={20} aria-hidden="true" />}
    </button>
  );
}
