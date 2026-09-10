/**
 * PPT 套用模板
 *
 * 支持两种模板形态，自动识别：
 *
 * ① 占位符模板（如本地 mock 用 pptxgenjs 生成的示例）
 *    - {{TITLE}} / {{SUBTITLE}} / {{CLOSING}} ← 全局标题/副标题/结尾
 *    - {{PAGE_TITLE_N}} ← 第 N 页标题
 *    - {{BULLETS_N}} ← 第 N 页要点（多 bullet 用换行分隔）
 *
 * ② 真实 PPT 模板（用户上传的成品 pptx，内部全是实际文字，没有占位符）
 *    策略是「保留样式，只替换能明确识别的文字容器」：
 *    - 优先寻找**语义明确的正文容器**（含多段文本的文本框），只改这类
 *    - 装饰元素（单字、图标文字、页码等）一律不动
 *    - 段落数按内容需要增删，不硬套模板原有段数
 *
 * 实现：用 adm-zip 拆 .pptx，改写 ppt/slides/slideN.xml，重新打包。
 * 不依赖 pptxgenjs（避免对模板结构做破坏性重写，样式/母版/主题全部保留）。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

export interface ApplyOptions {
  templatePath: string;
  outline: { title: string; slides: { title: string; bullets: string[] }[] };
  savePath: string;
}

export interface ApplyResult {
  success: boolean;
  path?: string;
  pageCount?: number;
  /** 实际被改写的幻灯片数，0 表示什么都没改（可用于提示用户） */
  filledCount?: number;
  /** 采用的策略，便于前端提示与排查 */
  strategy?: 'placeholder' | 'inject';
  /** 模板能容纳的大纲页数（内容页槽位），大纲超出时会被截断 */
  capacity?: number;
  /** 未被写入的页数（大纲页数 > 模板可容纳页数时 > 0） */
  skipped?: number;
  /** 生成的提示信息（成功但需要注意的场景） */
  notice?: string;
  error?: string;
}

// ===================== 基础工具 =====================

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 解码 XML 实体（仅用于取纯文本判断，回写时用 escapeXmlText） */
function unescapeXmlText(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

/** 保留原始空白与转义形态，只替换 <a:t> 的内部文本 */
function setTextNodeText(nodeXml: string, text: string): string {
  const open = nodeXml.slice(0, nodeXml.indexOf('>') + 1);
  return `${open}${escapeXmlText(text)}</a:t>`;
}

async function fileExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

// ===================== 占位符替换（策略 ①） =====================

/**
 * 占位符替换：仅替换 <a:t> 内的文本，且 {{K}} 前后可有空白
 */
function fillSlideXml(xml: string, mapping: Record<string, string>): string {
  let out = xml;
  for (const [k, v] of Object.entries(mapping)) {
    const safe = escapeXmlText(v);
    const re = new RegExp(`(<a:t[^>]*>)\\s*\\{\\{${k}\\}\\}\\s*(</a:t>)`, 'g');
    out = out.replace(re, `$1${safe}$2`);
  }
  return out;
}

// ===================== 形状解析（策略 ②） =====================

/** 一个段落 */
interface Paragraph {
  /** 段落完整 XML */
  xml: string;
  /** 段内的 <a:t> 节点 */
  nodes: { full: string; text: string }[];
  /** 段落内的字号（取最大值） */
  size: number;
}

/** 一个文本形状（sp / 图形框） */
interface TextShape {
  /** 形状在 slide XML 中的起止位置 */
  start: number;
  end: number;
  /** 完整原文 */
  raw: string;
  /** 形状内的段落列表 */
  paragraphs: Paragraph[];
  /** 形状整体纯文本（段落用 \n 连接） */
  plainText: string;
  /** 形状内最大字号 */
  maxSize: number;
  /** y 坐标（EMU） */
  y: number;
  /** x 坐标（EMU），取不到返回 0 */
  x: number;
  /** 形状宽度（EMU），0 表示未知 */
  cx: number;
  /** 形状高度（EMU），0 表示未知 */
  cy: number;
  /** 是否位于组合形状内部 */
  inGroup: boolean;
  /** 是否是占位符形状（<p:ph>），标题/正文占位通常是空文本框，仍应作为写入目标 */
  isPlaceholder: boolean;
  /** 占位符类型：title/ctrTitle=标题；body/subTitle=正文 */
  phType: string;
}

/** 提取 XML 中的全部 <a:t> 节点 */
function extractTextNodes(xml: string): { full: string; text: string }[] {
  const out: { full: string; text: string }[] = [];
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push({ full: m[0], text: unescapeXmlText(m[1]) });
  }
  return out;
}

/** 提取形状内所有字号（sz="1800" → 1800；含 run 级与段落级 rPr） */
function extractSizes(xml: string): number[] {
  const out: number[] = [];
  const re = /<a:(rPr|endParaRPr|defRPr)[^>]*\bsz="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(parseInt(m[2], 10));
  return out;
}

/** 提取 x 坐标；取不到返回 0 */
function extractOffsetX(xml: string): number {
  const m = /<a:off\b[^>]*\bx="(-?\d+)"/.exec(xml);
  return m ? parseInt(m[1], 10) : 0;
}

