/**
 * PPT 渲染引擎
 *
 * 流程：
 * 1. 第 2 轮 LLM：把大纲 + 主题样式定义 → 喂给 LLM，让它输出完整 HTML
 * 2. 自检（audit）：正则扫描 HTML 检测违规元素（emoji / backdrop-filter / 越界字号 / 越界颜色 / 外部图片）
 * 3. 重排（reflow）：如有问题，自动再调一次 LLM 输出"修正版"（避免 LLM 自由发挥导致排版失控）
 * 4. 校验返回的 HTML（必须是 <!DOCTYPE html> 开头）
 * 5. 包装成完整 HTML 文档 + 翻页脚本 + @media print 分页
 *
 * 进度回调：onProgress(stage, current, total, message)
 *   - stage: 'render' | 'audit' | 'reflow' | 'finalize'
 *   - current/total: 当前进度（render 时 = 当前页/total 页；reflow 时 = 1/1）
 */

import { findTheme, PptTheme, LAYOUT_IDS } from './pptThemes';

export interface SlideDraft {
  title: string;
  bullets: string[];
}

export interface Outline {
  title: string;
  slides: SlideDraft[];
}

export interface RenderOptions {
  themeId: string;
  outline: Outline;
  extraInstruction?: string;
  onProgress?: (stage: 'render' | 'audit' | 'reflow' | 'finalize', current: number, total: number, message: string) => void;
}

export interface RenderResult {
  success: boolean;
  html?: string;
  theme?: PptTheme;
  /** 自检发现的问题列表（已自动修复则为空） */
  issues?: AuditIssue[];
  error?: string;
}

export interface AuditIssue {
  rule: string;
  severity: 'warn' | 'error';
  match?: string;
  message: string;
}

const HTML_SYSTEM_PROMPT = `你是资深的演示文稿视觉设计师，擅长把结构化大纲转换为高质量的演示页面 HTML。

【核心规则：版式驱动】
你必须为每一页从「${LAYOUT_IDS.join(' / ')}」6 套预设版式中**选择一个**（按页面用途选），然后**严格按该版式的规范填充内容**，禁止自创任何版式外的元素或装饰。

【硬性要求】
1. 必须以 <!DOCTYPE html> 开头，完整 <html><head><body> 闭合
2. 必须包含 <style> 内联 CSS，禁止引用任何外部样式表
3. 必须包含 <meta charset="utf-8"> + <meta name="viewport">
4. 每页用 <section class="slide" id="slide-N" data-layout="<版式id>"> 包裹
5. 禁止任何外部图片引用（不要 <img src="http://...">）
6. **禁止** emoji / 玻璃卡片 (backdrop-filter) / 多层渐变 / 大字号数字框
7. 必须包含翻页快捷键：左右箭头键、PageUp/PageDown、Home/End
8. 必须包含分页指示器（右下角：1/N 形式）
9. 内容密度适中，单页字符数 ≤ 200
10. 禁止输出 markdown 代码块包裹（不要 \`\`\`html）
11. 禁止 <script> 标签（除键盘事件翻页外）
12. **必须**只用指定主题中提供的颜色变量（primary/secondary/accent/background），禁止引入其他颜色
13. **每一页的 data-layout 属性必须是以下之一：cover / toc / section / content / data / closing**

【输出格式】
仅输出 HTML 本身，不要任何说明文字、不要 markdown 围栏。

现在开始。`;

const REFLOW_SYSTEM_PROMPT = `你刚刚生成了一份 PPT HTML，但自检发现存在排版违规，需要你重新输出一份修正版。

【修正要点】
1. **完全删除所有 emoji 字符**（包括任何 Unicode 表情）
2. **删除所有 backdrop-filter / filter: blur(...) 属性**（玻璃卡片被禁）
3. **删除多层渐变叠加**（每个元素最多 1 个渐变背景）
4. **删除 font-size > 80px 的元素**
5. **删除 img 标签**（不允许外部图片）
6. **保留整体结构与每页 data-layout，只删除违规元素/属性**
7. **不得引入新的颜色**（只用 primary/secondary/accent/background 四个色）

直接输出修正后的完整 HTML，不要任何解释。`;

/**
 * 把大纲 + 主题 → 完整 HTML（含自检与重排）
 */
