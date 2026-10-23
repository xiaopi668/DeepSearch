import { CircleAlert } from 'lucide-react';
import type { ErrorDescription } from '../lib/errors';
import { Button } from './Button';

interface ErrorCardProps {
  description: ErrorDescription;
  onRetry: () => void;
  onOpenSettings: () => void;
}

/** 搜索失败时的扁平错误提示（无卡片外框，Google 灰按钮 / 蓝色文字动作）。 */
export function ErrorCard({ description, onRetry, onOpenSettings }: ErrorCardProps) {
  const action = description.action === 'settings' ? onOpenSettings : onRetry;
  return (
    <div className="serp-error" role="alert">
      <span className="serp-error__icon" aria-hidden="true">
        <CircleAlert size={20} />
      </span>
      <div className="serp-error__body">
        <h2 className="serp-error__title">{description.title}</h2>
        <p className="serp-error__message">{description.message}</p>
        {description.requestId ? (
          <p className="serp-error__request">请求 ID：{description.requestId}</p>
        ) : null}
        {description.actionLabel ? (
          <div className="serp-error__actions">
            <Button
              variant={description.action === 'settings' ? 'primary' : 'secondary'}
              className={description.action === 'settings' ? 'serp-error__link' : 'serp-error__retry'}
              onClick={action}
            >
              {description.actionLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
