/**
 * 重试与超时策略（国内 T0 标准）
 *
 * 设计目标：
 * 1. 网络瞬时抖动（ECONNRESET / 5xx / 429）自动指数退避重试
 * 2. 每个请求带硬超时（默认 120s），防止 Agent 永久挂起
 * 3. 支持 AbortSignal，Agent 停止 / 切换会话时立即断开 fetch
 * 4. 主模型失败后按 fallback 链自动切到备用模型
 * 5. 流式响应在 abort 时立即停止 reader.read 并 resolve 部分结果
 */

import { appendFileSync } from 'node:fs';

function dbgLog(msg: string): void {
  try {
    appendFileSync('C:\\Users\\yuhen\\Downloads\\CNKE\\cnke-claw\\agent-debug.log', `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

/** 可重试的 HTTP 状态码（429 限流 + 5xx 服务端错误） */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

/** 可重试的错误码（网络层瞬时失败） */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_SOCKET',
  'fetch failed',
]);

export interface RetryOptions {
  /** 最大重试次数（含首次失败），默认 3 */
  maxRetries?: number;
  /** 基础延迟 ms（指数退避），默认 1000 */
  baseDelayMs?: number;
  /** 最大延迟 ms（防止 sleep 过长），默认 8000 */
  maxDelayMs?: number;
}

export interface TimeoutOptions {
  /** 请求总超时 ms（包含重试），默认 120000 */
  totalTimeoutMs?: number;
  /** 单次请求超时 ms（不含重试间隔），默认 60000 */
  perAttemptTimeoutMs?: number;
}

export interface ChatParams {
  apiConfig: any;
  messages: any[];
  tools?: any[];
  temperature?: number;
  topP?: number;
  stream?: boolean;
  onStream?: (delta: string) => void;
  /** 取消信号：调用方（AgentManager）abort 时立即中断 */
  signal?: AbortSignal;
  /** Fallback 模型配置：主模型失败时按顺序尝试 */
  fallbackConfigs?: any[];
  /** 重试与超时策略（不传则用默认） */
  retry?: RetryOptions;
  timeout?: TimeoutOptions;
}

export interface ChatResponse {
  content: string;
  thinking?: string;
  toolCalls?: any[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_miss_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  /** 实际命中的 apiConfig（fallback 切换后与传入不同） */
  resolvedConfig?: any;
  /** 尝试次数（含重试） */
  attempts?: number;
}

/**
 * 归一化 usage：把不同厂商的缓存命中 token 字段统一映射到 OpenAI 兼容的
 * `prompt_tokens_details.cached_tokens / cache_miss_tokens / cache_write_tokens`。
 *
 * 各厂商命名差异（这是「缓存率一直 0」的根因）：
 * - OpenAI:      prompt_tokens_details.cached_tokens / cache_miss_tokens
 * - DeepSeek:    顶层 prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * - Anthropic:   顶层 cache_read_input_tokens / cache_creation_input_tokens
 * - 月之暗面/豆包等: 同上顶层字段
 */
function normalizeUsage(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  const out: any = { ...raw };

  // 已存在 OpenAI 格式的 details 则保留并确保字段存在
  let pd = out.prompt_tokens_details;
  if (!pd || typeof pd !== 'object') {
    pd = {};
    out.prompt_tokens_details = pd;
  }

  const hit =
    pd.cached_tokens ??
    raw.prompt_cache_hit_tokens ??
    raw.cache_read_input_tokens ??
    raw.cached_tokens ??
    0;
  const miss =
    pd.cache_miss_tokens ??
    raw.prompt_cache_miss_tokens ??
    raw.cache_miss_tokens ??
    (raw.prompt_cache_hit_tokens != null || raw.cache_read_input_tokens != null
      ? Math.max(0, (raw.prompt_tokens || 0) - Number(hit))
      : undefined);

  if (hit != null) pd.cached_tokens = Number(hit) || 0;
  if (miss != null) pd.cache_miss_tokens = Number(miss) || 0;
  if (raw.cache_creation_input_tokens != null) {
    pd.cache_write_tokens = Number(raw.cache_creation_input_tokens) || 0;
  }
  if (pd.cache_write_tokens == null) pd.cache_write_tokens = raw.cache_write_tokens ?? 0;

  // 归一化 reasoning_tokens
  let cd = out.completion_tokens_details;
  if (raw.reasoning_tokens != null) {
    if (!cd || typeof cd !== 'object') {
      cd = {};
      out.completion_tokens_details = cd;
    }
    if (cd.reasoning_tokens == null) cd.reasoning_tokens = Number(raw.reasoning_tokens) || 0;
  }

  return out;
}

/** 归一化错误：把 fetch / HTTP / 解析错误统一成可重试判断的形态 */
class HttpError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.retryable;
  if (err instanceof Error) {
    const code = (err as any).code || '';
    const msg = err.message || '';
    if (RETRYABLE_ERROR_CODES.has(code)) return true;
    if (msg.includes('fetch failed') || msg.includes('socket hang up')) return true;
    if (err.name === 'AbortError') return false; // 主动取消不重试
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

function calcBackoff(attempt: number, base: number, max: number): number {
  // 指数退避 + 20% 抖动：base * 2^attempt + random jitter
  const exp = Math.min(base * 2 ** attempt, max);
  const jitter = exp * 0.2 * Math.random();
  return Math.floor(exp + jitter);
}

/**
 * 规范化 chat 端点 URL：
 * - 去尾部斜杠
 * - 若 baseUrl 已含 /v1（或 /v1beta 等），直接拼 /chat/completions，避免双 /v1
 * - 若不含，按传统约定拼 /v1/chat/completions
 */
function buildChatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/v\d+(beta\d*)?$/.test(base)) {
    return `${base}/chat/completions`;
  }
  return `${base}/v1/chat/completions`;
}

function buildModelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/v\d+(beta\d*)?$/.test(base)) {
    return `${base}/models`;
  }
  return `${base}/v1/models`;
}

/**
 * LLMProvider - 全量模型适配器
 * 支持：OpenAI兼容、DeepSeek、Qwen、GLM、Claude、Ollama、中转API、NewAPI
 * 统一使用 AI Platform 兼容格式
 *
 * W1 新增能力：AbortSignal / 重试 / 超时 / Fallback 链
 */
export class LLMProvider {
  /** 可选：注入 ConfigAdapter 用于 listModels 等无需 apiConfig 的场景 */
  constructor(private config?: any) {}

  async chat(params: ChatParams): Promise<ChatResponse> {
    const {
      apiConfig,
      messages,
      tools,
      temperature,
      topP,
      stream,
      onStream,
      signal,
      fallbackConfigs = [],
      retry = {},
      timeout = {},
    } = params;

    const maxRetries = retry.maxRetries ?? 3;
    const baseDelay = retry.baseDelayMs ?? 1000;
    const maxDelay = retry.maxDelayMs ?? 8000;
    const perAttemptTimeout = timeout.perAttemptTimeoutMs ?? 60000;
    const totalTimeout = timeout.totalTimeoutMs ?? 120000;

    // Fallback 链：主配置 + 备用配置
    const chain: any[] = [apiConfig, ...(fallbackConfigs || [])].filter(Boolean);

    // 总超时计时器
    const totalDeadline = Date.now() + totalTimeout;
    let totalAttempts = 0;
    let lastError: unknown = null;
    let lastResolvedConfig: any = null;

    for (let chainIdx = 0; chainIdx < chain.length; chainIdx++) {
      const cfg = chain[chainIdx];
      lastResolvedConfig = cfg;
      const isLastInChain = chainIdx === chain.length - 1;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        totalAttempts++;
        if (signal?.aborted) {
          throw new DOMException('请求被取消', 'AbortError');
        }
        if (Date.now() > totalDeadline) {
          throw new Error(`LLM 总超时（${totalTimeout}ms）`);
        }

        try {
          const remaining = Math.max(1000, totalDeadline - Date.now());
          const attemptTimeout = Math.min(perAttemptTimeout, remaining);

          const response = await this.attemptChat(
            cfg,
            messages,
            tools,
            temperature,
            topP,
            stream,
            onStream,
            signal,
            attemptTimeout
          );
          response.resolvedConfig = cfg;
          response.attempts = totalAttempts;
          return response;
        } catch (err: unknown) {
          lastError = err;
          const aborted = err instanceof Error && err.name === 'AbortError';
          if (aborted) throw err; // 用户主动取消，直接抛

          const retryable = isRetryable(err);
          const hasMoreRetries = attempt < maxRetries - 1;
          const hasMoreFallbacks = !isLastInChain;

          if (!retryable) {
            // 不可重试错误：直接尝试 fallback 或抛
            if (hasMoreFallbacks) {
              dbgLog(
                `[chat] non-retryable on config[${chainIdx}] (${cfg?.model || '?'}): ${
                  err instanceof Error ? err.message : String(err)
                } → try fallback[${chainIdx + 1}]`
              );
              break; // 跳出当前 config 的重试循环，进入下一个 fallback
            }
            throw err;
          }

          if (hasMoreRetries) {
            const delay = calcBackoff(attempt, baseDelay, maxDelay);
            dbgLog(
              `[chat] retryable on config[${chainIdx}] attempt ${attempt + 1}/${maxRetries}: ${
                err instanceof Error ? err.message : String(err)
              } → sleep ${delay}ms`
            );
            try {
              await sleep(delay, signal);
            } catch {
              throw new DOMException('请求被取消', 'AbortError');
            }
            continue;
          }

          // 已用完当前 config 的重试次数，尝试下一个 fallback
          if (hasMoreFallbacks) {
            dbgLog(
              `[chat] exhausted retries on config[${chainIdx}] (${cfg?.model || '?'}) → fallback[${chainIdx + 1}] (${
                chain[chainIdx + 1]?.model || '?'
              })`
            );
            break;
          }

          // 已是最后一个 fallback 且重试用尽：抛错
          throw err;
        }
      }
    }

    // 理论上不会到这里（循环要么 return 要么 throw），但保险
    if (lastError instanceof Error) throw lastError;
    throw new Error('LLM 调用失败：无更多可用配置');
  }

  /**
   * 单次 chat 尝试：构造请求 + 走 stream 或 sync
   * attemptTimeoutMs 控制单次请求硬超时
   */
  private async attemptChat(
    apiConfig: any,
    messages: any[],
    tools: any[] | undefined,
    temperature: number | undefined,
    topP: number | undefined,
    stream: boolean | undefined,
    onStream: ((delta: string) => void) | undefined,
    signal: AbortSignal | undefined,
    attemptTimeoutMs: number
  ): Promise<ChatResponse> {
    const baseUrl = apiConfig.baseUrl?.replace(/\/+$/, '');
    const apiKey = apiConfig.apiKey;
    const model = apiConfig.model || 'gpt-4';

    const body: any = {
      model,
      messages,
      temperature: temperature ?? 0.7,
      top_p: topP ?? 1.0,
      stream: stream ?? false,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const url = buildChatUrl(apiConfig.baseUrl || '');

    // 组合外部 signal + 内部超时 signal（任一触发都中断）
    const internalCtrl = new AbortController();
    const onExternalAbort = () => internalCtrl.abort();
    if (signal) {
      if (signal.aborted) internalCtrl.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timeoutTimer = setTimeout(() => internalCtrl.abort(), attemptTimeoutMs);

    try {
      if (stream) {
        return await this.streamChat(url, apiKey, body, onStream, internalCtrl.signal);
      }
      return await this.syncChat(url, apiKey, body, internalCtrl.signal);
    } catch (err: any) {
      // 区分超时 / 取消 / 网络 / HTTP
      if (err?.name === 'AbortError') {
        if (signal?.aborted) throw new DOMException('请求被取消', 'AbortError');
        throw new HttpError(`请求超时（${attemptTimeoutMs}ms）`, undefined, 'TIMEOUT', true);
      }
      if (err instanceof HttpError) throw err;
      // 包装 fetch 抛出的原生错误
      const status = err?.status || err?.response?.status;
      if (status && RETRYABLE_STATUS.has(status)) {
        throw new HttpError(
          `API 错误 (${status}): ${err?.message || ''}`.slice(0, 200),
          status,
          err?.code,
          true
        );
      }
      if (status && !RETRYABLE_STATUS.has(status)) {
        throw new HttpError(
          `API 错误 (${status}): ${err?.message || ''}`.slice(0, 200),
          status,
          err?.code,
          false
        );
      }
      // 网络层错误
      throw new HttpError(
        err?.message || '网络错误',
        undefined,
        err?.code || 'NETWORK',
        isRetryable(err)
      );
    } finally {
      clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }

  private async syncChat(url: string, apiKey: string, body: any, signal: AbortSignal): Promise<ChatResponse> {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    } as any);

    if (!resp.ok) {
      const text = await resp.text();
      const status = resp.status;
      const retryable = RETRYABLE_STATUS.has(status);
      throw new HttpError(
        `API 请求失败 (${status}): ${text}`.slice(0, 500),
        status,
        undefined,
        retryable
      );
    }

    const data: any = await resp.json();
    const choice = data?.choices?.[0]?.message || {};
    return {
      content: choice.content || '',
      thinking: choice.reasoning_content || choice.thinking || '',
      toolCalls: choice.tool_calls || [],
      usage: normalizeUsage(data?.usage),
    };
  }

  private async streamChat(
    url: string,
    apiKey: string,
    body: any,
    onStream: ((delta: string) => void) | undefined,
    signal: AbortSignal
  ): Promise<ChatResponse> {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    } as any);

    if (!resp.ok) {
      const text = await resp.text();
      const status = resp.status;
      const retryable = RETRYABLE_STATUS.has(status);
      throw new HttpError(
        `API 请求失败 (${status}): ${text}`.slice(0, 500),
        status,
        undefined,
        retryable
      );
    }

    // 网关误配 / URL 拼接错误时会返回 HTML 页面（如 AIRelay 前端），提前检测给出清晰报错
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      throw new HttpError(
        'API 端点返回了 HTML 页面而非 JSON 流，请检查 baseUrl 配置（不要重复拼接 /v1）',
        resp.status,
        'INVALID_CONTENT_TYPE',
        false
      );
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new HttpError('无法读取流', undefined, 'NO_READER', false);

    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let thinking = '';
    const toolCalls: any[] = [];
    let usage: any = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6);
          if (jsonStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(jsonStr);
            const delta = chunk.choices?.[0]?.delta;

            // usage 在独立的 chunk 里（通常无 delta）
            if (chunk.usage) {
              usage = normalizeUsage(chunk.usage);
            }

            if (delta) {
              if (delta.content) {
                content += delta.content;
                onStream?.(delta.content);
              }
              if (delta.reasoning_content || delta.thinking) {
                thinking += delta.reasoning_content || delta.thinking;
              }
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index || 0;
                  if (!toolCalls[idx]) {
                    toolCalls[idx] = { id: tc.id, name: '', arguments: '' };
                  }
                  if (tc.function?.name) toolCalls[idx].name = tc.function.name;
                  if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
                }
              }
            }
          } catch {
            /* skip 单行解析错误 */
          }
        }
      }
    } catch (err: any) {
      // 中断时返回已累积的部分内容（让 Agent 能拿到不完整结果）
      if (err?.name === 'AbortError' || signal.aborted) {
        dbgLog(`[streamChat] aborted, returning partial content len=${content.length}`);
        // 不抛错，把已收内容当作正常返回（上层会从 toolCalls 缺失识别中断）
      } else {
        // reader.read 抛出（连接断开等）→ 重试
        throw new HttpError(
          `流中断: ${err?.message || ''}`.slice(0, 200),
          undefined,
          err?.code,
          true
        );
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }

    const parsedToolCalls = toolCalls
      .filter((tc) => tc && tc.name)
      .map((tc) => ({
        id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
        name: tc.name,
        arguments: (() => {
          try {
            return JSON.parse(tc.arguments || '{}');
          } catch {
            return {};
          }
        })(),
      }));

    dbgLog(
      `[streamChat] done. contentLen=${content.length} thinkingLen=${thinking.length} rawToolCalls=${toolCalls.length} parsedToolCalls=${parsedToolCalls.length} lastDeltaIncomplete=${buffer.length > 0}`
    );
    return { content, thinking, toolCalls: parsedToolCalls, usage };
  }

  async listModels(apiConfig: any): Promise<any[]> {
    const baseUrl = apiConfig.baseUrl?.replace(/\/+$/, '');
    const apiKey = apiConfig.apiKey;

    try {
      const resp = await fetch(buildModelsUrl(baseUrl || ''), {
        headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        signal: AbortSignal.timeout(15000),
      } as any);

      if (!resp.ok) return this.getDefaultModels(apiConfig.provider);
      const data: any = await resp.json();
      return data?.data || data?.models || [];
    } catch {
      return this.getDefaultModels(apiConfig.provider);
    }
  }

  private getDefaultModels(provider?: string): any[] {
    const defaults: Record<string, any[]> = {
      deepseek: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)' },
      ],
      qwen: [
        { id: 'qwen-max', name: 'Qwen Max' },
        { id: 'qwen-plus', name: 'Qwen Plus' },
        { id: 'qwen-turbo', name: 'Qwen Turbo' },
      ],
      glm: [
        { id: 'glm-4-plus', name: 'GLM-4 Plus' },
        { id: 'glm-4-flash', name: 'GLM-4 Flash' },
      ],
      claude: [
        { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
        { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
      ],
      ollama: [
        { id: 'llama3', name: 'Llama 3' },
        { id: 'qwen2', name: 'Qwen 2' },
      ],
    };
    return defaults[provider || ''] || [{ id: 'gpt-4', name: 'GPT-4' }];
  }
}
