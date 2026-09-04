/**
 * ContextCompressor - 上下文自动压缩（W8）
 *
 * 策略：
 * - 保留 system prompt + 最近 K 轮 user/assistant 对话
 * - 早期消息用 LLM 摘要为单条 system 消息
 * - 永远保留：plan/approval 关键信息
 *
 * Token 估算：粗略按字符数 / 2（中英混合），不依赖 tiktoken
 */

export interface CompressionOptions {
  /** 上下文最大 token 数（用于触发判断） */
  maxContextTokens: number;
  /** 触发压缩的 token 阈值比例，默认 0.8 */
  triggerRatio?: number;
  /** 保留最近多少轮 user/assistant 对话，默认 6 轮 */
  keepRecentTurns?: number;
}

export interface CompressionStats {
  beforeMessages: number;
  afterMessages: number;
  beforeChars: number;
  afterChars: number;
  savedTokens: number;
  compressedTurns: number;
}

export class ContextCompressor {
  estimateChars(messages: any[]): number {
    let total = 0;
    for (const m of messages || []) {
      total += charsOf(m.content);
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (typeof part === 'object' && part) {
            if (typeof part.text === 'string') total += part.text.length;
          }
        }
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc?.function?.arguments) total += String(tc.function.arguments).length;
        }
      }
    }
    return total;
  }

  estimateTokens(chars: number): number {
    return Math.ceil(chars / 2);
  }

  shouldCompress(messages: any[], options: CompressionOptions): boolean {
    const ratio = options.triggerRatio ?? 0.8;
    const tokens = this.estimateTokens(this.estimateChars(messages));
    return tokens >= options.maxContextTokens * ratio;
  }

  /**
   * 执行压缩：早期消息摘要为单条 system 消息
   * @param summaryProvider 异步生成摘要
   */
  async compress(
    messages: any[],
    summaryProvider: (toCompress: any[]) => Promise<string>,
    options: CompressionOptions
  ): Promise<{ messages: any[]; stats: CompressionStats }> {
    const keepRecent = options.keepRecentTurns ?? 6;
    const beforeChars = this.estimateChars(messages);
    const beforeTokens = this.estimateTokens(beforeChars);

    const sysMessages = messages.filter((m) => m.role === 'system');
    const conversationMsgs = messages.filter((m) => m.role !== 'system');

    const userIndices: number[] = [];
    for (let i = 0; i < conversationMsgs.length; i++) {
      if (conversationMsgs[i].role === 'user') userIndices.push(i);
    }

    if (userIndices.length <= keepRecent) {
      return {
        messages,
        stats: {
          beforeMessages: messages.length,
          afterMessages: messages.length,
          beforeChars,
          afterChars: beforeChars,
          savedTokens: 0,
          compressedTurns: 0,
        },
      };
    }

    const splitUserIdx = userIndices[userIndices.length - keepRecent];
    const toCompress = conversationMsgs.slice(0, splitUserIdx);
    const toKeep = conversationMsgs.slice(splitUserIdx);

    const summaryText = await summaryProvider(toCompress);
    const summaryMsg = {
      role: 'system',
      content: `[对话历史摘要 - 已自动压缩 ${toCompress.length} 条早期消息]\n${summaryText}`,
    };

    const newMessages = [...sysMessages, summaryMsg, ...toKeep];
    const afterChars = this.estimateChars(newMessages);
    const afterTokens = this.estimateTokens(afterChars);

    return {
      messages: newMessages,
      stats: {
        beforeMessages: messages.length,
        afterMessages: newMessages.length,
        beforeChars,
        afterChars,
        savedTokens: Math.max(0, beforeTokens - afterTokens),
        compressedTurns: toCompress.length,
      },
    };
  }
}

function charsOf(c: any): number {
  if (typeof c === 'string') return c.length;
  if (c == null) return 0;
  try { return JSON.stringify(c).length; } catch { return 0; }
}

/** 简易摘要 prompt 模板（调用方使用时拼接） */
export const SUMMARIZE_PROMPT = `你是对话压缩助手。下面是早期对话历史，请提炼出 200-500 字的简洁摘要，让后续 AI 能延续上下文而不丢失关键信息。

要求：
- 用户的目标 / 偏好 / 关键决策
- 已完成的工作（修改了哪些文件、解决了什么问题）
- 当前进度和待办
- 任何重要的技术细节

直接输出摘要文本，不要任何前缀。`;
