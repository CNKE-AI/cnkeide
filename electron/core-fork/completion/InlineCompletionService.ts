/**
 * AI 行内补全服务（Inline Completion）
 *
 * 设计目标：
 * 1. 独立于 AgentManager —— 不触发记忆 / checkpoint / plan / 事件流，不污染聊天会话。
 * 2. 复用 LLMProvider.chat 的重试 / 超时 / Abort / fallback 能力，采用非流式 + 低温度 + 短超时。
 * 3. 通用前后文续写策略：system 强约束「只输出续写代码」，user 用 <FILE>...<CURSOR>... 标注。
 * 4. LRU 缓存 + 同 key 并发去重 + AbortController 取消，保证高频触发下不打爆后端。
 */

import { dbgLog } from '../util/dbgLog';
import type { LLMProvider } from '../llm/LLMProvider';

/** 单次补全请求（renderer 已截好前后文） */
export interface InlineCompletionRequest {
  /** 文件路径（用于 prompt 提示与日志） */
  filePath: string;
  /** 语言标签（如 ts / py / plaintext） */
  language: string;
  /** 光标前文本（已按行数截断） */
  prefix: string;
  /** 光标后文本（已按行数截断） */
  suffix: string;
}

export type InlineCompletionResult = { text: string } | { error: string };

/** LRU 缓存容量 */
const CACHE_MAX = 200;
/** 缓存 key 取 prefix 尾部 / suffix 首部的字符数 */
const KEY_PREFIX_TAIL = 200;
const KEY_SUFFIX_HEAD = 100;
/** 单次补全最大输出 token（行内续写宜短） */
const MAX_TOKENS = 120;
/** 补全采样温度（低随机性，贴合上下文） */
const TEMPERATURE = 0.2;
/** 超时（行内补全必须快） */
const TOTAL_TIMEOUT_MS = 5000;
const PER_ATTEMPT_TIMEOUT_MS = 4500;

const SYSTEM_PROMPT = [
  '你是一个代码行内补全引擎。用户会给你一段代码，用 <CURSOR> 标记光标位置。',
  '请只输出应插入到 <CURSOR> 处的续写代码本身，严格遵守：',
  '- 不要输出任何解释、注释性前言或 markdown 代码围栏（```）。',
  '- 保持与周围代码一致的缩进和风格。',
  '- 只续写自然的下一小段（通常 1 行到几行），不要补全整段函数或文件。',
  '- 如果无法确定合理续写，输出空字符串。',
].join('\n');

/**
 * 简单字符串 hash（djb2），用于生成缓存 key。
 * 不需要加密强度，只要分布均匀、速度快。
 */
function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** 生成缓存 key：语言 + prefix 尾部 + suffix 首部 */
function cacheKeyOf(req: InlineCompletionRequest): string {
  const prefixTail = req.prefix.slice(-KEY_PREFIX_TAIL);
  const suffixHead = req.suffix.slice(0, KEY_SUFFIX_HEAD);
  return `${req.language}:${djb2(prefixTail)}:${djb2(suffixHead)}`;
}

/** 清理模型输出：剥离 markdown 围栏与首尾多余空白/解释 */
function sanitizeCompletion(raw: string): string {
  if (!raw) return '';
  let text = raw;

  // 剥离 markdown 代码围栏（```lang ... ```）
  const fenceMatch = text.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) text = fenceMatch[1];

  // 去掉首尾的「这是续写：」之类解释性行（保守：只删明显非代码的引导行）
  text = text.replace(/^\s*(?:以下是|这是|续写|补全|答案|输出)[:：].*\n/, '');

  // 只去掉首尾空白行，保留内部缩进
  text = text.replace(/^\n+/, '').replace(/\n+$/, '');
  // 整段为空白（空格/制表/换行）时视为无有效续写
  if (!text.trim()) return '';
  return text;
}

/** 剔除与 prefix 重复的续写前缀（模型有时会回显已存在的代码） */
function dedupeAgainstPrefix(prefix: string, completion: string): string {
  if (!completion) return completion;
  // 取 prefix 末尾若干行，若 completion 以其开头则去掉该重复部分
  const prefixLines = prefix.split('\n');
  for (let n = Math.min(5, prefixLines.length); n >= 1; n--) {
    const tail = prefixLines.slice(-n).join('\n').trimEnd();
    if (tail && completion.startsWith(tail)) {
      return completion.slice(tail.length).replace(/^\n/, '');
    }
  }
  return completion;
}

