import { classNames } from '../lib/utils';

const WORDMARK = 'DeepSearch';

interface LogoProps {
  size?: 'lg' | 'md' | 'sm';
  /** 单色字标：默认深灰（Google 灰字标），可选蓝色（Google 蓝） */
  tone?: 'gray' | 'blue';
  className?: string;
}

/**
 * 单色 Wordmark。默认使用 Google 深灰字标（#3c4043），
 * 可通过 tone="blue" 切换为 Google 蓝（#4285f4）。
 */
export function Logo({ size = 'md', tone = 'gray', className }: LogoProps) {
  return (
    <span
      className={classNames('logo-word', `logo-word--${size}`, `logo-word--${tone}`, className)}
      role="img"
      aria-label="DeepSearch"
    >
      <span className="logo-word__text" aria-hidden="true">
        {WORDMARK}
      </span>
    </span>
  );
}