export async function renderOutlineToHtml(
  llmProvider: any,
  apiConfig: any,
  opts: RenderOptions,
): Promise<RenderResult> {
  const theme = findTheme(opts.themeId);
  if (!theme) return { success: false, error: `未知主题：${opts.themeId}` };

  const onProgress = opts.onProgress || (() => {});
  const totalSlides = Math.max(1, opts.outline.slides.length);
  const userPrompt = buildUserPrompt(theme, opts.outline, opts.extraInstruction);

  let html = '';
  // 阶段 1：渲染
  onProgress('render', 1, totalSlides, `正在生成第 1/${totalSlides} 页...`);
  try {
    const resp = await llmProvider.chat({
      apiConfig,
      messages: [
        { role: 'system', content: HTML_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
    });
    let raw = (resp.content || '').trim();
    raw = stripCodeFence(raw);
    onProgress('render', totalSlides, totalSlides, `完成第 ${totalSlides}/${totalSlides} 页`);
    if (!raw.startsWith('<!DOCTYPE') && !raw.startsWith('<html')) {
      return { success: false, error: `LLM 输出不是合法 HTML，开头：${raw.slice(0, 60)}...` };
    }
    html = raw;
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }

  // 阶段 2：自检
  onProgress('audit', 1, 1, '排版自检完成');
  const issues = auditHtml(html);
  if (issues.length > 0) {
    // 阶段 3：自动重排
    onProgress('reflow', 0, 1, `检测到 ${issues.length} 处排版问题，自动重新调整布局...`);
    try {
      const resp = await llmProvider.chat({
        apiConfig,
        messages: [
          { role: 'system', content: HTML_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: html },
          { role: 'user', content: `${REFLOW_SYSTEM_PROMPT}\n\n【自检发现的问题】\n${issues.map((i, idx) => `${idx + 1}. [${i.rule}] ${i.message}${i.match ? ` (示例：${i.match.slice(0, 60)})` : ''}`).join('\n')}\n\n请输出修正后的 HTML。` },
        ],
        temperature: 0.4,
      });
      let reflowed = (resp.content || '').trim();
      reflowed = stripCodeFence(reflowed);
      if (reflowed.startsWith('<!DOCTYPE') || reflowed.startsWith('<html')) {
        html = reflowed;
        onProgress('reflow', 1, 1, '排版已自动修正');
      } else {
        onProgress('reflow', 1, 1, '重排失败，使用初版');
      }
    } catch {
      onProgress('reflow', 1, 1, '重排失败，使用初版');
    }
  }

  // 阶段 4：包装（加翻页脚本 + @media print）
  onProgress('finalize', 1, 1, '正在包装页面...');
  const finalHtml = wrapWithPagination(html, opts.outline);
  onProgress('finalize', 1, 1, '渲染完成');

  return { success: true, html: finalHtml, theme, issues: issues.length > 0 ? issues : [] };
}

/**
 * 排版自检：正则扫描 HTML 检测常见违规
 */
export function auditHtml(html: string): AuditIssue[] {
  const issues: AuditIssue[] = [];

  // 1. emoji（Unicode 高位字符 + 表情范围）
  const emojiRe = /[\u{1F300}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}]/gu;
  const emojiMatch = html.match(emojiRe);
  if (emojiMatch && emojiMatch.length > 0) {
    issues.push({
      rule: 'no-emoji',
      severity: 'warn',
      match: emojiMatch[0],
      message: `发现 ${emojiMatch.length} 个 emoji 字符，专业 PPT 不应使用`,
    });
  }

  // 2. backdrop-filter（玻璃卡片禁用）
  const blurMatch = html.match(/backdrop-filter\s*:\s*[^;]*/gi);
  if (blurMatch && blurMatch.length > 0) {
    issues.push({
      rule: 'no-backdrop-filter',
      severity: 'warn',
      match: blurMatch[0],
      message: `发现 ${blurMatch.length} 处 backdrop-filter，玻璃卡片被禁`,
    });
  }
  // 顺便检测 filter: blur
  const filterBlur = html.match(/filter\s*:\s*[^;]*blur/gi);
  if (filterBlur && filterBlur.length > 0) {
    issues.push({
      rule: 'no-filter-blur',
      severity: 'warn',
      match: filterBlur[0],
      message: `发现 ${filterBlur.length} 处 filter: blur，模糊效果被禁`,
    });
  }

  // 3. 越界字号（> 96px）
  const bigFont = html.match(/font-size\s*:\s*(\d{3,})px/gi);
  if (bigFont && bigFont.length > 0) {
    issues.push({
      rule: 'font-size-too-large',
      severity: 'warn',
      match: bigFont[0],
      message: `发现 ${bigFont.length} 处超大字号（≥100px），可能撑破页面`,
    });
  }

  // 4. 外部图片引用
  const imgHttp = html.match(/<img[^>]+src\s*=\s*["'](http[^"']+)/gi);
  if (imgHttp && imgHttp.length > 0) {
    issues.push({
      rule: 'no-external-image',
      severity: 'error',
      match: imgHttp[0],
      message: `发现 ${imgHttp.length} 个外部图片引用，HTML 内不允许`,
    });
  }

  // 5. 多层渐变叠加
  const multiGrad = html.match(/linear-gradient/g);
  if (multiGrad && multiGrad.length > 2) {
    issues.push({
      rule: 'multi-gradient',
      severity: 'warn',
      match: multiGrad[0],
      message: `发现 ${multiGrad.length} 处渐变，可能过度装饰`,
    });
  }

  // 6. data-layout 缺失或错误
  const slideSections = html.match(/<section[^>]+class\s*=\s*["'][^"']*slide[^"']*["'][^>]*>/gi) || [];
  const dataLayoutAttrs = html.match(/data-layout\s*=\s*["']([^"']+)["']/gi) || [];
  if (slideSections.length > 0 && dataLayoutAttrs.length < slideSections.length) {
    issues.push({
      rule: 'missing-data-layout',
      severity: 'error',
      message: `${slideSections.length} 页但只有 ${dataLayoutAttrs.length} 个 data-layout 属性`,
    });
  }

  return issues;
}

function buildUserPrompt(theme: PptTheme, outline: Outline, extra?: string): string {
  const slidesJson = JSON.stringify(
    {
      title: outline.title,
      slides: outline.slides.map((s, i) => ({
        index: i + 1,
        title: s.title,
        bullets: s.bullets.filter((b) => b.trim()),
      })),
    },
    null,
    2,
  );

  const layoutsBlock = LAYOUT_IDS.map((id) => theme.layouts[id].prompt).join('\n\n');

  return [
    `# 演示文稿主题`,
    outline.title,
    '',
    `# 选定的视觉主题`,
    theme.name,
    theme.description,
    '',
    `# 主题颜色变量（仅用这些）`,
    `- primary: ${theme.colors.primary}（标题 / 主装饰）`,
    `- secondary: ${theme.colors.secondary}（辅助 / 渐变终）`,
    `- accent: ${theme.colors.accent}（强调 / 小色块 / 数据）`,
    `- background: ${theme.colors.background}（正文页背景）`,
    '',
    `# 6 套预设版式（每页必选其一，严格按规范执行）`,
    layoutsBlock,
    '',
    `# 内容大纲（JSON）`,
    '```json',
    slidesJson,
    '```',
    '',
    `# 版式建议分配`,
    buildLayoutHint(outline),
    '',
    extra ? `# 附加要求\n${extra}` : '',
    '',
    '# 输出',
    '请生成完整 HTML。每一页 <section> 必须带 data-layout 属性。',
  ].join('\n');
}

function buildLayoutHint(outline: Outline): string {
  const total = outline.slides.length;
  const hints: string[] = [];
  outline.slides.forEach((s, i) => {
    const idx = i + 1;
    let suggestion = 'content';
    if (idx === 1) suggestion = 'cover';
    else if (idx === total) suggestion = 'closing';
    else {
      const bulletsCount = (s.bullets || []).filter((b) => b.trim()).length;
      const hasBigNumber = /(\d+%|¥|\$|\d+亿|\d+万|\d+\.\d+|\d+ 倍|\d+x)/.test(s.title + ' ' + s.bullets.join(' '));
      if (bulletsCount >= 4) suggestion = 'content';
      else if (bulletsCount <= 2 && hasBigNumber) suggestion = 'data';
      else suggestion = 'content';
    }
    hints.push(`第 ${idx} 页 [${s.title}] → 建议版式：${suggestion}`);
  });
  return hints.join('\n');
}

function stripCodeFence(s: string): string {
  const m = s.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/);
  if (m) return m[1].trim();
  const m2 = s.match(/```(?:html)?\s*([\s\S]*?)\s*```/);
  if (m2) return m2[1].trim();
  return s;
}

function wrapWithPagination(rawHtml: string, outline: Outline): string {
  const total = outline.slides.length;
  const styleAndScript = `
<style>
@page { size: 13.333in 7.5in; margin: 0; }
@media print {
  .slide { display: flex !important; page-break-after: always; break-after: page; }
  .slide:last-child { page-break-after: auto; break-after: auto; }
  #indicator { display: none !important; }
  body { margin: 0 !important; }
}
</style>
<script>
(function () {
  const slides = document.querySelectorAll('.slide');
  let idx = 0;
  function show(n) {
    if (n < 0 || n >= slides.length) return;
    slides.forEach((s, i) => s.style.display = i === n ? 'flex' : 'none');
    idx = n;
    const ind = document.getElementById('indicator');
    if (ind) ind.textContent = (n + 1) + ' / ${total}';
  }
  function next() { show(Math.min(idx + 1, slides.length - 1)); }
  function prev() { show(Math.max(idx - 1, 0)); }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prev(); }
    else if (e.key === 'Home') { e.preventDefault(); show(0); }
    else if (e.key === 'End') { e.preventDefault(); show(slides.length - 1); }
  });
  show(0);
  // 暴露 API 给父窗口（缩略图点击跳转）
  window.__pptGoto = (n) => show(n);
  window.__pptGetTotal = () => slides.length;
})();
</script>
<div id="indicator" style="position:fixed;bottom:16px;right:24px;font:600 13px/1 'Microsoft YaHei',sans-serif;color:#475569;background:rgba(255,255,255,0.85);padding:6px 12px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,0.08);z-index:9999;pointer-events:none;">1 / ${total}</div>
`;

  if (rawHtml.includes('</body>')) {
    return rawHtml.replace('</body>', styleAndScript + '</body>');
  }
  return rawHtml + styleAndScript;
}
