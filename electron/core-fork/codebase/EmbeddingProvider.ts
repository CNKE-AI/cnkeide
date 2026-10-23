/**
 * EmbeddingProvider - LLM 端点 Embedding 调用 + 内存 LRU 缓存（W5）
 *
 * 设计：
 * - 复用用户的 OpenAI 兼容 API（绝大多数 LLM 平台都支持 /v1/embeddings）
 * - 内存 LRU 缓存（不持久化到磁盘，避免打包体积 + IO）
 * - 单例：整个进程共享一个实例（避免重复创建 fetch 连接池）
 */

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 向量维度（按模型固定；调用时按需截断） */
  dimensions?: number;
}

export interface EmbeddingResult {
  embedding: number[];
  cached: boolean;
}

interface CacheEntry {
  embedding: number[];
  addedAt: number;
}

const CACHE_MAX = 500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class EmbeddingProvider {
  private cache: Map<string, CacheEntry> = new Map();
  private inflight: Map<string, Promise<number[]>> = new Map();

  clearCache(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  /**
   * 计算文本的 embedding 向量
   * 失败返回 null（不抛错，让调用方决定是否降级到关键词）
   */
  async embed(config: EmbeddingConfig, text: string, signal?: AbortSignal): Promise<EmbeddingResult | null> {
    const key = this.makeKey(config, text);
    if (!key) return null;

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.addedAt < CACHE_TTL_MS) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { embedding: cached.embedding, cached: true };
    }

    const existing = this.inflight.get(key);
    if (existing) {
      try {
        const vec = await existing;
        return { embedding: vec, cached: false };
      } catch {
        return null;
      }
    }

    const promise = (async () => {
      try {
        return await this.callEmbedApi(config, text, signal);
      } catch {
        return null;
      }
    })();
    // inflight 存的也允许 null；只有成功才往下走
    this.inflight.set(key, promise.then((v) => v ?? ([] as number[])));
    try {
      const vec = await promise;
      if (vec && vec.length > 0) this.putCache(key, vec);
      return vec && vec.length > 0 ? { embedding: vec, cached: false } : null;
    } catch {
      return null;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 批量 embed：并发 4 路（避免单请求体过大触发各家网关限制） */
  async embedBatch(config: EmbeddingConfig, texts: string[], signal?: AbortSignal): Promise<(number[] | null)[]> {
    const out: (number[] | null)[] = new Array(texts.length).fill(null);
    let cursor = 0;
    const limit = 4;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < limit; w++) {
      workers.push((async () => {
        while (true) {
          const i = cursor++;
          if (i >= texts.length) return;
          const r = await this.embed(config, texts[i], signal);
          if (r) out[i] = r.embedding;
        }
      })());
    }
    await Promise.all(workers);
    return out;
  }

  private async callEmbedApi(config: EmbeddingConfig, text: string, signal?: AbortSignal): Promise<number[] | null> {
    const baseUrl = config.baseUrl?.replace(/\/+$/, '');
    if (!baseUrl || !config.apiKey) return null;
    const url = /\/v\d+(beta\d*)?$/.test(baseUrl) ? `${baseUrl}/embeddings` : `${baseUrl}/v1/embeddings`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    const onExternalAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          input: text,
          ...(config.dimensions ? { dimensions: config.dimensions } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        return null;
      }
      const data: unknown = await resp.json();
      const emb =
        typeof data === 'object' && data !== null
          ? (data as { data?: Array<{ embedding?: unknown }> }).data?.[0]?.embedding
          : undefined;
      if (!Array.isArray(emb)) return null;
      return emb as number[];
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }

  private makeKey(config: EmbeddingConfig, text: string): string | null {
    if (!config.baseUrl || !config.model) return null;
    return `${config.baseUrl}::${config.model}::${text}`;
  }

  private putCache(key: string, embedding: number[]): void {
    if (this.cache.size >= CACHE_MAX) {
      // 淘汰最久未用
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, { embedding, addedAt: Date.now() });
  }
}

/** 全局单例 */
let _singleton: EmbeddingProvider | null = null;
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!_singleton) _singleton = new EmbeddingProvider();
  return _singleton;
}
