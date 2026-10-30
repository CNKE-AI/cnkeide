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
  /** 中文动作名（如「执行命令」），用于行首徽标 */
  label?: string;
  /** 参数摘要（命令、路径、检索词等），用于徽标后的正文 */
  detail?: string;
  /** 原始工具名，保留用于排查与悬浮提示 */
  tool?: string;
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

/**
 * 扫描类命令防白屏的三道闸门（渲染层兜底，与主进程 400KB 截断互补）：
 * 1. 单行上限——无换行的大块输出（base64/长 JSON/进度条重绘）不再整段进 DOM；
 * 2. 单次批量上限——onOutput 高频回调一次涌入数千行时只保留尾部；
 * 3. 总字符预算——行数没超但总字节爆炸时从头淘汰旧行，防止内存膨胀拖垮渲染进程。
 */
export const MAX_LINE_CHARS = 2000;
export const MAX_BATCH_LINES = 500;
export const MAX_TOTAL_CHARS = 800_000;

/** 单行裁剪：超长行截断并标注省略 */
export function clampLine(text: string, max = MAX_LINE_CHARS): string {
  return text.length > max ? text.slice(0, max) + `…（截断，原长 ${text.length} 字符）` : text;
}

/**
 * 把一段流式输出按行拆分为可入列的行对象（纯函数，便于回归测试）。
 * - \r 视为行内重绘分隔，只保留最后一段（模拟终端覆盖行为，进度条不再堆积）；
 * - 单行超长截断；
 * - 批量行数超限时只保留尾部。
 */
export function splitOutputLines<T>(
  text: string,
  makeLine: (s: string, i: number) => T,
  maxBatch = MAX_BATCH_LINES
): T[] {
  if (!text) return [];
  const parts = text.replace(/\r\n/g, '\n').split('\n');
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  if (parts.length === 0) return [];
  // 行内裸 \r 是终端重绘（进度条），只有最后一段是有效内容
  const clamped = parts.map((p) => clampLine(p.split('\r').pop() ?? ''));
  const tail = clamped.length > maxBatch ? clamped.slice(clamped.length - maxBatch) : clamped;
  return tail.map((p, i) => makeLine(p, i));
}

/** 按总字符预算从头淘汰旧行（纯函数） */
export function capTotalChars<T extends { text: string }>(lines: T[], budget = MAX_TOTAL_CHARS): T[] {
  let total = 0;
  for (const l of lines) total += l.text.length;
  if (total <= budget) return lines;
  let cut = 0;
  while (cut < lines.length && total - lines[cut].text.length > budget * 0.9) {
    total -= lines[cut].text.length;
    cut++;
  }
  return cut > 0 ? lines.slice(cut) : lines;
}

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

  /** 追加一行活动（meta 可携带中文动作名与参数摘要，供结构化渲染） */
  pushLine: (
    text: string,
    kind?: AgentActivityLine['kind'],
    meta?: Pick<AgentActivityLine, 'label' | 'detail' | 'tool'>
  ) => void;
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

/**
 * 工具名 → 中文动作名。
 * 覆盖内置工具、计划工具、文档工具、浏览器工具与常见别名，
 * 未命中时回退原始工具名（MCP 自定义工具），保证不丢信息。
 */
export const TOOL_LABELS: Record<string, string> = {
  // 命令与脚本
  execute_command: '执行命令',
  run_python: '运行脚本',
  run_tests: '运行测试',
  format_code: '格式化代码',
  // 文件读写
  read_file: '读取文件',
  write_to_file: '写入文件',
  create_file: '新建文件',
  delete_file: '删除文件',
  rename_file: '重命名文件',
  apply_diff: '应用改动',
  replace_in_file: '精确替换',
  insert_content: '插入内容',
  // 目录与检索
  list_directory: '浏览目录',
  list_dir: '浏览目录',
  search_files: '查找文件',
  search_content: '搜索内容',
  grep: '全文检索',
  get_file_outline: '解析结构',
  search_symbol: '查找符号',
  find_references: '查找引用',
  semantic_search: '语义检索',
  codebase_search: '语义检索',
  project_structure: '分析工程',
  // 网络
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  // 版本控制
  git_status: '查看状态',
  git_diff: '查看差异',
  git_log: '查看日志',
  git_branch: '查看分支',
  git_commit: '提交变更',
  git_checkout: '切换分支',
  git_fetch: '拉取远端',
  git_pull: '拉取更新',
  git_push: '推送远端',
  // 计划
  create_plan: '制定计划',
  add_plan_item: '追加步骤',
  update_plan_status: '更新进度',
  get_plan: '读取计划',
  mark_plan_complete: '完成计划',
  // 文档
  doc_ingest: '索引文档',
  doc_query: '文档问答',
  doc_list: '文档清单',
  doc_remove: '移除文档',
  // 浏览器与多模态
  browser_navigate: '打开网页',
  browser_click: '点击元素',
  browser_input: '填写输入',
  browser_extract: '提取内容',
  browser_screenshot: '页面截图',
  browser_close: '关闭浏览器',
  image_generate: '生成图片',
};

