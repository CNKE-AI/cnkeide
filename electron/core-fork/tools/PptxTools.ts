/**
 * PptxTools - PPT 演示文稿生成（W14）
 *
 * 设计（沿用 ImageGenTools / PlaywrightTools 的 Adapter 模式）：
 * - 通过 PptxAdapter 接口暴露能力，不强制在模块顶层静态 import pptxgenjs
 * - 真实实现 PptxGenAdapter 用动态 import（new Function 包裹，规避 vite 静态分析）
 * - Mock 实现：未安装/未配置时返回明确错误提示
 *
 * 数据模型：一个"演示文稿"由若干 Slide 组成，每页支持：
 *   - 标题 + 副标题
 *   - 正文（项目符号列表）
 *   - 图片
 *   - 表格
 *   - 图表（柱状/折线/饼图）
 */

// ===== 类型定义 =====

import { promises as fsp } from 'node:fs';
import AdmZip from 'adm-zip';
import type { PptBrand } from '../ppt/pptBrand';
import { mergeBrandColors } from '../ppt/pptBrand';
import { getLayout, CANVAS_W, CANVAS_H, GRID, CONTENT_W, Slot } from '../ppt/pptLayout';

export interface PptxBulletItem {
  text: string;
  /** 层级 0-5 */
  level?: number;
}

export interface PptxTableData {
  headers: string[];
  rows: string[][];
}

export interface PptxChartData {
  /** 类型：bar / line / pie */
  type: 'bar' | 'line' | 'pie';
  /** 分类标签 */
  labels: string[];
  /** 数据系列（多组为多序列） */
  series: { name: string; values: number[] }[];
}

export interface PptxSlideInput {
  /** 标题 */
  title?: string;
  /** 副标题 */
  subtitle?: string;
  /** 正文项目符号 */
  bullets?: PptxBulletItem[];
  /** 图片（本地路径或 base64 dataURL） */
  image?: { path?: string; data?: string; x?: number; y?: number; w?: number; h?: number };
  /** 表格 */
  table?: PptxTableData;
  /** 图表 */
  chart?: PptxChartData;
  /** 页面角色：决定版式（封面/目录/分节/内容/数据/结尾）。缺省=content */
  role?: 'cover' | 'toc' | 'section' | 'content' | 'data' | 'closing';
  /** 目录页章节列表（role=toc 时用） */
  tocItems?: string[];
  /** 布局：默认 'LAYOUT_WIDE'（16:9） */
  layout?: string;
}

export interface PptxCreateRequest {
  /** 演示文稿标题 */
  title?: string;
  /** 作者 */
  author?: string;
  /** 主题 */
  subject?: string;
  /** 幻灯片尺寸：16x9 或 4x3 */
  size?: '16x9' | '4x3';
  /** 主题配色（可选，启用后标题/背景/装饰条按主题渲染） */
  theme?: {
    primary?: string;
    secondary?: string;
    accent?: string;
    background?: string;
  };
  /** 企业品牌（可选：品牌色优先于 theme 色渲染色；Logo/页脚/字体注入） */
  brand?: PptBrand;
  /** 是否给每页加切换动画（淡入），默认 false */
  transition?: boolean;
  /** 初始幻灯片列表 */
  slides?: PptxSlideInput[];
}

export interface PptxSaveResult {
  success: boolean;
  /** 保存路径（未指定时为临时路径） */
  path?: string;
  /** 幻灯片数量 */
  slideCount?: number;
  /** 品牌元素是否实际生效（Logo 缺文件/颜色非法会降级并提示） */
  brandNotices?: string[];
  error?: string;
}

export interface PptxAdapter {
  readonly available: boolean;
  readonly provider: string;
  /** 生成 PPT 并写入文件，返回保存结果 */
  generate(req: PptxCreateRequest, savePath: string): Promise<PptxSaveResult>;
}

// ===== Mock 实现 =====

export class MockPptxAdapter implements PptxAdapter {
  readonly available = false;
  readonly provider = 'mock';

  async generate(_req: PptxCreateRequest, _savePath: string): Promise<PptxSaveResult> {
    return {
      success: false,
      error: 'PPT 生成未就绪：缺少 pptxgenjs 依赖，请运行 npm install pptxgenjs',
    };
  }
}

// ===== 真实实现（pptxgenjs）=====

export class PptxGenAdapter implements PptxAdapter {
  readonly available = true;
  readonly provider = 'pptxgenjs';

