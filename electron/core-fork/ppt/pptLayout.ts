/**
 * PPT 版式坐标规范（单一事实来源）—— 设计基准
 *
 * 【为什么要有这个文件】
 * 重构前的致命问题：HTML 预览用 CSS 流式布局（flex/gap/padding），PPTX 导出用
 * pptxgenjs 硬编码英寸坐标，两者各写各的，导致「预览看着还行，导出位置全乱」。
 *
 * 本文件定义统一的 **slot（插槽）坐标系统**，单位英寸，基准画布 13.333 × 7.5（16:9）：
 *   - PPTX 导出：直接把这些数字喂给 pptxgenjs（原生英寸）
 *   - HTML 预览：把英寸 ÷ 画布尺寸 × 100 变成 %，绝对定位还原
 * 于是「预览 = 导出」在数学上成立（同一组数字，两种单位表达）。
 *
 * 【坐标原语】
 *   x/y  左上角位置（英寸）
 *   w/h  宽高（英寸）
 *   align/valign/字号/颜色由各版式的语义决定（见 SLOT_ROLE）
 *
 * 【留白基准】（对齐专业演示文稿，避免"贴边"廉价感）
 *   左右安全边距 0.9in，顶部 0.55in，底部 0.45in
 */

import type { LayoutId } from './pptThemes';

/** 16:9 画布尺寸（英寸） */
export const CANVAS_W = 13.333;
export const CANVAS_H = 7.5;

/** 统一留白栅格（英寸） */
export const GRID = {
  /** 左右安全边距 */
  marginX: 0.9,
  /** 顶部安全边距 */
  marginTop: 0.55,
  /** 底部安全边距 */
  marginBottom: 0.45,
  /** 页脚区高度（从底部算） */
  footerH: 0.34,
} as const;

/** 内容区宽度（去掉左右边距） */
export const CONTENT_W = CANVAS_W - GRID.marginX * 2;

/**
 * 插槽：一个矩形区域 + 语义。
 * `role` 决定 HTML 侧应用什么字体/颜色/行高，PPTX 侧用什么 fontSize/bold。
 */
export interface Slot {
  /** 语义角色（同时也是 HTML class 后缀，如 .slot-title） */
  role: 'title' | 'subtitle' | 'eyebrow' | 'bullets' | 'toc' | 'metric' | 'metricLabel'
      | 'metricDesc' | 'chart' | 'cards' | 'bar' | 'footer' | 'pageNum' | 'brandBar' | 'note';
  x: number;
  y: number;
  w: number;
  h: number;
  /** 字号（pt；HTML 侧换算为 px 时 ×4/3） */
  fontSize: number;
  bold?: boolean;
  /** 颜色语义：由主题色决定，不写死 hex */
  colorRole?: 'primary' | 'secondary' | 'accent' | 'background' | 'text' | 'muted' | 'onPrimary';
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  /** 行高倍数 */
  lineHeight?: number;
}

/** 一套版式的插槽集合 */
export interface LayoutSpecV2 {
  id: LayoutId;
  /** 页面底色语义：dark = 用 primary 渐变；light = 用 background */
  scheme: 'dark' | 'light';
  slots: Slot[];
}

/** 卡片内边距（英寸）——cards 插槽内部子卡片用 */
export const CARD_PAD = 0.22;
/** 卡片间隙（英寸） */
export const CARD_GAP = 0.22;

// ===================== 内容区基准线 =====================
// 内容页统一：标题在 y=0.62，装饰条在 y=1.30，正文从 y=1.62 开始

/**
 * 6 套版式的坐标规范。
 *
 * 设计要点（对齐 WPS AI PPT 的克制与秩序感）：
 * - 封面：主标题在视觉黄金分割位（y≈2.55），不居中堆砌
 * - 目录：左侧序号 + 标题两列对齐，条目等距
 * - 分节：序号小字在上、大标题在中、短横线在下，垂直居中
 * - 内容：标题 + 短横线 + 要点列表，单列左对齐，要点行距充足
 * - 数据：左侧超大数字 + 右侧解读 + 底部图注
 * - 结尾：与封面呼应（同样的竖条装饰，形成视觉闭环）
 */
