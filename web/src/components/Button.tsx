import type { ComponentProps } from 'react';
import { LoaderCircle } from 'lucide-react';
import { classNames } from '../lib/utils';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';

interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  loading?: boolean;
}

/** 通用按钮：CSS 按压反馈 + 一致的尺寸/配色。 */
export function Button({
  variant = 'secondary',
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={classNames('btn', `btn--${variant}`, loading && 'is-loading', className)}
    >
      {loading ? <LoaderCircle className="btn__spinner" size={16} aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
