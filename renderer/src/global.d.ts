// 渲染进程全局类型声明

/** 本地记忆类型 */
export type MemoryType = 'preference' | 'project' | 'summary' | 'manual';
export type MemoryScope = 'global' | 'workspace';

export interface MemoryItem {
  id: string;
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  workspaceId?: string;
  importance: number; // 1-3
  createdAt: number;
  updatedAt: number;
  lastAccessAt: number;
  expiresAt?: number;
  source: 'auto' | 'manual';
  enabled: boolean;
}

export interface MemoryItemInput {
  content: string;
  type?: MemoryType;
  scope?: MemoryScope;
  workspaceId?: string;
  importance?: number;
  expiresInDays?: number;
  expiresAt?: number;
  source?: 'auto' | 'manual';
  enabled?: boolean;
}

export interface MemorySettings {
  enabled: boolean;
  autoLoad: boolean;
  autoExtract: boolean;
  injectBudgetChars: number;
}

export interface SkillView {
  id: string;
  name: string;
  description: string;
  kind: 'prompt' | 'package';
  source: 'builtin' | 'bundled' | 'local';
  version?: string;
  rootPath?: string;
  entryPath?: string;
  available?: boolean;
  error?: string;
  enabled: boolean;
}

/** 目录条目（主进程 FileSystemAdapter.listDir 返回） */
export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: number;
}

/** #codebase 检索命中条目（主进程 FileSystemAdapter.searchFiles 返回） */
export interface SearchResultEntry {
  path: string;
  relativePath: string;
  line: number;
  column: number;
  match: string;
}

