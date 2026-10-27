import { create } from 'zustand';

/** Agent 运行阶段 */
export type AgentPhase = 'idle' | 'thinking' | 'streaming' | 'tool' | 'waiting-approval' | 'done' | 'error' | 'aborted';

/** 终端里的一条 Agent 活动记录 */
export interface AgentActivityLine {
  id: number;
  /** 行内容 */
  text: string;
  /** 语义类型，决定颜色 */
  kind: 'info' | 'command' | 'output' | 'success' | 'error' | 'thinking' | 'file' | 'divider';
  at: number;
}

/** 被 Agent 触碰过的文件（用于编辑器联动标记） */
export interface AgentTouchedFile {
  path: string;
  /** read / write / create / delete / rename */
  action: 'read' | 'write' | 'create' | 'delete' | 'rename' | 'other';
  at: number;
  /** 工具名（如 read_file / write_to_file） */
  toolName: string;
}

/**
 * Agent 对某个文件的最近一次内容修改（W19）。
 * before/after 来自工具结果的 diff 元数据，用于编辑器内一键撤销。
 */
export interface AgentFileEdit {
  path: string;
  /** 修改前内容；新建文件为 undefined */
  before?: string;
  /** 修改后内容；删除文件为 undefined */
  after?: string;
  at: number;
  toolName: string;
}

const MAX_ACTIVITY_LINES = 2000;

interface AgentActivityState {
  /** 当前阶段 */
  phase: AgentPhase;
  /** 当前正在执行的工具名 */
  currentTool: string | null;
  /** 当前会话 id */
  sessionId: string | null;
  /** 运行开始时间（用于耗时显示） */
  startedAt: number | null;
  /** 已完成的工具调用数 */
  toolCount: number;
  /** 失败的工具调用数 */
  errorCount: number;
  /** 终端活动流 */
  lines: AgentActivityLine[];
  /** Agent 触碰过的文件路径集合（路径 → 记录） */
  touchedFiles: Map<string, AgentTouchedFile>;
  /** 已写入（新增/修改）的文件路径，用于编辑器"外部已修改"提示 */
  modifiedFiles: Set<string>;
  /** 每个文件最近一次被 Agent 修改的前后内容（路径 → 编辑记录），用于一键撤销 */
  agentEdits: Map<string, AgentFileEdit>;
  /** 待用户处理的审批请求数 */
  pendingApprovals: number;

  /** 追加一行活动 */
  pushLine: (text: string, kind?: AgentActivityLine['kind']) => void;
  /** 批量追加（多行文本一次写入，自动按行拆分） */
  pushText: (text: string, kind?: AgentActivityLine['kind']) => void;
  /** 清空活动流 */
  clear: () => void;
  /** 开始一次运行 */
  begin: (sessionId: string) => void;
  /** 结束运行 */
  finish: (phase: 'done' | 'error' | 'aborted') => void;
  /** 记录工具调用开始 */
  toolStart: (toolName: string, args?: any) => void;
  /** 记录工具调用结束 */
  toolEnd: (toolName: string, result?: any, ok?: boolean) => void;
  /** 标记文件被读取 */
  markRead: (path: string, toolName: string) => void;
  /** 标记文件被写入 */
  markModified: (path: string, toolName: string, action?: AgentTouchedFile['action']) => void;
  /** 清除某文件的"已修改"标记（编辑器保存后调用） */
  clearModified: (path: string) => void;
  /**
   * 记录一次 Agent 写入前后内容（供编辑器一键撤销）。
   * 同一文件重复写入时保留最早一次的 before —— 撤销应回到"Agent 动手之前"的状态。
   */
  recordAgentEdit: (edit: AgentFileEdit) => void;
  /** 丢弃某文件的撤销记录（撤销完成或用户已手动保存后调用） */
  clearAgentEdit: (path: string) => void;
  /** 审批计数 */
  setPendingApprovals: (n: number) => void;
  /**
   * 重置与工作区绑定的状态（切换/打开新工作区时调用）。
   * 清空 lines / touchedFiles / modifiedFiles，并复位运行统计，
   * 避免上一个工作区的活动记录被误认为属于当前项目。
   */
  resetWorkspaceState: () => void;
}

/** 从工具调用参数里提取目标文件路径（覆盖各工具的命名习惯） */
export function extractTargetPaths(toolName: string, args: any): string[] {
  if (!args || typeof args !== 'object') return [];
  const keys = ['path', 'filePath', 'file_path', 'target', 'destination', 'newPath', 'new_path', 'source'];
  const out: string[] = [];
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  return Array.from(new Set(out));
}

/** 判断工具是否写文件 */
export function isWriteTool(toolName: string): boolean {
  return /write_to_file|apply_diff|create_file|create_dir|delete_path|rename_path|edit_file|replace_in_file|insert_content|move_file|copy_file/i.test(toolName);
}

