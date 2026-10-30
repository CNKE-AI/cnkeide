import { contextBridge, ipcRenderer } from 'electron';
import path from 'node:path';
import type { RunParams } from './core-fork/agent/AgentManager';
import type { ApprovalRule } from './core-fork/checkpoint/ApprovalPolicy';
import type { McpServerConfig } from './core-fork/mcp/McpHub';
import type { MemoryItemInput } from './core-fork/memory/MemoryStore';
import type { AiPptSlideHint } from './core-fork/ppt/pptDesign';
import type { PreviewSlide } from './core-fork/ppt/pptPreview';
import type { PptxCreateRequest } from './core-fork/tools/PptxTools';
import type { ChatSession } from './store/SessionStore';
import type { UpdateStatus } from './updater/UpdateManager';
import type { InlineCompletionRequest } from './core-fork/completion/InlineCompletionService';
import type { StatsQuery } from './core-fork/analytics/HistoryStats';

// ===== 窗口控制 API =====
const windowApi = {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.sendSync('window:isMaximized'),
  onMaximizedChange: (cb: (maximized: boolean) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, maximized: boolean) => cb(maximized);
    ipcRenderer.on('window:maximized-changed', handler);
    return () => ipcRenderer.removeListener('window:maximized-changed', handler);
  },
  /** 同步「AI 任务进行中」状态，主进程据此启用窗口保护（防误最小化/误关闭） */
  setAgentBusy: (busy: boolean) => ipcRenderer.send('window:set-agent-busy', busy),
  /** 订阅窗口保护提示（例如任务执行中尝试最小化被拦截） */
  onGuardNotice: (cb: (payload: { reason: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { reason: string }) => cb(payload);
    ipcRenderer.on('window:guard-notice', handler);
    return () => ipcRenderer.removeListener('window:guard-notice', handler);
  },
  /**
   * 订阅「显示内置预览浏览器」请求。
   * Agent 的 browser_* 工具驱动的是这个预览面板，因此调用前主进程会要求面板可见。
   */
  onPreviewShow: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('preview:show', handler);
    return () => ipcRenderer.removeListener('preview:show', handler);
  },
};

// ===== 文件系统 API =====
const fsApi = {
  openFolder: () => ipcRenderer.invoke('fs:openFolder'),
  readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  listDir: (dirPath: string) => ipcRenderer.invoke('fs:listDir', dirPath),
  createFile: (filePath: string, content?: string) => ipcRenderer.invoke('fs:createFile', filePath, content),
  createDir: (dirPath: string) => ipcRenderer.invoke('fs:createDir', dirPath),
  deletePath: (filePath: string) => ipcRenderer.invoke('fs:deletePath', filePath),
  renamePath: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:renamePath', oldPath, newPath),
  exists: (filePath: string) => ipcRenderer.invoke('fs:exists', filePath),
  searchFiles: (rootPath: string, pattern: string) => ipcRenderer.invoke('fs:searchFiles', rootPath, pattern),
  /** 开始监听工作区目录变更（打开/切换文件夹时调用） */
  watchWorkspace: (rootPath: string) => ipcRenderer.invoke('fs:watchWorkspace', rootPath),
  /** 停止监听工作区目录变更 */
  unwatchWorkspace: () => ipcRenderer.invoke('fs:unwatchWorkspace'),
  /** 查询当前监听状态 */
  watchStatus: () => ipcRenderer.invoke('fs:watchStatus'),
  /** 订阅工作区文件变更（批量，已 debounce 合并） */
  onChanged: (cb: (payload: { root: string; changes: FsChange[] }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { root: string; changes: FsChange[] }) => cb(payload);
    ipcRenderer.on('fs:changed', handler);
    return () => ipcRenderer.removeListener('fs:changed', handler);
  },
};

/** 工作区文件变更条目 */
export interface FsChange {
  type: 'rename' | 'change';
  absolutePath: string;
  relativePath: string;
  dir: string;
  at: number;
}

