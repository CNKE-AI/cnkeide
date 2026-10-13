import {
  useAgentActivityStore,
  formatToolCall,
  extractTargetPaths,
  isWriteTool,
  isReadTool,
} from './agentActivityStore';
import { useEditorStore } from './editorStore';

/**
 * AgentEvent 的宽松结构（主进程事件字段随版本演进，这里只取需要的部分）
 */
interface RawAgentEvent {
  type: string;
  sessionId?: string;
  [key: string]: any;
}

/** tool_call 的 args 可能是字符串（JSON）或对象 */
function normalizeArgs(args: any): any {
  if (args == null) return {};
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return { command: args };
    }
  }
  return args;
}

/**
 * AgentActivityBridge - 把主进程的 agent 事件转换成面板可直接消费的状态
 *
 * 设计目标：终端面板 / 编辑器面板 / 资源管理器三者共享同一份 Agent 活动状态，
 * 任意一处产生的变化都能实时反映到其他面板，无需手动切换或刷新。
 *
 * 订阅方式：由 AppProvider 在应用启动时调用 attachAgentActivityBridge()，
 * 返回取消订阅函数。
 */
export function attachAgentActivityBridge(): () => void {
  const activity = useAgentActivityStore.getState();

  const off = window.cnke.agent.onEvent((event: RawAgentEvent) => {
    if (!event || typeof event.type !== 'string') return;
    const store = useAgentActivityStore.getState();

    switch (event.type) {
      // ---------- 运行生命周期 ----------
      case 'agent_start':
      case 'start': {
        store.begin(event.sessionId || 'default');
        store.pushLine('── Agent 开始运行 ──', 'divider');
        break;
      }

      case 'agent_end':
      case 'done':
      case 'complete': {
        const ok = event.error == null;
        store.pushLine(ok ? '── Agent 运行完成 ──' : '── Agent 运行失败 ──', 'divider');
        store.finish(ok ? 'done' : 'error');
        break;
      }

      case 'aborted': {
        store.pushLine('── Agent 已中止 ──', 'divider');
        store.finish('aborted');
        break;
      }

      // ---------- 思考 / 流式输出 ----------
      case 'thinking':
      case 'thinking-delta': {
        // 思考内容不进终端正文（噪音大），仅在链路断开时提示一次阶段切换
        if (store.phase !== 'thinking' && store.phase !== 'tool') {
          useAgentActivityStore.setState({ phase: 'thinking' });
        }
        break;
      }

      case 'assistant-message': {
        const text = event.content ?? event.text ?? '';
        if (typeof text === 'string' && text.trim()) {
          store.pushText(text, 'info');
        }
        useAgentActivityStore.setState({ phase: 'streaming' });
        break;
      }

      // ---------- 工具调用 ----------
      case 'tool_call':
      case 'tool-call': {
        const toolName = event.toolName || event.name || 'unknown';
        const args = normalizeArgs(event.args ?? event.arguments);
        store.toolStart(toolName, args);
        store.pushLine(`▶ ${formatToolCall(toolName, args)}`, 'command');

        // 文件双向联动：读 → 标记访问；写 → 标记修改 + 提示编辑器刷新
        const paths = extractTargetPaths(toolName, args);
        if (isWriteTool(toolName)) {
          for (const p of paths) {
            store.markModified(p, toolName, resolveWriteAction(toolName));
            useEditorStore.getState().noteExternalChange(p);
          }
        } else if (isReadTool(toolName)) {
          for (const p of paths) store.markRead(p, toolName);
        }
        break;
      }

      case 'tool_result':
      case 'tool-result': {
        const toolName = event.toolName || event.name || 'unknown';
        const ok = event.success !== false && event.error == null;
        store.toolEnd(toolName, event.result, ok);
        if (!ok) {
          const msg = typeof event.error === 'string' ? event.error : event.error?.message || '执行失败';
          store.pushLine(`✗ ${toolName}: ${msg}`, 'error');
        } else {
          store.pushLine(`✓ ${toolName}`, 'success');
        }
        break;
      }

      // ---------- 终端命令输出（execute_command 的 stdout/stderr）----------
      case 'shell-output':
      case 'shell_output': {
        const out = event.data ?? event.output ?? '';
        store.pushText(String(out), 'output');
        break;
      }

      // ---------- 审批 ----------
      case 'approval-request':
      case 'approval_request': {
        store.setPendingApprovals(store.pendingApprovals + 1);
        store.pushLine(`⏸ 等待审批：${event.toolName || ''}`, 'error');
        break;
      }
      case 'approval-resolved':
      case 'approval_resolved': {
        store.setPendingApprovals(Math.max(0, store.pendingApprovals - 1));
        break;
      }

      // ---------- 错误 ----------
      case 'error': {
        const msg = typeof event.error === 'string' ? event.error : event.error?.message || event.message || '未知错误';
        store.pushLine(`✗ ${msg}`, 'error');
        store.finish('error');
        break;
      }

      default:
        break;
    }
  });

  // 同步终端外部命令产生的文件变更标记（terminal:output 不产生事件，靠 watcher 兜底）
  void activity;

  return off;
}

/** 由工具名推断写操作类型 */
function resolveWriteAction(toolName: string): 'write' | 'create' | 'delete' | 'rename' {
  if (/delete/i.test(toolName)) return 'delete';
  if (/rename|move/i.test(toolName)) return 'rename';
  if (/create/i.test(toolName)) return 'create';
  return 'write';
}