/** 截断到自然边界：最多保留到最后一个换行/分号/右括号，避免半句 */
function truncateToNaturalBoundary(completion: string): string {
  if (!completion) return completion;
  // 行内补全以「完整行」为单位更稳妥：保留到最后一个换行符（含）
  const lastNewline = completion.lastIndexOf('\n');
  if (lastNewline === -1) return completion; // 单行续写，直接保留
  // 若最后一行（换行后）为空或纯闭合符，截到最后一个换行
  const tail = completion.slice(lastNewline + 1);
  if (tail.trim() === '' || /^[)\]}>;:,]*$/.test(tail.trim())) {
    return completion.slice(0, lastNewline + 1).replace(/\n+$/, '');
  }
  return completion;
}

export class InlineCompletionService {
  /** LRU 缓存：key -> completion text（用 Map 插入序实现 LRU） */
  private cache = new Map<string, string>();
  /** 同 key 进行中的请求，去重复用 */
  private inflight = new Map<string, Promise<InlineCompletionResult>>();
  /** 按 requestId 追踪 AbortController，支持取消 */
  private controllers = new Map<string, AbortController>();
  private requestSeq = 0;

  constructor(private llm: LLMProvider, private config: any) {}

  /** 取当前激活 apiConfig + fallback 链（与 Agent 同源） */
  private async resolveConfigs(): Promise<{ active: any; fallbacks: any[] }> {
    const configs = (await this.config.getApiKeyConfigs()) || [];
    const activeId = await this.config.get('activeApiConfigId');
    const active = configs.find((c: any) => c && c.id === activeId) || configs[0] || null;
    const fallbacks = configs.filter((c: any) => c && c !== active && c.enabled !== false);
    return { active, fallbacks };
  }

  /**
   * 执行一次补全。
   * requestId 用于取消；不传则内部生成（返回值不含 id，取消需用 cancelAll 或自然超时）。
   */
  async complete(req: InlineCompletionRequest, requestId?: string): Promise<InlineCompletionResult> {
    const key = cacheKeyOf(req);

    // 1. 缓存命中
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      // LRU：重新插入以刷新热度
      this.cache.delete(key);
      this.cache.set(key, cached);
      dbgLog(`[inlineCompletion] cache hit key=${key}`);
      return { text: cached };
    }

    // 2. 同 key 并发去重
    const pending = this.inflight.get(key);
    if (pending) {
      dbgLog(`[inlineCompletion] dedupe inflight key=${key}`);
      return pending;
    }

    const id = requestId ?? `ic_${++this.requestSeq}`;
    const controller = new AbortController();
    this.controllers.set(id, controller);

    const task = this.doComplete(req, controller.signal)
      .then((result) => {
        // 成功且非空才入缓存
        if ('text' in result && result.text) {
          this.cache.set(key, result.text);
          if (this.cache.size > CACHE_MAX) {
            // 淘汰最旧（Map 迭代序即插入序）
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
          }
        }
        return result;
      })
      .finally(() => {
        this.inflight.delete(key);
        this.controllers.delete(id);
      });

    this.inflight.set(key, task);
    return task;
  }

  /** 取消指定请求（编辑器失焦 / 切换文件 / 接受后调用） */
  cancel(requestId: string): void {
    const c = this.controllers.get(requestId);
    if (c) {
      c.abort();
      this.controllers.delete(requestId);
    }
  }

  private async doComplete(req: InlineCompletionRequest, signal: AbortSignal): Promise<InlineCompletionResult> {
    const { active, fallbacks } = await this.resolveConfigs();
    if (!active || !active.apiKey) {
      return { error: 'no-active-config' };
    }

    const userContent = [
      `文件: ${req.filePath}`,
      `语言: ${req.language}`,
      '',
      '<FILE>',
      req.prefix,
      '<CURSOR>',
      req.suffix,
      '</FILE>',
    ].join('\n');

    try {
      const resp = await this.llm.chat({
        apiConfig: active,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: TEMPERATURE,
        stream: false,
        signal,
        fallbackConfigs: fallbacks,
        retry: { maxRetries: 1 },
        timeout: { totalTimeoutMs: TOTAL_TIMEOUT_MS, perAttemptTimeoutMs: PER_ATTEMPT_TIMEOUT_MS },
      });

      let text = sanitizeCompletion(resp.content || '');
      text = dedupeAgainstPrefix(req.prefix, text);
      text = truncateToNaturalBoundary(text);

      dbgLog(`[inlineCompletion] ok file=${req.filePath} len=${text.length}`);
      return { text };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        dbgLog(`[inlineCompletion] aborted file=${req.filePath}`);
        return { error: 'aborted' };
      }
      const msg = err instanceof Error ? err.message : String(err);
      dbgLog(`[inlineCompletion] fail file=${req.filePath}: ${msg}`);
      return { error: msg };
    }
  }
}