export const LAYOUT_SPECS: Record<LayoutId, LayoutSpecV2> = {
  cover: {
    id: 'cover',
    scheme: 'dark',
    slots: [
      // 左上角品牌小字（作者/日期）
      { role: 'eyebrow', x: GRID.marginX, y: 0.7, w: 6, h: 0.32, fontSize: 11, colorRole: 'onPrimary', align: 'left', valign: 'middle' },
      // 主标题左对齐（比居中更专业；宽度留出右侧呼吸区）
      { role: 'title', x: GRID.marginX, y: 2.55, w: CONTENT_W * 0.82, h: 1.7, fontSize: 40, bold: true, colorRole: 'onPrimary', align: 'left', valign: 'middle', lineHeight: 1.15 },
      // 副标题
      { role: 'subtitle', x: GRID.marginX, y: 4.35, w: CONTENT_W * 0.7, h: 0.6, fontSize: 16, colorRole: 'onPrimary', align: 'left', valign: 'middle' },
      // 左下竖条（唯一装饰）
      { role: 'brandBar', x: GRID.marginX, y: 6.1, w: 0.05, h: 0.72, fontSize: 0, colorRole: 'accent' },
      // 底部公司名
      { role: 'footer', x: GRID.marginX, y: CANVAS_H - 0.72, w: CONTENT_W * 0.6, h: 0.3, fontSize: 10, colorRole: 'onPrimary', align: 'left', valign: 'middle' },
    ],
  },

  toc: {
    id: 'toc',
    scheme: 'light',
    slots: [
      { role: 'title', x: GRID.marginX, y: 0.72, w: CONTENT_W, h: 0.7, fontSize: 26, bold: true, colorRole: 'primary', align: 'left', valign: 'middle' },
      { role: 'brandBar', x: GRID.marginX, y: 1.5, w: 0.55, h: 0.035, fontSize: 0, colorRole: 'accent' },
      // 目录条目区（最多 6 条）
      { role: 'toc', x: GRID.marginX, y: 1.95, w: CONTENT_W * 0.86, h: 4.7, fontSize: 17, colorRole: 'text', align: 'left', valign: 'top', lineHeight: 1.6 },
      { role: 'footer', x: GRID.marginX, y: CANVAS_H - GRID.marginBottom - GRID.footerH, w: CONTENT_W * 0.6, h: GRID.footerH, fontSize: 9, colorRole: 'muted', align: 'left', valign: 'middle' },
      { role: 'pageNum', x: CANVAS_W - GRID.marginX - 1.2, y: CANVAS_H - GRID.marginBottom - GRID.footerH, w: 1.2, h: GRID.footerH, fontSize: 9, colorRole: 'muted', align: 'right', valign: 'middle' },
    ],
  },

  section: {
    id: 'section',
    scheme: 'dark',
    slots: [
      // 章节序号（小字，字距宽）
      { role: 'eyebrow', x: 0, y: 2.75, w: CANVAS_W, h: 0.35, fontSize: 11, colorRole: 'accent', align: 'center', valign: 'middle' },
      // 章节标题
      { role: 'title', x: GRID.marginX, y: 3.2, w: CONTENT_W, h: 1.05, fontSize: 34, bold: true, colorRole: 'onPrimary', align: 'center', valign: 'middle' },
      // 短横线
      { role: 'brandBar', x: CANVAS_W / 2 - 0.4, y: 4.48, w: 0.8, h: 0.045, fontSize: 0, colorRole: 'accent' },
    ],
  },

  content: {
    id: 'content',
    scheme: 'light',
    slots: [
      { role: 'title', x: GRID.marginX, y: 0.62, w: CONTENT_W, h: 0.68, fontSize: 24, bold: true, colorRole: 'primary', align: 'left', valign: 'middle' },
      { role: 'brandBar', x: GRID.marginX, y: 1.34, w: 0.5, h: 0.032, fontSize: 0, colorRole: 'accent' },
      { role: 'subtitle', x: GRID.marginX, y: 1.44, w: CONTENT_W, h: 0.4, fontSize: 12, colorRole: 'muted', align: 'left', valign: 'middle' },
      // 要点列表（最多 5 条，行距充足）
      { role: 'bullets', x: GRID.marginX, y: 1.95, w: CONTENT_W, h: 4.6, fontSize: 15, colorRole: 'text', align: 'left', valign: 'top', lineHeight: 1.62 },
      { role: 'footer', x: GRID.marginX, y: CANVAS_H - GRID.marginBottom - GRID.footerH, w: CONTENT_W * 0.6, h: GRID.footerH, fontSize: 9, colorRole: 'muted', align: 'left', valign: 'middle' },
      { role: 'pageNum', x: CANVAS_W - GRID.marginX - 1.2, y: CANVAS_H - GRID.marginBottom - GRID.footerH, w: 1.2, h: GRID.footerH, fontSize: 9, colorRole: 'muted', align: 'right', valign: 'middle' },
    ],
  },

  data: {
    id: 'data',
    scheme: 'light',
    slots: [
      { role: 'title', x: GRID.marginX, y: 0.62, w: CONTENT_W, h: 0.68, fontSize: 24, bold: true, colorRole: 'primary', align: 'left', valign: 'middle' },
      { role: 'brandBar', x: GRID.marginX, y: 1.34, w: 0.5, h: 0.032, fontSize: 0, colorRole: 'accent' },
      // 有指标数字时：左半区放大数字
      { role: 'metric', x: GRID.marginX, y: 2.15, w: 4.4, h: 1.35, fontSize: 60, bold: true, colorRole: 'accent', align: 'left', valign: 'middle', lineHeight: 1 },
      { role: 'metricLabel', x: GRID.marginX, y: 3.55, w: 4.4, h: 0.42, fontSize: 15, colorRole: 'primary', align: 'left', valign: 'middle' },
      // 左半区：无指标时退回要点列表
      { role: 'bullets', x: GRID.marginX, y: 2.05, w: 4.6, h: 4.3, fontSize: 13, colorRole: 'text', align: 'left', valign: 'top', lineHeight: 1.55 },
      // 右半区：图表
      { role: 'chart', x: 6.35, y: 1.85, w: 6.1, h: 4.6, fontSize: 0 },
      // 底部图注（可选）
      { role: 'note', x: GRID.marginX, y: CANVAS_H - 1.12, w: 4.6, h: 0.55, fontSize: 11, colorRole: 'muted', align: 'left', valign: 'top', lineHeight: 1.4 },
      { role: 'footer', x: GRID.marginX, y: CANVAS_H - GRID.marginBottom - GRID.footerH, w: CONTENT_W * 0.6, h: GRID.footerH, fontSize: 9, colorRole: 'muted', align: 'left', valign: 'middle' },
      { role: 'pageNum', x: CANVAS_W - GRID.marginX - 1.2, y: CANVAS_H - GRID.marginBottom - GRID.footerH, w: 1.2, h: GRID.footerH, fontSize: 9, colorRole: 'muted', align: 'right', valign: 'middle' },
    ],
  },

  closing: {
    id: 'closing',
    scheme: 'dark',
    slots: [
      { role: 'title', x: GRID.marginX, y: 2.85, w: CONTENT_W, h: 1.05, fontSize: 36, bold: true, colorRole: 'onPrimary', align: 'center', valign: 'middle' },
      { role: 'subtitle', x: GRID.marginX, y: 4.15, w: CONTENT_W, h: 0.55, fontSize: 15, colorRole: 'onPrimary', align: 'center', valign: 'middle' },
      { role: 'brandBar', x: CANVAS_W / 2 - 0.4, y: 5.05, w: 0.8, h: 0.045, fontSize: 0, colorRole: 'accent' },
      { role: 'footer', x: GRID.marginX, y: CANVAS_H - 0.72, w: CONTENT_W * 0.6, h: 0.3, fontSize: 10, colorRole: 'onPrimary', align: 'left', valign: 'middle' },
    ],
  },
};

/** 英寸 → CSS 百分比（HTML 预览用，保证与 PPTX 同一坐标系） */
export const toPctX = (inch: number): string => `${(inch / CANVAS_W * 100).toFixed(3)}%`;
export const toPctY = (inch: number): string => `${(inch / CANVAS_H * 100).toFixed(3)}%`;

/** pt → px（1pt = 4/3 px；HTML 侧字号换算） */
export const ptToPx = (pt: number): number => Math.round((pt * 4) / 3 * 100) / 100;

/** 取某版式的插槽（不存在时回退 content） */
export function getLayout(id: LayoutId): LayoutSpecV2 {
  return LAYOUT_SPECS[id] || LAYOUT_SPECS.content;
}
