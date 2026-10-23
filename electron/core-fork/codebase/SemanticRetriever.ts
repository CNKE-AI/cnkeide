/**
 * SemanticRetriever - 3 路召回融合（W5）
 *
 * 召回链路：
 *   1. 关键词（BM25 简化版：行级 + 文件名 + 符号名加权）
 *   2. 语义 embedding（cosine topK）
 *   3. 符号引用（searchSymbol / findReferences 增强）
 *
 * 融合：加权求和 → 排序 → topN
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { CodebaseIndexer } from './CodebaseIndexer';
import { EmbeddingProvider, EmbeddingConfig } from './EmbeddingProvider';
import { SemanticIndex, CodeChunk, SemanticQueryResult } from './SemanticIndex';

export interface RetrieverConfig {
  rootPath: string;
  /** 是否启用 embedding（用户配置/降级可关闭） */
  enableEmbedding: boolean;
  embedding?: EmbeddingConfig;
  /** 各路权重（默认 keyword=0.4, semantic=0.5, symbol=0.3） */
  weights?: { keyword: number; semantic: number; symbol: number };
  /** 最终返回 topK */
  topK?: number;
}

export interface RetrieverResult {
  file: string;
  relativeFile: string;
  line: number;
  snippet: string;
  score: number;
  sources: Array<'keyword' | 'semantic' | 'symbol'>;
  symbolName?: string;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'dist-electron', 'out', 'build',
  'coverage', '.next', '.cache', 'vendor', '__pycache__', 'target',
]);

const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.cpp', '.c', '.h', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.m', '.mm',
  '.json', '.md', '.txt', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss',
]);

export class SemanticRetriever {
  private index: SemanticIndex = new SemanticIndex();
  private fileList: string[] = [];
  private indexedFiles: Set<string> = new Set();
  private keywordIndex: Map<string, Set<string>> = new Map(); // word -> file paths
  private codebaseIndexer: CodebaseIndexer;

  constructor(private rootPath: string) {
    this.codebaseIndexer = new CodebaseIndexer({ rootPath });
  }

  /**
   * 完整重建：扫描文件 + 切块 + 关键词索引
   * embedding 异步执行，调用方可不等
   */
  async rebuild(): Promise<{ fileCount: number; chunkCount: number }> {
    this.index.clear();
    this.fileList = [];
    this.indexedFiles.clear();
    this.keywordIndex.clear();
    await this.codebaseIndexer.rebuildIndex();
    await this.scanFiles(this.rootPath);
    // 给代码库符号索引器建立 keyword 索引（行级反向）
    return { fileCount: this.indexedFiles.size, chunkCount: this.index.chunkCount };
  }

