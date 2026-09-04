/**
 * RagManager - RAG 对外接口（W10）
 *
 * 设计：
 * - 持有 DocumentIndex
 * - 暴露 ingest/remove/list/query 4 个方法
 * - query 返回 LLM-ready 引用文本 + 结构化命中
 */

import { parseDocument, ParsedDocument } from './DocumentParser';
import { DocumentIndex, DocQueryHit } from './DocumentIndex';
import { EmbeddingProvider, EmbeddingConfig } from '../codebase/EmbeddingProvider';

export interface RagIngestResult {
  docId: string;
  name: string;
  type: string;
  chars: number;
  pages?: number;
  chunkCount: number;
  embeddedCount: number;
}

export interface RagQueryResult {
  hits: DocQueryHit[];
  context: string;
  truncated: boolean;
}

export class RagManager {
  private index: DocumentIndex;
  private provider: EmbeddingProvider;

  constructor(provider?: EmbeddingProvider) {
    this.provider = provider || (() => {
      const { getEmbeddingProvider } = require('../codebase/EmbeddingProvider');
      return getEmbeddingProvider();
    })();
    this.index = new DocumentIndex(this.provider);
  }

  /**
   * 摄入文档：解析 → 切块 → embedding
   */
  async ingest(filePath: string, config: EmbeddingConfig, signal?: AbortSignal): Promise<RagIngestResult> {
    const doc = await parseDocument(filePath);
    const r = await this.index.addDocument(doc.id, doc.name, doc.text, config, signal);
    return {
      docId: doc.id,
      name: doc.name,
      type: doc.type,
      chars: doc.meta.chars,
      pages: doc.meta.pages,
      chunkCount: r.chunkCount,
      embeddedCount: r.embeddedCount,
    };
  }

  /** 移除文档 */
  remove(docId: string): void {
    this.index.removeDocument(docId);
  }

  /** 列出已索引文档 */
  list() {
    return this.index.listDocuments();
  }

  /** 检索 + 格式化 */
  async query(query: string, config: EmbeddingConfig, topK: number = 5, docIds?: string[], signal?: AbortSignal): Promise<RagQueryResult> {
    const hits = await this.index.search(query, config, topK, docIds, signal);
    const context = this.index.formatHitsForLlm(hits);
    return { hits, context, truncated: hits.length >= topK };
  }
}