/** 提取 y 坐标；取不到返回 MAX_SAFE_INTEGER */
function extractOffsetY(xml: string): number {
  const m = /<a:off\b[^>]*\by="(-?\d+)"/.exec(xml);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** 提取宽度 cx；取不到返回 0 */
function extractExtCx(xml: string): number {
  const m = /<a:ext\b[^>]*\bcx="(\d+)"/.exec(xml);
  return m ? parseInt(m[1], 10) : 0;
}

/** 提取形状高度 cy；取不到返回 0 */
function extractExtCy(xml: string): number {
  const m = /<a:ext\b[^>]*\bcy="(\d+)"/.exec(xml);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * 把一段 XML 按 <a:p> 切成段落
 *
 * 需要同时支持三种形态：
 *   <a:p>…</a:p>   普通段落
 *   <a:p/>         自闭合空段落（PowerPoint 常见于空行）
 *   <a:pPr …/>     段落的样式（属于该段，不能丢）
 */
function splitParagraphs(bodyXml: string): Paragraph[] {
  const out: Paragraph[] = [];
  const re = /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>|<a:p(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyXml)) !== null) {
    const xml = m[0];
    // 段落样式可能来自 a:pPr（空行段落常常只有 pPr），也可能是段落自身的 rPr
    const pPr = /<a:pPr\b[^>]*>/.exec(xml)?.[0] ?? '';
    const sizes = [...extractSizes(xml), ...extractSizes(pPr)];
    out.push({
      xml,
      nodes: extractTextNodes(xml),
      size: sizes.length ? Math.max(...sizes) : 0,
    });
  }
  return out;
}

/**
 * 从 slide XML 中提取所有「文本形状」
 *
 * 注意：真实 PPT 的 <p:sp> 常嵌套在 <p:grpSp> 里，直接用 indexOf('<p:sp>')
 * 会漏掉组合内的形状，所以这里改为**扫描所有 `<p:sp>` 并做标签配对**，
 * 不依赖所在层级；同时记录是否处于 grpSp 内。
 */
function extractTextShapes(slideXml: string): TextShape[] {
  const shapes: TextShape[] = [];

  // 先算出所有 grpSp 的区间，用于判断某个 sp 是否在组合内
  const groupRanges: { start: number; end: number }[] = [];
  {
    const re = /<p:grpSp>[\s\S]*?<\/p:grpSp>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(slideXml)) !== null) {
      groupRanges.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  const isInGroup = (pos: number) =>
    groupRanges.some((r) => pos > r.start && pos < r.end);

  // 逐个 <p:sp> 做深度配对
  let i = 0;
  while (i < slideXml.length) {
    const open = slideXml.indexOf('<p:sp', i);
    if (open === -1) break;
    // 必须是标签起始（避免匹配到 <p:spPr> / <p:spTree> 之类）
    if (!/^<p:sp[\s>/]/.test(slideXml.slice(open, open + 7))) {
      i = open + 5;
      continue;
    }
    const openEnd = slideXml.indexOf('>', open);
    if (openEnd === -1) break;

    let depth = 0;
    let j = open;
    let end = -1;
    while (j < slideXml.length) {
      const nextOpen = slideXml.indexOf('<p:sp', j);
      const nextClose = slideXml.indexOf('</p:sp>', j);
      if (nextClose === -1) break;
      const validOpen = nextOpen !== -1
        && nextOpen < nextClose
        && /^<p:sp[\s>/]/.test(slideXml.slice(nextOpen, nextOpen + 7));
      if (validOpen) {
        depth++;
        j = slideXml.indexOf('>', nextOpen) + 1;
      } else {
        depth--;
        j = nextClose + 7;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) break;

    const raw = slideXml.slice(open, end);
    // 只处理带 <p:txBody> 的形状
    if (/<p:txBody>/.test(raw)) {
      const txStart = raw.indexOf('<p:txBody>');
      const txEnd = raw.indexOf('</p:txBody>');
      if (txEnd > txStart) {
        const paragraphs = splitParagraphs(raw.slice(txStart, txEnd));
        const sizes = extractSizes(raw);
        const phType = /<p:ph\b[^>]*\btype="([^"]*)"/.exec(raw)?.[1] ?? '';
        shapes.push({
          start: open,
          end,
          raw,
          paragraphs,
          plainText: paragraphs.map((p) => p.nodes.map((n) => n.text).join('')).join('\n'),
          maxSize: sizes.length ? Math.max(...sizes) : 0,
          y: extractOffsetY(raw),
          x: extractOffsetX(raw),
          cx: extractExtCx(raw),
          cy: extractExtCy(raw),
          inGroup: isInGroup(open),
          isPlaceholder: /<p:ph\b/.test(raw),
          phType,
        });
      }
    }

    i = end;
  }

  return shapes;
}

// ===================== 段落增删（保留样式） =====================

/**
 * 把形状的段落数调整为 target 段
 *
 * - 不足：克隆「最后一个有文本的段落」（保留其 rPr 样式与项目符号），
 *   并**清空克隆体里的文本**，避免旧文字被复制。
 * - 超出：删除多余的尾部段落。
 */