/** 判断工具是否读文件 */
export function isReadTool(toolName: string): boolean {
  return /read_file|list_dir|search_files|grep|get_file_outline|semantic_search|search_symbol|find_references/i.test(toolName);
}

/** 生成工具调用的可读摘要（终端里显示） */
export function formatToolCall(toolName: string, args: any): string {
  const paths = extractTargetPaths(toolName, args);
  const cmd = args?.command ?? args?.cmd;
  const pattern = args?.pattern ?? args?.query;
  if (cmd && typeof cmd === 'string') return `${toolName}  $ ${cmd}`;
  if (paths.length > 0) return `${toolName}  ${paths.join(', ')}`;
  if (pattern && typeof pattern === 'string') return `${toolName}  "${pattern}"`;
  return toolName;
}

let lineSeq = 0;

export const useAgentActivityStore = create<AgentActivityState>((set, get) => ({
  phase: 'idle',
  currentTool: null,
  sessionId: null,
  startedAt: null,
  toolCount: 0,
  errorCount: 0,
  lines: [],
  touchedFiles: new Map(),
  modifiedFiles: new Set(),
  agentEdits: new Map(),
  pendingApprovals: 0,

  pushLine: (text, kind = 'info') => {
    set((s) => {
      const next = [...s.lines, { id: ++lineSeq, text, kind, at: Date.now() }];
      return { lines: next.length > MAX_ACTIVITY_LINES ? next.slice(next.length - MAX_ACTIVITY_LINES) : next };
    });
  },

  pushText: (text, kind = 'output') => {
    if (!text) return;
    const parts = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    // 去掉末尾空行，避免刷出一堆空行
    while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    if (parts.length === 0) return;
    set((s) => {
      const next = [
        ...s.lines,
        ...parts.map((p) => ({ id: ++lineSeq, text: p, kind, at: Date.now() })),
      ];
      return { lines: next.length > MAX_ACTIVITY_LINES ? next.slice(next.length - MAX_ACTIVITY_LINES) : next };
    });
  },

  clear: () => set({ lines: [] }),

  begin: (sessionId) =>
    set({
      phase: 'thinking',
      sessionId,
      startedAt: Date.now(),
      currentTool: null,
      toolCount: 0,
      errorCount: 0,
    }),

  finish: (phase) =>
    set(() => ({
      phase,
      currentTool: null,
      startedAt: null,
      pendingApprovals: 0,
    })),

  toolStart: (toolName, args) =>
    set((s) => ({
      phase: 'tool',
      currentTool: toolName,
      toolCount: s.toolCount + 1,
    })),

  toolEnd: (_toolName, _result, ok = true) =>
    set((s) => ({
      phase: 'thinking',
      currentTool: null,
      errorCount: ok ? s.errorCount : s.errorCount + 1,
    })),

  markRead: (path, toolName) => {
    if (!path) return;
    set((s) => {
      const touched = new Map(s.touchedFiles);
      touched.set(path, { path, action: 'read', at: Date.now(), toolName });
      return { touchedFiles: touched };
    });
  },

  markModified: (path, toolName, action = 'write') => {
    if (!path) return;
    set((s) => {
      const touched = new Map(s.touchedFiles);
      touched.set(path, { path, action, at: Date.now(), toolName });
      const modified = new Set(s.modifiedFiles);
      if (action !== 'delete') modified.add(path);
      else modified.delete(path);
      return { touchedFiles: touched, modifiedFiles: modified };
    });
  },

  clearModified: (path) => {
    set((s) => {
      if (!s.modifiedFiles.has(path)) return {};
      const modified = new Set(s.modifiedFiles);
      modified.delete(path);
      return { modifiedFiles: modified };
    });
  },

  setPendingApprovals: (n) => set({ pendingApprovals: Math.max(0, n) }),

  recordAgentEdit: (edit) => {
    if (!edit.path) return;
    set((s) => {
      const edits = new Map(s.agentEdits);
      const prev = edits.get(edit.path);
      // 保留最早的 before：撤销要回到 Agent 第一次动手之前
      edits.set(edit.path, prev ? { ...edit, before: prev.before } : edit);
      return { agentEdits: edits };
    });
  },

  clearAgentEdit: (path) => {
    set((s) => {
      if (!s.agentEdits.has(path)) return {};
      const edits = new Map(s.agentEdits);
      edits.delete(path);
      return { agentEdits: edits };
    });
  },

  resetWorkspaceState: () =>
    set({
      lines: [],
      touchedFiles: new Map(),
      modifiedFiles: new Set(),
      agentEdits: new Map(),
      phase: 'idle',
      currentTool: null,
      startedAt: null,
      toolCount: 0,
      errorCount: 0,
      pendingApprovals: 0,
    }),
}));
