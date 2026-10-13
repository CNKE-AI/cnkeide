/**
 * PPT HTML 预览生成器（重构版）
 *
 * 【核心变化】不再自己写一套 CSS 流式布局，而是把大纲交给 pptRenderer，
 * 由它按 pptLayout.ts 的 slot 坐标统一装配。
 *
 * 这样做的意义：
 *   HTML 预览与 PPTX 导出读的是**同一份版式规范（英寸坐标）**，
 *   HTML 侧只是把英寸换算成百分比定位，PPTX 侧直接用英寸，
 *   于是「预览即所得」在数学上成立，而不是靠人工对齐两套代码。
 *
 * 本文件保留为对外入口（handlers 引用 generatePreviewHtml），内部实现统一到 pptRenderer。
 */

import type { PptBrand } from './pptBrand';
import { mergeBrandColors } from './pptBrand';
import { findTheme } from './pptThemes';
import { renderOutlineHtmlSync, SlideDraft, Outline } from './pptRenderer';

export interface PreviewSlide {
  title?: string;
  subtitle?: string;
  bullets?: string[];
  chart?: { type: 'bar' | 'line' | 'pie'; labels: string[]; series: { name: string; values: number[] }[] };
  role?: 'cover' | 'toc' | 'section' | 'content' | 'data' | 'closing';
  tocItems?: string[];
  /** 数据页核心数字 */
  metric?: string;
  /** 核心数字标签 */
  metricLabel?: string;
  /** 底部图注 */
  note?: string;
}

export interface PreviewOutline {
  title: string;
  slides: PreviewSlide[];
}

export interface PreviewOptions {
  themeId: string;
  outline: PreviewOutline;
  brand?: PptBrand;
  /** AI 原创设计选择的配色；启用企业品牌色时品牌色优先。 */
  colors?: { primary?: string; secondary?: string; accent?: string; background?: string };
  /** AI 原创设计选择的字体。 */
  fontFamily?: string;
  /** AI 选择的主题化视觉场景。 */
  artDirection?: 'education' | 'culture' | 'technology' | 'healthcare' | 'business';
}

/**
 * 生成完整 HTML 演示文稿（纯代码，不调 LLM，确定性输出）
 *
 * 保持同步签名，兼容既有调用方；内部复用 pptRenderer 的统一装配逻辑。
 */
export function generatePreviewHtml(opts: PreviewOptions): string {
  const theme = findTheme(opts.themeId);
  const themeColors = { ...(theme?.colors || {
    primary: '#1e3a8a', secondary: '#7c3aed', accent: '#06b6d4', background: '#f8fafc',
  }), ...(opts.colors || {}) };
  const merged = mergeBrandColors(opts.brand, themeColors);

  const slides: SlideDraft[] = (opts.outline.slides || []).map((s) => ({
    title: s.title || '',
    subtitle: s.subtitle,
    bullets: Array.isArray(s.bullets) ? s.bullets : [],
    role: s.role,
    tocItems: s.tocItems,
    metric: s.metric,
    metricLabel: s.metricLabel,
    note: s.note,
    chart: s.chart,
  }));

  const outline: Outline = { title: opts.outline.title, slides };

  return renderOutlineHtmlSync(
    opts.themeId,
    outline,
    merged ? {
      primary: `#${merged.primary}`,
      secondary: `#${merged.secondary}`,
      accent: `#${merged.accent}`,
      background: `#${merged.background}`,
    } : undefined,
    opts.fontFamily,
    opts.artDirection,
  );
}