function resizeParagraphs(shapeXml: string, target: number): string {
  const txStart = shapeXml.indexOf('<p:txBody>');
  const txEnd = shapeXml.indexOf('</p:txBody>');
  if (txStart === -1 || txEnd === -1 || txEnd < txStart) return shapeXml;

  const body = shapeXml.slice(txStart, txEnd);
  const paras = splitParagraphs(body);
  if (paras.length === 0 || target <= 0) return shapeXml;

  let newBody = body;

  if (target < paras.length) {
    // 删除尾部多余段落（自后向前，避免索引位移）
    for (let k = paras.length - 1; k >= target; k--) {
      const localIdx = newBody.lastIndexOf(paras[k].xml);
      if (localIdx !== -1) {
        newBody = newBody.slice(0, localIdx) + newBody.slice(localIdx + paras[k].xml.length);
      }
    }
  } else if (target > paras.length) {
    // 克隆模板段落：优先用「有文本的段落」作模板，且清空克隆体的文字
    const tplPara =
      [...paras].reverse().find((p) => p.nodes.length > 0 && p.nodes.some((n) => n.text.trim()))?.xml
      ?? paras[paras.length - 1].xml;

    const blankPara = tplPara.replace(
      /<a:t(?:\s[^>]*)?>[\s\S]*?<\/a:t>/g,
      (m) => setTextNodeText(m, ''),
    );

    const insertAt = newBody.lastIndexOf(paras[paras.length - 1].xml) + paras[paras.length - 1].xml.length;
    const extra = blankPara.repeat(target - paras.length);
    newBody = newBody.slice(0, insertAt) + extra + newBody.slice(insertAt);
  }

  return shapeXml.slice(0, txStart) + newBody + shapeXml.slice(txEnd);
}

/**
 * 按段落逐条写入文本
 *
 * 段落数会先被调整为 texts.length，再一一对应写入。
 *
 * 关键：一段文本可能被拆成多个 run（如 `<a:t>风萧萧兮</a:t><a:t>易水寒</a:t>`），
 * 必须把该段所有 text 节点合并成一个承载全文、其余删除，
 * 否则会出现「首字在前、剩余内容跑到后面段落」的错位。
 */
function writeParagraphTexts(shapeXml: string, texts: string[]): string {
  if (texts.length === 0) return shapeXml;

  const resized = resizeParagraphs(shapeXml, texts.length);
  const txStart = resized.indexOf('<p:txBody>');
  const txEnd = resized.indexOf('</p:txBody>');
  if (txStart === -1 || txEnd === -1) return resized;

  let body = resized.slice(txStart, txEnd);
  const paras = splitParagraphs(body);

  // 自后向前处理段落，彻底避免索引位移
  for (let pi = Math.min(paras.length, texts.length) - 1; pi >= 0; pi--) {
    const para = paras[pi];
    let paraXml = para.xml;
    const text = texts[pi] ?? '';

    if (para.nodes.length > 0) {
      // 自后向前：先删掉除第一个之外的文本节点，再把第一个节点写成全文
      for (let ni = para.nodes.length - 1; ni >= 1; ni--) {
        const idx = paraXml.lastIndexOf(para.nodes[ni].full);
        if (idx !== -1) {
          paraXml = paraXml.slice(0, idx) + paraXml.slice(idx + para.nodes[ni].full.length);
        }
      }
      const idx0 = paraXml.lastIndexOf(para.nodes[0].full);
      if (idx0 !== -1) {
        paraXml = paraXml.slice(0, idx0)
          + setTextNodeText(para.nodes[0].full, text)
          + paraXml.slice(idx0 + para.nodes[0].full.length);
      }
    } else {
      // 段内没有任何 <a:t>（纯样式段落）：补一个 run 承载文本
      const closing = paraXml.lastIndexOf('</a:p>');
      if (closing !== -1) {
        paraXml = paraXml.slice(0, closing)
          + `<a:r><a:t>${escapeXmlText(text)}</a:t></a:r>`
          + paraXml.slice(closing);
      }
    }

    const localIdx = body.lastIndexOf(para.xml);
    if (localIdx !== -1) {
      body = body.slice(0, localIdx) + paraXml + body.slice(localIdx + para.xml.length);
    }
  }

  return resized.slice(0, txStart) + body + resized.slice(txEnd);
}

// ===================== 容器识别 =====================

/** 常见的设计性短文本（装饰字、图标文字），不应被当作正文容器 */
const DECORATIVE_PATTERNS: RegExp[] = [
  /^\s*[\d]{1,3}\s*$/,                       // 纯页码/序号
  /^\s*[壹贰叁肆伍陆柒捌玖拾]\s*$/,           // 中文序号单字
  /^\s*[·•\-—|/、,，.。]\s*$/,                // 分隔符
];

/** 是否是明显的目录/导览页（"目录""CONTENTS"） */
function isTocPage(shapes: TextShape[]): boolean {
  return shapes.some((s) =>
    /^\s*(目\s*录|CONTENTS?|content)\s*$/i.test(s.plainText.replace(/\n/g, '').trim()),
  );
}

/**
 * 是否是占位提示文字（模板自带的示例文案）
 *
 * 覆盖国内模板常见说法：在此输入/在此添加/单击此处/点击此处/添加标题/添加文字/
 * 您的内容打在这里/文本占位 等。这些内容必须被清掉或替换，否则成品里会残留。
 */