// ===== 终端 API =====
const terminalApi = {
  spawn: (cmd: string, args: string[], cwd: string) => ipcRenderer.invoke('terminal:spawn', cmd, args, cwd),
  write: (pid: number, data: string) => ipcRenderer.send('terminal:write', pid, data),
  resize: (pid: number, cols: number, rows: number) => ipcRenderer.send('terminal:resize', pid, cols, rows),
  kill: (pid: number) => ipcRenderer.send('terminal:kill', pid),
  onOutput: (cb: (data: { pid: number; data: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { pid: number; data: string }) => cb(data);
    ipcRenderer.on('terminal:output', handler);
    return () => ipcRenderer.removeListener('terminal:output', handler);
  },
  onExit: (cb: (data: { pid: number; code: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { pid: number; code: number }) => cb(data);
    ipcRenderer.on('terminal:exit', handler);
    return () => ipcRenderer.removeListener('terminal:exit', handler);
  },
};

// ===== Agent API =====
const agentApi = {
  run: (params: RunParams) => ipcRenderer.invoke('agent:run', params),
  // 测试专用（仅 CNKE_FLOOD_TEST=1 时主进程注册该通道）：重放 agent 事件供白屏实测
  ...(process.env.CNKE_FLOOD_TEST === '1'
    ? { testPushEvent: (event: unknown) => ipcRenderer.invoke('agent:testPushEvent', event) }
    : {}),
  abort: (sessionId: string) => ipcRenderer.send('agent:abort', sessionId),
  enhancePrompt: (text: string) => ipcRenderer.invoke('agent:enhancePrompt', text),
  onEvent: (cb: (event: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: unknown) => cb(event);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  onToolCall: (cb: (data: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('agent:tool-call', handler);
    return () => ipcRenderer.removeListener('agent:tool-call', handler);
  },
  onToolResult: (cb: (data: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('agent:tool-result', handler);
    return () => ipcRenderer.removeListener('agent:tool-result', handler);
  },
};

// ===== 语音输入 API（内置离线识别）=====
const voiceApi = {
  /** 查询/初始化引擎；首次会触发模型下载，进度经 onStatus 推送 */
  status: () => ipcRenderer.invoke('voice:status'),
  /** 喂入 16kHz float32 PCM 帧（数组化传输，避免结构化克隆开销） */
  feed: (samples: number[]) => ipcRenderer.send('voice:feed', samples),
  /** 结束听写，返回全部确认文本 */
  finalize: () => ipcRenderer.invoke('voice:finalize'),
  /** 取消本次听写 */
  reset: () => ipcRenderer.send('voice:reset'),
  /** 识别结果推送：{ text, final } */
  onText: (cb: (data: { text: string; final: boolean }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { text: string; final: boolean }) => cb(data);
    ipcRenderer.on('voice:text', handler);
    return () => ipcRenderer.removeListener('voice:text', handler);
  },
  /** 引擎状态/下载进度推送 */
  onStatus: (cb: (s: { ready: boolean; message: string; progress: number }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, s: { ready: boolean; message: string; progress: number }) => cb(s);
    ipcRenderer.on('voice:status', handler);
    return () => ipcRenderer.removeListener('voice:status', handler);
  },
};

// ===== 会话 API =====
const sessionApi = {
  list: (workspaceId: string) => ipcRenderer.invoke('session:list', workspaceId),
  listAll: () => ipcRenderer.invoke('session:listAll'),
  load: (sessionId: string) => ipcRenderer.invoke('session:load', sessionId),
  save: (session: ChatSession) => ipcRenderer.invoke('session:save', session),
  delete: (sessionId: string) => ipcRenderer.invoke('session:delete', sessionId),
  create: (workspaceId: string, title?: string) => ipcRenderer.invoke('session:create', workspaceId, title),
};

// ===== 配置 API =====
const skillApi = {
  list: () => ipcRenderer.invoke('skills:list'),
  scan: () => ipcRenderer.invoke('skills:scan'),
  setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('skills:setEnabled', id, enabled),
};

const configApi = {
  get: (key: string) => ipcRenderer.invoke('config:get', key),
  set: (key: string, value: unknown) => ipcRenderer.invoke('config:set', key, value),
  getApiKeyConfigs: () => ipcRenderer.invoke('config:getApiKeyConfigs'),
  saveApiConfig: (config: Record<string, unknown>) => ipcRenderer.invoke('config:saveApiConfig', config),
  deleteApiConfig: (id: string) => ipcRenderer.invoke('config:deleteApiConfig', id),
  syncBuiltins: () => ipcRenderer.invoke('config:syncBuiltins'),
};

// ===== AI 行内补全 API（独立轻量通道，不污染聊天会话）=====
const completionApi = {
  /** 请求一次行内补全；requestId 用于取消 */
  inline: (req: InlineCompletionRequest, requestId?: string) =>
    ipcRenderer.invoke('completion:inline', { requestId, req }),
  /** 取消进行中的补全请求 */
  cancel: (requestId: string) => ipcRenderer.invoke('completion:cancel', requestId),
};

// ===== 本地记忆 API =====
const memoryApi = {
  list: () => ipcRenderer.invoke('memory:list'),
  add: (input: MemoryItemInput) => ipcRenderer.invoke('memory:add', input),
  update: (id: string, patch: Partial<MemoryItemInput>) => ipcRenderer.invoke('memory:update', id, patch),
  delete: (id: string) => ipcRenderer.invoke('memory:delete', id),
  clear: () => ipcRenderer.invoke('memory:clear'),
};

// ===== 仓库级指令文件 API（AGENTS.md / CNKE.md）=====
const projectApi = {
  /** 列出当前工作区会被注入的项目指令文件（含字节数、截断标记） */
  instructions: (rootPath?: string) => ipcRenderer.invoke('project:instructions', rootPath),
  /** 在工作区根目录生成 AGENTS.md 模板（已存在则返回 created=false，不覆盖） */
  createInstruction: (rootPath?: string, fileName?: string) =>
    ipcRenderer.invoke('project:createInstruction', rootPath, fileName),
};

// ===== MCP API =====
const mcpApi = {
  listServers: () => ipcRenderer.invoke('mcp:listServers'),
  addServer: (config: McpServerConfig) => ipcRenderer.invoke('mcp:addServer', config),
  removeServer: (id: string) => ipcRenderer.invoke('mcp:removeServer', id),
  toggleServer: (id: string, enabled: boolean) => ipcRenderer.invoke('mcp:toggleServer', id, enabled),
  listTools: (serverId: string) => ipcRenderer.invoke('mcp:listTools', serverId),
  refreshTools: (serverId: string) => ipcRenderer.invoke('mcp:refreshTools', serverId),
  callTool: (serverId: string, toolName: string, args: unknown) => ipcRenderer.invoke('mcp:callTool', serverId, toolName, args),
  getCatalog: (forceRefresh = false) => ipcRenderer.invoke('mcp:getCatalog', forceRefresh),
  installFromCatalog: (entry: any) => ipcRenderer.invoke('mcp:installFromCatalog', entry),
  onStatusChanged: (cb: (status: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: unknown) => cb(status);
    ipcRenderer.on('mcp:status-changed', handler);
    return () => ipcRenderer.removeListener('mcp:status-changed', handler);
  },
};

// ===== 对话框 API =====
const dialogApi = {
  showOpenDialog: () => ipcRenderer.invoke('dialog:open'),
  showSaveDialog: () => ipcRenderer.invoke('dialog:save'),
  showMessageBox: (opts: Electron.MessageBoxOptions) => ipcRenderer.invoke('dialog:message', opts),
  /** 保存聊天里的生成图片（data URL → 保存对话框 → 写盘） */
  saveImage: (dataUrl: string, suggestedName?: string) =>
    ipcRenderer.invoke('image:save', { dataUrl, suggestedName }),
};

// ===== Shell API =====
const shellApi = {
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
};

// ===== Path API =====
const pathApi = {
  dirname: (p: string) => path.dirname(p),
  basename: (p: string) => path.basename(p),
  join: (...segments: string[]) => path.join(...segments),
  sep: path.sep,
};

// ===== App API（版本/平台信息）=====
const appApi = {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getPlatform: () => ipcRenderer.invoke('app:getPlatform'),
};

// ===== 上下文占用 API（W11 ContextTracker）=====
const contextApi = {
  getState: (sessionId: string) => ipcRenderer.invoke('context:getState', sessionId),
  listStates: () => ipcRenderer.invoke('context:listStates'),
  removeState: (sessionId: string) => ipcRenderer.invoke('context:removeState', sessionId),
};

// ===== Checkpoint 快照 API（W7）=====
const checkpointApi = {
  listSnapshots: (sessionId: string) => ipcRenderer.invoke('checkpoint:listSnapshots', sessionId),
  restore: (snapshotId: string) => ipcRenderer.invoke('checkpoint:restore', snapshotId),
  getSnapshot: (snapshotId: string) => ipcRenderer.invoke('checkpoint:getSnapshot', snapshotId),
  diffSnapshot: (snapshotId: string) => ipcRenderer.invoke('checkpoint:diffSnapshot', snapshotId),
  getModifiedFiles: () => ipcRenderer.invoke('checkpoint:getModifiedFiles'),
};

// ===== 工具审批信任规则 API（W7）=====
const approvalApi = {
  listRules: () => ipcRenderer.invoke('approval:listRules'),
  addRule: (rule: ApprovalRule) => ipcRenderer.invoke('approval:addRule', rule),
  removeRule: (index: number) => ipcRenderer.invoke('approval:removeRule', index),
};

// ===== 会话导出 / 导入 / 上下文压缩 API =====
const sessionExApi = {
  export: (sessionId: string) => ipcRenderer.invoke('session:export', sessionId),
  import: (data: unknown) => ipcRenderer.invoke('session:import', data),
  summarize: (sessionId: string) => ipcRenderer.invoke('session:summarize', sessionId),
  deleteMessage: (sessionId: string, messageId: string) => ipcRenderer.invoke('session:deleteMessage', sessionId, messageId),
};

// ===== Plan 查询 API（W3）=====
const planApi = {
  get: (sessionId: string) => ipcRenderer.invoke('plan:get', sessionId),
  skip: (sessionId: string, itemId: string) => ipcRenderer.invoke('plan:skip', sessionId, itemId),
  retry: (sessionId: string, itemId: string) => ipcRenderer.invoke('plan:retry', sessionId, itemId),
  abandon: (sessionId: string) => ipcRenderer.invoke('plan:abandon', sessionId),
};

// ===== 官方后台 API（远程配置 / 公告 / 反馈）=====
const backendApi = {
  ping: () => ipcRenderer.invoke('backend:ping'),
  getDeviceId: () => ipcRenderer.invoke('backend:getDeviceId'),
  getBuiltins: () => ipcRenderer.invoke('backend:getBuiltins'),
  getAnnouncements: () => ipcRenderer.invoke('backend:getAnnouncements'),
  subscribeAnnouncements: () => ipcRenderer.invoke('backend:subscribeAnnouncements'),
  onAnnouncement: (cb: (payload: { type: string; announcements?: unknown[]; serverTime?: number }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { type: string; announcements?: unknown[]; serverTime?: number }) => cb(payload);
    ipcRenderer.on('backend:announcement-event', listener);
    return () => ipcRenderer.removeListener('backend:announcement-event', listener);
  },
  submitFeedback: (msg: string, contact?: string) => ipcRenderer.invoke('backend:submitFeedback', msg, contact),
  listFeedback: (since?: number) => ipcRenderer.invoke('backend:listFeedback', since || 0),
};

// ===== 工具确认 API =====
const toolApproveApi = {
  onRequest: (cb: (data: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on('tool:approve-request', handler);
    return () => ipcRenderer.removeListener('tool:approve-request', handler);
  },
  respond: (requestId: string, approved: boolean) => ipcRenderer.send('tool:approve-response', requestId, approved),
};

// ===== 系统通知 API（任务结束 / 异常退出）=====
const notifyApi = {
  show: (payload: { type: 'done' | 'error'; title?: string; message?: string }) => {
    ipcRenderer.send('agent:notify', payload);
  },
};

// ===== 应用菜单事件 API（主进程菜单项 → 渲染层动作）=====
// 菜单项和快捷键（Ctrl+O / Ctrl+S）由主进程捕获，但动作本身属于 UI 状态
// （切换工作区、保存编辑器当前文件），所以必须由渲染层执行。
// 过去这三个通道只有发送方没有接收方，菜单点击和快捷键因此完全无反应。
const menuApi = {
  onOpenFolder: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('menu:openFolder', handler);
    return () => ipcRenderer.removeListener('menu:openFolder', handler);
  },
  onSaveFile: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('menu:saveFile', handler);
    return () => ipcRenderer.removeListener('menu:saveFile', handler);
  },
  onAbout: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('menu:about', handler);
    return () => ipcRenderer.removeListener('menu:about', handler);
  },
};

// ===== PPT 生成 API（W14）=====
const pptApi = {
  /** 打开独立的 PPT 生成窗口，可选预填主题 */
  open: (topic?: string) => ipcRenderer.send('ppt:open', topic),
  /** 订阅来自主窗口的预填主题 */
  onTopic: (handler: (topic: string) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, topic: string) => handler(topic);
    ipcRenderer.on('ppt:prefill-topic', wrapped);
    return () => ipcRenderer.removeListener('ppt:prefill-topic', wrapped);
  },
  /** 关闭 PPT 窗口 */
  close: () => ipcRenderer.send('ppt:close'),
  minimize: () => ipcRenderer.send('ppt:minimize'),
  /** 生成并保存 PPT 到指定路径 */
  generate: (req: PptxCreateRequest, savePath?: string) => ipcRenderer.invoke('ppt:generate', req, savePath),
  /** AI 生成 PPT 大纲（复用当前 active API + LLMProvider；场景化时按场景结构骨架组织） */
  generateOutline: (topic: string, slideCount?: number, scenarioId?: string) =>
    ipcRenderer.invoke('ppt:generateOutline', topic, slideCount, scenarioId),
  /** AI 自动生成原创视觉方案（配色、字体和风格），不使用外部模板。 */
  generateAiDesign: (payload: { topic?: string; scenarioName?: string; slides?: AiPptSlideHint[]; fallbackThemeId?: string }) =>
    ipcRenderer.invoke('ppt:generateAiDesign', payload),
  /** 扫描当前工作区内容摘要（目录结构 + README + 文档清单） */
  scanWorkspace: (wsPath?: string) => ipcRenderer.invoke('ppt:scanWorkspace', wsPath),
  /** 基于当前工作区代码/文档自动生成 PPT 大纲 */
  generateFromWorkspace: (opts?: { wsPath?: string; slideCount?: number; focus?: string }) =>
    ipcRenderer.invoke('ppt:generateFromWorkspace', opts),
  /** 列出内置主题清单（4 套） */
  listThemes: () => ipcRenderer.invoke('ppt:listThemes'),
  /** 纯代码生成 HTML 预览（不调 LLM，确定性输出，与 PPTX 视觉一致）—— 一键生成主推 */
  generatePreview: (payload: { themeId: string; outline: { title: string; slides: PreviewSlide[] }; design?: { palette?: { primary?: string; secondary?: string; accent?: string; background?: string }; fontFamily?: string; artDirection?: string } }) =>
    ipcRenderer.invoke('ppt:generatePreview', payload),
  /** 第 2 轮 LLM：把大纲 + 主题样式 → 渲染为完整 HTML 演示文稿 */
  renderTheme: (payload: {
    themeId: string;
    outline: { title: string; slides: { title: string; bullets: string[] }[] };
    extraInstruction?: string;
  }) => ipcRenderer.invoke('ppt:renderTheme', payload),
  /** 保存渲染好的 HTML 到指定路径 */
  saveHtml: (payload: { html: string; savePath: string }) =>
    ipcRenderer.invoke('ppt:saveHtml', payload),
  /** 导出 PDF：把渲染好的 HTML 转为 16:9 PDF 文件（savePath 缺省时弹保存对话框） */
  exportPdf: (payload: { html: string; savePath?: string; title?: string }) =>
    ipcRenderer.invoke('ppt:exportPdf', payload),
  /** 监听 PPT 渲染进度（render/audit/reflow/finalize 阶段） */
  onRenderProgress: (handler: (payload: { stage: string; current: number; total: number; message: string }) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: { stage: string; current: number; total: number; message: string }) => handler(payload);
    ipcRenderer.on('ppt:renderProgress', wrapped);
    return () => ipcRenderer.removeListener('ppt:renderProgress', wrapped);
  },
  /** 大纲细化扩写（单页） */
  expandSlide: (payload: {
    slide: { title: string; bullets: string[] };
    presentationTopic?: string;
    intensity?: 'light' | 'standard' | 'deep';
    extraInstruction?: string;
  }) => ipcRenderer.invoke('ppt:expandSlide', payload),
  /** 大纲细化扩写（全文） */
  expandAll: (payload: {
    outline: { title: string; slides: { title: string; bullets: string[] }[] };
    intensity?: 'light' | 'standard' | 'deep';
    extraInstruction?: string;
  }) => ipcRenderer.invoke('ppt:expandAll', payload),
  /** 监听全文扩写进度 */
  onExpandProgress: (handler: (payload: { current: number; total: number; message: string }) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: { current: number; total: number; message: string }) => handler(payload);
    ipcRenderer.on('ppt:expandProgress', wrapped);
    return () => ipcRenderer.removeListener('ppt:expandProgress', wrapped);
  },
  /** 场景清单（商务汇报/产品发布/项目提案/年度总结/培训课件/通用） */
  listScenarios: () => ipcRenderer.invoke('ppt:listScenarios'),
  /** 场景自动检测（LLM 分类 + 关键词兜底） */
  detectScenario: (topic: string) => ipcRenderer.invoke('ppt:detectScenario', topic),
  /** 读取品牌配置（Logo/企业色/字体/页脚） */
  getBrand: () => ipcRenderer.invoke('ppt:getBrand'),
  /** 保存品牌配置 */
  setBrand: (brand: unknown) => ipcRenderer.invoke('ppt:setBrand', brand),
};

