import type { CSSProperties } from 'react';
import { classNames } from '../lib/utils';

interface SkeletonLineProps {
  width?: string;
  height?: number;
  className?: string;
  style?: CSSProperties;
}

export function SkeletonLine({ width = '100%', height = 14, className, style }: SkeletonLineProps) {
  return (
    <span
      className={classNames('skeleton-shimmer', className)}
      style={{ width, height, ...style }}
      aria-hidden="true"
    />
  );
}

/** 搜索结果加载中的卡片骨架。 */
export function ResultSkeletons({ count = 5 }: { count?: number }) {
  return (
    <div className="result-skeletons" aria-busy="true" aria-label="正在加载搜索结果">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton-card" key={index} aria-hidden="true">
          <div className="skeleton-card__meta">
            <SkeletonLine width="22px" height={22} className="skeleton-shimmer--circle" />
            <SkeletonLine width="132px" height={12} />
            <SkeletonLine width="72px" height={12} />
          </div>
          <SkeletonLine width="72%" height={20} />
          <SkeletonLine width="96%" height={14} />
          <SkeletonLine width="88%" height={14} />
          <SkeletonLine width="56%" height={14} />
        </div>
      ))}
    </div>
  );
}

/** AI 总结首字之前的等待骨架。 */
export function AiStreamingSkeleton() {
  return (
    <div className="ai-skeleton" aria-hidden="true">
      <SkeletonLine width="92%" height={14} />
      <SkeletonLine width="84%" height={14} />
      <SkeletonLine width="64%" height={14} />
    </div>
  );
}

/** 抓取抽屉正文加载骨架。 */
export function DrawerSkeleton() {
  return (
    <div className="drawer-skeleton" aria-busy="true" aria-label="正在抓取网页正文">
      <SkeletonLine width="42%" height={24} />
      <SkeletonLine width="70%" height={14} />
      <div className="drawer-skeleton__gap" />
      <SkeletonLine width="100%" height={14} />
      <SkeletonLine width="94%" height={14} />
      <SkeletonLine width="98%" height={14} />
      <SkeletonLine width="60%" height={14} />
      <div className="drawer-skeleton__gap" />
      <SkeletonLine width="100%" height={14} />
      <SkeletonLine width="88%" height={14} />
      <SkeletonLine width="92%" height={14} />
      <SkeletonLine width="45%" height={14} />
    </div>
  );
}
