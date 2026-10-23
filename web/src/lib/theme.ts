import {
  Hct,
  SchemeTonalSpot,
  argbFromHex,
  hexFromArgb,
} from '@material/material-color-utilities';
import type { Theme } from './types';

/** Material You 默认种子色（Material 3 基线紫）。 */
export const DEFAULT_THEME_SEED = '#6750a4';

/** 可选主题色：Material You 用单一来源色生成整套动态色板。 */
export const MATERIAL_SEEDS: ReadonlyArray<{ id: string; name: string; color: string }> = [
  { id: 'purple', name: 'Material You', color: DEFAULT_THEME_SEED },
  { id: 'blue', name: '深海蓝', color: '#0b57d0' },
  { id: 'green', name: '森屿绿', color: '#386a20' },
  { id: 'orange', name: '暖沙橙', color: '#8b5000' },
  { id: 'pink', name: '玫瑰粉', color: '#984061' },
  { id: 'teal', name: '青碧', color: '#006a6a' },
];

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function normalizeThemeSeed(value: unknown): string {
  return typeof value === 'string' && HEX_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : DEFAULT_THEME_SEED;
}

/**
 * 用 Material You 的 tonal spot 算法，把单一来源色扩展成完整 M3 动态色板。
 * 这里使用 Android 12/13 默认的 SchemeTonalSpot，并写入现有 CSS token。
 */
export function applyMaterialYou(seed: string, mode: Theme): { surface: string } {
  const source = Hct.fromInt(argbFromHex(normalizeThemeSeed(seed)));
  const scheme = new SchemeTonalSpot(source, mode === 'dark', 0);

  const roles: Record<string, number> = {
    primary: scheme.primary,
    onPrimary: scheme.onPrimary,
    primaryContainer: scheme.primaryContainer,
    onPrimaryContainer: scheme.onPrimaryContainer,
    secondary: scheme.secondary,
    onSecondary: scheme.onSecondary,
    secondaryContainer: scheme.secondaryContainer,
    onSecondaryContainer: scheme.onSecondaryContainer,
    tertiary: scheme.tertiary,
    onTertiary: scheme.onTertiary,
    tertiaryContainer: scheme.tertiaryContainer,
    onTertiaryContainer: scheme.onTertiaryContainer,
    error: scheme.error,
    onError: scheme.onError,
    errorContainer: scheme.errorContainer,
    onErrorContainer: scheme.onErrorContainer,
    background: scheme.background,
    onBackground: scheme.onBackground,
    surface: scheme.surface,
    onSurface: scheme.onSurface,
    surfaceVariant: scheme.surfaceVariant,
    onSurfaceVariant: scheme.onSurfaceVariant,
    surfaceContainerLowest: scheme.surfaceContainerLowest,
    surfaceContainerLow: scheme.surfaceContainerLow,
    surfaceContainer: scheme.surfaceContainer,
    surfaceContainerHigh: scheme.surfaceContainerHigh,
    surfaceContainerHighest: scheme.surfaceContainerHighest,
    outline: scheme.outline,
    outlineVariant: scheme.outlineVariant,
    inverseSurface: scheme.inverseSurface,
    inverseOnSurface: scheme.inverseOnSurface,
    inversePrimary: scheme.inversePrimary,
  };

  const root = document.documentElement;
  for (const [role, argb] of Object.entries(roles)) {
    const token = role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    root.style.setProperty(`--md-${token}`, hexFromArgb(argb));
  }

  return { surface: hexFromArgb(scheme.surface) };
}

/**
 * 从用户上传的图片中提取一个适合做 Material You 种子色的主色。
 * 先按 4-bit 通道分桶，再优先选择饱和度较高、出现频率高的颜色。
 */
export async function extractThemeSeedFromImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > 12 * 1024 * 1024) throw new Error('图片不能超过 12MB');

  const bitmap = await createImageBitmap(file);
  try {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('当前浏览器不支持 Canvas');
    context.drawImage(bitmap, 0, 0, size, size);
    const { data } = context.getImageData(0, 0, size, size);

    type Bucket = { count: number; r: number; g: number; b: number; score: number };
    const buckets = new Map<string, Bucket>();
    let fallbackR = 0;
    let fallbackG = 0;
    let fallbackB = 0;
    let fallbackCount = 0;

    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3] ?? 0;
      if (alpha < 128) continue;
      const r = data[index] ?? 0;
      const g = data[index + 1] ?? 0;
      const b = data[index + 2] ?? 0;
      fallbackR += r;
      fallbackG += g;
      fallbackB += b;
      fallbackCount += 1;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const chroma = max === 0 ? 0 : (max - min) / max;
      const lightness = (max + min) / 510;
      if (max < 24 || min > 232 || chroma < 0.12 || lightness < 0.16 || lightness > 0.92) continue;

      const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
      const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0, score: 0 };
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.score = bucket.count * (0.55 + chroma);
      buckets.set(key, bucket);
    }

    let best: Bucket | null = null;
    for (const bucket of buckets.values()) {
      if (!best || bucket.score > best.score) best = bucket;
    }

    const toHex = (r: number, g: number, b: number): string =>
      `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;

    if (best && best.count > 0) {
      return toHex(best.r / best.count, best.g / best.count, best.b / best.count);
    }
    if (fallbackCount > 0) {
      return toHex(fallbackR / fallbackCount, fallbackG / fallbackCount, fallbackB / fallbackCount);
    }
    return DEFAULT_THEME_SEED;
  } finally {
    bitmap.close();
  }
}