// ===== PPT Master 原生 PPTX 流水线 API =====
// 产出 PowerPoint 原生可编辑对象（母版/版式/形状），替代旧 pptxgenjs 扁平导出
const pptMasterApi = {
  /** 环境自检：Python 版本 / 技能包完整性 / 依赖安装情况 */
  checkEnv: () => ipcRenderer.invoke('pptmaster:checkEnv'),
  /** 重新解析 Python（用户指定路径后） */
  rebindPython: (pythonPath?: string) => ipcRenderer.invoke('pptmaster:rebindPython', pythonPath),
  /** 安装缺失依赖（pip install -r requirements.txt） */
  installDeps: () => ipcRenderer.invoke('pptmaster:installDeps'),
  /** 生成原生 PPTX。进度通过 onProgress 订阅 */
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
  }) => ipcRenderer.invoke('pptmaster:generate', opts),
  /** 选择导出保存路径 */
  pickSavePath: (defaultName?: string) =>
    ipcRenderer.invoke('pptmaster:pickSavePath', defaultName),
  /** 列出已生成项目 */
  listProjects: () => ipcRenderer.invoke('pptmaster:listProjects'),
  /** 在系统文件管理器中打开项目目录 */
  openProjectDir: (projectPath: string) =>
    ipcRenderer.invoke('pptmaster:openProjectDir', projectPath),
  /** 列出技能包工作流与参考文档 */
  listCapabilities: () => ipcRenderer.invoke('pptmaster:listCapabilities'),
  /** 订阅生成进度 */
  onProgress: (cb: (p: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, p: unknown) => cb(p);
    ipcRenderer.on('pptmaster:progress', handler);
    return () => ipcRenderer.removeListener('pptmaster:progress', handler);
  },
  /** 订阅 pip 安装输出 */
  onInstallOutput: (cb: (line: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, line: string) => cb(line);
    ipcRenderer.on('pptmaster:installOutput', handler);
    return () => ipcRenderer.removeListener('pptmaster:installOutput', handler);
  },
};