/** 会话存储结构（主进程 SessionStore 返回，messages 为宽松类型供渲染层收窄） */
export interface StoredSession {
  id: string;
  workspaceId?: string;
  title?: string;
  messages?: any[];
  mode?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** Agent 事件宽松结构（主进程事件字段随版本演进，仅约束公共字段） */
export interface AgentEventLike {
  type: string;
  sessionId?: string;
  [key: string]: any;
}

/** PPT 大纲宽松结构（LLM 动态生成，字段随场景变化） */
export interface PptOutlineLike {
  title?: string;
  slides?: any[];
  [key: string]: any;
}

export interface CnkeAPI {
  window: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => boolean;
    onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
    /** 同步「AI 任务进行中」状态（主进程据此启用窗口保护） */
    setAgentBusy: (busy: boolean) => void;
    /** 订阅窗口保护提示（任务执行中误最小化 / 误关闭被拦截） */
    onGuardNotice: (cb: (payload: { reason: string }) => void) => () => void;
  };
  fs: {
    openFolder: () => Promise<string | null>;
    readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
    writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
    listDir: (dirPath: string) => Promise<{ success: boolean; entries?: DirEntry[]; error?: string }>;
    createFile: (filePath: string, content?: string) => Promise<{ success: boolean; error?: string }>;
    createDir: (dirPath: string) => Promise<{ success: boolean; error?: string }>;
    deletePath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    renamePath: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>;
    exists: (filePath: string) => Promise<boolean>;
    searchFiles: (rootPath: string, pattern: string) => Promise<{ success: boolean; results?: SearchResultEntry[]; error?: string }>;
    /** 开始监听工作区目录变更（打开/切换文件夹时调用） */
    watchWorkspace: (rootPath: string) => Promise<{ success: boolean; error?: string }>;
    /** 停止监听工作区目录变更 */
    unwatchWorkspace: () => Promise<{ success: boolean }>;
    /** 查询当前监听状态 */
    watchStatus: () => Promise<{ watching: boolean; root: string | null }>;
    /** 订阅工作区文件变更（批量，主进程已 debounce 合并） */
    onChanged: (cb: (payload: { root: string; changes: FsChange[] }) => void) => () => void;
  };
  skills: {
    list: () => Promise<SkillView[]>;
    scan: () => Promise<SkillView[]>;
    setEnabled: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string; skills: SkillView[] }>;
  };
  terminal: {
    spawn: (cmd: string, args: string[], cwd: string) => Promise<{ success: boolean; pid?: number; error?: string }>;
    write: (pid: number, data: string) => void;
    resize: (pid: number, cols: number, rows: number) => void;
    kill: (pid: number) => void;
    onOutput: (cb: (data: { pid: number; data: string }) => void) => () => void;
    onExit: (cb: (data: { pid: number; code: number }) => void) => () => void;
  };
  agent: {
    run: (params: unknown) => Promise<{ success: boolean; error?: string }>;
    abort: (sessionId: string) => void;
    enhancePrompt: (text: string) => Promise<{ success: boolean; enhanced?: string; error?: string }>;
    onEvent: (cb: (event: AgentEventLike) => void) => () => void;
    onToolCall: (cb: (data: unknown) => void) => () => void;
    onToolResult: (cb: (data: unknown) => void) => () => void;
  };
  session: {
    list: (workspaceId: string) => Promise<StoredSession[]>;
    listAll: () => Promise<StoredSession[]>;
    load: (sessionId: string) => Promise<StoredSession | null>;
    save: (session: unknown) => Promise<{ success: boolean; error?: string }>;
    delete: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    create: (workspaceId: string, title?: string) => Promise<StoredSession>;
  };
  config: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    getApiKeyConfigs: () => Promise<unknown[]>;
    saveApiConfig: (config: unknown) => Promise<{ success: boolean; error?: string }>;
    deleteApiConfig: (id: string) => Promise<{ success: boolean; error?: string }>;
    syncBuiltins: () => Promise<{ success: boolean; added: number; updated: number; removed: number; error?: string }>;
  };
  /** 本地记忆：跨多次模型调用持久化的上下文/偏好/摘要 */
  memory: {
    list: () => Promise<MemoryItem[]>;
    add: (input: MemoryItemInput) => Promise<{ success: boolean; item?: MemoryItem; error?: string }>;
    update: (id: string, patch: Partial<MemoryItemInput>) => Promise<{ success: boolean; item?: MemoryItem; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    clear: () => Promise<{ success: boolean; error?: string }>;
  };
  mcp: {
    listServers: () => Promise<unknown[]>;
    addServer: (config: unknown) => Promise<{ success: boolean; error?: string }>;
    removeServer: (id: string) => Promise<{ success: boolean; error?: string }>;
    toggleServer: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    listTools: (serverId: string) => Promise<unknown[]>;
    refreshTools: (serverId: string) => Promise<{ success: boolean; tools?: unknown[]; error?: string }>;
    callTool: (serverId: string, toolName: string, args: unknown) => Promise<unknown>;
    onStatusChanged: (cb: (status: unknown) => void) => () => void;
  };
  dialog: {
    showOpenDialog: (opts?: unknown) => Promise<string | null>;
    showSaveDialog: (opts?: unknown) => Promise<string | null>;
    showMessageBox: (opts: unknown) => Promise<unknown>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
    openPath: (path: string) => Promise<void>;
  };
  toolApprove: {
    onRequest: (cb: (data: unknown) => void) => () => void;
    respond: (requestId: string, approved: boolean) => void;
  };
  path: {
    dirname: (p: string) => string;
    basename: (p: string) => string;
    join: (...segments: string[]) => string;
    sep: string;
  };
  backend: {
    ping: () => Promise<{ success: boolean; latency?: number; error?: string }>;
    getDeviceId: () => Promise<string>;
    getBuiltins: () => Promise<{ success: boolean; builtins?: unknown[]; error?: string }>;
    getAnnouncements: () => Promise<{ success: boolean; announcements?: unknown[]; error?: string }>;
    subscribeAnnouncements: () => Promise<{ success: boolean; error?: string }>;
    onAnnouncement: (cb: (payload: { type: string; announcements?: unknown[]; serverTime?: number }) => void) => () => void;
    submitFeedback: (msg: string, contact?: string) => Promise<{ success: boolean; item?: unknown; error?: string }>;
    listFeedback: (since?: number) => Promise<{ success: boolean; items?: unknown[]; newReplyCount?: number; serverTime?: number; error?: string }>;
  };
  /** 远程更新 API（增量热更新 / 断点续传 / 回滚） */
  update: {
    check: (mode: 'manual' | 'auto') => Promise<UpdateCheckResult>;
    download: (mode: 'manual' | 'auto') => Promise<{ success: boolean; error?: string }>;
    install: () => Promise<{ success: boolean; error?: string }>;
    cancel: () => Promise<{ success: boolean }>;
    getStatus: () => Promise<UpdateStatus>;
    getLogs: (limit?: number) => Promise<UpdateLogEntry[]>;
    /** 检查是否刚完成更新（返回版本号或 null） */
    checkAnnouncement: () => Promise<string | null>;
    /** 获取远程 releasenotes.txt 内容 */
    getReleaseNotes: () => Promise<string>;
    onStatus: (cb: (status: UpdateStatus) => void) => () => void;
  };
  /** 系统通知（任务结束 / 异常退出） */
  notify: {
    show: (payload: { type: 'done' | 'error'; title?: string; message?: string }) => void;
  };
  /** 应用菜单事件（主进程菜单项 → 渲染层动作），返回取消订阅函数 */
  menu: {
    onOpenFolder: (cb: () => void) => () => void;
    onSaveFile: (cb: () => void) => () => void;
    onAbout: (cb: () => void) => () => void;
  };
  /** App 元信息（从主进程读取，避免硬编码） */
  app: {
    getVersion: () => Promise<string>;
    getPlatform: () => Promise<string>;
  };
  /** 上下文占用（W11 ContextTracker） */
  context: {
    getState: (sessionId: string) => Promise<ContextState | undefined>;
    listStates: () => Promise<ContextState[]>;
    removeState: (sessionId: string) => Promise<{ success: boolean }>;
  };
  /** Checkpoint 快照（W7） */
  checkpoint: {
    listSnapshots: (sessionId: string) => Promise<unknown[]>;
    restore: (snapshotId: string) => Promise<{ success: boolean; snapshotId: string }>;
    getSnapshot: (snapshotId: string) => Promise<unknown>;
    diffSnapshot: (snapshotId: string) => Promise<unknown>;
    getModifiedFiles: () => Promise<string[]>;
  };
  /** 工具审批信任规则（W7） */
  approval: {
    listRules: () => Promise<ApprovalRule[]>;
    addRule: (rule: ApprovalRule) => Promise<{ success: boolean }>;
    removeRule: (index: number) => Promise<{ success: boolean }>;
  };
  /** 会话导出/导入/上下文压缩 */
  sessionEx: {
    export: (sessionId: string) => Promise<{ success: boolean; data?: unknown; error?: string }>;
    import: (data: unknown) => Promise<{ success: boolean; session?: unknown; error?: string }>;
    summarize: (sessionId: string) => Promise<{ success: boolean; summary?: string; error?: string }>;
    deleteMessage: (sessionId: string, messageId: string) => Promise<{ success: boolean; error?: string }>;
  };
  /** 计划查询（W3） */
  plan: {
    get: (sessionId: string) => Promise<{ plan: unknown; progress: unknown }>;
    skip: (sessionId: string, itemId: string) => Promise<{ success: boolean; plan: unknown; progress: unknown }>;
    retry: (sessionId: string, itemId: string) => Promise<{ success: boolean; plan: unknown; progress: unknown }>;
    abandon: (sessionId: string) => Promise<{ success: boolean; plan: unknown; progress: unknown }>;
  };
  /** PPT 生成（W14） */
  ppt: {
    open: (topic?: string) => void;
    close: () => void;
    minimize: () => void;
    generate: (req: unknown, savePath?: string) => Promise<{ success: boolean; path?: string; slideCount?: number; brandNotices?: string[]; audit?: { issues: Array<{ level: 'warning' | 'fixed'; slide: number; message: string }>; summary: string; passed: boolean }; error?: string }>;
    generateOutline: (topic: string, slideCount?: number, scenarioId?: string) => Promise<{ success: boolean; outline?: PptOutlineLike; scenarioId?: string | null; error?: string }>;
    generateAiDesign: (payload: { topic?: string; scenarioName?: string; slides?: unknown[]; fallbackThemeId?: string }) => Promise<{ success: boolean; design: { themeId: string; palette: { primary: string; secondary: string; accent: string; background: string }; fontFamily: string; visualStyle: string; rationale: string }; byLlm: boolean }>;
    scanWorkspace: (wsPath?: string) => Promise<WorkspaceScanSummary>;
    generateFromWorkspace: (opts?: { wsPath?: string; slideCount?: number; focus?: string }) => Promise<{ success: boolean; outline?: PptOutlineLike; workspace?: WorkspaceScanSummary; error?: string }>;
    listScenarios: () => Promise<{ success: boolean; scenarios: Array<{ id: string; name: string; description: string; recommendedTheme: string; recommendedPages: [number, number] }> }>;
    detectScenario: (topic: string) => Promise<{ success: boolean; scenarioId: string; byLlm: boolean; confidence: number }>;
    getBrand: () => Promise<{ success: boolean; brand: { enabled: boolean; companyName: string; logoPath: string; primary: string; secondary: string; accent: string; fontFamily: string; footerText: string } }>;
    setBrand: (brand: unknown) => Promise<{ success: boolean; brand: unknown }>;
    listThemes: () => Promise<{ success: boolean; themes?: { id: string; name: string; description: string; colors: { primary: string; secondary: string; accent: string; background: string }; icon: string }[] }>;
    generatePreview: (payload: { themeId: string; outline: { title: string; slides: unknown[] }; design?: { palette?: { primary?: string; secondary?: string; accent?: string; background?: string }; fontFamily?: string; artDirection?: string } }) => Promise<{ success: boolean; html?: string; error?: string }>;
    renderTheme: (payload: { themeId: string; outline: { title: string; slides: { title: string; bullets: string[]; chart?: { type: 'bar' | 'line' | 'pie'; labels: string[]; series: { name: string; values: number[] }[] } }[] }; extraInstruction?: string }) => Promise<{ success: boolean; html?: string; theme?: unknown; error?: string }>;
    saveHtml: (payload: { html: string; savePath: string }) => Promise<{ success: boolean; path?: string; error?: string }>;
    exportPdf: (payload: { html: string; savePath?: string; title?: string }) => Promise<{ success: boolean; path?: string; error?: string }>;
    onRenderProgress: (handler: (payload: { stage: 'render' | 'audit' | 'reflow' | 'finalize'; current: number; total: number; message: string }) => void) => () => void;
    expandSlide: (payload: { slide: { title: string; bullets: string[] }; presentationTopic?: string; intensity?: 'light' | 'standard' | 'deep'; extraInstruction?: string }) => Promise<{ success: boolean; slide?: { title: string; bullets: string[] }; error?: string }>;
    expandAll: (payload: { outline: { title: string; slides: { title: string; bullets: string[] }[] }; intensity?: 'light' | 'standard' | 'deep'; extraInstruction?: string }) => Promise<{ success: boolean; outline?: { title: string; slides: { title: string; bullets: string[] }[] }; error?: string }>;
    onExpandProgress: (handler: (payload: { current: number; total: number; message: string }) => void) => () => void;
    open: (topic?: string) => void;
    onTopic: (handler: (topic: string) => void) => () => void;
  };
  /** PPT Master 原生 PPTX 流水线（替代旧 pptxgenjs 扁平导出） */
  pptMaster: {
    checkEnv: () => Promise<{
      success: boolean;
      ok?: boolean;
      python?: { path: string; version: string | null; source: string } | null;
      skillOk?: boolean;
      missingSkill?: string[];
      dependencies?: Array<{ name: string; importName: string; installed: boolean; impact: string; required: boolean }>;
      blockers?: string[];
      projectsRoot?: string;
      error?: string;
    }>;
    rebindPython: (pythonPath?: string) => Promise<{ success: boolean; found: boolean; path?: string; version?: string | null; error?: string }>;
    installDeps: () => Promise<{ success: boolean; error?: string }>;
    generate: (opts: {
      projectName?: string;
      topic: string;
      sources?: string[];
      slideCount?: number;
      canvasFormat?: string;
      deliveryContext?: string;
      styleHint?: string;
      speakerNotes?: boolean;
      animations?: boolean;
      savePath?: string;
    }) => Promise<{
      success: boolean;
      projectPath?: string;
      pptxPath?: string;
      reportPath?: string;
      pageCount?: number;
      qualityGate?: string;
      warnings?: string[];
      error?: string;
      timings?: Record<string, number>;
    }>;
    pickSavePath: (defaultName?: string) => Promise<{ success: boolean; savePath: string }>;
    listProjects: () => Promise<{
      success: boolean;
      projects: Array<{ name: string; path: string; pageCount: number; pptxPath: string | null; mtime: number }>;
      root?: string;
      error?: string;
    }>;
    openProjectDir: (projectPath: string) => Promise<{ success: boolean; error?: string }>;
    listCapabilities: () => Promise<{ success: boolean; skillRoot?: string; workflows?: string[]; references?: string[]; error?: string }>;
    onProgress: (
      handler: (p: {
        stage: 'idle' | 'checking' | 'converting' | 'init' | 'planning' | 'authoring' | 'early-gate' | 'final-gate' | 'postprocess' | 'exporting' | 'done' | 'error';
        message: string;
        current?: number;
        total?: number;
        percent?: number;
        log?: string;
      }) => void,
    ) => () => void;
    onInstallOutput: (handler: (line: string) => void) => () => void;
  };
}

