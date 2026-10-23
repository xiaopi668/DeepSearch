import { TriangleAlert } from 'lucide-react';
import { classNames } from '../lib/utils';
import { Button } from './Button';

interface KeyNoticeProps {
  onOpenSettings: () => void;
  compact?: boolean;
  className?: string;
}

/** 未配置 API Key 时的引导横幅（首页 / 结果页复用）。 */
export function KeyNotice({ onOpenSettings, compact = false, className }: KeyNoticeProps) {
  return (
    <div className={classNames('key-notice', compact && 'key-notice--compact', className)} role="note">
      <TriangleAlert className="key-notice__icon" size={compact ? 20 : 24} aria-hidden="true" />
      <div className="key-notice__body">
        <p className="key-notice__title">先设置你的 DeepSeek API Key</p>
        <p className="key-notice__text">Key 只保存在本浏览器，不会写入服务器。</p>
      </div>
      <Button variant="primary" className="key-notice__action" onClick={onOpenSettings}>
        去设置
      </Button>
    </div>
  );
}
