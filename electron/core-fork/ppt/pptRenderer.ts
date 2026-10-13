/**
 * PPT 渲染引擎（重构版：确定性代码渲染，彻底移除 LLM 写 CSS 路径）
 *
 * 【重构原因】旧版让 LLM 输出整份 HTML + <style>，再用正则"自检"（查 emoji /
 * backdrop-filter / 越界字号），本质是拿正则管 AI 的美术，结果不可控且
 * 与 PPTX 导出视觉完全不一致。
 *
 * 【新架构】三层职责分离：
 *   ① 内容层：LLM 只产出结构化内容（标题/要点/指标/图表）——见 pptScenarios 大纲
 *   ② 版式层：代码按 pptLayout.ts 的 slot 坐标装配 HTML（本文件）
 *   ③ 导出层：PPTX 读同一份 pptLayout.ts，保证「预览 = 导出」
 *
 * 本文件不再调用 LLM、不再做正则自检（auditHtml 仅保留供旧路径兼容调用）。
 */

import { findTheme, PptTheme, LayoutId } from './pptThemes';
import { renderArtScene } from './pptArt';
import type { AiPptArtDirection } from './pptDesign';
import {
  getLayout, Slot, toPctX, toPctY, ptToPx, CANVAS_W, CANVAS_H, GRID, CONTENT_W,
} from './pptLayout';

export interface ChartData {
  type: 'bar' | 'line' | 'pie';
  labels: string[];
  series: { name: string; values: number[] }[];
}

export interface SlideDraft {
  title: string;
  subtitle?: string;
  bullets: string[];
  /** 页面角色（决定版式）。缺省按顺序推断 */
  role?: LayoutId;
  /** 目录页条目 */
  tocItems?: string[];
  /** 数据页核心数字（如 "23%"） */
  metric?: string;
  /** 数字标签（如 "营收同比增长"） */
  metricLabel?: string;
  /** 底部图注/补充说明 */
  note?: string;
  /** 数据页图表 */
  chart?: ChartData;
}

export interface Outline {
  title: string;
  slides: SlideDraft[];
}

export interface RenderOptions {
  themeId: string;
  outline: Outline;
  /** 兼容旧签名（新架构不再使用额外指令） */
  extraInstruction?: string;
  brandColors?: { primary?: string; secondary?: string; accent?: string; background?: string };
  /** AI 原创设计选择的字体；企业品牌字体由上层优先覆盖。 */
  fontFamily?: string;
  /** AI 选择的主题化视觉场景。 */
  artDirection?: AiPptArtDirection;
  onProgress?: (stage: 'render' | 'audit' | 'reflow' | 'finalize', current: number, total: number, message: string) => void;
}

export interface RenderResult {
  success: boolean;
  html?: string;
  theme?: PptTheme;
  issues?: AuditIssue[];
  error?: string;
}

export interface AuditIssue {
  rule: string;
  severity: 'warn' | 'error';
  match?: string;
  message: string;
}

/** 解析后的配色（HTML 侧用 #hex） */
interface Palette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  /** 正文色（浅底） */
  text: string;
  /** 次要文字色 */
  muted: string;
  /** 深底上的文字色 */
  onPrimary: string;
}

/**
 * 同步装配完整 HTML（纯代码，确定性）。
 * 供 pptPreview.generatePreviewHtml 等同步调用方复用，避免两套装配逻辑。
 */
export function renderOutlineHtmlSync(
  themeId: string,
  outline: Outline,
  brandColors?: RenderOptions['brandColors'],
  fontFamily?: string,
  artDirection?: AiPptArtDirection,
): string {
  const theme = findTheme(themeId);
  const merged = { ...(theme?.colors || {
    primary: '#1e3a8a', secondary: '#7c3aed', accent: '#06b6d4', background: '#f8fafc',
  }), ...(brandColors || {}) };
  const palette = buildPalette(merged);
  const slides = assignRolesIfMissing(outline.slides);
  return buildDocument(outline.title, slides, palette, theme || ({ id: themeId } as PptTheme), brandColors, fontFamily, artDirection);
}

/**
 * 把大纲 + 主题 → 完整 HTML（纯代码，确定性）
 */
