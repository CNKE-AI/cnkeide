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
};

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

// ===== 远程更新 API =====
const updateApi = {
  check: (mode: 'manual' | 'auto') => ipcRenderer.invoke('update:check', mode),
  download: (mode: 'manual' | 'auto') => ipcRenderer.invoke('update:download', mode),
  install: () => ipcRenderer.invoke('update:install'),
  cancel: () => ipcRenderer.invoke('update:cancel'),
  getStatus: () => ipcRenderer.invoke('update:getStatus'),
  getLogs: (limit?: number) => ipcRenderer.invoke('update:getLogs', limit),
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
});

// 类型导出（给渲染进程的 d.ts 用）
export {};
