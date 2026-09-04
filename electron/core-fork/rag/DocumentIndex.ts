/**
 * DocumentIndex - 文档切块 + Embedding + 检索（W10）
 *
 * 复用 EmbeddingProvider（轻量外部 API）
 * 切块策略：段落优先 + 滑动窗口
 * - 段落（双换行）切分
 * - 单段太长时按字符滑窗（chunk 800，重叠 100）
 * - 检索：query embedding → cosine topK
 */

import { EmbeddingProvider, EmbeddingConfig } from '../codebase/EmbeddingProvider';

export interface DocChunk {
  id: string;
  docId: string;
  docName: string;
  /** 块在文档中的位置（段号或字符 offset） */
  position: number;
  text: string;
  snippet: string;
  embedding?: number[];
}

export interface DocQueryHit {
  chunk: DocChunk;
  score: number;
}

const CHUNK_SIZE = 800;
const OVERLAP = 100;

export class DocumentIndex {
  private docs: Map<string, { name: string; chunks: DocChunk[]; updatedAt: number }> = new Map();
  private provider: EmbeddingProvider;

  constructor(provider?: EmbeddingProvider) {
    this.provider = provider || (() => {
      const { getEmbeddingProvider } = require('../codebase/EmbeddingProvider');
      return getEmbeddingProvider();
    })();
  }

  /** 添加或更新文档 */
  async addDocument(
    docId: string,
    docName: string,
    text: string,
    config: EmbeddingConfig,
    signal?: AbortSignal
  ): Promise<{ chunkCount: number; embeddedCount: number }> {
    const chunks = this.chunkText(docId, docName, text);
    // 异步 embed
    let embeddedCount = 0;
    if (this.provider && config.baseUrl && config.apiKey) {
      const vectors = await this.provider.embedBatch(config, chunks.map((c) => c.text), signal);
      for (let i = 0; i < chunks.length; i++) {
        if (vectors[i] && vectors[i]!.length > 0) {
          chunks[i].embedding = vectors[i]!;
          embeddedCount++;
        }
      }
    }
    this.docs.set(docId, { name: docName, chunks, updatedAt: Date.now() });
    return { chunkCount: chunks.length, embeddedCount };
  }

  /** 移除文档 */
  removeDocument(docId: string): void {
    this.docs.delete(docId);
  }

  /** 列出文档 */
  listDocuments(): Array<{ id: string; name: string; chunkCount: number; updatedAt: number }> {
    return Array.from(this.docs.entries()).map(([id, d]) => ({
      id,
      name: d.name,
      chunkCount: d.chunks.length,
      updatedAt: d.updatedAt,
    }));
  }

  /** 检索 */
  async search(
    query: string,
    config: EmbeddingConfig,
    topK: number = 5,
    docIds?: string[],
    signal?: AbortSignal
  ): Promise<DocQueryHit[]> {
    if (!this.provider || !config.baseUrl || !config.apiKey) {
      return this.keywordSearch(query, topK, docIds);
    }
    const qr = await this.provider.embed(config, query, signal);
    if (!qr) {
      return this.keywordSearch(query, topK, docIds);
    }
    const out: DocQueryHit[] = [];
    for (const [docId, doc] of this.docs) {
      if (docIds && docIds.length > 0 && !docIds.includes(docId)) continue;
      for (const c of doc.chunks) {
        if (!c.embedding || c.embedding.length === 0) continue;
        const score = cosine(qr.embedding, c.embedding);
        out.push({ chunk: c, score });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topK);
  }

  /** 关键词兜底检索 */
  keywordSearch(query: string, topK: number = 5, docIds?: string[]): DocQueryHit[] {
    const words = tokenize(query);
    if (words.length === 0) return [];
    const out: DocQueryHit[] = [];
    for (const [docId, doc] of this.docs) {
      if (docIds && docIds.length > 0 && !docIds.includes(docId)) continue;
      for (const c of doc.chunks) {
        const lower = c.text.toLowerCase();
        let hits = 0;
        for (const w of words) if (lower.includes(w)) hits++;
        if (hits > 0) {
          out.push({ chunk: c, score: hits / words.length });
        }
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topK);
  }

  /** 把检索结果格式化为 LLM 可读的引用文本 */
  formatHitsForLlm(hits: DocQueryHit[], maxChars: number = 4000): string {
    if (hits.length === 0) return '（无相关文档）';
    const out: string[] = ['[检索到的相关文档片段]'];
    let total = 0;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const ref = `[${i + 1}] 来自《${h.chunk.docName}》（相关度 ${(h.score * 100).toFixed(1)}%）`;
      const block = `${ref}\n${h.chunk.text}`;
      if (total + block.length > maxChars) {
        // 截断最后一个
        const remain = maxChars - total;
        if (remain < 100) break;
        out.push(block.slice(0, remain) + '\n...(截断)');
        break;
      }
      out.push(block);
      total += block.length;
    }
    return out.join('\n\n');
  }

  /** 切块：段落 + 滑动窗口 */
  chunkText(docId: string, docName: string, text: string): DocChunk[] {
    const chunks: DocChunk[] = [];
    const paragraphs = text.split(/\n\s*\n/);
    let position = 0;
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      if (trimmed.length <= CHUNK_SIZE) {
        chunks.push({
          id: `${docId}_${position}`,
          docId,
          docName,
          position,
          text: trimmed,
          snippet: trimmed.slice(0, 150),
        });
        position++;
      } else {
        // 滑动窗口切分
        for (let i = 0; i < trimmed.length; i += CHUNK_SIZE - OVERLAP) {
          const slice = trimmed.slice(i, i + CHUNK_SIZE);
          chunks.push({
            id: `${docId}_${position}_${i}`,
            docId,
            docName,
            position: position + i / 1000,
            text: slice,
            snippet: slice.slice(0, 150),
          });
        }
        position++;
      }
    }
    return chunks;
  }
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && w.length <= 30);
}