function isPlaceholderText(t: string): boolean {
  return /请在这里|请在此|输入您的标题|输入标题|点击输入|点击此处|单击此处|单击添加|点击添加|在此输入|在此添加|此处输入|此处添加|这里输入|请输入|输入副标题|输入文本|输入文字|输入内容|输入您需要|添加标题|添加文字|添加内容|内容打在这里|打字|占位|请替换|输入您的|示例文字|文本占位/i
    .test(t);
}

/**
 * 是否是模板自带的「装饰性成句文案」（诗句、引文、slogan）
 *
 * 与 DECORATIVE_PATTERNS 的分工：那边管单字/序号/分隔符（靠长度即可判定），
 * 这边管「成句但明显不是待填内容」的文案。国内模板常见做法是在页面上
 * 排一句诗或一句标语，若被当成正文容器，用户的大纲就会被写错位置。
 *
 * 判定从严，宁可漏判也不能误伤正常正文：
 *  1. 必须是中文成句且长度 >= 5（正常要点如「医疗影像数据量年增 40%」不命中）；
 *  2. 命中古诗词虚词收尾（兮/矣/哉/焉/尔/乎）或典型对仗句式。
 */
function isDecorativeVerse(t: string): boolean {
  const s = t.replace(/\s/g, '');
  if (s.length < 5) return false;
  // 纯中文（含常见标点），避免把中英混排的正文/术语误判
  if (!/^[\u4e00-\u9fa5，。、；：？！“”‘’（）《》—…·]+$/.test(s)) return false;

  // ① 古诗词虚词收尾（「路漫漫其修远兮」「壮哉」「妙矣」）
  if (/[兮矣哉焉尔乎]$/.test(s)) return true;
  // ② 典型标语/诗句对仗句式（「不负韶华 只争朝夕」这类以并列结构出现的整句）
  if (/^(不|莫|勿|何|岂)[\u4e00-\u9fa5]{3,}[，、]?[\u4e00-\u9fa5]{0,}?[乎兮矣哉]$/.test(s)) return true;
  // ③ 成套引号内的完整引文（「……」作为装饰引用出现）
  if (/^[“《][\u4e00-\u9fa5，。、；：？！—…]{4,}[”》]$/.test(s)) return true;

  return false;
}

/**
 * 形状内「有文字的段落」数量
 *
 * 空段落（含自闭合 <a:p/>）在 PPT 里只是排版空行，不能用来判断
 * 「这是多行正文容器」，否则「在此添加标题」这类单行占位框
 * 会因为带 3 个空段落而被误判成正文容器。
 */
function countTextParagraphs(s: TextShape): number {
  return s.paragraphs.filter((p) => p.nodes.some((n) => n.text.trim())).length;
}

/** 是否是 PPT 原生的标题占位符（title / ctrTitle） */
function isTitlePlaceholder(s: TextShape): boolean {
  return s.isPlaceholder && /^(title|ctrTitle)$/i.test(s.phType || 'title');
}

/** 是否是 PPT 原生的正文占位符（body / subTitle） */
function isBodyPlaceholder(s: TextShape): boolean {
  return s.isPlaceholder && /^(body|subTitle|obj|content)$/i.test(s.phType || 'body');
}

/**
 * 从一页中选出「标题容器」与「正文容器」
 *
 * 真实模板（尤其国内 PPT）有两种常见结构，都要能识别：
 *
 * A. 写了示例文字的结构 —— 「请在此输入标题」「您的内容打在这里…」
 *    标题位靠占位文案识别，正文位靠多段落/长占位识别。
 *
 * B. 完全空文字框的结构（103-11is / 中国风格 这类母版驱动的模板）
 *    标题框里一个字都没有，正文也不是「多段落」而只是一根正文条。
 *    此时按「位置 + 字号」推断：页面顶部字号最大的空框 = 标题位，
 *    标题下方最宽的空框 = 正文位。
 */