// ===== 远程更新 API =====
const updateApi = {
  check: (mode: 'manual' | 'auto') => ipcRenderer.invoke('update:check', mode),
  download: (mode: 'manual' | 'auto') => ipcRenderer.invoke('update:download', mode),
  install: () => ipcRenderer.invoke('update:install'),
  cancel: () => ipcRenderer.invoke('update:cancel'),
  getStatus: () => ipcRenderer.invoke('update:getStatus'),
  getLogs: (limit?: number) => ipcRenderer.invoke('update:getLogs', limit),
  checkAnnouncement: () => ipcRenderer.invoke('update:checkAnnouncement'),
  getReleaseNotes: () => ipcRenderer.invoke('update:getReleaseNotes'),
  onStatus: (cb: (status: UpdateStatus) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: UpdateStatus) => cb(status);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
};

// ===== 历史统计看板 API（W18）=====
const statsApi = {
  /** 统计模型算出的整块看板（指标 / 趋势 / 分布 / 洞察） */
  dashboard: (filter: StatsQuery = {}) => ipcRenderer.invoke('stats:dashboard', filter),
  /** 历史记录明细（过滤 + 排序 + 分页） */
  sessions: (query: StatsQuery = {}) => ipcRenderer.invoke('stats:sessions', query),
  /** 导出当前筛选结果：csv = 明细表格，markdown = 完整报告（主进程弹保存框并写盘） */
  export: (query: StatsQuery = {}, format: 'csv' | 'markdown' = 'csv') =>
    ipcRenderer.invoke('stats:export', query, format),
};

