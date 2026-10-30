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

/** AI 行内补全请求（renderer 已截好前后文） */
export interface InlineCompletionRequest {
  filePath: string;
  language: string;
  prefix: string;
  suffix: string;
}

// ===== 任务工作区（W19）=====
// 一个任务 = 一个工作区文件夹 + 绑定该文件夹的会话。
// id 与 workspacePath 相同（绝对路径），即 session.workspaceId 的主键。
export interface TaskItem {
  id: string;
  name: string;
  dirName: string;
  parentDir: string;
  workspacePath: string;
  createdAt: number;
  sessionCount: number;
  /** 已归档：默认折叠在「已归档」分组里，不参与日常切换 */
  archived: boolean;
  /** 归档时间（取消归档后为 0） */
  archivedAt?: number;
  /** 文件夹已不在磁盘上（被手动删除/移动/未挂载） */
  missing: boolean;
  /** 仅重命名返回：目录是否真的改了名 */
  dirChanged?: boolean;
  /** 仅重命名返回：改名前的路径（调用方据此更新本地状态） */
  previousPath?: string;
  /** 仅重命名返回：为释放目录占用而被关掉的终端数量 */
  terminalsClosed?: number;
}

// ===== 历史统计看板（W18）=====
// 与主进程 electron/core-fork/analytics 的返回结构一一对应；
// 这里独立声明而非 import，避免渲染层跨 tsconfig 引用主进程源码。
export type StatsRange = '7d' | '30d' | '90d' | 'all';
export type StatsSortBy = 'updatedAt' | 'totalTokens' | 'messages' | 'toolCalls';

export interface StatsQuery {
  range?: StatsRange;
  workspaceId?: string | null;
  keyword?: string | null;
  page?: number;
  pageSize?: number;
  sortBy?: StatsSortBy;
}

// ===== 全文搜索（W22）=====
export interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  maxResults?: number;
}

export interface ContentMatch {
  file: string;
  relativePath: string;
  line: number;
  column: number;
  text: string;
}

export interface SearchResultSet {
  matches: ContentMatch[];
  filesScanned: number;
  truncated: boolean;
  skippedLarge: number;
  timedOut: boolean;
}

/** 导出结果：canceled=true 表示用户在保存框里点了取消 */
export interface StatsExportResult {
  canceled: boolean;
  filePath?: string;
  bytes?: number;
  rows?: number;
}