function pickContainers(shapes: TextShape[]): {
  title: TextShape | null;
  body: TextShape[];
  /** 这页是否是可承载正文的「内容页」 */
  isContentPage: boolean;
} {
  const empty: ReturnType<typeof pickContainers> = { title: null, body: [], isContentPage: false };
  if (shapes.length === 0) return empty;

  const textParaCount = countTextParagraphs;

  // 候选：有实际文字、不是装饰性短文本
  const usable = shapes.filter((s) => {
    const t = s.plainText.replace(/\n/g, '').trim();
    if (!t) return false;
    if (DECORATIVE_PATTERNS.some((re) => re.test(t))) return false;
    // 极短文字（1~2 字，如「淡」「雅」「题」「文」「壹」）视为竖排装饰字，
    // 这类形状常含多个空段落，故按「合并后总字数」判定而非段落数
    if (t.length <= 2 && textParaCount(s) <= 3) return false;
    // 组合形状内的短文本（如「淡」「雅」）视为装饰
    if (s.inGroup && t.length <= 2) return false;
    // 模板自带的装饰性成句文案（诗句/引文）不是待填内容
    if (isDecorativeVerse(t)) return false;
    return true;
  });

  // ---- 标题容器 ----
  // ① 原生标题占位符优先（可能一个字都没有）
  const phTitle = usable.find((s) => isTitlePlaceholder(s) && textParaCount(s) <= 1);
  // ② 单行占位示例文字（"请在此输入标题"）
  const placeholderTitle = usable.find((s) => {
    if (!isPlaceholderText(s.plainText)) return false;
    if (textParaCount(s) > 1) return false;
    // 单行占位框里文字很长（>= 20 字）的一般是正文位而非标题位
    return s.plainText.replace(/\s/g, '').length < 20;
  });

  // ---- 正文容器：真正的多行文本区 ----
  // 注意：含占位文字的**多行**容器是模板预留的正文位，必须算正文容器；
  // 否则会得出「这页没有正文」→ 误判成结尾页 → 整页被跳过。
  const bodyCandidates = usable.filter((s) => {
    if (s === placeholderTitle || s === phTitle) return false;
    const pCount = textParaCount(s);
    if (pCount >= 2) return true;      // 多个有文字的段落
    if (isBodyPlaceholder(s)) return true; // 原生正文占位符
    // 单行但有占位提示且文字够长 → 正文位
    return pCount === 1
      && isPlaceholderText(s.plainText)
      && s.plainText.replace(/\s/g, '').length >= 8;
  });

  let title: TextShape | null = phTitle ?? placeholderTitle ?? null;

  // ---- 兜底：模板文字框全空 / 标题位无文字时，按位置+字号推断 ----
  //
  // 例外：整页的文字全部集中在「竖向长条」框里（竖排诗句，如花瓶/卷轴上的
  // 「挥毫泼墨展英姿」「剑走风动淋漓致」），而且这页**没有**任何标题占位
  // （既无「这里输入标题」也无原生 title 占位符）——那是纯书法装饰页，
  // 没有可承载内容的标题+正文结构，必须跳过，否则会把诗句框当正文位改写。
  //
  // 注意：只要页面存在标题占位，就不能套用该规则——内容页的正文文本框
  // 本身也可能是个较高的窄框（cx < cy），套用会误伤正常内容页。
  const hasExplicitTitle = !!phTitle || !!placeholderTitle;
  if (!hasExplicitTitle && title) {
    const t = title as TextShape;
    const others = usable.filter((s) => s !== t);
    const allVertical = others.length > 0
      && others.every((s) => s.cx > 0 && s.cx < s.cy);
    if (allVertical && t.cx > 0 && t.cx < t.cy) {
      return { title, body: [], isContentPage: false };
    }
  }

  if (!title || bodyCandidates.length === 0) {
    const sortedY = [...usable].sort((a, b) => a.y - b.y);
    const topY = sortedY[0]?.y ?? 0;
    const maxUsableSize = Math.max(0, ...usable.map((s) => s.maxSize));

    // 标题位：页面顶部（前 40% 高度内）字号最大的形状
    if (!title) {
      const topBand = sortedY.filter((s) => s.y - topY < 1_800_000);
      title = [...(topBand.length ? topBand : sortedY)]
        .sort((a, b) => (b.maxSize - a.maxSize) || (a.y - b.y))[0] ?? null;
    }

    // 正文位：标题位之下、偏左、宽度较大的形状
    if (bodyCandidates.length === 0 && title) {
      const below = usable.filter((s) => s !== title && s.y > title!.y);
      const candidates = below.length ? below : usable.filter((s) => s !== title);
      const top = [...candidates]
        .sort((a, b) => (a.y - b.y) || (b.cx - a.cx))[0];
      // 只在形状明显比标题小/宽时才把它当正文位，避免把另一个大标题当正文
      if (top && (maxUsableSize === 0 || top.maxSize <= maxUsableSize * 1.05)) {
        bodyCandidates.push(top);
      }
    }
  }

  const isContentPage = bodyCandidates.length > 0;
  return { title, body: bodyCandidates, isContentPage };
}

/**
 * 对单张内容页执行「标题 + 正文」注入
 *
 * 返回 isContentPage 标记该页是否具备承载正文的能力；
 * 只有 isContentPage=true 的页才会真正写入内容（设计页/章节页会跳过）。
 */
function injectContentSlide(
  xml: string,
  pageTitle: string,
  bullets: string[],
): { xml: string; changed: boolean; hitBody: boolean; isContentPage: boolean } {
  const shapes = extractTextShapes(xml);
  if (shapes.length === 0) return { xml, changed: false, hitBody: false, isContentPage: false };

  const { title, body, isContentPage } = pickContainers(shapes);
  const cleanBullets = bullets.map((b) => b.trim()).filter(Boolean);

  // 不是内容页：完全不动，避免破坏章节页/设计页
  if (!isContentPage) {
    return { xml, changed: false, hitBody: false, isContentPage: false };
  }

  const replacements = new Map<number, string>();
  let hitBody = false;

  // 标题
  if (title && pageTitle) {
    replacements.set(title.start, writeParagraphTexts(title.raw, [pageTitle]));
  }

  // 正文：写入「段落数最多」的容器（模板常把要点放在一个文本框里）
  const target = [...body].sort((a, b) => b.paragraphs.length - a.paragraphs.length)[0];
  if (target) {
    if (cleanBullets.length > 0) {
      replacements.set(target.start, writeParagraphTexts(target.raw, cleanBullets));
      hitBody = true;
    } else {
      // 大纲这页没有要点：清空正文，避免残留模板示例文字
      const blanks = target.paragraphs.map(() => '');
      replacements.set(target.start, writeParagraphTexts(target.raw, blanks.length ? blanks : ['']));
      hitBody = true;
    }
  }

  // 清理其余「占位提示文字」容器（模板自带的示例文案），避免残留。
  // 注意要覆盖单段落的情况：目录页的每个条目副标题常是独立单段落文本框。
  for (const s of shapes) {
    if (replacements.has(s.start)) continue;
    if (s.paragraphs.length > 0 && isPlaceholderText(s.plainText)) {
      replacements.set(s.start, clearShapeText(s.raw));
    }
  }

  if (replacements.size === 0) return { xml, changed: false, hitBody: false, isContentPage };

  // 自后向前套用，避免索引位移
  let out = xml;
  const entries = [...replacements.entries()].sort((a, b) => b[0] - a[0]);
  for (const [start, newRaw] of entries) {
    const shape = shapes.find((s) => s.start === start);
    if (!shape) continue;
    out = out.slice(0, shape.start) + newRaw + out.slice(shape.end);
  }

  return { xml: out, changed: out !== xml, hitBody, isContentPage };
}

