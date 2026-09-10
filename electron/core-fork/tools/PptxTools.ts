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
  /** 初始幻灯片列表 */
  slides?: PptxSlideInput[];
}

export interface PptxSaveResult {
  success: boolean;
  /** 保存路径（未指定时为临时路径） */
  path?: string;
  /** 幻灯片数量 */
  slideCount?: number;
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

      // 主题配色（pptxgenjs 要求无 # 的 6 位 hex）
      const hex = (c: string | undefined, fallback: string) =>
        (c && /^#?[0-9a-fA-F]{6}$/.test(c) ? c.replace('#', '').toUpperCase() : fallback);
      const theme = req.theme || {};
      const cPrimary = hex(theme.primary, '1E3A8A');
      const cAccent = hex(theme.accent, '06B6D4');
      const cBg = hex(theme.background, 'FFFFFF');
      const hasTheme = !!req.theme;
      // 背景过深时正文改浅色，保证可读性（简单亮度判断）
      const bgLuminance = (() => {
        const r = parseInt(cBg.slice(0, 2), 16), g = parseInt(cBg.slice(2, 4), 16), b = parseInt(cBg.slice(4, 6), 16);
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      })();
      const cTitle = bgLuminance > 0.6 ? cPrimary : 'FFFFFF';
      const cText = bgLuminance > 0.6 ? '374151' : 'E5E7EB';
      const cSubtitle = bgLuminance > 0.6 ? '6B7280' : '9CA3AF';

      const slides = req.slides ?? [];
      for (const s of slides) {
        const slide = pptx.addSlide();
        slide.background = { color: cBg };

        // 主题装饰：顶部主色条 + 左上强调色块（仅启用主题时）
        if (hasTheme) {
          slide.addShape('rect', { x: 0, y: 0, w: SW, h: 0.12, fill: { color: cPrimary } });
          slide.addShape('rect', { x: 0, y: 0, w: 0.12, h: SH, fill: { color: cAccent } });
        }

        // 标题
        if (s.title) {
          slide.addText(s.title, {
            x: hasTheme ? 0.9 : 0.7,
            y: 0.5,
            w: SW - 1.4,
            h: 1.0,
            fontSize: 32,
            bold: true,
            color: hasTheme ? cTitle : '1F2937',
            align: 'left',
          });
        }
        // 副标题
        if (s.subtitle) {
          slide.addText(s.subtitle, {
            x: hasTheme ? 0.9 : 0.7,
            y: s.title ? 1.5 : 0.6,
            w: SW - 1.4,
            h: 0.6,
            fontSize: 18,
            color: hasTheme ? cSubtitle : '6B7280',
            align: 'left',
          });
        }
        // 正文项目符号
        if (s.bullets && s.bullets.length > 0) {
          const bulletsY = (s.title ? 1.5 : 0.6) + (s.subtitle ? 0.8 : 0.0);
          slide.addText(
            s.bullets.map((b) => ({ text: b.text, options: { bullet: { indent: b.level ?? 0 }, breakLine: true } })),
            {
              x: hasTheme ? 0.9 : 0.7,
              y: bulletsY,
              w: SW - 1.4,
              h: SH - bulletsY - 0.6,
              fontSize: 16,
              color: hasTheme ? cText : '374151',
              valign: 'top',
              lineSpacing: 24,
            }
          );
        }
        // 图片
        if (s.image && (s.image.path || s.image.data)) {
          const img = s.image;
          const w = img.w ?? 6;
          const h = img.h ?? 4;
          const x = img.x ?? (SW - w) / 2;
          const y = img.y ?? 1.8;
          if (img.path) {
            slide.addImage({ path: img.path, x, y, w, h });
          } else if (img.data) {
            slide.addImage({ data: img.data, x, y, w, h });
          }
        }
        // 表格
        if (s.table) {
          const headers = s.table.headers;
          const rows = s.table.rows;
          const tableRows: any[] = [
            headers.map((h) => ({ text: h, options: { bold: true, fill: { color: '2563EB' }, color: 'FFFFFF' } })),
            ...rows.map((r) => r.map((c) => ({ text: c }))),
          ];
          slide.addTable(tableRows, {
            x: 0.7,
            y: 1.8,
            w: SW - 1.4,
            colW: headers.map(() => (SW - 1.4) / headers.length),
            border: { type: 'solid', pt: 0.5, color: 'D1D5DB' },
            fontSize: 14,
          });
        }
        // 图表
        if (s.chart) {
          const chart = s.chart;
          const chartType = { bar: 'bar', line: 'line', pie: 'pie' }[chart.type] || 'bar';
          // pptxgenjs addChart 期望 data 为 [{ name, labels, values }]
          const chartData = chart.series.map((ser) => ({
            name: ser.name,
            labels: chart.labels,
            values: ser.values,
          }));
          slide.addChart(chartType, chartData, {
            x: 0.7,
            y: 1.8,
            w: SW - 1.4,
            h: SH - 2.6,
            showLegend: chart.series.length > 1,
          });
        }
      }

      await pptx.writeFile({ fileName: savePath });
      return { success: true, path: savePath, slideCount: slides.length };
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
