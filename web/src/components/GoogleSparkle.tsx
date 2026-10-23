import { useId } from 'react';

interface GoogleSparkleProps {
  size?: number;
  className?: string;
}

const STAR =
  'M12 1.6C13.3 7 16.9 10.7 22.4 12C16.9 13.3 13.3 17 12 22.4C10.7 17 7 13.3 1.6 12C7 10.7 10.7 7 12 1.6Z';

/**
 * Google 四色 sparkle（AI 概览专用的小图标）。
 * 用四个象限裁切把同一颗四角星分成四种 Google 色，不使用渐变。
 */
export function GoogleSparkle({ size = 22, className }: GoogleSparkleProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const clipId = (name: string): string => `sparkle-${uid}-${name}`;

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clipId('q1')}>
          <rect x="12" y="0" width="12" height="12" />
        </clipPath>
        <clipPath id={clipId('q2')}>
          <rect x="0" y="0" width="12" height="12" />
        </clipPath>
        <clipPath id={clipId('q3')}>
          <rect x="0" y="12" width="12" height="12" />
        </clipPath>
        <clipPath id={clipId('q4')}>
          <rect x="12" y="12" width="12" height="12" />
        </clipPath>
      </defs>
      <path d={STAR} fill="#4285f4" clipPath={`url(#${clipId('q1')})`} />
      <path d={STAR} fill="#ea4335" clipPath={`url(#${clipId('q2')})`} />
      <path d={STAR} fill="#fbbc05" clipPath={`url(#${clipId('q3')})`} />
      <path d={STAR} fill="#34a853" clipPath={`url(#${clipId('q4')})`} />
    </svg>
  );
}