  /** 异步给所有 chunk 跑 embedding（增量） */
  async embedAll(config: EmbeddingConfig, provider: EmbeddingProvider, signal?: AbortSignal): Promise<{ embedded: number; failed: number }> {
    const chunks = this.index.getAllChunks().filter((c) => !c.embedding || c.embedding.length === 0);
    if (chunks.length === 0) return { embedded: 0, failed: 0 };
    const vectors = await provider.embedBatch(config, chunks.map((c) => c.text), signal);
    let embedded = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (vectors[i]) {
        chunks[i].embedding = vectors[i]!;
        embedded++;
      }
    }
    return { embedded, failed: chunks.length - embedded };
  }

  /**
   * 3 路召回 + 融合
   */
  async search(query: string, config: RetrieverConfig, signal?: AbortSignal): Promise<RetrieverResult[]> {
    const weights = config.weights || { keyword: 0.4, semantic: 0.5, symbol: 0.3 };
    const topK = config.topK ?? 10;
    const scores: Map<string, { file: string; relativeFile: string; line: number; snippet: string; symbolName?: string; score: number; sources: Set<'keyword' | 'semantic' | 'symbol'> }> = new Map();

    const rel = (file: string) => path.relative(this.rootPath, file).replace(/\\/g, '/');

    function add(file: string, line: number, snippet: string, score: number, source: 'keyword' | 'semantic' | 'symbol', symbolName?: string) {
      const key = `${file}:${line}`;
      const existing = scores.get(key);
      if (existing) {
        existing.score += score;
        existing.sources.add(source);
      } else {
        scores.set(key, { file, relativeFile: rel(file), line, snippet, score, sources: new Set([source]), symbolName });
      }
    }

    // 1) 关键词召回
    const kwResults = this.keywordSearch(query, topK * 3);
    for (const r of kwResults) {
      add(r.file, r.line, r.snippet, r.score * weights.keyword, 'keyword');
    }

    // 2) 语义召回
    if (config.enableEmbedding && config.embedding && provider) {
      // provider 通过参数传入更灵活；这里采用全局单例
    }
    if (config.enableEmbedding && config.embedding) {
      const semResults = await this.semanticSearch(query, config.embedding, topK * 3, signal);
      for (const r of semResults) {
        add(r.chunk.file, r.chunk.line, r.chunk.snippet, r.score * weights.semantic, 'semantic', r.chunk.symbolName);
      }
    }

    // 3) 符号召回
    const symResults = await this.codebaseIndexer.searchSymbol(query, 5);
    for (const s of symResults) {
      add(s.file, s.line, s.snippet, 1.0 * weights.symbol, 'symbol', s.name);
    }
    const refResults = await this.codebaseIndexer.findReferences(query, 5);
    for (const r of refResults) {
      add(r.file, r.line, r.snippet, 0.5 * weights.symbol, 'symbol');
    }

    const arr = Array.from(scores.values())
      .map((r) => ({ ...r, sources: Array.from(r.sources) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return arr;
  }

  /** 仅关键词召回（无 embedding 降级路径） */
  keywordSearch(query: string, topK: number = 30): Array<{ file: string; line: number; snippet: string; score: number }> {
    const qWords = tokenize(query);
    if (qWords.length === 0) return [];
    const fileScores: Map<string, { score: number; hits: Array<{ line: number; snippet: string; weight: number }> }> = new Map();

    for (const word of qWords) {
      const matchedFiles = this.keywordIndex.get(word) || new Set<string>();
      for (const file of matchedFiles) {
        const f = fileScores.get(file) || { score: 0, hits: [] };
        f.score += 1;
        fileScores.set(file, f);
      }
    }

    // 行级定位
    const out: Array<{ file: string; line: number; snippet: string; score: number }> = [];
    // SemanticIndex 的 chunks/chunksByFile 为私有，这里以结构化类型读取（只读用途）
    const index = this.index as unknown as {
      chunks: Map<string, CodeChunk>;
      chunksByFile: Map<string, string[]>;
    };
    for (const [file, info] of fileScores) {
      const ids: string[] | undefined = index.chunksByFile.get(file);
      if (!ids) continue;
      for (const id of ids) {
        const c: CodeChunk | undefined = index.chunks.get(id);
        if (!c) continue;
        const lower = c.text.toLowerCase();
        let count = 0;
        for (const w of qWords) if (lower.includes(w)) count++;
        if (count > 0) {
          out.push({
            file,
            line: c.line,
            snippet: c.snippet,
            score: info.score + count * 0.2,
          });
        }
      }
    }

    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topK);
  }

  /** 语义召回（需先 embedAll） */
  async semanticSearch(query: string, config: EmbeddingConfig, topK: number = 30, signal?: AbortSignal): Promise<SemanticQueryResult[]> {
    const provider = getProvider();
    const r = await provider.embed(config, query, signal);
    if (!r) return [];
    return this.index.search(r.embedding, topK);
  }

  private async scanFiles(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await this.scanFiles(path.join(dir, e.name));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!TEXT_EXTS.has(ext)) continue;
        if (e.name.startsWith('.')) continue;
        const file = path.join(dir, e.name);
        if (this.indexedFiles.has(file)) continue;
        await this.indexOneFile(file);
      }
    }
  }

  private async indexOneFile(file: string): Promise<void> {
    try {
      const stat = await fs.stat(file);
      if (stat.size > 2 * 1024 * 1024) return; // > 2MB 跳过
      const content = await fs.readFile(file, 'utf-8');
      const chunks = this.index.indexFile(file, content);
      // 关键词索引
      for (const c of chunks) {
        for (const w of tokenize(c.text)) {
          let set = this.keywordIndex.get(w);
          if (!set) { set = new Set(); this.keywordIndex.set(w, set); }
          set.add(file);
        }
      }
      this.indexedFiles.add(file);
      this.fileList.push(file);
    } catch {
      /* skip */
    }
  }
}

/** 简易分词：去标点 + 转小写 + 长度 >= 2 保留 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && w.length <= 30);
}

import { getEmbeddingProvider } from './EmbeddingProvider';
const provider = getEmbeddingProvider();
function getProvider(): EmbeddingProvider { return provider; }