/**
 * 清空形状内的所有文字，但**保持段落数不变**（保留版式与项目符号）
 * 用于清除模板自带的示例/占位文字。
 */
function clearShapeText(shapeXml: string): string {
  return shapeXml.replace(
    /<a:t(?:\s[^>]*)?>[\s\S]*?<\/a:t>/g,
    (m) => setTextNodeText(m, ''),
  );
}

/**
 * 清理一页中所有「模板自带的示例/占位文字」容器
 *
 * 独立于内容页判定：目录页等没有正文容器的页也要清理，
 * 否则输出里会残留「请在这里输入副标题」这类模板示例文案。
 * 返回新的 xml 与是否有改动。
 */
function cleanPlaceholderTexts(xml: string, shapes: TextShape[]): { xml: string; changed: boolean } {
  const targets = shapes.filter(
    (s) => s.paragraphs.length > 0
      && s.plainText.trim().length > 0
      && isPlaceholderText(s.plainText),
  );
  if (targets.length === 0) return { xml, changed: false };

  let out = xml;
  for (const s of [...targets].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + clearShapeText(s.raw) + out.slice(s.end);
  }
  return { xml: out, changed: out !== xml };
}

/** 单页内容槽位（按质量排序后使用） */
interface ContentSlot {
  index: number;
  /** 该页可写的正文段数（有文字段落数） */
  paragraphs: number;
  /** 正文容器里已有的总文字量 */
  chars: number;
  /** 已存在的短文本形状数（模板为每个要点预留了独立文本框的特征） */
  shortShapes: number;
  score: number;
}

/**
 * 扫描模板，找出「可承载正文的页」
 *
 * 真实模板常见「设计页 / 章节页 / 目录页 / 内容页」混合布局，
 * 必须只把内容写进真正的内容页，否则会把目录/章节页写坏。
 *
 * 返回顺序与模板页序一致（封面/结尾由调用方通过 skip 排除）。
 */
function findContentPages(
  zip: AdmZip,
  slideList: { entryName: string }[],
  skip: Set<number>,
): number[] {
  const slots: ContentSlot[] = [];

  for (let i = 0; i < slideList.length; i++) {
    if (skip.has(i)) continue;
    const entry = zip.getEntry(slideList[i].entryName);
    if (!entry) continue;
    const xml = entry.getData().toString('utf-8');
    const shapes = extractTextShapes(xml);

    // 目录/章节导览页结构特殊（多个并列短条目），写进去会破坏结构
    if (isTocPage(shapes)) continue;

    const { body, isContentPage } = pickContainers(shapes);
    if (body.length === 0 || !isContentPage) continue;

    // 反查：若这页的「正文容器」其实是章节条目列表（多个短文本并列），也跳过。
    // 注意：只统计**有文字的段落**，空段落（含自闭合 <a:p/>）会拉低平均值
    // 从而把正常内容页（如"2017年…<空行>2018年…"）误判成目录条目。
    const longest = [...body].sort(
      (a, b) => countTextParagraphs(b) - countTextParagraphs(a),
    )[0];
    const pCount = countTextParagraphs(longest);
    const textParas = longest.paragraphs.filter((p) => p.nodes.some((n) => n.text.trim()));
    const chars = textParas.map((p) => p.nodes.map((n) => n.text).join('')).join('').replace(/\s/g, '').length;
    const avgLen = chars / Math.max(1, pCount);
    if (avgLen < 4) continue; // 平均每段不到 4 字 → 是目录/条目，不是正文

    // 模板为「每个要点一个独立文本框」的版式：有若干个短文本框
    const shortShapes = shapes.filter((s) => {
      const t = s.plainText.replace(/\n/g, '').trim();
      return t.length >= 3 && t.length <= 40 && countTextParagraphs(s) === 1;
    }).length;

    // 打分：文字越多越像正文位；页内短文本框并列说明这页能承载多个要点
    const score = chars + shortShapes * 12 + pCount * 6;
    slots.push({ index: i, paragraphs: pCount, chars, shortShapes, score });
  }

  // 保持模板页序：用户预期大纲第 1 页写进模板第 1 个内容页槽位
  return slots.map((s) => s.index);
}

/**
 * 封面注入：主标题 = 字号最大的容器；副标题 = 次大
 */
