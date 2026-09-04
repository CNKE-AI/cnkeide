/**
 * ContextTracker - 实时上下文窗口追踪（W11）
 *
 * 目标：让用户看到当前会话用了多少 token、占模型窗口多少比例
 *
 * 数据来源：
 * - LLM API 返回的 usage（最准确） → 优先
 * - 本地字符估算（粗略但实时） → 兜底
 *
 * 状态：
 * - perSession: Map<sessionId, ContextState>
 * - 每次 LLM 响应后更新
 */

import { detectCapabilities, ModelCapabilities } from '../llm/ProviderCapabilities';

export interface ContextState {
  sessionId: string;
  model: string;
  /** 模型上下文窗口大小（token） */
  maxContextTokens: number;
  /** 累计 prompt tokens（来自 LLM 响应的 usage） */
  promptTokens: number;
  /** 累计 completion tokens */
  completionTokens: number;
  /** 当前消息列表的字符数（实时估算） */
  currentChars: number;
  /** 当前消息列表的估算 tokens（实时） */
  estimatedTokens: number;
  /** 当前消息数（含 system） */
  messageCount: number;
  /** 时间戳 */
  updatedAt: number;
}

export class ContextTracker {
  private states: Map<string, ContextState> = new Map();

  /** 估算单条消息的字符数（含 content 数组 + tool_calls） */
  estimateMessageChars(m: any): number {
    let total = 0;
    if (typeof m?.content === 'string') total += m.content.length;
    else if (Array.isArray(m?.content)) {
      for (const part of m.content) {
        if (typeof part === 'string') total += part.length;
        else if (part && typeof part === 'object') {
          if (typeof part.text === 'string') total += part.text.length;
          // 图片 base64 不计入
        }
      }
    } else if (m?.content != null) {
      try { total += JSON.stringify(m.content).length; } catch { /* ignore */ }
    }
    if (Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.function?.name) total += tc.function.name.length;
        if (tc?.function?.arguments) total += String(tc.function.arguments).length;
      }
    }
    return total;
  }

  /** 计算消息数组的总字符数 */
  estimateMessagesChars(messages: any[]): number {
    return (messages || []).reduce((sum, m) => sum + this.estimateMessageChars(m), 0);
  }

  /** 字符 → token 估算（粗略：1 token ≈ 2 字符） */
  charsToTokens(chars: number): number {
    return Math.ceil(chars / 2);
  }

  /** 更新会话的 token 状态 */
  update(sessionId: string, model: string, messages: any[], usage?: { prompt_tokens?: number; completion_tokens?: number }): ContextState {
    const caps = detectCapabilities(model);
    const currentChars = this.estimateMessagesChars(messages);
    const estimatedTokens = this.charsToTokens(currentChars);
    const state: ContextState = {
      sessionId,
      model,
      maxContextTokens: caps.maxContextTokens,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      currentChars,
      estimatedTokens,
      messageCount: messages?.length || 0,
      updatedAt: Date.now(),
    };
    this.states.set(sessionId, state);
    return state;
  }

  /** 查询 */
  get(sessionId: string): ContextState | undefined {
    return this.states.get(sessionId);
  }

  /** 删除会话状态（会话结束/删除时） */
  remove(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /** 列出所有 */
  list(): ContextState[] {
    return Array.from(this.states.values());
  }

  /** 计算使用率（0-1） */
  static ratio(state: ContextState): number {
    if (state.maxContextTokens === 0) return 0;
    return Math.min(1, state.estimatedTokens / state.maxContextTokens);
  }

  /** UI 友好的状态文本 */
  static displayText(state: ContextState): string {
    const used = state.estimatedTokens.toLocaleString();
    const max = state.maxContextTokens.toLocaleString();
    const ratio = (ContextTracker.ratio(state) * 100).toFixed(1);
    return `${used} / ${max} tokens (${ratio}%)`;
  }

  /** 颜色分级 */
  static level(state: ContextState): 'safe' | 'warning' | 'critical' {
    const r = ContextTracker.ratio(state);
    if (r < 0.6) return 'safe';
    if (r < 0.85) return 'warning';
    return 'critical';
  }
}
