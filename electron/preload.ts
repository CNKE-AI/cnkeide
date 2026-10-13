import { contextBridge, ipcRenderer } from 'electron';
import path from 'node:path';

// ===== 窗口控制 API =====
const windowApi = {
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.sendSync('window:isMaximized'),
  onMaximizedChange: (cb: (maximized: boolean) => void) => {
    const handler = (_e: any, maximized: boolean) => cb(maximized);
    ipcRenderer.on('window:maximized-changed', handler);
    return () => ipcRenderer.removeListener('window:maximized-changed', handler);
  },
  /** 同步「AI 任务进行中」状态，主进程据此启用窗口保护（防误最小化/误关闭） */
  setAgentBusy: (busy: boolean) => ipcRenderer.send('window:set-agent-busy', busy),
  /** 订阅窗口保护提示（例如任务执行中尝试最小化被拦截） */
  onGuardNotice: (cb: (payload: { reason: string }) => void) => {
    const handler = (_e: any, payload: any) => cb(payload);
    ipcRenderer.on('window:guard-notice', handler);
    return () => ipcRenderer.removeListener('window:guard-notice', handler);
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
    const handler = (_e: any, payload: any) => cb(payload);
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
    const handler = (_e: any, data: any) => cb(data);
    ipcRenderer.on('terminal:output', handler);
    return () => ipcRenderer.removeListener('terminal:output', handler);
  },
  onExit: (cb: (data: { pid: number; code: number }) => void) => {
    const handler = (_e: any, data: any) => cb(data);
    ipcRenderer.on('terminal:exit', handler);
    return () => ipcRenderer.removeListener('terminal:exit', handler);
  },
};

