import { ipcMain, BrowserWindow, shell, dialog, app } from 'electron';
import { ConfigAdapter } from '../adapter/ConfigAdapter';
import { FileSystemAdapter } from '../adapter/FileSystemAdapter';
import { TerminalAdapter } from '../adapter/TerminalAdapter';
import { StorageAdapter } from '../adapter/StorageAdapter';
import { WindowAdapter } from '../adapter/WindowAdapter';
import { SessionStore } from '../store/SessionStore';
import { McpHub } from '../core-fork/mcp/McpHub';
import { AgentManager } from '../core-fork/agent/AgentManager';
import { MemoryStore, MemoryItem, MemoryItemInput } from '../core-fork/memory/MemoryStore';
import { CheckpointManager } from '../core-fork/checkpoint/CheckpointManager';
import { CodebaseIndexer } from '../core-fork/codebase/CodebaseIndexer';
import { BackendAdapter } from '../adapter/BackendAdapter';
import { UpdateManager } from '../updater/UpdateManager';
import { PlanManager } from '../core-fork/plan/PlanManager';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function registerIpcHandlers(config: ConfigAdapter): { dispose: () => void } {
  // 官方后台客户端（远程配置 / 公告 / 反馈）
  const backendAdapter = new BackendAdapter(config);
  const fsAdapter = new FileSystemAdapter();
  const terminalAdapter = new TerminalAdapter();
  const storageAdapter = new StorageAdapter();
  const windowAdapter = new WindowAdapter();

  storageAdapter.init();

  const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  windowAdapter.setMainWindow(mainWindow ?? null);

  // 安全发送：窗口销毁后 webContents.send 会抛 "Object has been destroyed"，
  // 导致主进程崩溃（典型场景：关闭开发版时子进程 exit 事件仍被转发）。
  const sendToWindow = (channel: string, payload?: unknown): void => {
    try {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
      }
    } catch {
      // 窗口销毁竞态下静默忽略，避免主进程崩溃
    }
  };

  // 远程更新管理器（对接 https://ai.cnkes.cn/cnkeide/updates）
  const updateManager = new UpdateManager(config);
  updateManager.setMainWindow(mainWindow ?? null);

  // 静默后台自动检测更新（启动后延迟执行，避免影响启动性能；开发环境跳过）
  const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL;
  if (!isDev && updateManager.isAutoCheckEnabled()) {
    setTimeout(() => {
      void updateManager.checkForUpdates('auto').catch(() => {});
    }, updateManager.getAutoCheckDelay());
  }

  // 终端输出转发到渲染进程
  terminalAdapter.on('output', (data) => {
    sendToWindow('terminal:output', data);
  });
  terminalAdapter.on('exit', (data) => {
    sendToWindow('terminal:exit', data);
  });

  // 初始化会话存储
  const sessionStore = new SessionStore(storageAdapter, config);
  // 初始化 MCP Hub
  const mcpHub = new McpHub(config);
  // 连接状态变更推送到渲染进程
  mcpHub.onStatusChanged((status) => {
    sendToWindow('extension:status-changed', status);
  });
  // 启动恢复：自动拉起所有已启用的 MCP 服务器（后台执行，不阻塞窗口）
  void mcpHub.startEnabledServers().catch(() => {});
  const checkpointManager = new CheckpointManager();
  checkpointManager.init();
  // W3：任务规划状态机（注入 AgentManager，启用 plan_* 工具与计划引导）
  const planManager = new PlanManager();
  const codebaseIndexer = new CodebaseIndexer({ rootPath: config.getLastWorkspace() || process.cwd() });
  // 本地记忆存储：跨多次模型调用持久化上下文（偏好/项目事实/对话摘要）
  const memoryStore = new MemoryStore(storageAdapter);
  void memoryStore.warmUp();
  const agentManager = new AgentManager({ config, fsAdapter, terminalAdapter, mcpHub, windowAdapter, checkpointManager, codebaseIndexer, memoryStore, planManager });

  // ===== 文件系统 IPC =====
  ipcMain.handle('fs:openFolder', async () => {
    const result = await windowAdapter.showOpenFolder();
    if (result) {
      config.setLastWorkspace(result);
      // 立即落盘，避免 scheduleWrite 的 300ms 延迟期间用户关闭/崩溃导致工作区配置丢失
      await config.flush();
      codebaseIndexer.setRootPath(result);
    }
    return result;
  });

  ipcMain.handle('fs:readFile', async (_e, filePath: string) => {
    return fsAdapter.readFile(filePath);
  });

  ipcMain.handle('fs:writeFile', async (_e, filePath: string, content: string) => {
    return fsAdapter.writeFile(filePath, content);
  });

  ipcMain.handle('fs:listDir', async (_e, dirPath: string) => {
    return fsAdapter.listDir(dirPath);
  });

  ipcMain.handle('fs:createFile', async (_e, filePath: string, content?: string) => {
    return fsAdapter.createFile(filePath, content || '');
  });

  ipcMain.handle('fs:createDir', async (_e, dirPath: string) => {
    return fsAdapter.createDir(dirPath);
  });

  ipcMain.handle('fs:deletePath', async (_e, filePath: string) => {
    return fsAdapter.deletePath(filePath);
  });

  ipcMain.handle('fs:renamePath', async (_e, oldPath: string, newPath: string) => {
    return fsAdapter.renamePath(oldPath, newPath);
  });

  ipcMain.handle('fs:exists', async (_e, filePath: string) => {
    return fsAdapter.exists(filePath);
  });

  ipcMain.handle('fs:searchFiles', async (_e, rootPath: string, pattern: string) => {
    return fsAdapter.searchFiles(rootPath, pattern);
  });

  // ===== 终端 IPC =====
  ipcMain.handle('terminal:spawn', async (_e, cmd: string, args: string[], cwd: string) => {
    return terminalAdapter.spawn(cmd, args, cwd);
  });

  ipcMain.on('terminal:write', (_e, pid: number, data: string) => {
    terminalAdapter.write(pid, data);
  });

  ipcMain.on('terminal:resize', (_e, pid: number, cols: number, rows: number) => {
    terminalAdapter.resize(pid, cols, rows);
  });

  ipcMain.on('terminal:kill', (_e, pid: number) => {
    terminalAdapter.kill(pid);
  });

  // ===== Agent IPC =====
  ipcMain.handle('agent:run', async (_e, params: any) => {
    return agentManager.run(params, (event) => {
      sendToWindow('agent:event', event);
    });
  });

  ipcMain.on('agent:abort', (_e, sessionId: string) => {
    agentManager.abort(sessionId);
  });

  ipcMain.handle('agent:enhancePrompt', async (_e, text: string) => {
    return agentManager.enhancePrompt(text);
  });

  // 工具调用确认
  ipcMain.on('tool:approve-response', (_e, requestId: string, approved: boolean) => {
    agentManager.resolveToolApproval(requestId, approved);
  });

  // ===== Plan 事件转发（W3）：PlanManager 状态变化实时推送到前端 =====
  planManager.on((planEvent) => {
    sendToWindow('agent:event', { type: 'plan', data: planEvent });
  });

  // ===== 本地记忆 IPC =====
  ipcMain.handle('memory:list', async (): Promise<MemoryItem[]> => {
    return memoryStore.list();
  });

  ipcMain.handle('memory:add', async (_e, input: MemoryItemInput): Promise<{ success: boolean; item?: MemoryItem; error?: string }> => {
    return memoryStore.add(input || { content: '' });
  });

  ipcMain.handle('memory:update', async (_e, id: string, patch: Partial<MemoryItemInput>): Promise<{ success: boolean; item?: MemoryItem; error?: string }> => {
    if (!id) return { success: false, error: '缺少记忆 id' };
    return memoryStore.update(id, patch || {});
  });

  ipcMain.handle('memory:delete', async (_e, id: string): Promise<{ success: boolean; error?: string }> => {
    if (!id) return { success: false, error: '缺少记忆 id' };
    return memoryStore.remove(id);
  });

  ipcMain.handle('memory:clear', async (): Promise<{ success: boolean; error?: string }> => {
    return memoryStore.clear();
  });

  // ===== 会话 IPC =====
  ipcMain.handle('session:list', async (_e, workspaceId: string) => {
    return sessionStore.listByWorkspace(workspaceId);
  });

  // 全局会话列表（跨工作区，每个对话可绑定不同工作区）
  ipcMain.handle('session:listAll', async () => {
    return sessionStore.listAll();
  });

  ipcMain.handle('session:load', async (_e, sessionId: string) => {
    return sessionStore.load(sessionId);
  });

  ipcMain.handle('session:save', async (_e, session: any) => {
    return sessionStore.save(session);
  });

  ipcMain.handle('session:delete', async (_e, sessionId: string) => {
    return sessionStore.delete(sessionId);
  });

  ipcMain.handle('session:create', async (_e, workspaceId: string, title?: string) => {
    return sessionStore.create(workspaceId, title);
  });

  // ===== 会话导出 / 导入 / 上下文压缩 / 单条删除 =====
  ipcMain.handle('session:export', async (_e, sessionId: string) => {
    const session = await sessionStore.load(sessionId);
    if (!session) return { success: false, error: '会话不存在' };
    return { success: true, data: session };
  });

  ipcMain.handle('session:import', async (_e, data: any) => {
    try {
      if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) {
        return { success: false, error: '无效的会话数据' };
      }
      // 生成新 id，避免与现有会话冲突
      const imported = { ...data, id: data.id || randomUUID() };
      await sessionStore.save(imported);
      return { success: true, session: imported };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 上下文压缩：用 LLM 摘要替换早期历史，保留最近 N 轮
  ipcMain.handle('session:summarize', async (_e, sessionId: string) => {
    try {
      const session = await sessionStore.load(sessionId);
      if (!session) return { success: false, error: '会话不存在' };
      const summary = await agentManager.summarizeContext(sessionId, session.messages);
      return { success: true, summary };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 单步回滚：删除指定消息及其之后的所有消息
  ipcMain.handle('session:deleteMessage', async (_e, sessionId: string, messageId: string) => {
    try {
      const session = await sessionStore.load(sessionId);
      if (!session) return { success: false, error: '会话不存在' };
      const idx = session.messages.findIndex((m: any) => m.id === messageId);
      if (idx === -1) return { success: false, error: '消息不存在' };
      session.messages = session.messages.slice(0, idx);
      await sessionStore.save(session);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ===== Plan 查询（W3）：读取当前会话的计划状态 =====
  ipcMain.handle('plan:get', async (_e, sessionId: string) => {
    const plan = planManager.getPlan(sessionId);
    const progress = planManager.progress(sessionId);
    return { plan, progress };
  });

  // ===== 配置 IPC =====
  ipcMain.handle('config:get', async (_e, key: string) => {
    return config.get(key);
  });

  ipcMain.handle('config:set', async (_e, key: string, value: any) => {
    config.set(key, value);
    await config.flush();
  });

  ipcMain.handle('config:getApiKeyConfigs', async () => {
    return config.getApiKeyConfigs();
  });

  ipcMain.handle('config:saveApiConfig', async (_e, apiConfig: any) => {
    return config.saveApiConfig(apiConfig);
  });

  ipcMain.handle('config:deleteApiConfig', async (_e, id: string) => {
    return config.deleteApiConfig(id);
  });

  // 同步官方内置 API 到本地配置（强一致：下线即删除、字段强制刷新；用户自定义配置不动）
  ipcMain.handle('config:syncBuiltins', async () => {
    const res = await backendAdapter.getBuiltins();
    // 空列表视为后端异常，不执行同步（mergeBuiltinApis 内部亦有同款防御），
    // 防止误删全部官方模型 + 清空 activeApiConfigId 导致切换模型静默失效
    if (!res.success || !Array.isArray(res.builtins) || res.builtins.length === 0) {
      return { success: false, added: 0, updated: 0, removed: 0, error: res.error || '无内置 API' };
    }
    const stats = config.mergeBuiltinApis(res.builtins);
    return { success: true, ...stats };
  });

  // ===== MCP IPC =====
  ipcMain.handle('mcp:listServers', async () => {
    return mcpHub.listServersWithStatus();
  });

  ipcMain.handle('mcp:addServer', async (_e, serverConfig: any) => {
    return mcpHub.addServer(serverConfig);
  });

  ipcMain.handle('mcp:removeServer', async (_e, id: string) => {
    return mcpHub.removeServer(id);
  });

  ipcMain.handle('mcp:toggleServer', async (_e, id: string, enabled: boolean) => {
    return mcpHub.toggleServer(id, enabled);
  });

  ipcMain.handle('mcp:listTools', async (_e, serverId: string) => {
    return mcpHub.listTools(serverId);
  });

  ipcMain.handle('mcp:refreshTools', async (_e, serverId: string) => {
    return mcpHub.refreshTools(serverId);
  });

  ipcMain.handle('mcp:callTool', async (_e, serverId: string, toolName: string, args: any) => {
    return mcpHub.callTool(serverId, toolName, args);
  });

  // ===== checkpoint rollback IPC =====
  ipcMain.handle('checkpoint:listSnapshots', async (_e, sessionId: string) => {
    return checkpointManager.listSnapshots(sessionId);
  });

  ipcMain.handle('checkpoint:restore', async (_e, snapshotId: string) => {
    const ok = await checkpointManager.restoreSnapshot(snapshotId);
    return { success: ok, snapshotId };
  });

  // W7：单条快照查询
  ipcMain.handle('checkpoint:getSnapshot', async (_e, snapshotId: string) => {
    return checkpointManager.getSnapshot(snapshotId);
  });

  // W7：快照 diff 视图（与当前文件对比）
  ipcMain.handle('checkpoint:diffSnapshot', async (_e, snapshotId: string) => {
    return checkpointManager.diffSnapshot(snapshotId);
  });

  ipcMain.handle('checkpoint:getModifiedFiles', async () => {
    return agentManager.getModifiedFiles();
  });

  // ===== W7 工具审批规则 =====
  ipcMain.handle('approval:listRules', async () => {
    return agentManager.listApprovalRules();
  });

  ipcMain.handle('approval:addRule', async (_e, rule: any) => {
    agentManager.addApprovalRule(rule);
    return { success: true };
  });

  ipcMain.handle('approval:removeRule', async (_e, index: number) => {
    return { success: agentManager.removeApprovalRule(index) };
  });

  // ===== W11 上下文状态 =====
  ipcMain.handle('context:getState', async (_e, sessionId: string) => {
    return agentManager.getContextState(sessionId);
  });

  ipcMain.handle('context:listStates', async () => {
    return agentManager.listContextStates();
  });

  ipcMain.handle('context:removeState', async (_e, sessionId: string) => {
    agentManager.removeContextState(sessionId);
    return { success: true };
  });

  // ===== 对话框 IPC =====
  ipcMain.handle('dialog:open', async (_e, opts?: any) => {
    return windowAdapter.showOpenFolder();
  });

  ipcMain.handle('dialog:save', async (_e, opts?: any) => {
    return windowAdapter.showSaveDialog(opts?.defaultName, opts?.filters);
  });

  ipcMain.handle('dialog:message', async (_e, opts: any) => {
    return dialog.showMessageBox(opts);
  });

  // ===== Shell IPC =====
  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    return windowAdapter.openExternal(url);
  });

  ipcMain.handle('shell:openPath', async (_e, targetPath: string) => {
    return windowAdapter.openPath(targetPath);
  });

  // ===== 官方后台 IPC（远程配置 / 公告 / 反馈）=====
  ipcMain.handle('backend:ping', async () => {
    return backendAdapter.ping();
  });

  // ===== App 元信息（版本/平台）=====
  ipcMain.handle('app:getVersion', async () => {
    return app.getVersion();
  });

  ipcMain.handle('app:getPlatform', async () => {
    return process.platform;
  });

  ipcMain.handle('backend:getDeviceId', async () => {
    return backendAdapter.getDeviceId();
  });

  ipcMain.handle('backend:getBuiltins', async () => {
    return backendAdapter.getBuiltins();
  });

  ipcMain.handle('backend:getAnnouncements', async () => {
    return backendAdapter.getAnnouncements();
  });

  // 公告 SSE 实时推送订阅：渲染层发起订阅，主进程建立长连接，
  // 收到公告变化后通过 'backend:announcement-event' 通道推送到渲染层。
  let unsubscribeAnnouncements: (() => void) | null = null;
  ipcMain.handle('backend:subscribeAnnouncements', async () => {
    if (unsubscribeAnnouncements) {
      // 已订阅则幂等返回（避免重复建连）
      return { success: true };
    }
    try {
      unsubscribeAnnouncements = backendAdapter.subscribeAnnouncements((evt) => {
        if (evt.type === 'announcements') {
          sendToWindow('backend:announcement-event', {
            type: 'announcements',
            announcements: evt.announcements || [],
            serverTime: evt.serverTime,
          });
        }
        // disconnect 事件仅内部用于重连，不需要推送给渲染层
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || '订阅失败' };
    }
  });

  ipcMain.handle('backend:submitFeedback', async (_e, msg: string, contact?: string) => {
    return backendAdapter.submitFeedback(msg, contact);
  });

  ipcMain.handle('backend:listFeedback', async (_e, since?: number) => {
    return backendAdapter.listFeedback(since || 0);
  });

  // ===== 远程更新 IPC =====
  ipcMain.handle('update:check', async (_e, mode: 'manual' | 'auto') => {
    return updateManager.checkForUpdates(mode || 'manual');
  });

  ipcMain.handle('update:download', async (_e, mode: 'manual' | 'auto') => {
    return updateManager.downloadAndInstall(mode || 'manual');
  });

  ipcMain.handle('update:install', async () => {
    return updateManager.installNow();
  });

  ipcMain.handle('update:cancel', async () => {
    updateManager.cancel();
    return { success: true };
  });

  ipcMain.handle('update:getStatus', async () => {
    return updateManager.getStatus();
  });

  ipcMain.handle('update:getLogs', async (_e, limit?: number) => {
    return updateManager.getUpdateLogs(limit || 100);
  });

  // 返回应用退出时的清理函数
  return {
    dispose: () => {
      mcpHub.dispose();
      terminalAdapter.dispose?.();
      // 落盘尚未持久化的记忆变更
      void memoryStore.flushNow().catch(() => {});
      // 落盘更新日志并清理 autoUpdater 监听
      void updateManager.dispose();
      // 断开公告 SSE 长连接
      try { unsubscribeAnnouncements?.(); } catch {}
    },
  };
}
