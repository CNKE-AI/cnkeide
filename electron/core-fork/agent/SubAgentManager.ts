/**
 * SubAgentManager - 子 Agent 委派（W8）
 *
 * 设计：
 * - 子 Agent 复用同一个 LLMProvider，但用独立 sessionId 隔离上下文
 * - agentType: 'general-purpose'（完整工具）/ 'explore'（只读工具）
 * - 跑完返回结构化结果给主 Agent
 * - 简单实现：每次 spawn 一个新 LLM 调用循环（不用 worker 进程）
 */

import { randomUUID } from 'node:crypto';
import { BASE_SYSTEM_PROMPT } from './AgentManager';

export type SubAgentType = 'general-purpose' | 'explore';

export interface SubAgentTask {
  /** 任务描述（subagent 的 prompt） */
  description: string;
  /** Agent 类型，默认 general-purpose */
  agentType?: SubAgentType;
  /** 最大轮数，默认 10 */
  maxTurns?: number;
  /** 父 sessionId（用于日志/追踪） */
  parentSessionId: string;
}

export interface SubAgentResult {
  success: boolean;
  output: string;
  turns: number;
  toolCallCount: number;
  error?: string;
}

export interface SubAgentExecutor {
  /** 执行单轮 LLM 调用 */
  callLlm(args: { apiConfig: any; messages: any[]; tools: any[]; signal?: AbortSignal }): Promise<{
    content: string;
    thinking?: string;
    toolCalls: any[];
    usage?: any;
  }>;
  /** 执行工具（explore 类型用只读白名单） */
  executeTool(name: string, args: any): Promise<{ success: boolean; output?: string; error?: string }>;
  /** 获取 active apiConfig */
  getActiveApiConfig(): any;
  /** 获取工具列表（按 agentType 过滤） */
  getAvailableTools(agentType: SubAgentType): any[];
  /** emit 进度事件 */
  onProgress?: (event: { type: 'thinking' | 'assistant' | 'tool_call' | 'tool_result'; data: any }) => void;
}

/** explore 子 Agent 的只读工具白名单（导出以便主 Agent 构造工具列表时复用） */
export const EXPLORE_TOOLS = new Set([
  'read_file', 'search_files', 'list_directory', 'get_file_outline',
  'search_symbol', 'find_references', 'project_structure',
  'grep', 'web_search', 'web_fetch', 'git_status', 'git_log',
  'semantic_search',
]);

const SYSTEM_PROMPTS: Record<SubAgentType, string> = {
  'general-purpose': `你是 CnkeIDE 的子 Agent，被主 Agent 委派来完成一个独立子任务。
- 你的工作环境与主 Agent 一致（共享 API 配置和工作区）
- 拥有完整工具链（除 plan 与 destructive 工具）
- 专注完成被委派的任务，不主动做额外事
- 完成后用清晰的 Markdown 总结结果`,
  'explore': `你是 CnkeIDE 的只读探索子 Agent，被主 Agent 委派来调研代码或搜索信息。
- 严格只读：禁止使用 write_to_file / apply_diff / create_file / delete_file / rename_file / execute_command / git_commit / format_code 等任何修改或执行类工具
- 你的输出会被主 Agent 用于决策，所以要清晰、精确、引用文件:行号
- 完成后用结构化 Markdown 报告发现`,
};

export class SubAgentManager {
  private running: Set<string> = new Set();

  async runTask(task: SubAgentTask, executor: SubAgentExecutor, signal?: AbortSignal): Promise<SubAgentResult> {
    const subId = `sub_${randomUUID()}`;
    if (this.running.has(task.parentSessionId)) {
      return { success: false, output: '', turns: 0, toolCallCount: 0, error: '同一会话已有子任务在运行' };
    }
    this.running.add(task.parentSessionId);
    try {
      return await this.runInner(subId, task, executor, signal);
    } finally {
      this.running.delete(task.parentSessionId);
    }
  }

  private async runInner(
    subId: string,
    task: SubAgentTask,
    executor: SubAgentExecutor,
    signal?: AbortSignal
  ): Promise<SubAgentResult> {
    const type = task.agentType || 'general-purpose';
    const maxTurns = task.maxTurns ?? 10;
    const apiConfig = executor.getActiveApiConfig();
    if (!apiConfig) {
      return { success: false, output: '', turns: 0, toolCallCount: 0, error: '无 API 配置' };
    }
    const tools = executor.getAvailableTools(type);
    const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${SYSTEM_PROMPTS[type]}`;
    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task.description },
    ];
    let turn = 0;
    let totalToolCalls = 0;
    try {
      while (turn < maxTurns) {
        if (signal?.aborted) return { success: false, output: '', turns: turn, toolCallCount: totalToolCalls, error: '已取消' };
        turn++;
        const r = await executor.callLlm({ apiConfig, messages, tools, signal });
        if (r.thinking) executor.onProgress?.({ type: 'thinking', data: { thinking: r.thinking } });
        if (r.content) executor.onProgress?.({ type: 'assistant', data: { content: r.content } });
        if (!r.toolCalls || r.toolCalls.length === 0) {
          return { success: true, output: r.content, turns: turn, toolCallCount: totalToolCalls };
        }
        // 写入 assistant 消息
        messages.push({
          role: 'assistant',
          content: r.content || null,
          tool_calls: r.toolCalls.map((c: any) => ({
            id: c.id, type: 'function',
            function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments || {}) },
          })),
        });
        // 执行工具
        for (const call of r.toolCalls) {
          if (signal?.aborted) return { success: false, output: '', turns: turn, toolCallCount: totalToolCalls, error: '已取消' };
          // explore 类型强制只读
          if (type === 'explore' && !EXPLORE_TOOLS.has(call.name)) {
            messages.push({
              tool_call_id: call.id, role: 'tool',
              content: `[错误] explore 子 Agent 禁止使用工具 ${call.name}（只允许只读工具）`,
            });
            executor.onProgress?.({ type: 'tool_result', data: { toolCallId: call.id, result: '拒绝：只读模式' } });
            continue;
          }
          totalToolCalls++;
          executor.onProgress?.({ type: 'tool_call', data: call });
          const result = await executor.executeTool(call.name, call.arguments || {});
          executor.onProgress?.({ type: 'tool_result', data: { toolCallId: call.id, result } });
          messages.push({
            tool_call_id: call.id, role: 'tool',
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });
        }
      }
      return { success: true, output: messages[messages.length - 1]?.content || '达到最大轮数', turns: turn, toolCallCount: totalToolCalls };
    } catch (err: any) {
      return { success: false, output: '', turns: turn, toolCallCount: totalToolCalls, error: err.message || String(err) };
    }
  }
}