function injectCoverSlide(
  xml: string,
  title: string,
  subtitle: string,
): { xml: string; changed: boolean } {
  const shapes = extractTextShapes(xml);
  if (shapes.length === 0) return { xml, changed: false };

  const usable = shapes.filter((s) => {
    const t = s.plainText.replace(/\n/g, '').trim();
    if (!t) return false;
    if (DECORATIVE_PATTERNS.some((re) => re.test(t))) return false;
    if (s.inGroup && t.length <= 2) return false;
    return true;
  });
  if (usable.length === 0) return { xml, changed: false };

  // 按字号降序；同字号按 y 升序
  const ranked = [...usable].sort((a, b) => (b.maxSize - a.maxSize) || (a.y - b.y));
  const titleShape = ranked[0];

  const replacements = new Map<number, string>();
  replacements.set(titleShape.start, writeParagraphTexts(titleShape.raw, [title]));

  // 副标题：次大字号，且明显小于主标题（避免把并列的装饰大字当成副标题）
  if (subtitle) {
    const subShape = ranked[1];
    if (subShape && subShape.maxSize > 0 && subShape.maxSize < titleShape.maxSize) {
      replacements.set(subShape.start, writeParagraphTexts(subShape.raw, [subtitle]));
    }
  }

  let out = xml;
  const entries = [...replacements.entries()].sort((a, b) => b[0] - a[0]);
  for (const [start, newRaw] of entries) {
    const shape = shapes.find((s) => s.start === start);
    if (!shape) continue;
    out = out.slice(0, shape.start) + newRaw + out.slice(shape.end);
  }

  return { xml: out, changed: out !== xml };
}

// ===================== 幻灯片顺序 =====================

/** 读取 pptx 中 slide 文件的自然序列表（按真实展示顺序） */
function listSlides(zip: AdmZip): { entryName: string; index: number }[] {
  try {
    const presEntry = zip.getEntry('ppt/presentation.xml');
    const relsEntry = zip.getEntry('ppt/_rels/presentation.xml.rels');
    if (presEntry && relsEntry) {
      const pres = presEntry.getData().toString('utf-8');
      const rels = relsEntry.getData().toString('utf-8');
      const relMap = new Map<string, string>();
      const relRe = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g;
      let rm: RegExpExecArray | null;
      while ((rm = relRe.exec(rels)) !== null) relMap.set(rm[1], rm[2]);

      const ordered: { entryName: string; index: number }[] = [];
      const idRe = /<p:sldId\b[^>]*\br:id="([^"]+)"/g;
      let im: RegExpExecArray | null;
      while ((im = idRe.exec(pres)) !== null) {
        const target = relMap.get(im[1]);
        if (!target) continue;
        const normalized = path.posix.normalize(
          target.startsWith('/') ? target.slice(1) : 'ppt/' + target,
        );
        if (zip.getEntry(normalized)) {
          const n = parseInt((normalized.match(/slide(\d+)\.xml$/) || [])[1] || '0', 10);
          ordered.push({ entryName: normalized, index: n });
        }
      }
      if (ordered.length > 0) return ordered;
    }
  } catch { /* 回退到文件名排序 */ }

  return zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .map((e) => ({
      entryName: e.entryName,
      index: parseInt(e.entryName.match(/slide(\d+)\.xml/)![1], 10),
    }))
    .sort((a, b) => a.index - b.index);
}

// ===================== 主入口 =====================