  async generate(req: PptxCreateRequest, savePath: string): Promise<PptxSaveResult> {
    try {
      // 动态 import，规避 vite 静态分析（与 PlaywrightTools 一致）
      const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
      const Pptxgen = await dynamicImport('pptxgenjs');
      const Pptx = (Pptxgen.default ?? Pptxgen) as any;

      const pptx = new Pptx();
      pptx.layout = req.size === '4x3' ? 'LAYOUT_4x3' : 'LAYOUT_WIDE';
      if (req.author) pptx.author = req.author;
      if (req.subject) pptx.subject = req.subject;
      if (req.title) pptx.title = req.title;

      // 定义 16:9 布局尺寸（英寸）
      const SW = 13.333;
      const SH = 7.5;

      // 企业品牌：品牌色优先于主题色；Logo / 页脚 / 字体注入
      const brand = req.brand?.enabled ? req.brand : null;
      const brandNotices: string[] = [];
      let logoExists = false;
      if (brand?.logoPath) {
        try {
          await fsp.access(brand.logoPath);
          logoExists = true;
        } catch {
          brandNotices.push(`Logo 文件不存在（${brand.logoPath}），已跳过 Logo 注入`);
        }
      }

      // 主题配色（pptxgenjs 要求无 # 的 6 位 hex）——品牌色覆盖主题色
      const themeColors = {
        primary: req.theme?.primary || '1E3A8A',
        secondary: req.theme?.secondary || '7C3AED',
        accent: req.theme?.accent || '06B6D4',
        background: req.theme?.background || 'FFFFFF',
      };
      const merged = mergeBrandColors(brand, themeColors);
      const cPrimary = merged.primary;
      const cAccent = merged.accent;
      const cBg = merged.background;
      const hasTheme = !!req.theme || !!brand;
      // 背景过深时正文改浅色，保证可读性（简单亮度判断）
      const bgLuminance = (() => {
        const r = parseInt(cBg.slice(0, 2), 16), g = parseInt(cBg.slice(2, 4), 16), b = parseInt(cBg.slice(4, 6), 16);
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      })();
      const cTitle = bgLuminance > 0.6 ? cPrimary : 'FFFFFF';
      const cText = bgLuminance > 0.6 ? '374151' : 'E5E7EB';
      const cSubtitle = bgLuminance > 0.6 ? '6B7280' : '9CA3AF';
      // 企业字体（空则用 pptxgenjs 默认）
      const fontFace = brand?.fontFamily || undefined;

      const slides = req.slides ?? [];
      const totalSlides = slides.length;
      const footerParts = [brand?.footerText, brand?.companyName].filter(Boolean).join(' · ');

      for (let slideIdx = 0; slideIdx < totalSlides; slideIdx++) {
        const s = slides[slideIdx];
        const role = s.role || 'content';
        const spec = getLayout(role);
        // 与 HTML 预览同一份版式规范：scheme 决定深浅底色，slot 决定坐标
        const onDark = spec.scheme === 'dark';
        const slide = pptx.addSlide();
        slide.background = { color: onDark ? cPrimary : cBg };

        const cSlotTitle = onDark ? 'FFFFFF' : cTitle;
        const cSlotText = onDark ? 'E5E7EB' : cText;
        const cSlotMuted = onDark ? '9CA3AF' : cSubtitle;

        // 按 slot 语义取值（与 pptRenderer.slotContent 严格对应）
        const slotValue = (slotRole: Slot['role']): string | null => {
          switch (slotRole) {
            case 'title':
              if (!s.title && role === 'closing') return '感谢观看';
              return s.title || null;
            case 'subtitle':
              return s.subtitle || null;
            case 'eyebrow':
              if (role === 'section') return `SECTION ${String(slideIdx + 1).padStart(2, '0')}`;
              return s.subtitle || null;
            case 'metric':
            case 'metricLabel':
            case 'note':
              return (s as any)[slotRole] || null;
            case 'footer':
              return footerParts || null;
            case 'pageNum':
              return `${slideIdx + 1} / ${totalSlides}`;
            default:
              return null;
          }
        };

        const colorOf = (slot: Slot): string => {
          switch (slot.colorRole) {
            case 'primary': return onDark ? 'FFFFFF' : cPrimary;
            case 'accent': return cAccent;
            case 'onPrimary': return 'FFFFFF';
            case 'muted': return cSlotMuted;
            default: return onDark ? cSlotText : cSlotTitle === cTitle ? cSlotText : cSlotText;
          }
        };

        for (const slot of spec.slots) {
          const { x, y, w, h } = slot;

          // 装饰条
          if (slot.role === 'brandBar') {
            slide.addShape('rect', { x, y, w, h, fill: { color: cAccent } });
            continue;
          }

          // 要点列表
          if (slot.role === 'bullets') {
            const items = (s.bullets || []).map((b) => b.text).filter((t) => t && t.trim());
            if (!items.length) continue;
            slide.addText(
              items.map((t) => ({ text: t, options: { bullet: { indent: 0 }, breakLine: true } })),
              {
                x, y, w, h,
                fontSize: slot.fontSize,
                color: colorOf(slot),
                valign: 'top',
                align: slot.align || 'left',
                lineSpacing: Math.round(slot.fontSize * (slot.lineHeight || 1.4)),
                fontFace,
              },
            );
            continue;
          }

          // 目录条目
          if (slot.role === 'toc') {
            const toc = s.tocItems || (s.bullets || []).map((b) => b.text) || [];
            const rows = toc.slice(0, 6).map((t, i) => ({
              text: `${String(i + 1).padStart(2, '0')}  ${t}`,
              options: { fontSize: slot.fontSize, color: colorOf(slot), fontFace, breakLine: true, align: 'left' as const },
            }));
            if (!rows.length) continue;
            slide.addText(rows as any, {
              x, y, w, h, valign: 'top',
              lineSpacing: Math.round(slot.fontSize * 1.55),
            });
            continue;
          }

          // 图表
          if (slot.role === 'chart') {
            const hasChart = s.chart && Array.isArray(s.chart.series) && s.chart.series.length > 0;
            if (!hasChart) continue;
            const chart = s.chart!;
            const chartType = { bar: 'bar', line: 'line', pie: 'pie' }[chart.type] || 'bar';
            const chartData = chart.series.map((ser) => ({ name: ser.name, labels: chart.labels, values: ser.values }));
            slide.addChart(chartType as any, chartData, {
              x, y, w, h,
              showLegend: chart.series.length > 1,
              showTitle: false,
              chartColors: [cAccent, cPrimary, '7C3AED', 'F59E0B'],
              catAxisLabelFontSize: 10,
              valAxisLabelFontSize: 10,
              legendFontSize: 10,
            });
            continue;
          }

          // 普通文本 slot
          const value = slotValue(slot.role);
          if (!value) continue;
          slide.addText(value, {
            x, y, w, h,
            fontSize: slot.fontSize || 12,
            bold: !!slot.bold,
            color: colorOf(slot),
            align: (slot.align || 'left') as any,
            valign: (slot.valign === 'middle' ? 'middle' : slot.valign === 'bottom' ? 'bottom' : 'top') as any,
            fontFace,
          });
        }

        // 图片
        if (s.image && (s.image.path || s.image.data)) {
          const img = s.image;
          const w = img.w ?? 6;
          const h = img.h ?? 4;
          const x = img.x ?? (CANVAS_W - w) / 2;
          const y = img.y ?? 1.8;
          if (img.path) slide.addImage({ path: img.path, x, y, w, h });
          else if (img.data) slide.addImage({ data: img.data, x, y, w, h });
        }

        // 表格
        if (s.table) {
          const headers = s.table.headers;
          const rows = s.table.rows;
          const tableRows: any[] = [
            headers.map((h) => ({ text: h, options: { bold: true, fill: { color: cPrimary }, color: 'FFFFFF', fontFace } })),
            ...rows.map((r) => r.map((c) => ({ text: c, options: { fontFace } }))),
          ];
          slide.addTable(tableRows, {
            x: GRID.marginX, y: 1.85, w: CONTENT_W,
            colW: headers.map(() => CONTENT_W / headers.length),
            border: { type: 'solid', pt: 0.5, color: 'D1D5DB' },
            fontSize: 13,
          });
        }

        // 品牌 Logo
        if (logoExists && brand?.logoPath) {
          slide.addImage({ path: brand.logoPath, x: CANVAS_W - 1.2, y: CANVAS_H - 0.75, w: 0.7, h: 0.42 });
        }

        // 未在 slot 规范里定义页码的版式（封面/结尾除外）补页码
        const hasPageNum = spec.slots.some((sl) => sl.role === 'pageNum');
        if (!hasPageNum && role !== 'cover' && role !== 'closing') {
          slide.addText(`${slideIdx + 1} / ${totalSlides}`, {
            x: CANVAS_W - GRID.marginX - 0.6,
            y: CANVAS_H - GRID.marginBottom - GRID.footerH,
            w: 0.6, h: GRID.footerH, fontSize: 9,
            color: onDark ? '9CA3AF' : '6B7280',
            align: 'right', valign: 'middle', fontFace,
          });
        }
      }

      await pptx.writeFile({ fileName: savePath });

      // 切换动画：pptxgenjs 不支持 transition，生成后用 adm-zip 注入 <p:transition>（淡入）
      if (req.transition && slides.length > 0) {
        try {
          const zip = new AdmZip(savePath);
          const slideEntries = zip.getEntries().filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName));
          for (const entry of slideEntries) {
            const xml = entry.getData().toString('utf-8');
            if (xml.includes('<p:transition')) continue;
            const patched = xml.replace(
              /<\/p:cSld>/,
              '</p:cSld><p:transition spd="med"><p:fade/></p:transition>',
            );
            zip.updateFile(entry.entryName, Buffer.from(patched, 'utf-8'));
          }
          zip.writeZip(savePath);
        } catch {
          brandNotices.push('切换动画注入失败，已导出为无动画版本');
        }
      }

      return { success: true, path: savePath, slideCount: slides.length, brandNotices };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }
}

/** 工厂：动态探测 pptxgenjs 是否可用，返回真实或 Mock 适配器 */
export async function createPptxAdapter(): Promise<PptxAdapter> {
  try {
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
    await dynamicImport('pptxgenjs');
    return new PptxGenAdapter();
  } catch {
    return new MockPptxAdapter();
  }
}
