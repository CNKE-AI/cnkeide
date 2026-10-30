import {
  useAgentActivityStore,
  describeToolCall,
  toolLabel,
  extractTargetPaths,
  isWriteTool,
  isReadTool,
} from './agentActivityStore';
import { useEditorStore } from './editorStore';

/**
 * AgentEvent 的宽松结构。
 * 主进程统一发出 { type, sessionId, data } 包装结构，具体字段都在 data 里；
 * 这里保留扁平字段仅为兼容早期版本，取值时以 data 优先。
 */
interface RawAgentEvent {
  type: string;
  sessionId?: string;
  data?: any;
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
  // toolCallId → 工具名：tool_result 事件只带 id 与结果，需要回查工具名
  const toolNames = new Map<string, string>();

  const off = window.cnke.agent.onEvent((event: RawAgentEvent) => {
    if (!event || typeof event.type !== 'string') return;
    const store = useAgentActivityStore.getState();
    // 主进程事件的实际负载在 event.data 中；不是对象时退回事件本身
    const d: any = event.data && typeof event.data === 'object' ? event.data : event;

    switch (event.type) {
      // ---------- 运行生命周期 ----------
      case 'start': {
        toolNames.clear();
        store.begin(event.sessionId || d.sessionId || 'default');
        store.pushLine('会话开始', 'divider');
        break;
      }

      case 'done': {
        // aborted: 主进程在用户点「停止」清除 runningSessions 后随 done 一起下发
        if (d.aborted) {
          store.pushLine('已中止', 'divider');
          store.finish('aborted');
          break;
        }
        const ok = d.error == null && event.error == null;
        store.pushLine(ok ? '运行完成' : '运行失败', 'divider');
        store.finish(ok ? 'done' : 'error');
        break;
      }

      // ---------- 思考 / 正文 ----------
      case 'thinking': {
        // 思考内容不进终端正文（噪音大），仅切换阶段
        if (store.phase !== 'thinking' && store.phase !== 'tool') {
          useAgentActivityStore.setState({ phase: 'thinking' });
        }
        break;
      }

      case 'assistant': {
        // 正文已在聊天区渲染，终端只标记阶段，避免整段重复刷屏
        useAgentActivityStore.setState({ phase: 'streaming' });
        break;
      }

      // ---------- 工具调用 ----------
      case 'tool_call': {
        const toolName = String(d.name ?? d.toolName ?? event.toolName ?? event.name ?? 'unknown');
        const args = normalizeArgs(d.arguments ?? d.args ?? event.args);
        if (d.id) toolNames.set(String(d.id), toolName);
        store.toolStart(toolName, args);
        const summary = describeToolCall(toolName, args);
        store.pushLine(
          summary.detail ? `${summary.label}  ${summary.detail}` : summary.label,
          'command',
          { label: summary.label, detail: summary.detail, tool: toolName }
        );

        // 文件双向联动：读 → 标记访问；写 → 标记修改 + 提示编辑器刷新
        const paths = extractTargetPaths(toolName, args);
        if (isWriteTool(toolName)) {
          for (const p of paths) {
            store.markModified(p, toolName, resolveWriteAction(toolName));
            void useEditorStore.getState().noteExternalChange(p);
          }
        } else if (isReadTool(toolName)) {
          for (const p of paths) store.markRead(p, toolName);
        }
        break;
      }

      case 'tool_result': {
        const id = d.toolCallId ? String(d.toolCallId) : '';
        const toolName = toolNames.get(id) || store.currentTool || 'unknown';
        const result = d.result;
        const rejected = result === '已拒绝';
        const ok = !rejected && !(result && typeof result === 'object' && result.success === false);
        store.toolEnd(toolName, result, ok);
        const label = toolLabel(toolName);
        if (rejected) {
          store.pushLine(`${label} · 用户已拒绝`, 'error', { label, detail: '用户已拒绝', tool: toolName });
        } else if (!ok) {
          const msg = result?.error || (typeof result === 'string' ? result : '执行失败');
          const detail = String(msg).slice(0, 160);
          store.pushLine(`${label} · ${detail}`, 'error', { label, detail, tool: toolName });
        } else {
          store.pushLine(`${label} · 完成`, 'success', { label, detail: '完成', tool: toolName });
        }
        // 写操作的 diff 元数据 → 记录前后内容，供编辑器内一键撤销
        const diff = result && typeof result === 'object' ? result.diff : undefined;
        if (ok && diff && typeof diff.path === 'string') {
          store.recordAgentEdit({
            path: diff.path,
            before: typeof diff.before === 'string' ? diff.before : undefined,
            after: typeof diff.after === 'string' ? diff.after : undefined,
            at: Date.now(),
            toolName,
          });
        }
        if (id) toolNames.delete(id);
        break;
      }

      // ---------- 审批 ----------
      case 'approval_request': {
        store.setPendingApprovals(store.pendingApprovals + 1);
        useAgentActivityStore.setState({ phase: 'waiting-approval' });
        store.pushLine(`等待审批 · ${toolLabel(String(d.toolName || ''))}`, 'error', {
          label: '等待审批',
          detail: toolLabel(String(d.toolName || '')),
          tool: d.toolName ? String(d.toolName) : undefined,
        });
        break;
      }

      case 'approval_resolved': {
        store.setPendingApprovals(Math.max(0, store.pendingApprovals - 1));
        break;
      }

      // ---------- 错误 ----------
      case 'error': {
        const msg = typeof d.error === 'string' ? d.error : d.error?.message || d.message || '未知错误';
        store.pushLine(`✗ ${msg}`, 'error');
        store.finish('error');
        break;
      }

      default:
        break;
    }
  });

  return off;
}

/** 由工具名推断写操作类型 */
function resolveWriteAction(toolName: string): 'write' | 'create' | 'delete' | 'rename' {
  if (/delete/i.test(toolName)) return 'delete';
  if (/rename|move/i.test(toolName)) return 'rename';
  if (/create/i.test(toolName)) return 'create';
  return 'write';
}