/** 工作区文件变更条目（主进程 fs:changed 广播） */
export interface FsChange {
  /** rename 覆盖新增/删除（Node fs.watch 不区分），change 为内容变化 */
  type: 'rename' | 'change';
  absolutePath: string;
  /** 相对工作区根的路径，POSIX 分隔符 */
  relativePath: string;
  /** 变更所在目录绝对路径 */
  dir: string;
  at: number;
}

export interface WorkspaceScanSummary {
  success: boolean;
  workspace?: string;
  projectName?: string;
  readmeContent?: string;
  readmePath?: string;
  structure?: string;
  fileStats?: { totalFiles: number; topDirs: { name: string; count: number }[] };
  docFiles?: { path: string; size: number }[];
  error?: string;
}

export interface ContextState {
  sessionId: string;
  model: string;
  maxContextTokens: number;
  promptTokens: number;
  completionTokens: number;
  currentChars: number;
  estimatedTokens: number;
  messageCount: number;
  updatedAt: number;
}

export interface ApprovalRule {
  toolName: string;
  pathPattern?: string;
  commandPattern?: string;
  action: 'allow' | 'deny' | 'ask';
  source?: string;
}

export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  mode: 'manual' | 'auto';
  version?: string;
  releaseNotes?: string;
  releaseDate?: string;
  /** 强制更新最低版本：当前版本低于此值时不可跳过更新 */
  minimumRunVersion?: string;
  percent: number;
  transferred: number;
  total: number;
  differential: boolean;
  message?: string;
  error?: string;
}

export interface UpdateCheckResult {
  success: boolean;
  hasUpdate: boolean;
  version?: string;
  releaseNotes?: string;
  releaseDate?: string;
  /** 强制更新最低版本：当前版本低于此值时不可跳过更新 */
  minimumRunVersion?: string;
  error?: string;
}

export interface UpdateLogEntry {
  time: string;
  action: 'check' | 'download' | 'install' | 'error' | 'skip';
  mode: 'manual' | 'auto';
  version?: string;
  status: 'success' | 'failed' | 'cancelled';
  message?: string;
  error?: string;
}

declare global {
  interface Window {
    cnke: CnkeAPI;
  }
}