export interface StatsDailyPoint {
  date: string;
  sessions: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolFailures: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StatsSummary {
  sessions: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolFailures: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  cacheHitRate: number;
  toolFailureRate: number;
  activeDays: number;
  spanDays: number;
  avgTokensPerSession: number;
  avgMessagesPerSession: number;
  avgTokensPerMessage: number;
  peakDate: string | null;
  peakTokens: number;
  firstAt: number | null;
  lastAt: number | null;
}

export interface StatsRingKpi {
  key: string;
  label: string;
  value: number;
  display: string;
  sub: string;
  tone: 'violet' | 'amber' | 'cyan' | 'emerald';
}

export interface StatsModelSlice {
  model: string;
  messages: number;
  tokens: number;
  share: number;
}

export interface StatsToolSlice {
  tool: string;
  count: number;
  failures: number;
  share: number;
}

export interface StatsInsight {
  level: 'good' | 'warn' | 'info';
  title: string;
  detail: string;
  metric?: string;
}

export interface StatsForecastPoint {
  date: string;
  tokens: number;
  lower: number;
  upper: number;
}

export interface StatsTrendModel {
  slope: number;
  r2: number;
  movingAvg: number;
  growthRate: number | null;
  forecast: StatsForecastPoint[];
  anomalies: { date: string; tokens: number; z: number }[];
  direction: 'up' | 'down' | 'flat';
}

export interface StatsDashboard {
  generatedAt: number;
  range: string;
  summary: StatsSummary;
  kpis: StatsRingKpi[];
  daily: StatsDailyPoint[];
  trend: StatsTrendModel;
  models: StatsModelSlice[];
  tools: StatsToolSlice[];
  hourly: number[];
  insights: StatsInsight[];
  activityScore: number;
}

export interface StatsSessionRow {
  id: string;
  title: string;
  workspaceId: string;
  mode: string;
  createdAt: number;
  updatedAt: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolFailures: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  models: string[];
  firstMessageAt: number | null;
  lastMessageAt: number | null;
  durationMs: number;
  preview: string;
}

export interface StatsWorkspaceOption {
  id: string;
  label: string;
  sessions: number;
}

export interface StatsSessionPage {
  rows: StatsSessionRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  workspaces: StatsWorkspaceOption[];
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
    /** 订阅「显示内置预览浏览器」请求（Agent 浏览器工具调用时触发） */
    onPreviewShow: (cb: () => void) => () => void;
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
  /** 语音输入（内置离线识别，详见 electron/voice/VoiceEngine.ts） */
  voice: {
    status: () => Promise<{ ready: boolean; message: string; progress: number }>;
    feed: (samples: number[]) => void;
    finalize: () => Promise<string>;
    reset: () => void;
    onText: (cb: (data: { text: string; final: boolean }) => void) => () => void;
    onStatus: (cb: (s: { ready: boolean; message: string; progress: number }) => void) => () => void;
  };
  /** AI 行内补全（独立轻量通道，不污染聊天会话） */
  completion: {
    inline: (req: InlineCompletionRequest, requestId?: string) => Promise<{ text: string } | { error: string }>;
    cancel: (requestId: string) => Promise<void>;
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
    getCatalog: (forceRefresh?: boolean) => Promise<McpCatalogEntry[]>;
    installFromCatalog: (entry: McpCatalogEntry) => Promise<{ success: boolean; error?: string }>;
    onStatusChanged: (cb: (status: unknown) => void) => () => void;
  };
  dialog: {
    showOpenDialog: (opts?: unknown) => Promise<string | null>;
    showSaveDialog: (opts?: unknown) => Promise<string | null>;
    showMessageBox: (opts: unknown) => Promise<unknown>;
    /** 保存聊天里的生成图片（data URL → 保存对话框 → 写盘） */
    saveImage: (dataUrl: string, suggestedName?: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
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
  /** 系统通知（任务结束 / 异常退出 / 一般提示） */
  notify: {
    show: (payload: { type: 'done' | 'error' | 'info'; title?: string; message?: string }) => void;
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
  /** 历史统计看板：统计模型在主进程完成聚合，渲染层只负责展示 */
  stats: {
    dashboard: (filter?: StatsQuery) => Promise<{ success: boolean; data?: StatsDashboard; error?: string }>;
    sessions: (query?: StatsQuery) => Promise<{ success: boolean; data?: StatsSessionPage; error?: string }>;
    /** 导出当前筛选结果（主进程弹保存框并写盘；canceled 表示用户取消） */
    export: (
      query?: StatsQuery,
      format?: 'csv' | 'markdown',
    ) => Promise<{ success: boolean; data?: StatsExportResult; error?: string }>;
  };
  /** 任务工作区：新建任务时由主进程建文件夹，渲染层只关心结果 */
  task: {
    list: () => Promise<{ success: boolean; data?: TaskItem[]; error?: string }>;
    create: (name: string, parentDir?: string) => Promise<{ success: boolean; data?: TaskItem; error?: string }>;
    reveal: (workspacePath: string) => Promise<{ success: boolean; error?: string }>;
    rename: (id: string, newName: string) => Promise<{ success: boolean; data?: TaskItem; error?: string }>;
    archive: (id: string, archived?: boolean) => Promise<{ success: boolean; error?: string }>;
  };
  /** 工作区全文搜索（Ctrl+Shift+F） */
  search: {
    content: (
      rootPath: string,
      query: string,
      opts?: SearchOptions,
    ) => Promise<{ success: boolean; data?: SearchResultSet; error?: string }>;
  };
  /** 仓库级指令文件（AGENTS.md / CNKE.md）：每轮对话自动注入 systemPrompt */
  project: {
    instructions: (rootPath?: string) => Promise<ProjectInstructionsReport>;
    createInstruction: (
      rootPath?: string,
      fileName?: string,
    ) => Promise<{ success: boolean; path?: string; created?: boolean; error?: string }>;
  };
}

/** 单条已加载的项目指令文件 */
export interface ProjectInstructionFile {
  path: string;
  /** 相对工作区根目录，/ 分隔 */
  relPath: string;
  bytes: number;
  /** 超过单文件上限被截断 */
  truncated: boolean;
  /** 相对根目录的层级深度，根目录为 0 */
  depth: number;
}

export interface ProjectInstructionsReport {
  success: boolean;
  root?: string;
  files: ProjectInstructionFile[];
  /** 被跳过的文件（空文件 / 超预算 / 读取失败） */
  skipped: { path: string; relPath: string; reason: string }[];
  /** 实际注入的字节数 */
  totalBytes: number;
  /** 将要拼进 systemPrompt 的提示块 */
  block: string;
  error?: string;
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

export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  source: 'registry' | 'builtin';
  version?: string;
  repositoryUrl?: string;
  author?: string;
  installConfig: {
    protocol: 'stdio' | 'http';
    command?: string;
    args?: string;
    url?: string;
  };
}

declare global {
  interface Window {
    cnke: CnkeAPI;
  }
}

/**
 * Electron 专有的 <webview> 标签，React 内置 JSX 类型里没有。
 * 仅预览面板使用（需要主进程 webPreferences.webviewTag = true）。
 */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: import('react').DetailedHTMLProps<import('react').HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        allowpopups?: string;
        partition?: string;
      };
    }
  }
}
