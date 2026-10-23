import { useEffect } from 'react';

const RIPPLE_TARGET = 'button:not([disabled]), a.btn';

/**
 * Material You 的柔和触控涟漪。
 * 在按钮的点击坐标处插入一枚圆形波纹，动画结束后自动移除。
 */
export function useMaterialRipple(): void {
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const origin = event.target;
      if (!(origin instanceof Element)) return;
      const target = origin.closest<HTMLElement>(RIPPLE_TARGET);
      if (!target || target.dataset.noRipple === 'true') return;

      const rect = target.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const wave = document.createElement('span');
      wave.className = 'md-ripple';
      wave.style.width = `${size}px`;
      wave.style.height = `${size}px`;
      wave.style.left = `${event.clientX - rect.left - size / 2}px`;
      wave.style.top = `${event.clientY - rect.top - size / 2}px`;
      target.appendChild(wave);

      const cleanup = (): void => wave.remove();
      wave.addEventListener('animationend', cleanup, { once: true });
      window.setTimeout(cleanup, 700);
    };

    document.addEventListener('pointerdown', handlePointerDown, { passive: true });
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);
}
