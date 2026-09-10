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

export interface CnkeAPI {
  window: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => boolean;
    onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
  };
  fs: {
    openFolder: () => Promise<string | null>;
    readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
    writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
    listDir: (dirPath: string) => Promise<{ success: boolean; entries?: any[]; error?: string }>;
    createFile: (filePath: string, content?: string) => Promise<{ success: boolean; error?: string }>;
    createDir: (dirPath: string) => Promise<{ success: boolean; error?: string }>;
    deletePath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    renamePath: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>;
    exists: (filePath: string) => Promise<boolean>;
    searchFiles: (rootPath: string, pattern: string) => Promise<{ success: boolean; results?: any[]; error?: string }>;
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
    run: (params: any) => Promise<{ success: boolean; error?: string }>;
    abort: (sessionId: string) => void;
    enhancePrompt: (text: string) => Promise<{ success: boolean; enhanced?: string; error?: string }>;
    onEvent: (cb: (event: any) => void) => () => void;
    onToolCall: (cb: (data: any) => void) => () => void;
    onToolResult: (cb: (data: any) => void) => () => void;
  };
  session: {
    list: (workspaceId: string) => Promise<any[]>;
    listAll: () => Promise<any[]>;
    load: (sessionId: string) => Promise<any>;
    save: (session: any) => Promise<{ success: boolean; error?: string }>;
    delete: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    create: (workspaceId: string, title?: string) => Promise<any>;
  };
  config: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<void>;
    getApiKeyConfigs: () => Promise<any[]>;
    saveApiConfig: (config: any) => Promise<{ success: boolean; error?: string }>;
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
    listServers: () => Promise<any[]>;
    addServer: (config: any) => Promise<{ success: boolean; error?: string }>;
    removeServer: (id: string) => Promise<{ success: boolean; error?: string }>;
    toggleServer: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    listTools: (serverId: string) => Promise<any[]>;
    refreshTools: (serverId: string) => Promise<{ success: boolean; tools?: any[]; error?: string }>;
    callTool: (serverId: string, toolName: string, args: any) => Promise<any>;
    onStatusChanged: (cb: (status: any) => void) => () => void;
  };
  dialog: {
    showOpenDialog: (opts?: any) => Promise<string | null>;
    showSaveDialog: (opts?: any) => Promise<string | null>;
    showMessageBox: (opts: any) => Promise<any>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
    openPath: (path: string) => Promise<void>;
  };
  toolApprove: {
    onRequest: (cb: (data: any) => void) => () => void;
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
    getBuiltins: () => Promise<{ success: boolean; builtins?: any[]; error?: string }>;
    getAnnouncements: () => Promise<{ success: boolean; announcements?: any[]; error?: string }>;
    subscribeAnnouncements: () => Promise<{ success: boolean; error?: string }>;
    onAnnouncement: (cb: (payload: { type: string; announcements?: any[]; serverTime?: number }) => void) => () => void;
    submitFeedback: (msg: string, contact?: string) => Promise<{ success: boolean; item?: any; error?: string }>;
    listFeedback: (since?: number) => Promise<{ success: boolean; items?: any[]; newReplyCount?: number; serverTime?: number; error?: string }>;
  };
  /** 远程更新 API（增量热更新 / 断点续传 / 回滚） */
  update: {
    check: (mode: 'manual' | 'auto') => Promise<UpdateCheckResult>;
    download: (mode: 'manual' | 'auto') => Promise<{ success: boolean; error?: string }>;
    install: () => Promise<{ success: boolean; error?: string }>;
    cancel: () => Promise<{ success: boolean }>;
    getStatus: () => Promise<UpdateStatus>;
    getLogs: (limit?: number) => Promise<UpdateLogEntry[]>;
    onStatus: (cb: (status: UpdateStatus) => void) => () => void;
  };
  /** 系统通知（任务结束 / 异常退出） */
  notify: {
    show: (payload: { type: 'done' | 'error'; title?: string; message?: string }) => void;
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
    listSnapshots: (sessionId: string) => Promise<any[]>;
    restore: (snapshotId: string) => Promise<{ success: boolean; snapshotId: string }>;
    getSnapshot: (snapshotId: string) => Promise<any>;
    diffSnapshot: (snapshotId: string) => Promise<any>;
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
    export: (sessionId: string) => Promise<{ success: boolean; data?: any; error?: string }>;
    import: (data: any) => Promise<{ success: boolean; session?: any; error?: string }>;
    summarize: (sessionId: string) => Promise<{ success: boolean; summary?: string; error?: string }>;
    deleteMessage: (sessionId: string, messageId: string) => Promise<{ success: boolean; error?: string }>;
  };
  /** 计划查询（W3） */
  plan: {
    get: (sessionId: string) => Promise<{ plan: any; progress: any }>;
  };
  /** PPT 生成（W14） */
  ppt: {
    open: () => void;
    close: () => void;
    minimize: () => void;
    generate: (req: any, savePath?: string) => Promise<{ success: boolean; path?: string; slideCount?: number; error?: string }>;
    generateOutline: (topic: string, slideCount?: number) => Promise<{ success: boolean; outline?: any; error?: string }>;
    scanWorkspace: (wsPath?: string) => Promise<WorkspaceScanSummary>;
    generateFromWorkspace: (opts?: { wsPath?: string; slideCount?: number; focus?: string }) => Promise<{ success: boolean; outline?: any; workspace?: WorkspaceScanSummary; error?: string }>;
    listThemes: () => Promise<{ success: boolean; themes?: { id: string; name: string; description: string; colors: { primary: string; secondary: string; accent: string; background: string }; icon: string }[] }>;
    renderTheme: (payload: { themeId: string; outline: { title: string; slides: { title: string; bullets: string[] }[] }; extraInstruction?: string }) => Promise<{ success: boolean; html?: string; theme?: any; error?: string }>;
    saveHtml: (payload: { html: string; savePath: string }) => Promise<{ success: boolean; path?: string; error?: string }>;
    exportPdf: (payload: { html: string; savePath?: string; title?: string }) => Promise<{ success: boolean; path?: string; error?: string }>;
    onRenderProgress: (handler: (payload: { stage: 'render' | 'audit' | 'reflow' | 'finalize'; current: number; total: number; message: string }) => void) => () => void;
    listRemoteTemplates: (payload?: { page?: number; pageSize?: number; category?: string; keyword?: string }) => Promise<{ success: boolean; index?: { version: string; updatedAt: string; templates: Array<{ id: string; name: string; category: string; pageCount: number; style: string; description: string; thumbnailUrl: string | null; downloadUrl: string | null; size: number; updatedAt: string }>; total?: number; page?: number; pageSize?: number; categories?: string[] }; error?: string }>;
    listRemoteCategories: () => Promise<{ success: boolean; categories?: string[]; error?: string }>;
    downloadTemplate: (payload: { id: string }) => Promise<{ success: boolean; path?: string; fromCache?: boolean; error?: string }>;
    onTemplateProgress: (handler: (payload: { id: string; downloaded: number; total: number; ratio: number }) => void) => () => void;
    expandSlide: (payload: { slide: { title: string; bullets: string[] }; presentationTopic?: string; intensity?: 'light' | 'standard' | 'deep'; extraInstruction?: string }) => Promise<{ success: boolean; slide?: { title: string; bullets: string[] }; error?: string }>;
    expandAll: (payload: { outline: { title: string; slides: { title: string; bullets: string[] }[] }; intensity?: 'light' | 'standard' | 'deep'; extraInstruction?: string }) => Promise<{ success: boolean; outline?: { title: string; slides: { title: string; bullets: string[] }[] }; error?: string }>;
    onExpandProgress: (handler: (payload: { current: number; total: number; message: string }) => void) => () => void;
    applyTemplate: (payload: { templateId: string; outline: { title: string; slides: { title: string; bullets: string[] }[] }; savePath?: string }) => Promise<{ success: boolean; path?: string; pageCount?: number; filledCount?: number; strategy?: 'placeholder' | 'inject'; capacity?: number; error?: string }>;
    openWithTopic?: (topic: string) => void;
  };
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