// ===== 任务工作区 API（W19）=====
const taskApi = {
  /** 任务列表（含每个任务下的会话数、文件夹是否还在磁盘上） */
  list: () => ipcRenderer.invoke('task:list'),
  /** 新建任务：在指定父目录（默认「文档/CnkeIDE」）下建同名空文件夹，并登记索引 */
  create: (name: string, parentDir?: string) => ipcRenderer.invoke('task:create', name, parentDir),
  /** 在系统文件管理器里定位任务文件夹 */
  reveal: (workspacePath: string) => ipcRenderer.invoke('task:reveal', workspacePath),
  /** 重命名任务（同时改磁盘目录名，并迁移会话绑定） */
  rename: (id: string, newName: string) => ipcRenderer.invoke('task:rename', id, newName),
  /** 归档 / 取消归档（只动索引，不删文件夹） */
  archive: (id: string, archived: boolean = true) => ipcRenderer.invoke('task:archive', id, archived),
};

// ===== 工作区全文搜索（Ctrl+Shift+F）=====
const searchApi = {
  /** 在工作区里搜内容；query 默认按字面量匹配（不是正则） */
  content: (rootPath: string, query: string, opts?: any) =>
    ipcRenderer.invoke('search:content', rootPath, query, opts),
};

// 暴露到渲染进程
contextBridge.exposeInMainWorld('cnke', {
  window: windowApi,
  fs: fsApi,
  terminal: terminalApi,
  agent: agentApi,
  session: sessionApi,
  skills: skillApi,
  config: configApi,
  voice: voiceApi,
  completion: completionApi,
  memory: memoryApi,
  project: projectApi,
  mcp: mcpApi,
  dialog: dialogApi,
  shell: shellApi,
  toolApprove: toolApproveApi,
  path: pathApi,
  backend: backendApi,
  update: updateApi,
  notify: notifyApi,
  menu: menuApi,
  app: appApi,
  context: contextApi,
  checkpoint: checkpointApi,
  approval: approvalApi,
  sessionEx: sessionExApi,
  plan: planApi,
  ppt: pptApi,
  pptMaster: pptMasterApi,
  stats: statsApi,
  task: taskApi,
  search: searchApi,
});

// 类型导出（给渲染进程的 d.ts 用）
export {};