// ===== Agent API =====
const agentApi = {
  run: (params: any) => ipcRenderer.invoke('agent:run', params),
  abort: (sessionId: string) => ipcRenderer.send('agent:abort', sessionId),
  enhancePrompt: (text: string) => ipcRenderer.invoke('agent:enhancePrompt', text),
  onEvent: (cb: (event: any) => void) => {
    const handler = (_e: any, event: any) => cb(event);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  onToolCall: (cb: (data: any) => void) => {
    const handler = (_e: any, data: any) => cb(data);
    ipcRenderer.on('agent:tool-call', handler);
    return () => ipcRenderer.removeListener('agent:tool-call', handler);
  },
  onToolResult: (cb: (data: any) => void) => {
    const handler = (_e: any, data: any) => cb(data);
    ipcRenderer.on('agent:tool-result', handler);
    return () => ipcRenderer.removeListener('agent:tool-result', handler);
  },
};

// ===== 会话 API =====
const sessionApi = {
  list: (workspaceId: string) => ipcRenderer.invoke('session:list', workspaceId),
  listAll: () => ipcRenderer.invoke('session:listAll'),
  load: (sessionId: string) => ipcRenderer.invoke('session:load', sessionId),
  save: (session: any) => ipcRenderer.invoke('session:save', session),
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
  set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
  getApiKeyConfigs: () => ipcRenderer.invoke('config:getApiKeyConfigs'),
  saveApiConfig: (config: any) => ipcRenderer.invoke('config:saveApiConfig', config),
  deleteApiConfig: (id: string) => ipcRenderer.invoke('config:deleteApiConfig', id),
  syncBuiltins: () => ipcRenderer.invoke('config:syncBuiltins'),
};

// ===== 本地记忆 API =====
const memoryApi = {
  list: () => ipcRenderer.invoke('memory:list'),
  add: (input: any) => ipcRenderer.invoke('memory:add', input),
  update: (id: string, patch: any) => ipcRenderer.invoke('memory:update', id, patch),
  delete: (id: string) => ipcRenderer.invoke('memory:delete', id),
  clear: () => ipcRenderer.invoke('memory:clear'),
};

// ===== MCP API =====
const mcpApi = {
  listServers: () => ipcRenderer.invoke('mcp:listServers'),
  addServer: (config: any) => ipcRenderer.invoke('mcp:addServer', config),
  removeServer: (id: string) => ipcRenderer.invoke('mcp:removeServer', id),
  toggleServer: (id: string, enabled: boolean) => ipcRenderer.invoke('mcp:toggleServer', id, enabled),
  listTools: (serverId: string) => ipcRenderer.invoke('mcp:listTools', serverId),
  refreshTools: (serverId: string) => ipcRenderer.invoke('mcp:refreshTools', serverId),
  callTool: (serverId: string, toolName: string, args: any) => ipcRenderer.invoke('mcp:callTool', serverId, toolName, args),
  onStatusChanged: (cb: (status: any) => void) => {
    const handler = (_e: any, status: any) => cb(status);
    ipcRenderer.on('mcp:status-changed', handler);
    return () => ipcRenderer.removeListener('mcp:status-changed', handler);
  },
};

// ===== 对话框 API =====
const dialogApi = {
  showOpenDialog: (opts?: any) => ipcRenderer.invoke('dialog:open'),
  showSaveDialog: (opts?: any) => ipcRenderer.invoke('dialog:save'),
  showMessageBox: (opts: any) => ipcRenderer.invoke('dialog:message', opts),
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
  addRule: (rule: any) => ipcRenderer.invoke('approval:addRule', rule),
  removeRule: (index: number) => ipcRenderer.invoke('approval:removeRule', index),
};

// ===== 会话导出 / 导入 / 上下文压缩 API =====
const sessionExApi = {
  export: (sessionId: string) => ipcRenderer.invoke('session:export', sessionId),
  import: (data: any) => ipcRenderer.invoke('session:import', data),
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
  onAnnouncement: (cb: (payload: { type: string; announcements?: any[]; serverTime?: number }) => void) => {
    const listener = (_e: any, payload: any) => cb(payload);
    ipcRenderer.on('backend:announcement-event', listener);
    return () => ipcRenderer.removeListener('backend:announcement-event', listener);
  },
  submitFeedback: (msg: string, contact?: string) => ipcRenderer.invoke('backend:submitFeedback', msg, contact),
  listFeedback: (since?: number) => ipcRenderer.invoke('backend:listFeedback', since || 0),
};

// ===== 工具确认 API =====
const toolApproveApi = {
  onRequest: (cb: (data: any) => void) => {
    const handler = (_e: any, data: any) => cb(data);
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
  generate: (req: any, savePath?: string) => ipcRenderer.invoke('ppt:generate', req, savePath),
  /** AI 生成 PPT 大纲（复用当前 active API + LLMProvider；场景化时按场景结构骨架组织） */
  generateOutline: (topic: string, slideCount?: number, scenarioId?: string) =>
    ipcRenderer.invoke('ppt:generateOutline', topic, slideCount, scenarioId),
  /** AI 自动生成原创视觉方案（配色、字体和风格），不使用外部模板。 */
  generateAiDesign: (payload: { topic?: string; scenarioName?: string; slides?: any[]; fallbackThemeId?: string }) =>
    ipcRenderer.invoke('ppt:generateAiDesign', payload),
  /** 扫描当前工作区内容摘要（目录结构 + README + 文档清单） */
  scanWorkspace: (wsPath?: string) => ipcRenderer.invoke('ppt:scanWorkspace', wsPath),
  /** 基于当前工作区代码/文档自动生成 PPT 大纲 */
  generateFromWorkspace: (opts?: { wsPath?: string; slideCount?: number; focus?: string }) =>
    ipcRenderer.invoke('ppt:generateFromWorkspace', opts),
  /** 列出内置主题清单（4 套） */
  listThemes: () => ipcRenderer.invoke('ppt:listThemes'),
  /** 纯代码生成 HTML 预览（不调 LLM，确定性输出，与 PPTX 视觉一致）—— 一键生成主推 */
  generatePreview: (payload: { themeId: string; outline: { title: string; slides: any[] }; design?: { palette?: { primary?: string; secondary?: string; accent?: string; background?: string }; fontFamily?: string; artDirection?: string } }) =>
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
    const wrapped = (_e: any, payload: any) => handler(payload);
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
    const wrapped = (_e: any, payload: any) => handler(payload);
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
  setBrand: (brand: any) => ipcRenderer.invoke('ppt:setBrand', brand),
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
  onProgress: (cb: (p: any) => void) => {
    const handler = (_e: any, p: any) => cb(p);
    ipcRenderer.on('pptmaster:progress', handler);
    return () => ipcRenderer.removeListener('pptmaster:progress', handler);
  },
  /** 订阅 pip 安装输出 */
  onInstallOutput: (cb: (line: string) => void) => {
    const handler = (_e: any, line: string) => cb(line);
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
  onStatus: (cb: (status: any) => void) => {
    const handler = (_e: any, status: any) => cb(status);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
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
  memory: memoryApi,
  mcp: mcpApi,
  dialog: dialogApi,
  shell: shellApi,
  toolApprove: toolApproveApi,
  path: pathApi,
  backend: backendApi,
  update: updateApi,
  notify: notifyApi,
  app: appApi,
  context: contextApi,
  checkpoint: checkpointApi,
  approval: approvalApi,
  sessionEx: sessionExApi,
  plan: planApi,
  ppt: pptApi,
  pptMaster: pptMasterApi,
});

// 类型导出（给渲染进程的 d.ts 用）
export {};
