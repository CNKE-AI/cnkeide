/**
 * DocumentParser - 多格式文档解析（W10）
 *
 * 支持：.md .txt .pdf .docx .html
 * 设计：纯 Node 实现，零外部依赖（除 pdf 解析用 zlib 自解压）
 *
 * 局限：PDF 仅解析文本内容（不支持扫描件/图片）
 * 后续可换 pdf-parse 或 pdfjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export interface ParsedDocument {
  /** 文档唯一 id（路径 hash） */
  id: string;
  /** 文件绝对路径 */
  path: string;
  /** 文件名 */
  name: string;
  /** 文档类型 */
  type: 'markdown' | 'text' | 'pdf' | 'docx' | 'html' | 'unknown';
  /** 解析出的纯文本（已去标签/去格式） */
  text: string;
  /** 解析元信息（页数、字数等） */
  meta: {
    bytes: number;
    chars: number;
    pages?: number;
  };
}

/** 主入口 */
export async function parseDocument(filePath: string): Promise<ParsedDocument> {
  const stat = await fs.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  let type: ParsedDocument['type'] = 'unknown';
  let text = '';
  let pages: number | undefined;

  switch (ext) {
    case '.md':
    case '.markdown':
      type = 'markdown';
      text = await fs.readFile(filePath, 'utf-8');
      break;
    case '.txt':
    case '.log':
    case '.csv':
      type = 'text';
      text = await fs.readFile(filePath, 'utf-8');
      break;
    case '.html':
    case '.htm':
      type = 'html';
      text = htmlToText(await fs.readFile(filePath, 'utf-8'));
      break;
    case '.pdf': {
      type = 'pdf';
      const pdfResult = await parsePdf(filePath);
      text = pdfResult.text;
      pages = pdfResult.pages;
      break;
    }
    case '.docx':
      type = 'docx';
      text = await parseDocx(filePath);
      break;
    default:
      // 尝试当文本读
      type = 'unknown';
      try { text = await fs.readFile(filePath, 'utf-8'); } catch { text = ''; }
  }

  return {
    id: hashId(filePath),
    path: filePath,
    name: path.basename(filePath),
    type,
    text: text.trim(),
    meta: {
      bytes: stat.size,
      chars: text.length,
      pages,
    },
  };
}

/** HTML → 纯文本 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?(div|p|br|h[1-6]|li|tr|td|th|article|section|header|footer|nav|main|aside)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * PDF 解析（轻量：直接读压缩对象）
 * 局限：仅解析简单的 PDF（flate + 文本对象），复杂排版可能丢字
 * 对编程文档（多为简单排版）足够
 */
async function parsePdf(filePath: string): Promise<{ text: string; pages: number }> {
  const buf = await fs.readFile(filePath);
  const text = extractPdfText(buf);
  // 简单估算页数：看 /Type /Page 出现次数
  const pageMatches = buf.toString('binary').match(/\/Type\s*\/Page[^s]/g);
  const pages = pageMatches ? pageMatches.length : 1;
  return { text, pages };
}

/** 从 PDF 二进制提取文本（处理 FlateDecode 压缩） */
function extractPdfText(buf: Buffer): string {
  const binary = buf.toString('binary');
  // 找所有 stream ... endstream 块
  const out: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(binary)) !== null) {
    const raw = Buffer.from(m[1], 'binary');
    let decoded: Buffer;
    try {
      decoded = zlib.inflateSync(raw);
    } catch {
      // 没压缩或压缩算法不同，跳过
      decoded = raw;
    }
    const text = decoded.toString('latin1');
    // 提取 (... ) 圆括号包裹的文本对象
    const tjRe = /\(((?:\\.|[^()\\])*)\)\s*Tj/g;
    let tm: RegExpExecArray | null;
    while ((tm = tjRe.exec(text)) !== null) {
      const s = decodePdfEscapes(tm[1]);
      out.push(s);
    }
    // 也支持 TJ 数组形式：[(str) (str)] TJ
    const tjArrRe = /\[([\s\S]*?)\]\s*TJ/g;
    while ((tm = tjArrRe.exec(text)) !== null) {
      const arr = tm[1];
      const inner = arr.match(/\(((?:\\.|[^()\\])*)\)/g);
      if (inner) {
        for (const s of inner) out.push(decodePdfEscapes(s.slice(1, -1)));
      }
    }
  }
  return out.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
}

function decodePdfEscapes(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

/**
 * DOCX 解析（DOCX 本质是 zip + XML）
 * 简化：找 document.xml 提取 <w:t> 文本节点
 */
async function parseDocx(filePath: string): Promise<string> {
  // 用 Node 内置 zlib 不够（zip 中央目录需要完整解包）
  // 退而求其次：暴力扫描文件找 <w:t> 标签
  const buf = await fs.readFile(filePath);
  // 找 document.xml 在 zip 里的位置
  const content = buf.toString('binary');
  const idx = content.indexOf('word/document.xml');
  if (idx < 0) {
    return ''; // 找不到，可能是损坏或非标准
  }
  // 找附近 <w:t> 标签
  // DOCX 中 <w:t> 可能未压缩也可能在压缩流里
  // 简化：尝试解 zip 中央目录找 document.xml 的偏移
  const xmlData = extractDocxXml(buf);
  if (!xmlData) return '';
  return extractTextFromDocxXml(xmlData);
}

/** 简化：尝试用 zlib inflate 各处找 document.xml 内容 */
function extractDocxXml(buf: Buffer): string | null {
  // 找所有 zlib 压缩流（PK\x03\x04 后跟 inflate）
  // 用最朴素办法：扫整文件试 inflate
  const out: string[] = [];
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x78 && (buf[i + 1] === 0x9c || buf[i + 1] === 0x01 || buf[i + 1] === 0xda)) {
      try {
        const decoded = zlib.inflateSync(buf.subarray(i, i + 1024 * 1024));
        const s = decoded.toString('utf-8');
        if (s.includes('document.xml') || s.includes('<w:t')) {
          out.push(s);
        }
      } catch { /* not a zlib stream */ }
    }
  }
  // 找最像的 document.xml
  const docXml = out.find((s) => s.includes('w:document') || s.includes('<w:t'));
  return docXml || null;
}

/** 从 DOCX XML 提取纯文本 */
function extractTextFromDocxXml(xml: string): string {
  const out: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]);
  }
  // 也支持 <w:p> 段落分隔
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `doc_${(h >>> 0).toString(36)}`;
}