export async function applyTemplate(opts: ApplyOptions): Promise<ApplyResult> {
  try {
    if (!(await fileExists(opts.templatePath))) {
      return { success: false, error: `模板文件不存在：${opts.templatePath}` };
    }

    const zip = new AdmZip(opts.templatePath);
    const slideList = listSlides(zip);
    if (slideList.length === 0) {
      return { success: false, error: '模板内没有找到任何幻灯片' };
    }
    const totalPages = slideList.length;
    const slideCount = opts.outline.slides.length;

    // ---------- 策略 ①：占位符替换 ----------
    const mapping: Record<string, string> = {
      TITLE: opts.outline.title,
      SUBTITLE: `共 ${slideCount} 页 · 自动生成`,
      CLOSING: '感谢观看',
    };
    opts.outline.slides.forEach((s, i) => {
      mapping[`PAGE_TITLE_${i + 1}`] = s.title;
      mapping[`BULLETS_${i + 1}`] = s.bullets.filter((b) => b.trim()).join('\n');
    });

    let placeholderHits = 0;
    const placeholderApplied = new Map<string, string>();
    for (const { entryName } of slideList) {
      const entry = zip.getEntry(entryName);
      if (!entry) continue;
      const before = entry.getData().toString('utf-8');
      const after = fillSlideXml(before, mapping);
      if (before !== after) { placeholderApplied.set(entryName, after); placeholderHits++; }
    }

    if (placeholderHits > 0) {
      for (const [entryName, xml] of placeholderApplied) {
        zip.updateFile(entryName, Buffer.from(xml, 'utf-8'));
      }
      await fsp.mkdir(path.dirname(opts.savePath), { recursive: true });
      zip.writeZip(opts.savePath);
      return {
        success: true,
        path: opts.savePath,
        pageCount: totalPages,
        filledCount: placeholderHits,
        strategy: 'placeholder',
      };
    }

    // ---------- 策略 ②：真实 PPT 文本注入 ----------

    // 识别封面（第 1 页）
    const coverIdx = 0;

    // 结尾页判定：必须是「有感谢/结束语」或「完全没有正文容器」的页
    // （不能只靠字数少判断，否则会误伤简短的正常内容页）
    const detectClosing = (): boolean => {
      if (totalPages < 3) return false;
      const lastEntry = zip.getEntry(slideList[totalPages - 1].entryName);
      if (!lastEntry) return false;
      const xml = lastEntry.getData().toString('utf-8');
      const shapes = extractTextShapes(xml);

      // 有明确结束语 → 结尾页
      const plain = shapes.map((s) => s.plainText).join('');
      if (/感谢(聆听|观看|阅读|垂听)|谢谢(观看|聆听)?|THANKS?|The\s+End/i.test(plain)) {
        return true;
      }

      // 没有任何可承载正文的容器 → 结尾页（设计页）
      const { body } = pickContainers(shapes);
      return body.length === 0;
    };
    const hasClosing = detectClosing();

    // 只挑「真正有正文容器」的页做为内容页槽位，
    // 跳过设计页/章节页（如只有「贰」的过渡页），避免写坏版式
    //
    // 注意：skipSet 里存的必须是 **数组下标**（与 findContentPages / 循环里的 i 同一坐标系），
    // 不能用 slideList[i].index（那是 slideN.xml 的文件编号）。二者在
    // 「slideN.xml 文件编号与展示顺序不一致」的模板里会错位，导致封面/结尾页被当成
    // 内容页写入、正常内容页被跳过。
    const skipSet = new Set<number>([coverIdx]);
    if (hasClosing) skipSet.add(totalPages - 1);

    let contentPageIdxs = findContentPages(zip, slideList, skipSet);

    // 没有任何可识别正文容器的页 → 至少尝试把非封面/非结尾页当内容页
    if (contentPageIdxs.length === 0) {
      for (let i = 0; i < totalPages; i++) {
        if (!skipSet.has(i)) contentPageIdxs.push(i);
      }
    }

    const capacity = contentPageIdxs.length;
    const writeCount = Math.min(capacity, slideCount);
    const skipped = Math.max(0, slideCount - writeCount);

    let filledCount = 0;
    let bodyHits = 0;

    // 封面
    {
      const entry = zip.getEntry(slideList[coverIdx].entryName);
      if (entry) {
        const before = entry.getData().toString('utf-8');
        const { xml: after, changed } = injectCoverSlide(
          before,
          opts.outline.title,
          `共 ${slideCount} 页 · 自动生成`,
        );
        if (changed) {
          zip.updateFile(slideList[coverIdx].entryName, Buffer.from(after, 'utf-8'));
          filledCount++;
        }
      }
    }

    // 内容页：逐页对应写入
    const writtenPages = new Set<number>();
    for (let i = 0; i < writeCount; i++) {
      const pageIdx = contentPageIdxs[i];
      const entry = zip.getEntry(slideList[pageIdx].entryName);
      if (!entry) continue;

      const slideData = opts.outline.slides[i];
      if (!slideData) continue;

      const before = entry.getData().toString('utf-8');
      const { xml: after, changed, hitBody } = injectContentSlide(
        before,
        slideData.title || '',
        slideData.bullets,
      );
      if (changed) {
        zip.updateFile(slideList[pageIdx].entryName, Buffer.from(after, 'utf-8'));
        writtenPages.add(pageIdx);
        filledCount++;
        if (hitBody) bodyHits++;
      }
    }

    // 清掉所有未处理页里模板自带的占位示例文字（如目录页的「请在这里输入副标题」），
    // 避免输出成品里残留模板示例文案
    for (let i = 0; i < totalPages; i++) {
      if (skipSet.has(i) || writtenPages.has(i)) continue;
      const entry = zip.getEntry(slideList[i].entryName);
      if (!entry) continue;
      const before = entry.getData().toString('utf-8');
      const shapes = extractTextShapes(before);
      const { xml: after, changed } = cleanPlaceholderTexts(before, shapes);
      if (changed) {
        zip.updateFile(slideList[i].entryName, Buffer.from(after, 'utf-8'));
      }
    }

    await fsp.mkdir(path.dirname(opts.savePath), { recursive: true });
    zip.writeZip(opts.savePath);

    if (filledCount === 0) {
      return {
        success: false,
        pageCount: totalPages,
        filledCount: 0,
        strategy: 'inject',
        error: '模板中没有可识别的文字框，无法注入内容（该模板可能是纯图片版式）',
      };
    }

    // 生成提示：把「模板页数不够」这件事如实告诉用户
    let notice: string | undefined;
    if (skipped > 0) {
      notice = `模板共 ${totalPages} 页，可写入 ${writeCount} 页内容，大纲有 ${slideCount} 页，最后 ${skipped} 页未写入。建议选择页数更多的模板，或减少大纲页数。`;
    } else if (bodyHits === 0) {
      notice = `已替换 ${filledCount} 页的标题，但未识别到正文文本框，要点未写入。`;
    }

    return {
      success: true,
      path: opts.savePath,
      pageCount: totalPages,
      filledCount,
      strategy: 'inject',
      capacity,
      skipped,
      notice,
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