export async function renderOutlineToHtml(
  _llmProvider: any,
  _apiConfig: any,
  opts: RenderOptions,
): Promise<RenderResult> {
  const theme = findTheme(opts.themeId);
  if (!theme) return { success: false, error: `未知主题：${opts.themeId}` };

  const onProgress = opts.onProgress || (() => {});
  const total = Math.max(1, opts.outline.slides.length);

  onProgress('render', 1, total, '正在装配版式...');
  const html = renderOutlineHtmlSync(opts.themeId, opts.outline, opts.brandColors, opts.fontFamily, opts.artDirection);
  onProgress('render', total, total, `完成 ${total} 页装配`);
  onProgress('finalize', 1, 1, '渲染完成');

  return { success: true, html, theme, issues: [] };
}

/** 构造配色（含派生正文色） */
export function buildPalette(colors: { primary: string; secondary: string; accent: string; background: string }): Palette {
  const lum = luminance(colors.background);
  const light = lum > 0.6;
  return {
    primary: colors.primary,
    secondary: colors.secondary,
    accent: colors.accent,
    background: colors.background,
    text: light ? '#374151' : '#e5e7eb',
    muted: light ? '#6b7280' : '#9ca3af',
    onPrimary: '#ffffff',
  };
}

function luminance(hex: string): number {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return 1;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * 缺省角色推断（与前端 assignRoles 规则一致，保证前后端同构）。
 * LLM 若已显式给 role 则尊重。
 */
export function assignRolesIfMissing(slides: SlideDraft[]): SlideDraft[] {
  const total = slides.length;
  const tocItems = slides.slice(1, total >= 4 ? total - 1 : total).map((s) => s.title).filter(Boolean);
  return slides.map((s, i) => {
    if (s.role) return s;
    let role: LayoutId = 'content';
    if (i === 0) role = 'cover';
    else if (i === total - 1) role = 'closing';
    else if (total >= 4 && i === 1) role = 'toc';
    else if (s.chart && s.chart.series?.length) role = 'data';
    else if (s.metric) role = 'data';
    return { ...s, role, ...(role === 'toc' ? { tocItems: s.tocItems || tocItems } : {}) };
  });
}

// ===================== HTML 文档装配 =====================

function buildDocument(
  title: string,
  slides: SlideDraft[],
  p: Palette,
  theme: PptTheme,
  brandColors?: RenderOptions['brandColors'],
  fontFamily?: string,
  artDirection: AiPptArtDirection = 'education',
): string {
  const total = slides.length;
  const body = slides.map((s, i) => renderSlide(s, i, total, p, theme.id, artDirection)).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
/* ===== 基准：16:9 舞台，所有 slot 绝对定位（与 PPTX 同坐标系） ===== */
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; }
body {
  font-family: '${esc(fontFamily || 'Microsoft YaHei')}', 'PingFang SC', 'Source Han Sans SC', sans-serif;
  background: #11131a; overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
.stage {
  position: relative; width: 100vw; height: 100vh;
  display: none; overflow: hidden; color: ${p.text};
}
.stage.active { display: block; }
.stage.dark { background: linear-gradient(135deg, ${p.primary} 0%, ${p.secondary} 100%); color: ${p.onPrimary}; }
.stage.light { background: linear-gradient(180deg, #fff 0%, ${p.background} 100%); }
.art-scene { position:absolute; inset:0; width:100%; height:100%; z-index:0; }
.slot { z-index:1; }
.stage.dark .art-scene { opacity:.28; mix-blend-mode:screen; }
/* ===== slot：绝对定位 + 文本盒模型（与 pptxgenjs 文本框行为一致） ===== */
.slot { position: absolute; display: flex; overflow: hidden; }
.slot-content { width: 100%; }
.line { display: block; }
/* 要点列表 */
.bullets { display: flex; flex-direction: column; }
.bullet {
  position: relative; padding-left: 0.9em; margin-bottom: 0.62em;
  text-align: justify;
}
.bullet::before {
  content: ''; position: absolute; left: 0; top: 0.62em;
  width: 0.3em; height: 0.3em; border-radius: 1px; background: ${p.accent};
}
.bullet:last-child { margin-bottom: 0; }
/* 目录条目 */
.toc-item { display: flex; align-items: baseline; gap: 0.85em; margin-bottom: 0.72em; }
.toc-num { color: ${p.accent}; font-weight: 600; opacity: 0.85; }
.toc-text { color: ${p.primary}; font-weight: 500; }
/* 装饰竖条 */
.deco-bar { width: 100%; height: 100%; background: ${p.accent}; border-radius: 2px; }
.slot.brandBar .deco-bar { border-radius: 999px; }
/* 页脚 */
.slot.footer .slot-content { display: flex; align-items: center; }
/* 图表 */
.chart-wrap { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
.chart-wrap svg { width: 100%; height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 0.7em; justify-content: center; font-size: 0.72em; color: ${p.muted}; margin-bottom: 0.35em; }
.legend i { display: inline-block; width: 0.65em; height: 0.65em; border-radius: 2px; margin-right: 0.3em; vertical-align: -0.05em; }
/* 指示器 */
#indicator {
  position: fixed; bottom: 14px; right: 20px; z-index: 99;
  font: 600 12px/1 'Microsoft YaHei', sans-serif; color: #475569;
  background: rgba(255,255,255,0.9); padding: 5px 11px; border-radius: 999px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.12); pointer-events: none;
}
/* ===== 打印 / PDF：每页一屏 16:9 ===== */
@page { size: ${CANVAS_W}in ${CANVAS_H}in; margin: 0; }
@media print {
  body { background: #fff; overflow: visible; }
  .stage {
    display: block !important; width: ${CANVAS_W}in !important; height: ${CANVAS_H}in !important;
    page-break-after: always; break-after: page;
  }
  .stage:last-child { page-break-after: auto; break-after: auto; }
  #indicator { display: none !important; }
}
</style>
</head>
<body>
${body}
<div id="indicator">1 / ${total}</div>
<script>
(function () {
  var stages = document.querySelectorAll('.stage');
  var idx = 0;
  function show(n) {
    if (n < 0 || n >= stages.length) return;
    for (var i = 0; i < stages.length; i++) stages[i].classList.toggle('active', i === n);
    idx = n;
    var ind = document.getElementById('indicator');
    if (ind) ind.textContent = (n + 1) + ' / ' + stages.length;
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); show(Math.min(idx + 1, stages.length - 1)); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(Math.max(idx - 1, 0)); }
    else if (e.key === 'Home') { e.preventDefault(); show(0); }
    else if (e.key === 'End') { e.preventDefault(); show(stages.length - 1); }
  });
  show(0);
  window.__pptGoto = function (n) { show(n); };
  window.__pptGetTotal = function () { return stages.length; };
})();
</script>
</body>
</html>`;
}

// ===================== 单页装配 =====================

function renderSlide(s: SlideDraft, index: number, total: number, p: Palette, themeId: string, artDirection: AiPptArtDirection): string {
  const role = s.role || 'content';
  const spec = getLayout(role);
  const art = renderArtScene(artDirection, p, index);
  const slots = spec.slots
    .map((slot) => renderSlot(slot, s, index, total, p, role))
    .filter(Boolean)
    .join('\n');

  return `<section class="stage ${spec.scheme}" data-layout="${role}" data-theme="${esc(themeId)}">
${art}
${slots}
</section>`;
}

/** 渲染单个 slot（按 role 分派内容） */
function renderSlot(slot: Slot, s: SlideDraft, index: number, total: number, p: Palette, role: LayoutId): string {
  const color = resolveColor(slot.colorRole, p);
  const style = [
    `left:${toPctX(slot.x)}`,
    `top:${toPctY(slot.y)}`,
    `width:${toPctX(slot.w)}`,
    `height:${toPctY(slot.h)}`,
    `font-size:${ptToPx(slot.fontSize)}px`,
    slot.lineHeight ? `line-height:${slot.lineHeight}` : '',
    slot.bold ? 'font-weight:700' : 'font-weight:400',
    `color:${color}`,
    `justify-content:${slot.align === 'center' ? 'center' : slot.align === 'right' ? 'flex-end' : 'flex-start'}`,
    `align-items:${slot.valign === 'middle' ? 'center' : slot.valign === 'bottom' ? 'flex-end' : 'flex-start'}`,
    `text-align:${slot.align || 'left'}`,
  ].filter(Boolean).join(';');

  const inner = slotContent(slot, s, index, total, p, role);
  if (inner === null) return ''; // 无内容则该 slot 不输出

  const cls = `slot ${slot.role}${slot.align ? ` align-${slot.align}` : ''}`;
  return `<div class="${cls}" data-slot="${slot.role}" style="${style}"><div class="slot-content">${inner}</div></div>`;
}

function slotContent(slot: Slot, s: SlideDraft, index: number, total: number, p: Palette, role: LayoutId): string | null {
  switch (slot.role) {
    case 'title':
      if (!s.title) return null;
      // 封面/分节/结尾单行标题；内容页长标题折行
      return esc(s.title);
    case 'subtitle': {
      const points = (s.bullets || []).map((item) => item.trim()).filter(Boolean).slice(0, 3);
      if (role === 'cover') {
        return [s.subtitle, ...points].filter((item): item is string => !!item).map((item) => esc(item)).join('<br>') || null;
      }
      if (!s.subtitle) return null;
      return esc(s.subtitle);
    }
    case 'eyebrow': {
      if (role === 'section') {
        // 分节页序号：SECTION 01 形式，字距拉开
        return `<span style="letter-spacing:0.34em">SECTION ${String(index + 1).padStart(2, '0')}</span>`;
      }
      // 封面左上角：副标题当作者/日期用
      return s.subtitle ? esc(s.subtitle) : null;
    }
    case 'bullets': {
      const items = (s.bullets || []).map((b) => b.trim()).filter(Boolean);
      if (items.length === 0 && s.subtitle) return `<div class="bullet">${esc(s.subtitle)}</div>`;
      if (items.length === 0) return null;
      // 数据页左侧空间窄，去项目符号改用紧凑行
      if (role === 'data') {
        return `<div class="bullets">${items.map((b) => `<div class="bullet" style="font-size:${ptToPx(slot.fontSize)}px">${esc(b)}</div>`).join('')}</div>`;
      }
      return `<div class="bullets">${items.map((b) => `<div class="bullet" style="font-size:${ptToPx(slot.fontSize)}px">${esc(b)}</div>`).join('')}</div>`;
    }
    case 'toc': {
      const items = (s.tocItems && s.tocItems.length ? s.tocItems : (s.bullets || [])).filter(Boolean);
      if (items.length === 0) return null;
      return `<div>${items.slice(0, 6).map((t, i) => `<div class="toc-item"><span class="toc-num" style="font-size:${ptToPx(slot.fontSize * 0.82)}px">${String(i + 1).padStart(2, '0')}</span><span class="toc-text" style="font-size:${ptToPx(slot.fontSize)}px">${esc(t)}</span></div>`).join('')}</div>`;
    }
    case 'metric':
      if (!s.metric) return null;
      return esc(s.metric);
    case 'metricLabel':
      if (!s.metricLabel) return null;
      return esc(s.metricLabel);
    case 'chart':
      if (!s.chart || !s.chart.series?.length) return null;
      return `<div class="chart-wrap">${renderChartSvg(s.chart, p)}</div>`;
    case 'note':
      if (!s.note) return null;
      return esc(s.note);
    case 'brandBar':
      return `<div class="deco-bar"></div>`;
    case 'footer':
      return esc(s.subtitle && role === 'cover' ? (s.note || '') : '');
    case 'pageNum':
      return `${index + 1} / ${total}`;
    default:
      return null;
  }
}

function resolveColor(role: Slot['colorRole'], p: Palette): string {
  switch (role) {
    case 'primary': return p.primary;
    case 'secondary': return p.secondary;
    case 'accent': return p.accent;
    case 'background': return p.background;
    case 'text': return p.text;
    case 'muted': return p.muted;
    case 'onPrimary': return p.onPrimary;
    default: return p.text;
  }
}

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===================== 图表 SVG（纯手写，零依赖） =====================

export function renderChartSvg(chart: ChartData, p: Palette): string {
  const W = 600, H = 380;
  const palette = [p.accent, p.primary, p.secondary, '#f59e0b', '#10b981', '#ef4444'];
  const maxVal = Math.max(1, ...chart.series.flatMap((s) => s.values));
  const labels = chart.labels || [];
  const lc = Math.max(1, labels.length);
  const pad = { top: 26, right: 18, bottom: 42, left: 52 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  if (chart.type === 'pie' && chart.series[0]) {
    const values = chart.series[0].values;
    const totalV = values.reduce((a, b) => a + b, 0) || 1;
    let angle = -Math.PI / 2;
    const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 34;
    const slices = values.map((v, i) => {
      const a = (v / totalV) * Math.PI * 2;
      const x1 = cx + Math.cos(angle) * r, y1 = cy + Math.sin(angle) * r;
      const x2 = cx + Math.cos(angle + a) * r, y2 = cy + Math.sin(angle + a) * r;
      const la = a > Math.PI ? 1 : 0;
      const mid = angle + a / 2;
      const lx = cx + Math.cos(mid) * (r * 0.62), ly = cy + Math.sin(mid) * (r * 0.62);
      const pct = Math.round((v / totalV) * 100);
      angle += a;
      const label = labels[i] ?? '';
      return `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${la} 1 ${x2},${y2} Z" fill="${palette[i % palette.length]}" stroke="#fff" stroke-width="2"/>`
        + (pct >= 6 ? `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" font-size="13" font-weight="600" fill="#fff">${esc(label)} ${pct}%</text>` : '');
    }).join('');
    return `<div><div class="legend">${values.map((_, i) => `<span><i style="background:${palette[i % palette.length]}"></i>${esc(labels[i] ?? '')}</span>`).join('')}</div><svg viewBox="0 0 ${W} ${H}">${slices}</svg></div>`;
  }

  const groupW = plotW / lc;
  const barW = chart.type === 'bar' ? Math.min(46, (groupW * 0.68) / Math.max(1, chart.series.length)) : 0;
  const valToY = (v: number) => pad.top + plotH - (v / maxVal) * plotH;
  const labelX = (i: number) => pad.left + groupW * (i + 0.5);

  const grid: string[] = [];
  for (let g = 0; g <= 4; g++) {
    const y = pad.top + (plotH / 4) * g;
    const val = Math.round(maxVal - (maxVal / 4) * g);
    grid.push(`<line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`
      + `<text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#94a3b8">${val}</text>`);
  }
  const xl = labels.map((l, i) => `<text x="${labelX(i)}" y="${H - pad.bottom + 18}" text-anchor="middle" font-size="11" fill="#64748b">${esc(l)}</text>`).join('');

  let body = '';
  if (chart.type === 'bar') {
    body = chart.series.map((ser, si) => ser.values.map((v, i) => {
      const off = (si - (chart.series.length - 1) / 2) * (barW + 2);
      const x = labelX(i) + off - barW / 2;
      const y = valToY(v);
      return `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(0, pad.top + plotH - y)}" fill="${palette[si % palette.length]}" rx="2"/>`;
    }).join('')).join('');
  } else {
    body = chart.series.map((ser, si) => {
      const pts = ser.values.map((v, i) => `${labelX(i)},${valToY(v)}`).join(' ');
      const dots = ser.values.map((v, i) => `<circle cx="${labelX(i)}" cy="${valToY(v)}" r="4" fill="${palette[si % palette.length]}" stroke="#fff" stroke-width="1.5"/>`).join('');
      return `<polyline points="${pts}" fill="none" stroke="${palette[si % palette.length]}" stroke-width="2.5" stroke-linejoin="round"/>${dots}`;
    }).join('');
  }

  const legend = chart.series.length > 1
    ? `<div class="legend">${chart.series.map((ser, si) => `<span><i style="background:${palette[si % palette.length]}"></i>${esc(ser.name)}</span>`).join('')}</div>`
    : '';

  return `<div>${legend}<svg viewBox="0 0 ${W} ${H}">${grid.join('')}${body}${xl}</svg></div>`;
}

/**
 * 兼容旧路径的空实现（旧版正则自检已废弃）。
 * 版式由代码保证，不再需要运行时正则审计。
 */
export function auditHtml(_html: string): AuditIssue[] {
  return [];
}
