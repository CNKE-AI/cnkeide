/**
 * SemanticIndex - 代码块语义索引（W5）
 *
 * 设计：
 * - 把每个代码文件切成"代码块"（按符号/段落），每个块算一个 embedding
 * - 存储于内存 Map（项目级），重建时清空
 * - 召回：cosine similarity topK
 *
 * 块切分策略（轻量，避免复杂解析）：
 * 1. 按"空行 + 符号定义行"切分（TS/JS/Python/Go/Rust 通用）
 * 2. 单块最长 2000 字符（避免超长函数拖垮 embedding 质量）
 * 3. 保留 file/line/symbolName/snippet 元数据
 *
 * 注：本模块不直接调 API，统一由 SemanticRetriever 注入 EmbeddingProvider
 */

export interface CodeChunk {
  id: string;
  file: string;
  line: number;
  symbolName?: string;
  /** 块的纯文本（用于 embedding） */
  text: string;
  /** 简短 snippet（前 200 字符） */
  snippet: string;
  /** embedding 向量（embed 完成后填充） */
  embedding?: number[];
}

export interface SemanticQueryResult {
  chunk: CodeChunk;
  score: number; // 0~1
}

const CHUNK_MAX_CHARS = 2000;
const SNIPPET_MAX = 200;

export class SemanticIndex {
  private chunks: Map<string, CodeChunk> = new Map();
  private chunksByFile: Map<string, string[]> = new Map();
  /** 文件签名（用于增量重建） */
  private fileSigs: Map<string, string> = new Map();

  size(): number {
    return this.chunks.size;
  }

  /** chunks 大小（兼容旧调用方） */
  get chunkCount(): number {
    return this.chunks.size;
  }

  getFiles(): string[] {
    return Array.from(this.chunksByFile.keys());
  }

  /** 重建或增量更新文件索引 */
  indexFile(file: string, content: string): CodeChunk[] {
    const sig = this.signature(content);
    if (this.fileSigs.get(file) === sig) {
      return (this.chunksByFile.get(file) || []).map((id) => this.chunks.get(id)!).filter(Boolean);
    }
    // 移除旧 chunks
    const oldIds = this.chunksByFile.get(file) || [];
    for (const id of oldIds) this.chunks.delete(id);

    const newChunks = chunkFile(file, content);
    const ids: string[] = [];
    for (const c of newChunks) {
      this.chunks.set(c.id, c);
      ids.push(c.id);
    }
    this.chunksByFile.set(file, ids);
    this.fileSigs.set(file, sig);
    return newChunks;
  }

  /** 移除文件 */
  removeFile(file: string): void {
    const ids = this.chunksByFile.get(file) || [];
    for (const id of ids) this.chunks.delete(id);
    this.chunksByFile.delete(file);
    this.fileSigs.delete(file);
  }

  /** 清空 */
  clear(): void {
    this.chunks.clear();
    this.chunksByFile.clear();
    this.fileSigs.clear();
  }

  /** 拿所有 chunk（用于离线 embed） */
  getAllChunks(): CodeChunk[] {
    return Array.from(this.chunks.values());
  }

  /** cosine similarity 检索（需先确保所有 chunk 都已 embed） */
  search(queryVec: number[], topK: number = 10): SemanticQueryResult[] {
    if (queryVec.length === 0) return [];
    const results: SemanticQueryResult[] = [];
    for (const c of this.chunks.values()) {
      if (!c.embedding || c.embedding.length === 0) continue;
      const score = cosine(queryVec, c.embedding);
      results.push({ chunk: c, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /** 给一批 chunk 写入 embedding */
  setEmbeddings(chunks: CodeChunk[], vectors: (number[] | null)[]): number {
    let n = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (vectors[i] && vectors[i]!.length > 0) {
        chunks[i].embedding = vectors[i]!;
        n++;
      }
    }
    return n;
  }

  private signature(content: string): string {
    // 简单签名：内容长度 + 前 64 字符哈希；用于增量判断
    let h = 0;
    for (let i = 0; i < Math.min(content.length, 256); i++) {
      h = (h * 31 + content.charCodeAt(i)) | 0;
    }
    return `${content.length}:${h}`;
  }
}

/** 把文件内容切成 code chunks */
export function chunkFile(file: string, content: string): CodeChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: CodeChunk[] = [];
  let buffer: string[] = [];
  let bufferStart = 1;
  let lastSymbol: string | undefined;

  function flush(endLine: number, force: boolean = false) {
    if (buffer.length === 0) return;
    const text = buffer.join('\n').trim();
    if (text.length === 0) {
      buffer = [];
      return;
    }
    if (text.length < 10 && !force) {
      // 太短的块不单独切
      buffer = [];
      return;
    }
    const id = `${file}#${bufferStart}`;
    const snippet = text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX) + '...' : text;
    chunks.push({
      id,
      file,
      line: bufferStart,
      symbolName: lastSymbol,
      text: text.length > CHUNK_MAX_CHARS ? text.slice(0, CHUNK_MAX_CHARS) : text,
      snippet,
    });
    buffer = [];
  }

  // 简单的"符号行"检测：含 function/class/interface/type/struct/fn/def/func 等关键字
  const SYMBOL_RE = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|fn|def|func|struct|trait|impl|public|private|protected|static|abstract|final|sealed|override|virtual|async)\b/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isSymbol = SYMBOL_RE.test(line);
    const isBlank = /^\s*$/.test(line);

    if (isSymbol || isBlank) {
      // 触发切分
      if (buffer.length > 0) {
        flush(i + 1);
      }
      bufferStart = i + 1;
      if (isSymbol) {
        // 抓符号名
        const m = line.match(/(?:function|class|interface|type|enum|fn|def|func|struct|trait|impl)\s+([A-Za-z_$][\w$]*)/);
        lastSymbol = m ? m[1] : undefined;
        buffer.push(line);
      }
    } else {
      if (buffer.length === 0) bufferStart = i + 1;
      buffer.push(line);
      // 单块超过 CHUNK_MAX_CHARS 强制切分
      if (buffer.join('\n').length > CHUNK_MAX_CHARS) {
        flush(i + 1, true);
        lastSymbol = undefined;
      }
    }
  }
  flush(lines.length, true);

  return chunks;
}

/** cosine similarity */
export function cosine(a: number[], b: number[]): number {
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