/** 取工具的中文动作名，未收录时回退原工具名 */
export function toolLabel(toolName: string): string {
  if (!toolName) return '未知操作';
  return TOOL_LABELS[toolName] || TOOL_LABELS[toolName.toLowerCase()] || toolName;
}

/** 工具调用的结构化摘要：中文动作名 + 参数正文 */
export interface ToolCallSummary {
  /** 中文动作名，如「执行命令」 */
  label: string;
  /** 参数摘要，如命令行、文件路径、检索词 */
  detail: string;
  /** 参数正文的语义前缀（命令用 $，检索用引号），供渲染层配色 */
  hint: 'command' | 'path' | 'query' | 'none';
}

/** 把工具调用参数整理成「动作名 + 正文」，供终端结构化展示 */
export function describeToolCall(toolName: string, args: any): ToolCallSummary {
  const label = toolLabel(toolName);
  const cmd = args?.command ?? args?.cmd ?? args?.script;
  if (typeof cmd === 'string' && cmd.trim()) {
    return { label, detail: cmd.trim(), hint: 'command' };
  }
  const paths = extractTargetPaths(toolName, args);
  if (paths.length > 0) {
    return { label, detail: paths.join('  ·  '), hint: 'path' };
  }
  const query = args?.pattern ?? args?.query ?? args?.url ?? args?.prompt;
  if (typeof query === 'string' && query.trim()) {
    return { label, detail: query.trim(), hint: 'query' };
  }
  const keys = args && typeof args === 'object' ? Object.keys(args) : [];
  if (keys.length === 0) return { label, detail: '', hint: 'none' };
  // 兜底：把前两个参数压成 key=value，避免出现「只有工具名」的空行
  const brief = keys
    .slice(0, 2)
    .map((k) => {
      const v = args[k];
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${s && s.length > 40 ? s.slice(0, 40) + '…' : s}`;
    })
    .join('  ');
  return { label, detail: brief, hint: 'none' };
}

/** 生成工具调用的可读摘要（中文动作名 + 参数），用于纯文本场景 */
export function formatToolCall(toolName: string, args: any): string {
  const { label, detail, hint } = describeToolCall(toolName, args);
  if (!detail) return label;
  if (hint === 'command') return `${label}  $ ${detail}`;
  if (hint === 'query') return `${label}  "${detail}"`;
  return `${label}  ${detail}`;
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

  pushLine: (text, kind = 'info', meta) => {
    set((s) => {
      const next = [
        ...s.lines,
        { id: ++lineSeq, text: clampLine(text), kind, at: Date.now(), ...(meta || {}) },
      ];
      return {
        lines: capTotalChars(
          next.length > MAX_ACTIVITY_LINES ? next.slice(next.length - MAX_ACTIVITY_LINES) : next
        ),
      };
    });
  },

  pushText: (text, kind = 'output') => {
    if (!text) return;
    const added = splitOutputLines(text, (p) => ({ id: ++lineSeq, text: p, kind, at: Date.now() }));
    if (added.length === 0) return;
    set((s) => {
      const next = [...s.lines, ...added];
      return {
        lines: capTotalChars(
          next.length > MAX_ACTIVITY_LINES ? next.slice(next.length - MAX_ACTIVITY_LINES) : next
        ),
      };
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
