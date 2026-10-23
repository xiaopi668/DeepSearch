import { useState } from 'react';
import { avatarColorFor, initialsOf } from '../lib/format';
import { classNames } from '../lib/utils';

interface SiteIconProps {
  src: string | null;
  name: string;
  size?: number;
  className?: string;
}

/** 站点 favicon；加载失败时退化为纯色字母头像。 */
export function SiteIcon({ src, name, size = 20, className }: SiteIconProps) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;
  return (
    <span
      className={classNames('site-icon', className)}
      style={{
        width: size,
        height: size,
        background: showImage ? undefined : avatarColorFor(name || 'search'),
      }}
      aria-hidden="true"
    >
      {showImage && src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="site-icon__letter" style={{ fontSize: Math.max(9, size * 0.5) }}>
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
}
