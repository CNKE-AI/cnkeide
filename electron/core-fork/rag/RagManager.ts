/**
 * RagManager - RAG 对外接口（W10）
 *
 * 设计：
 * - 持有 DocumentIndex
 * - 暴露 ingest/remove/list/query 4 个方法
 * - query 返回 LLM-ready 引用文本 + 结构化命中
 */

import { parseDocument } from './DocumentParser';
import { DocumentIndex, DocQueryHit } from './DocumentIndex';
import { EmbeddingProvider, EmbeddingConfig, getEmbeddingProvider } from '../codebase/EmbeddingProvider';

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
    // 注意：这里必须使用静态 import 的 getEmbeddingProvider。
    // 原实现用运行期 require('../codebase/EmbeddingProvider')，打包后该相对路径
    // 会以 dist-electron/main.js 为基准解析（指向 dist-electron/codebase/…），
    // 构建产物中并不存在该文件，于是 new RagManager() 直接抛 MODULE_NOT_FOUND，
    // 连锁导致 registerIpcHandlers() 中断、全部 ipcMain.handle 未注册。
    this.provider = provider || getEmbeddingProvider();
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
