import { ipcMain, BrowserWindow, shell, dialog, app } from 'electron';
import * as voiceEngine from '../voice/VoiceEngine';
import type { VoiceStatus } from '../voice/VoiceEngine';
import { ConfigAdapter } from '../adapter/ConfigAdapter';
import { FileSystemAdapter } from '../adapter/FileSystemAdapter';
import { TerminalAdapter } from '../adapter/TerminalAdapter';
import { StorageAdapter } from '../adapter/StorageAdapter';
import { WindowAdapter } from '../adapter/WindowAdapter';
import { SessionStore } from '../store/SessionStore';
import { McpHub } from '../core-fork/mcp/McpHub';
import { McpCatalogService } from '../core-fork/mcp/McpCatalogService';
import { AgentManager } from '../core-fork/agent/AgentManager';
import { loadProjectInstructions, createInstructionTemplate, DEFAULT_INSTRUCTION_FILES } from '../core-fork/agent/ProjectInstructions';
import { MemoryStore, MemoryItem, MemoryItemInput } from '../core-fork/memory/MemoryStore';
import { CheckpointManager } from '../core-fork/checkpoint/CheckpointManager';
import { CodebaseIndexer } from '../core-fork/codebase/CodebaseIndexer';
import { BackendAdapter } from '../adapter/BackendAdapter';
import { WorkspaceWatcher } from '../adapter/WorkspaceWatcher';
import type { WorkspaceChange } from '../adapter/WorkspaceWatcher';
import type { DirEntry } from '../adapter/FileSystemAdapter';
import type { ChatSession } from '../store/SessionStore';
import type { RunParams } from '../core-fork/agent/AgentManager';
import type { McpServerConfig } from '../core-fork/mcp/McpHub';
import type { McpCatalogEntry } from '../core-fork/mcp/McpCatalogService';
import type { ApprovalRule } from '../core-fork/checkpoint/ApprovalPolicy';
import type { PptxCreateRequest } from '../core-fork/tools/PptxTools';
import type { AiPptSlideHint } from '../core-fork/ppt/pptDesign';
import type { PreviewSlide } from '../core-fork/ppt/pptPreview';
import { UpdateManager } from '../updater/UpdateManager';
import { PlanManager } from '../core-fork/plan/PlanManager';
import { RagManager } from '../core-fork/rag/RagManager';
import { LLMProvider } from '../core-fork/llm/LLMProvider';
import { InlineCompletionService } from '../core-fork/completion/InlineCompletionService';
import type { InlineCompletionRequest } from '../core-fork/completion/InlineCompletionService';
import { createPptxAdapter, PptxAdapter } from '../core-fork/tools/PptxTools';
import { renderOutlineToHtml } from '../core-fork/ppt/pptRenderer';
import { PPT_THEMES, findTheme } from '../core-fork/ppt/pptThemes';
import { exportHtmlToPdf } from '../core-fork/ppt/pptPdf';
import { expandSlide, expandAll } from '../core-fork/ppt/pptOutlineExpand';
import { generatePreviewHtml } from '../core-fork/ppt/pptPreview';
import { PPT_SCENARIOS, getScenario, detectScenarioByKeyword, detectScenarioByLlm, buildScenarioOutlinePrompt, buildGenericOutlinePrompt } from '../core-fork/ppt/pptScenarios';
import { DEFAULT_BRAND, normalizeBrand, PptBrand } from '../core-fork/ppt/pptBrand';
import { buildAiPptDesignPrompt, normalizeAiPptDesign } from '../core-fork/ppt/pptDesign';
import { buildDashboard } from '../core-fork/analytics/StatsModel';
import { filterRows, filterSessions, paginate, sessionRows, sortRows, workspaceOptions, NO_WORKSPACE_ID } from '../core-fork/analytics/HistoryStats';
import { buildCsvReport, buildMarkdownReport, suggestFileName } from '../core-fork/analytics/ReportExport';
import type { StatsQuery } from '../core-fork/analytics/HistoryStats';
import { createTaskWorkspace, renameTaskWorkspace, retryWhileBusy, taskWorkspaceExists } from '../core-fork/tasks/TaskWorkspace';
import { searchContent } from '../core-fork/search/ContentSearch';
import { resolveTaskRootDir } from '../util/paths';
import { auditOutline, summarizeIssues, AuditIssue } from '../core-fork/ppt/pptAudit';
import type { AuditOutlineInput } from '../core-fork/ppt/pptAudit';
import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getPptMasterService,
  getSkillRunner,
  getSkillRootCandidate,
  getProjectsRoot,
  rebindPython,
  PptMasterService,
} from '../core-fork/pptmaster';
import { installDependencies } from '../core-fork/pptmaster';
import { SkillRegistry } from '../core-fork/skills/SkillRegistry';

/** 未配置模型或模型不可用时的本地保底大纲，保证 PPT 基础导出可用。 */
function buildFallbackPptOutline(topic: string, slideCount: number) {
  const title = String(topic || '演示文稿').trim() || '演示文稿';
  const sections = [
    ['封面', [`${title}`, '核心观点与行动方案']],
    ['背景与目标', [`说明「${title}」的业务背景与当前需求`, '明确本次沟通的目标、范围与成功标准', '聚焦最需要优先解决的问题']],
    ['现状与挑战', ['梳理现有流程、资源与关键约束', '识别影响推进效率的主要风险', '确定需要优先验证的假设']],
    ['核心方案', [`围绕「${title}」提出可执行的解决思路`, '将方案拆分为清晰的工作模块', '明确每个模块的产出与责任边界']],
    ['实施路径', ['按阶段安排调研、试点与推广', '为关键节点设置验收与复盘机制', '根据反馈及时调整优先级']],
    ['资源与协作', ['明确所需人员、时间与工具支持', '建立跨团队沟通和决策机制', '提前协调依赖事项与交付节奏']],
    ['风险与应对', ['持续跟踪范围、进度与质量风险', '为关键风险准备替代方案', '定期同步问题与处理进展']],
    ['预期成果', ['形成可复用的方法与交付物', '提升协作效率与过程可见性', '沉淀后续迭代所需的反馈数据']],
    ['下一步计划', ['确认负责人和近期行动项', '制定首个里程碑与复盘时间', '根据执行结果持续优化方案']],
  ];
  const slides = Array.from({ length: Math.max(1, slideCount) }, (_, index) => {
    const section = sections[Math.min(index, sections.length - 1)];
    return { title: section[0], bullets: section[1] };
  });
  return { title, slides };
}

export function registerIpcHandlers(config: ConfigAdapter): { dispose: () => void } {
  // 官方后台客户端（远程配置 / 公告 / 反馈）
  const backendAdapter = new BackendAdapter(config);
  const fsAdapter = new FileSystemAdapter();
  const terminalAdapter = new TerminalAdapter();
  const storageAdapter = new StorageAdapter();
  const windowAdapter = new WindowAdapter();
  // 工作区文件监听：变更广播到渲染层，驱动资源管理器/编辑器/终端三视图同步
  const workspaceWatcher = new WorkspaceWatcher();

  void storageAdapter.init();

  const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  windowAdapter.setMainWindow(mainWindow ?? null);

  // 安全发送：窗口销毁后 webContents.send 会抛 "Object has been destroyed"，
  // 导致主进程崩溃（典型场景：关闭开发版时子进程 exit 事件仍被转发）。
  // 同时动态解析目标窗口：上方捕获的 mainWindow 引用在窗口销毁重建后会失效
  // （托盘唤起 / macOS activate 重建窗口），发往旧窗口会导致新窗口收不到任何推送
  // （终端无输出、AI 无流式事件、审批弹窗不出现）。每次发送时按 URL 排除 PPT
  // 独立窗口，动态取当前主窗口；无可用窗口时静默跳过。
  const sendToWindow = (channel: string, payload?: unknown): void => {
    try {
      const isMainWindow = (w: BrowserWindow) => {
        try {
          return !w.webContents.getURL().includes('ppt.html');
        } catch {
          return true;
        }
      };
      const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
      const win =
        (mainWindow && !mainWindow.isDestroyed() && isMainWindow(mainWindow) ? mainWindow : undefined) ||
        all.find((w) => isMainWindow(w)) ||
        all[0];
      if (win && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    } catch {
      // 窗口销毁竞态下静默忽略，避免主进程崩溃
    }
  };

  // 远程更新管理器（对接 https://ai.cnkes.cn/cnkeide/updates）
  const updateManager = new UpdateManager(config);
  updateManager.setMainWindow(mainWindow ?? null);

  // 静默暗更循环（启动后延迟首检 + 每 4h 周期复检；开发环境跳过）
  const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL;
  if (!isDev) {
    updateManager.startAutoCheckLoop();
  }

  // 终端输出转发到渲染进程
  terminalAdapter.on('output', (data) => {
    sendToWindow('terminal:output', data);
  });
  terminalAdapter.on('exit', (data) => {
    sendToWindow('terminal:exit', data);
  });

  // 工作区文件变更 → 批量广播到渲染进程（fs:changed）
  workspaceWatcher.on('changes', (payload: { root: string; changes: WorkspaceChange[] }) => {
    sendToWindow('fs:changed', payload);
  });
  // 启动时自动恢复上次工作区的监听
  {
    const lastWs = config.getLastWorkspace();
    if (lastWs && existsSync(lastWs)) workspaceWatcher.watch(lastWs);
  }

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
  void checkpointManager.init();
  // W3：任务规划状态机（注入 AgentManager，启用 plan_* 工具与计划引导）
  const planManager = new PlanManager();
  // RAG 索引在整个应用生命周期内复用，避免每轮 Agent 会话丢失已导入文档。
  const ragManager = new RagManager();
  const codebaseIndexer = new CodebaseIndexer({ rootPath: config.getLastWorkspace() || process.cwd() });
  // 本地记忆存储：跨多次模型调用持久化上下文（偏好/项目事实/对话摘要）
  const memoryStore = new MemoryStore(storageAdapter);
  void memoryStore.warmUp();
  // 技能扫描是只读操作：只检查候选 skills 目录的直接子目录及其 SKILL.md。
  const skillRegistry = new SkillRegistry();
  void skillRegistry.scan();
  const agentManager = new AgentManager({ config, fsAdapter, terminalAdapter, mcpHub, windowAdapter, checkpointManager, codebaseIndexer, memoryStore, planManager, ragManager, skillRegistry });

  // ===== 文件系统 IPC =====
  ipcMain.handle('fs:openFolder', async () => {
    const result = await windowAdapter.showOpenFolder();
    if (result) {
      config.setLastWorkspace(result);
      // 立即落盘，避免 scheduleWrite 的 300ms 延迟期间用户关闭/崩溃导致工作区配置丢失
      await config.flush();
      codebaseIndexer.setRootPath(result);
      // 切换文件监听到新工作区（内部会自动释放旧监听）
      workspaceWatcher.watch(result);
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

  // 工作区全文搜索（Ctrl+Shift+F）：字面量匹配 + 目录/大文件/耗时三重保护
  ipcMain.handle('search:content', async (_e, rootPath: string, query: string, opts: any = {}) => {
    try {
      const res = await searchContent(rootPath, query, opts || {});
      return res.error ? { success: false, error: res.error } : { success: true, data: res };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 切换监听的工作区根目录（打开/切换文件夹时调用）
  ipcMain.handle('fs:watchWorkspace', (_e, rootPath: string) => {
    return workspaceWatcher.watch(rootPath);
  });

  ipcMain.handle('fs:unwatchWorkspace', () => {
    workspaceWatcher.unwatch();
    return { success: true };
  });

  ipcMain.handle('fs:watchStatus', () => {
    return { watching: workspaceWatcher.watching, root: workspaceWatcher.root };
  });

  // ===== 终端 IPC =====
  ipcMain.handle('terminal:spawn', (_e, cmd: string, args: string[], cwd: string) => {
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
  // 测试专用通道（仅 CNKE_FLOOD_TEST=1 注册）：向渲染层重放 agent 事件，
  // 供白屏回归实测（scripts/test_flood_ui.mjs）驱动真实渲染链路。产品环境不注册。
  if (process.env.CNKE_FLOOD_TEST === '1') {
    ipcMain.handle('agent:testPushEvent', (_e, event: unknown) => {
      sendToWindow('agent:event', event);
      return true;
    });
  }
  ipcMain.handle('agent:run', async (_e, params: RunParams) => {
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

  // ===== 语音输入（内置离线识别，详见 voice/VoiceEngine.ts）=====
  ipcMain.handle('voice:status', async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const onProgress = (s: VoiceStatus) => {
      if (win && !win.isDestroyed()) win.webContents.send('voice:status', s);
    };
    return voiceEngine.getStatus(onProgress);
  });
  ipcMain.on('voice:feed', (_e, samples: number[]) => {
    try {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      const r = voiceEngine.feedAudio(Float32Array.from(samples));
      if (!win) return;
      if (r.final) win.webContents.send('voice:text', { text: r.final, final: true });
      else if (r.partial) win.webContents.send('voice:text', { text: r.partial, final: false });
    } catch {
      /* 单帧解码异常不中断听写会话 */
    }
  });
  ipcMain.handle('voice:finalize', () => voiceEngine.finalizeAudio());
  ipcMain.on('voice:reset', () => voiceEngine.resetSession());

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

  // ===== 仓库级指令文件 IPC（W24：AGENTS.md / CNKE.md）=====
  // 面板打开时列出「这次对话到底会注入哪些约定」，避免用户不知道 AI 读了什么。
  ipcMain.handle('project:instructions', async (_e, rootPath?: string) => {
    const root = typeof rootPath === 'string' ? rootPath.trim() : '';
    if (!root) {
      return { success: false, error: '未打开工作区', files: [], skipped: [], totalBytes: 0, block: '' };
    }
    const budget = config.get<number>('agentConfig.projectInstructionsBudget', 24000);
    // 这是显式的用户动作（打开面板/点刷新），绕过扫描缓存，保证看到的是磁盘最新内容
    const result = await loadProjectInstructions({ root, maxTotalBytes: budget, useCache: false });
    return { success: true, ...result };
  });

  ipcMain.handle('project:createInstruction', async (_e, rootPath?: string, fileName?: string) => {
    const root = typeof rootPath === 'string' ? rootPath.trim() : '';
    if (!root) return { success: false, error: '未打开工作区' };
    return createInstructionTemplate(root, fileName || DEFAULT_INSTRUCTION_FILES[0]);
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

  ipcMain.handle('session:save', async (_e, session: ChatSession) => {
    return sessionStore.save(session);
  });

  ipcMain.handle('session:delete', async (_e, sessionId: string) => {
    // 会话删除时必须同步释放其 plan。
    // PlanManager.plans 以 sessionId 为 key 且此前没有清理入口，
    // 已删除会话的计划会一直驻留内存（app 生命周期内不释放）。
    planManager.clear(sessionId);
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

  ipcMain.handle('session:import', async (_e, data: ChatSession) => {
    try {
      if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) {
        return { success: false, error: '无效的会话数据' };
      }
      // id 冲突处理：导入数据自带 id 且已存在同 id 会话时，生成新 id，
      // 避免静默覆盖现有会话（原实现复用 id 会直接替换掉既有内容且无任何提示）
      let importId = data.id || randomUUID();
      if (data.id && (await sessionStore.load(data.id))) {
        importId = randomUUID();
      }
      const imported = { ...data, id: importId };
      await sessionStore.save(imported);
      return { success: true, session: imported };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 上下文压缩：用 LLM 摘要替换早期历史，保留最近 N 轮
  ipcMain.handle('session:summarize', async (_e, sessionId: string) => {
    try {
      const session = await sessionStore.load(sessionId);
      if (!session) return { success: false, error: '会话不存在' };
      const summary = await agentManager.summarizeContext(sessionId, session.messages);
      return { success: true, summary };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ===== 历史统计看板 IPC（W18）=====
  // 统计模型放在主进程算：历史会话可能上千条、消息上万条，
  // 全部搬到渲染层聚合会阻塞 UI（与之前 sessionDb 同步写盘卡界面同类问题）。
  ipcMain.handle('stats:dashboard', async (_e, filter: StatsQuery = {}) => {
    try {
      const sessions = await sessionStore.listAll();
      return { success: true, data: buildDashboard(sessions, filter) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 历史记录列表：关键词/工作区/时间范围过滤 + 排序 + 分页，全部在主进程完成
  ipcMain.handle('stats:sessions', async (_e, query: StatsQuery = {}) => {
    try {
      const all = await sessionStore.listAll();
      const scoped = filterSessions(all, query);
      const rows = sortRows(filterRows(sessionRows(scoped), query), query.sortBy);
      const paged = paginate(rows, query.page, query.pageSize);
      // 工作区下拉的数字要跟"选中后能看到多少条"一致：按时间范围+关键词筛选后再计数，
      // 但**不能**再套一层工作区过滤，否则选中一个工作区后其它选项就消失了。
      const withinRange = filterSessions(all, { range: query.range, keyword: query.keyword });
      return { success: true, data: { ...paged, workspaces: workspaceOptions(withinRange) } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 导出：把当前筛选条件对应的看板 + 明细落盘
  // 前端只传筛选条件和格式，聚合、拼装、选路径、写文件全在主进程完成，
  // 避免把可能上千行的明细先搬到渲染层再传回来。
  ipcMain.handle('stats:export', async (_e, query: StatsQuery = {}, format: 'csv' | 'markdown' = 'csv') => {
    try {
      const all = await sessionStore.listAll();
      const scoped = filterSessions(all, query);
      // 导出用**全量**明细（不分页）：用户导出就是为了拿到完整数据
      const rows = sortRows(filterRows(sessionRows(scoped), query), query.sortBy);
      const dashboard = buildDashboard(all, query);

      const ws = query.workspaceId;
      const workspaceLabel =
        !ws || ws === 'all'
          ? '全部工作区'
          : ws === NO_WORKSPACE_ID
            ? '未归属工作区'
            : path.basename(ws);

      const meta = {
        range: query.range,
        workspaceLabel,
        keyword: query.keyword || '',
        generatedAt: dashboard.generatedAt,
      };

      const content =
        format === 'csv' ? buildCsvReport(rows, meta) : buildMarkdownReport(dashboard, rows, meta);

      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0];
      const opts = {
        title: format === 'csv' ? '导出统计明细（CSV）' : '导出统计报告（Markdown）',
        defaultPath: path.join(app.getPath('documents'), suggestFileName(format)),
        filters:
          format === 'csv'
            ? [{ name: 'CSV 表格', extensions: ['csv'] }]
            : [{ name: 'Markdown 文档', extensions: ['md'] }],
      };
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) return { success: true, data: { canceled: true } };

      await fsp.writeFile(res.filePath, content, 'utf8');
      return {
        success: true,
        data: {
          canceled: false,
          filePath: res.filePath,
          bytes: Buffer.byteLength(content, 'utf8'),
          rows: rows.length,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ===== 任务工作区 IPC（W19）=====
  // 「新建任务 = 建一个同名空文件夹 + 建一条绑定该工作区的会话」，
  // 与 TRAE 的交互一致：任务在侧边栏可见，点开即切到对应文件夹。
  // 关联主键就是绝对路径本身（与 session.workspaceId 同一语义），
  // 所以任务 / 会话 / 统计看板的工作区下拉三处天然对齐，不需要额外映射表。
  const TASK_COLLECTION = 'tasks';

  ipcMain.handle('task:list', async () => {
    try {
      const [records, sessions] = await Promise.all([
        storageAdapter.getAll<any>(TASK_COLLECTION),
        sessionStore.listAll(),
      ]);
      const counts = new Map<string, number>();
      for (const s of sessions) {
        const ws = (s as any).workspaceId as string | undefined;
        if (ws) counts.set(ws, (counts.get(ws) || 0) + 1);
      }
      const data = records
        .filter((r) => r && typeof r.id === 'string' && r.id)
        .map((r) => ({
          id: r.id as string,
          name: (r.name as string) || path.basename(r.id),
          dirName: (r.dirName as string) || path.basename(r.id),
          parentDir: (r.parentDir as string) || path.dirname(r.id),
          workspacePath: r.id as string,
          createdAt: (r.createdAt as number) || 0,
          sessionCount: counts.get(r.id) || 0,
          archived: !!r.archived,
          archivedAt: (r.archivedAt as number) || 0,
          // 用户可能手动删了/移走了文件夹：标出来但不悄悄清理索引，
          // 否则移动硬盘没挂载时会把任务列表清空。
          missing: !taskWorkspaceExists(r.id),
        }))
        .sort((a, b) => b.createdAt - a.createdAt);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('task:create', async (_e, name: string, parentDir?: string) => {
    try {
      const displayName = typeof name === 'string' ? name.trim().slice(0, 120) : '';
      if (!displayName) return { success: false, error: '任务名不能为空' };

      const parent = (parentDir && String(parentDir).trim()) || resolveTaskRootDir();
      const result = createTaskWorkspace({ name: displayName, parentDir: parent });
      if (!result.ok) return { success: false, error: result.error };

      const rec = result.record;
      // 索引写入失败不影响文件夹已建好的事实，但必须告诉调用方，
      // 否则任务在列表里"消失"，用户会以为创建失败又建一个（产生 -2 空壳）。
      await storageAdapter.upsert(TASK_COLLECTION, {
        id: rec.id,
        name: rec.name,
        dirName: rec.dirName,
        parentDir: rec.parentDir,
        workspacePath: rec.workspacePath,
        createdAt: rec.createdAt,
      });

      return { success: true, data: { ...rec, sessionCount: 0, missing: false } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 在系统文件管理器里定位任务文件夹（比"打开 IDE 文件夹"更常用于确认产物落在哪）
  ipcMain.handle('task:reveal', async (_e, workspacePath: string) => {
    try {
      if (!workspacePath || !taskWorkspaceExists(workspacePath)) {
        return { success: false, error: '任务文件夹不存在，可能已被删除或移动' };
      }
      const errMsg = await shell.openPath(workspacePath);
      return errMsg ? { success: false, error: errMsg } : { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 重命名任务：改展示名 + 改磁盘目录名，并把绑定该工作区的会话迁到新路径
  ipcMain.handle('task:rename', async (_e, id: string, newName: string) => {
    try {
      const rec = await storageAdapter.getById<any>(TASK_COLLECTION, id);
      if (!rec) return { success: false, error: '任务不存在' };

      const oldPath: string = rec.workspacePath || rec.id;

      // Windows 上「被监听 / 被占用」的目录 rename 会抛 EBUSY：
      // 工作区监听器给每个目录都挂了 fs.watch 句柄，改的就是当前工作区时必然失败。
      // 所以先释放监听，改完再挂到新路径上。
      const watchedRoot = workspaceWatcher.root;
      const hitsWatch =
        !!watchedRoot &&
        (oldPath === watchedRoot ||
          oldPath.startsWith(watchedRoot + path.sep) ||
          watchedRoot.startsWith(oldPath + path.sep));
      if (hitsWatch) workspaceWatcher.unwatch();

      // 终端 shell 的 cwd 就是这个目录：Windows 下会让 rename 一直 EBUSY。
      // 关掉它们（父层收到改名结果后会把工作区指到新路径，终端会自动重启）。
      const terminalsClosed = terminalAdapter.killByCwd(oldPath);
      if (terminalsClosed > 0) await new Promise((r) => setTimeout(r, 150));

      const attemptRename = () =>
        renameTaskWorkspace({
          workspacePath: oldPath,
          newName: String(newName || ''),
          createdAt: rec.createdAt,
        });

      // 句柄释放有延迟（终端 cwd、编辑器、杀毒扫描都会短暂占用），
      // 退避重试 5 次，累计约 1.8s，足以覆盖绝大多数"文件正在使用"。
      const res = await retryWhileBusy(attemptRename);

      if (!res.ok) {
        // 目录没动，监听要还回去，否则文件树停止刷新
        if (hitsWatch) workspaceWatcher.watch(oldPath);
        return { success: false, error: res.error };
      }
      if (hitsWatch) workspaceWatcher.watch(res.record.id);

      if (res.dirChanged) {
        try {
          // 会话的 workspaceId 就是工作区绝对路径，路径变了必须跟着迁，
          // 否则任务名改完，会话全变成指向一个不存在的文件夹。
          // 这里直接走 storageAdapter.upsert 而不是 sessionStore.save：
          // 后者会把 updatedAt 刷成 now，一次重命名就能让所有会话跳到"最近"。
          const sessions = await sessionStore.listAll();
          const affected = sessions.filter((s: any) => s.workspaceId === oldPath);
          for (const s of affected) {
            await storageAdapter.upsert('sessions', { ...(s as any), workspaceId: res.record.id });
          }
          // 当前打开的若是这个任务，配置也要指到新路径
          if (config.get('workspace.lastWorkspace') === oldPath) {
            config.set('workspace.lastWorkspace', res.record.id);
          }
        } catch (err) {
          // 目录已经改了名但会话没迁成功：把目录改回去，保证两边一致
          try {
            await fsp.rename(res.record.id, res.previousPath);
          } catch {
            /* 改不回去就只能保留新目录，下面的错误信息会说明 */
          }
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: `迁移会话失败，已尝试还原目录名：${msg}` };
        }
      }

      // 主键变了 = 新记录 + 删旧记录（保留归档状态与创建时间）
      if (res.dirChanged) await storageAdapter.delete(TASK_COLLECTION, id);
      const saved = {
        ...rec,
        id: res.record.id,
        name: res.record.name,
        dirName: res.record.dirName,
        parentDir: res.record.parentDir,
        workspacePath: res.record.workspacePath,
        createdAt: res.record.createdAt,
        archived: !!rec.archived,
        archivedAt: rec.archivedAt || 0,
      };
      await storageAdapter.upsert(TASK_COLLECTION, saved);

      return {
        success: true,
        data: {
          id: saved.id,
          name: saved.name,
          dirName: saved.dirName,
          parentDir: saved.parentDir,
          workspacePath: saved.workspacePath,
          createdAt: saved.createdAt,
          archived: saved.archived,
          archivedAt: saved.archivedAt,
          sessionCount: 0,
          missing: false,
          dirChanged: res.dirChanged,
          previousPath: res.previousPath,
          // 改名时被关掉的终端数量：前端据此提示"终端已在新目录重启"
          terminalsClosed,
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 归档 / 取消归档：只动索引，**绝不删文件夹** —— 用户的项目文件比列表整洁重要得多
  ipcMain.handle('task:archive', async (_e, id: string, archived: boolean = true) => {
    try {
      const rec = await storageAdapter.getById<any>(TASK_COLLECTION, id);
      if (!rec) return { success: false, error: '任务不存在' };
      await storageAdapter.upsert(TASK_COLLECTION, {
        ...rec,
        archived: !!archived,
        archivedAt: archived ? Date.now() : 0,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 单步回滚：删除指定消息及其之后的所有消息
  ipcMain.handle('session:deleteMessage', async (_e, sessionId: string, messageId: string) => {
    try {
      const session = await sessionStore.load(sessionId);
      if (!session) return { success: false, error: '会话不存在' };
      const idx = session.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return { success: false, error: '消息不存在' };
      session.messages = session.messages.slice(0, idx);
      await sessionStore.save(session);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ===== Plan 查询（W3）：读取当前会话的计划状态 =====
  // 这几个 handler 过去没有 try/catch：一旦抛错，ipcRenderer.invoke 的 Promise 会 reject
  // 到渲染层，而调用方若没有 catch 就变成未处理 rejection —— 会直接卸载整个 React 树，
  // 用户看到的就是点击后黑屏。统一改成"永远 resolve 一个带 error 的结果"，把异常留在主进程。
  const planSnapshot = (sessionId: string) => {
    try {
      return { plan: planManager.getPlan(sessionId), progress: planManager.progress(sessionId) };
    } catch {
      return { plan: undefined, progress: null };
    }
  };

  ipcMain.handle('plan:skip', (_e, sessionId: string, itemId: string) => {
    try {
      return { success: planManager.skipItem(sessionId, itemId), ...planSnapshot(sessionId) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), ...planSnapshot(sessionId) };
    }
  });

  ipcMain.handle('plan:retry', (_e, sessionId: string, itemId: string) => {
    try {
      return { success: planManager.retryItem(sessionId, itemId), ...planSnapshot(sessionId) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), ...planSnapshot(sessionId) };
    }
  });

  ipcMain.handle('plan:abandon', (_e, sessionId: string) => {
    try {
      planManager.abandon(sessionId);
      return { success: true, ...planSnapshot(sessionId) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), ...planSnapshot(sessionId) };
    }
  });

  ipcMain.handle('plan:get', (_e, sessionId: string) => {
    return planSnapshot(sessionId);
  });

  // ===== 配置 IPC =====
  ipcMain.handle('config:get', (_e, key: string) => {
    return config.get(key);
  });

  ipcMain.handle('config:set', async (_e, key: string, value: unknown) => {
    config.set(key, value);
    await config.flush();
  });

  ipcMain.handle('config:getApiKeyConfigs', () => {
    return config.getApiKeyConfigs();
  });

  // ===== AI 行内补全 IPC（独立轻量通道，不经过 AgentManager）=====
  const inlineCompletionService = new InlineCompletionService(new LLMProvider(), config);
  ipcMain.handle('completion:inline', (_e, payload: { requestId?: string; req: InlineCompletionRequest }) => {
    return inlineCompletionService.complete(payload.req, payload.requestId);
  });
  ipcMain.handle('completion:cancel', (_e, requestId: string) => {
    inlineCompletionService.cancel(requestId);
  });

  ipcMain.handle('config:saveApiConfig', (_e, apiConfig: Record<string, unknown>) => {
    return config.saveApiConfig(apiConfig);
  });

  ipcMain.handle('config:deleteApiConfig', (_e, id: string) => {
    return config.deleteApiConfig(id);
  });

  // ===== 技能市场 IPC（P0：内置提示词 + 本地 SKILL.md 扫描） =====
  ipcMain.handle('skills:list', async () => {
    await skillRegistry.scan();
    return skillRegistry.list(config.get<unknown>('enabledSkills', []));
  });

  ipcMain.handle('skills:scan', async () => {
    await skillRegistry.scan();
    return skillRegistry.list(config.get<unknown>('enabledSkills', []));
  });

  ipcMain.handle('skills:setEnabled', async (_e, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') {
      return { success: false, error: '技能参数无效', skills: skillRegistry.list(config.get<unknown>('enabledSkills', [])) };
    }
    await skillRegistry.scan();
    const available = new Set(skillRegistry.list([]).map((skill) => skill.id));
    if (!available.has(id)) {
      return { success: false, error: '未找到该技能', skills: skillRegistry.list(config.get<unknown>('enabledSkills', [])) };
    }
    const current = config.get<unknown>('enabledSkills', []);
    const ids = Array.isArray(current) ? current.filter((value): value is string => typeof value === 'string' && available.has(value)) : [];
    const next = enabled ? [...new Set([...ids, id])] : ids.filter((value) => value !== id);
    config.set('enabledSkills', next);
    await config.flush();
    return { success: true, skills: skillRegistry.list(next) };
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
  const catalogService = new McpCatalogService(app.getPath('userData'));

  ipcMain.handle('mcp:listServers', () => {
    return mcpHub.listServersWithStatus();
  });

  ipcMain.handle('mcp:addServer', (_e, serverConfig: McpServerConfig) => {
    return mcpHub.addServer(serverConfig);
  });

  ipcMain.handle('mcp:removeServer', (_e, id: string) => {
    return mcpHub.removeServer(id);
  });

  ipcMain.handle('mcp:toggleServer', (_e, id: string, enabled: boolean) => {
    return mcpHub.toggleServer(id, enabled);
  });

  ipcMain.handle('mcp:listTools', (_e, serverId: string) => {
    return mcpHub.listTools(serverId);
  });

  ipcMain.handle('mcp:refreshTools', async (_e, serverId: string) => {
    return mcpHub.refreshTools(serverId);
  });

  ipcMain.handle('mcp:callTool', (_e, serverId: string, toolName: string, args: Record<string, unknown>) => {
    return mcpHub.callTool(serverId, toolName, args);
  });

  ipcMain.handle('mcp:getCatalog', async (_e, forceRefresh = false) => {
    return catalogService.getCatalog(forceRefresh);
  });

  ipcMain.handle('mcp:installFromCatalog', async (_e, entry: McpCatalogEntry) => {
    const config = McpCatalogService.toServerConfig(entry);
    return mcpHub.addServer(config);
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

  ipcMain.handle('checkpoint:getModifiedFiles', () => {
    return agentManager.getModifiedFiles();
  });

  // ===== W7 工具审批规则 =====
  ipcMain.handle('approval:listRules', () => {
    return agentManager.listApprovalRules();
  });

  ipcMain.handle('approval:addRule', (_e, rule: ApprovalRule) => {
    agentManager.addApprovalRule(rule);
    return { success: true };
  });

  ipcMain.handle('approval:removeRule', (_e, index: number) => {
    return { success: agentManager.removeApprovalRule(index) };
  });

  // ===== W11 上下文状态 =====
  ipcMain.handle('context:getState', (_e, sessionId: string) => {
    return agentManager.getContextState(sessionId);
  });

  ipcMain.handle('context:listStates', () => {
    return agentManager.listContextStates();
  });

  ipcMain.handle('context:removeState', (_e, sessionId: string) => {
    agentManager.removeContextState(sessionId);
    return { success: true };
  });

  // ===== 生成图片保存 IPC =====
  // 聊天里的生成图片是 data URL，浏览器协议下 <a download> 对大 data URL 不可靠，
  // 统一走主进程：弹出保存对话框 + 解码写盘。
  ipcMain.handle(
    'image:save',
    async (_e, payload: { dataUrl: string; suggestedName?: string }) => {
      try {
        const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(payload?.dataUrl || ''));
        if (!m) return { success: false, error: '无效的图片数据' };
        const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
        const name = (payload.suggestedName || 'generated-image').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: '保存生成图片',
          defaultPath: path.join(app.getPath('downloads'), `${name}.${ext}`),
          filters: [{ name: '图片', extensions: [ext] }],
        });
        if (canceled || !filePath) return { success: true, canceled: true };
        await fsp.writeFile(filePath, Buffer.from(m[3], 'base64'));
        return { success: true, canceled: false, filePath };
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    },
  );

  // ===== 对话框 IPC =====
  ipcMain.handle('dialog:open', () => windowAdapter.showOpenFolder());

  ipcMain.handle('dialog:save', async (_e, opts?: { defaultName?: string; filters?: Electron.FileFilter[] }) => {
    return windowAdapter.showSaveDialog(opts?.defaultName, opts?.filters);
  });

  ipcMain.handle('dialog:message', async (_e, opts: Electron.MessageBoxOptions) => {
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
  ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
  });

  ipcMain.handle('app:getPlatform', () => {
    return process.platform;
  });

  ipcMain.handle('backend:getDeviceId', () => {
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
  ipcMain.handle('backend:subscribeAnnouncements', () => {
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
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : '订阅失败' };
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

  ipcMain.handle('update:install', () => {
    return updateManager.installNow();
  });

  ipcMain.handle('update:cancel', () => {
    updateManager.cancel();
    return { success: true };
  });

  ipcMain.handle('update:getStatus', () => {
    return updateManager.getStatus();
  });

  ipcMain.handle('update:getLogs', async (_e, limit?: number) => {
    return updateManager.getUpdateLogs(limit || 100);
  });

  // 更新公告：检测是否刚完成更新，若是则返回版本号（渲染层据此弹出公告窗口）
  ipcMain.handle('update:checkAnnouncement', async () => {
    return updateManager.checkPostUpdateAnnouncement();
  });

  // 获取远程 releasenotes.txt 内容（更新公告正文）
  ipcMain.handle('update:getReleaseNotes', async () => {
    return updateManager.fetchReleaseNotes();
  });

  // ===== PPT 生成 IPC（W14）=====
  let pptAdapter: PptxAdapter | null = null;
  const getPptAdapter = async (): Promise<PptxAdapter> => {
    if (!pptAdapter) pptAdapter = await createPptxAdapter();
    return pptAdapter;
  };

  // 生成 PPT 并保存到指定路径（企业级：生成前智能审校 + 自动修复 + 品牌注入）
  ipcMain.handle('ppt:generate', async (_e, req: PptxCreateRequest, savePath?: string) => {
    const adapter = await getPptAdapter();
    if (!adapter.available) {
      return { success: false, error: 'PPT 生成未就绪：缺少 pptxgenjs 依赖，请运行 npm install pptxgenjs' };
    }
    if (!savePath) {
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '保存 PPT',
        defaultPath: path.join(app.getPath('documents'), `${req?.title || '演示文稿'}.pptx`),
        filters: [{ name: 'PowerPoint 演示文稿', extensions: ['pptx'] }],
      });
      if (canceled || !filePath) return { success: false, error: '已取消保存' };
      savePath = filePath;
    }
    // 智能审校：文字溢出预防（超长标题/要点拆分/图表数据一致性），能修的自动修
    let auditIssues: AuditIssue[] = [];
    const finalReq: PptxCreateRequest = req || {};
    if (finalReq?.slides) {
      const audited = auditOutline(finalReq);
      auditIssues = audited.issues;
      finalReq.slides = audited.data.slides as unknown as PptxCreateRequest['slides'];
      if (audited.data.title !== undefined) finalReq.title = audited.data.title;
    }
    const result = await adapter.generate(finalReq, savePath);
    if (result.success) {
      return {
        ...result,
        audit: { issues: auditIssues, summary: summarizeIssues(auditIssues), passed: auditIssues.every((i) => i.level === 'fixed') },
      };
    }
    return result;
  });

  // AI 生成 PPT 大纲（企业级：支持场景化结构骨架 + 图表建议）
  ipcMain.handle('ppt:generateOutline', async (_e, topic: string, slideCount?: number, scenarioId?: string) => {
    const configs = config.getApiKeyConfigs();
    const activeId = config.get<string>('activeApiConfigId');
    const apiConfig = configs.find((c) => c.id === activeId) || configs[0];
    const n = Math.max(1, Math.min(20, Number(slideCount) || 8));
    const scenario = scenarioId ? getScenario(scenarioId) : null;
    if (!apiConfig) {
      return {
        success: true,
        outline: buildFallbackPptOutline(topic, n),
        scenarioId: scenario?.id || null,
        byFallback: true,
        notice: '未配置模型，已使用本地大纲生成 PPT。配置模型后可获得更贴合主题的内容。',
      };
    }
    try {
      const llm = new LLMProvider();
      const prompt = scenario
        ? buildScenarioOutlinePrompt(topic, n, scenario)
        : buildGenericOutlinePrompt(topic, n);
      const resp = await llm.chat({
        apiConfig,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      });
      // 剥离可能的 ```json ... ``` 包裹
      let text = (resp.content || '').trim();
      const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) text = fenceMatch[1].trim();
      const parsed = JSON.parse(text);
      return { success: true, outline: parsed, scenarioId: scenario?.id || null };
    } catch (err) {
      console.warn('[ppt] AI 大纲生成失败，改用本地保底大纲:', err instanceof Error ? err.message : err);
      return {
        success: true,
        outline: buildFallbackPptOutline(topic, n),
        scenarioId: scenario?.id || null,
        byFallback: true,
        notice: '模型暂不可用，已使用本地大纲生成 PPT。',
      };
    }
  });

  // AI 原创视觉设计：只返回受校验的本地绘制参数，绝不下载或套用外部 PPT 模板。
  ipcMain.handle('ppt:generateAiDesign', async (_e, payload: {
    topic?: string;
    scenarioName?: string;
    slides?: AiPptSlideHint[];
    fallbackThemeId?: string;
  }) => {
    const fallbackThemeId = payload?.fallbackThemeId || 'business';
    const fallback = normalizeAiPptDesign(null, fallbackThemeId);
    const configs = config.getApiKeyConfigs();
    const activeId = config.get<string>('activeApiConfigId');
    const apiConfig = configs.find((c) => c.id === activeId) || configs[0];
    if (!apiConfig) return { success: true, design: fallback, byLlm: false };
    try {
      const llm = new LLMProvider();
      const response = await llm.chat({
        apiConfig,
        messages: [{
          role: 'user',
          content: buildAiPptDesignPrompt({
            topic: String(payload?.topic || '演示文稿'),
            scenarioName: payload?.scenarioName,
            slides: payload?.slides ?? [],
          }),
        }],
        temperature: 0.45,
      });
      let text = String(response.content || '').trim();
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced) text = fenced[1].trim();
      return { success: true, design: normalizeAiPptDesign(JSON.parse(text), fallbackThemeId), byLlm: true };
    } catch {
      // 设计建议失败不阻断生成；用受控默认方案继续保证可导出。
      return { success: true, design: fallback, byLlm: false };
    }
  });

  // ===== 企业级：场景体系 =====
  // 场景清单（静态，不调 LLM）
  ipcMain.handle('ppt:listScenarios', () => {
    return {
      success: true,
      scenarios: PPT_SCENARIOS.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        recommendedTheme: s.recommendedTheme,
        recommendedPages: s.recommendedPages,
      })),
    };
  });

  // 场景自动检测（LLM 分类 + 关键词兜底，永不失败）
  ipcMain.handle('ppt:detectScenario', async (_e, topic: string) => {
    const t = String(topic || '').trim();
    if (!t) return { success: true, scenarioId: 'general', byLlm: false, confidence: 0 };
    const configs = config.getApiKeyConfigs();
    const activeId = config.get<string>('activeApiConfigId');
    const apiConfig = configs.find((c) => c.id === activeId) || configs[0];
    if (!apiConfig) {
      // 未配置 API：直接关键词规则
      return { success: true, scenarioId: detectScenarioByKeyword(t).id, byLlm: false, confidence: 0.5 };
    }
    try {
      const llm = new LLMProvider();
      const r = await detectScenarioByLlm(llm, apiConfig, t);
      return { success: true, scenarioId: r.scenario.id, byLlm: r.byLlm, confidence: r.confidence };
    } catch {
      return { success: true, scenarioId: detectScenarioByKeyword(t).id, byLlm: false, confidence: 0.5 };
    }
  });

  // ===== 企业级：品牌配置 =====
  ipcMain.handle('ppt:getBrand', () => {
    return { success: true, brand: config.get<PptBrand>('ppt.brand', DEFAULT_BRAND) };
  });

  ipcMain.handle('ppt:setBrand', (_e, brand: unknown) => {
    const normalized = normalizeBrand(brand);
    config.set('ppt.brand', normalized);
    return { success: true, brand: normalized };
  });

  // ===== PPT 主题相关 =====
  // 返回内置主题清单（不调用 LLM）
  ipcMain.handle('ppt:listThemes', () => {
    return {
      success: true,
      themes: PPT_THEMES.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        colors: t.colors,
        icon: t.icon,
      })),
    };
  });

  // 纯代码生成 HTML 预览（不调 LLM，确定性输出，与 PPTX 导出视觉一致）
  // 替代 ppt:renderTheme 的 LLM 渲染路径——一键生成主推此路径
  ipcMain.handle('ppt:generatePreview', (_e, payload: {
    themeId: string;
    outline: { title: string; slides: PreviewSlide[] };
    design?: { palette?: { primary?: string; secondary?: string; accent?: string; background?: string }; fontFamily?: string; artDirection?: string };
  }) => {
    try {
      const theme = findTheme(payload.themeId);
      if (!theme) return { success: false, error: `未知主题：${payload.themeId}` };
      const brand = config.get<PptBrand>('ppt.brand', DEFAULT_BRAND);
      const aiDesign = normalizeAiPptDesign({
        themeId: payload.themeId,
        palette: payload.design?.palette,
        fontFamily: payload.design?.fontFamily,
        artDirection: payload.design?.artDirection,
      }, payload.themeId);
      const html = generatePreviewHtml({
        themeId: aiDesign.themeId,
        outline: payload.outline,
        brand: brand?.enabled ? brand : undefined,
        colors: aiDesign.palette,
        fontFamily: brand?.enabled && brand.fontFamily ? brand.fontFamily : aiDesign.fontFamily,
        artDirection: aiDesign.artDirection,
      });
      return { success: true, html };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 第 2 轮 LLM：把大纲 + 主题样式 → 渲染为完整 HTML 演示文稿
  ipcMain.handle(
    'ppt:renderTheme',
    async (
      e,
      payload: {
        themeId: string;
        outline: { title: string; slides: { title: string; bullets: string[] }[] };
        extraInstruction?: string;
      },
    ) => {
      const theme = findTheme(payload.themeId);
      if (!theme) return { success: false, error: `未知主题：${payload.themeId}` };
      const configs = config.getApiKeyConfigs();
      const activeId = config.get<string>('activeApiConfigId');
      const apiConfig = configs.find((c) => c.id === activeId) || configs[0];
      if (!apiConfig) return { success: false, error: '未配置 API，无法渲染。请先在设置中配置模型 API。' };
      const sender = e.sender;
      // 品牌色注入 HTML 预览（保证预览与导出 PPTX 视觉一致）
      const brand = config.get<PptBrand>('ppt.brand', DEFAULT_BRAND);
      const brandColors = brand?.enabled ? {
        primary: brand.primary || theme.colors.primary,
        secondary: brand.secondary || theme.colors.secondary,
        accent: brand.accent || theme.colors.accent,
        background: theme.colors.background,
      } : undefined;
      try {
        const llm = new LLMProvider();
        const result = await renderOutlineToHtml(llm, apiConfig, {
          themeId: payload.themeId,
          outline: payload.outline,
          extraInstruction: payload.extraInstruction,
          brandColors,
          onProgress: (stage, current, total, message) => {
            try { sender.send('ppt:renderProgress', { stage, current, total, message }); } catch { /* 窗口已关闭 */ }
          },
        });
        return result;
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // 保存渲染好的 HTML 到指定路径
  ipcMain.handle('ppt:saveHtml', async (_e, payload: { html: string; savePath: string }) => {
    try {
      if (!payload?.html || !payload?.savePath) {
        return { success: false, error: '缺少 html 或 savePath' };
      }
      await fsp.mkdir(path.dirname(payload.savePath), { recursive: true });
      await fsp.writeFile(payload.savePath, payload.html, 'utf-8');
      return { success: true, path: payload.savePath };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 导出 PDF：把渲染好的 HTML（含 @media print 分页样式）转 16:9 PDF
  ipcMain.handle(
    'ppt:exportPdf',
    async (_e, payload: { html: string; savePath?: string; title?: string }) => {
      if (!payload?.html) return { success: false, error: '缺少 html' };
      let savePath = payload.savePath;
      if (!savePath) {
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: '导出 PDF',
          defaultPath: path.join(app.getPath('documents'), `${payload.title || '演示文稿'}.pdf`),
          filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
        });
        if (canceled || !filePath) return { success: false, error: '已取消导出' };
        savePath = filePath;
      }
      return exportHtmlToPdf(payload.html, savePath);
    },
  );


  // 大纲细化扩写（单页）
  ipcMain.handle(
    'ppt:expandSlide',
    async (
      _e,
      payload: {
        slide: { title: string; bullets: string[] };
        presentationTopic?: string;
        intensity?: 'light' | 'standard' | 'deep';
        extraInstruction?: string;
      },
    ) => {
      const configs = config.getApiKeyConfigs();
      const activeId = config.get<string>('activeApiConfigId');
      const apiConfig = configs.find((c) => c.id === activeId) || configs[0];
      if (!apiConfig) return { success: false, error: '未配置 API，无法扩写' };
      try {
        const llm = new LLMProvider();
        const result = await expandSlide(llm, apiConfig, payload.slide, {
          intensity: payload.intensity,
          extraInstruction: payload.extraInstruction,
          presentationTopic: payload.presentationTopic,
        });
        return result;
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // 大纲细化扩写（全文）
  ipcMain.handle(
    'ppt:expandAll',
    async (
      e,
      payload: {
        outline: { title: string; slides: { title: string; bullets: string[] }[] };
        intensity?: 'light' | 'standard' | 'deep';
        extraInstruction?: string;
      },
    ) => {
      const configs = config.getApiKeyConfigs();
      const activeId = config.get<string>('activeApiConfigId');
      const apiConfig = configs.find((c) => c.id === activeId) || configs[0];
      if (!apiConfig) return { success: false, error: '未配置 API，无法扩写' };
      const sender = e.sender;
      try {
        const llm = new LLMProvider();
        const result = await expandAll(llm, apiConfig, payload.outline, {
          intensity: payload.intensity,
          extraInstruction: payload.extraInstruction,
          presentationTopic: payload.outline.title,
          onProgress: (current, total, message) => {
            try { sender.send('ppt:expandProgress', { current, total, message }); } catch { /* 窗口已关闭 */ }
          },
        });
        return result;
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );


  // ===== 工作区内容扫描（供 PPT 从当前项目自动生成内容）=====

  /** 需要忽略的目录/文件名，避免把依赖、构建产物、缓存扫进来 */
  const PPT_SCAN_IGNORE_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', 'release',
    '.next', '.nuxt', '.cache', 'coverage', 'vendor', '__pycache__',
    '.idea', '.vscode', 'venv', '.venv', 'target', '.gradle',
  ]);
  const PPT_SCAN_IGNORE_FILES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.DS_Store', 'Thumbs.db',
  ]);
  /** 优先作为项目说明读取的文档名 */
  const PPT_README_CANDIDATES = [
    'README.md', 'readme.md', 'README.MD', 'README', 'README.txt',
    'README.rst', 'readme', '说明.md', '项目说明.md', '介绍.md', 'README.zh.md',
  ];
  /** 扫描目录结构时每层最多列出的条目数，避免超大目录刷屏 */
  const PPT_SCAN_MAX_ENTRIES_PER_DIR = 60;
  /** 递归扫描的最大深度 */
  const PPT_SCAN_MAX_DEPTH = 5;

  interface WorkspaceScanSummary {
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

  /** 递归列出目录结构（限定深度与每层条目数） */
  async function buildDirStructure(
    dir: string,
    depth: number,
    maxDepth: number,
    lines: string[],
    prefix: string,
    basePath: string,
  ): Promise<void> {
    if (depth > maxDepth || lines.length > 800) return;
    let entries: DirEntry[] = [];
    try {
      const res = await fsAdapter.listDir(dir);
      if (!res.success || !res.entries) return;
      entries = res.entries.filter(
        (e) => !PPT_SCAN_IGNORE_DIRS.has(e.name) && !PPT_SCAN_IGNORE_FILES.has(e.name),
      );
    } catch {
      return;
    }
    const dirs = entries.filter((e) => e.isDirectory);
    const files = entries.filter((e) => e.isFile);
    const shown = [...dirs, ...files].slice(0, PPT_SCAN_MAX_ENTRIES_PER_DIR);
    for (let i = 0; i < shown.length; i++) {
      const e = shown[i];
      const isLast = i === shown.length - 1;
      const connector = isLast ? '└─ ' : '├─ ';
      lines.push(`${prefix}${connector}${e.name}${e.isDirectory ? '/' : ''}`);
      if (e.isDirectory) {
        await buildDirStructure(e.path, depth + 1, maxDepth, lines, `${prefix}${isLast ? '   ' : '│  '}`, basePath);
      }
    }
  }

  /** 读取工作区 README / 文档，返回摘要 */
  async function scanWorkspaceSummary(wsPath: string): Promise<WorkspaceScanSummary> {
    try {
      const statRes = await fsAdapter.listDir(wsPath);
      if (!statRes.success) {
        return { success: false, error: `无法读取工作区：${statRes.error || '目录不存在'}` };
      }

      // 1. 项目名
      const projectName = path.basename(wsPath) || '当前项目';

      // 2. 查找 README 文档
      let readmeContent: string | undefined;
      let readmePath: string | undefined;
      for (const cand of PPT_README_CANDIDATES) {
        const fp = path.join(wsPath, cand);
        const r = await fsAdapter.readFile(fp);
        if (r.success && r.content) {
          readmeContent = r.content.slice(0, 6000); // 截断，避免上下文过长
          readmePath = cand;
          break;
        }
      }

      // 3. 目录结构
      const structureLines: string[] = [`${projectName}/`];
      await buildDirStructure(wsPath, 1, PPT_SCAN_MAX_DEPTH, structureLines, '', wsPath);

      // 4. 统计文档文件（.md/.txt/.rst/.docx/.pdf 等）
      const docFiles: { path: string; size: number }[] = [];
      const topDirs: Record<string, number> = {};
      const collectDocs = async (dir: string, depth: number) => {
        if (depth > 3) return;
        let entries: DirEntry[] = [];
        try {
          const res = await fsAdapter.listDir(dir);
          if (!res.success || !res.entries) return;
          entries = res.entries;
        } catch {
          return;
        }
        for (const e of entries) {
          if (PPT_SCAN_IGNORE_DIRS.has(e.name) || PPT_SCAN_IGNORE_FILES.has(e.name)) continue;
          if (e.isDirectory) {
            if (depth === 1) topDirs[e.name] = topDirs[e.name] || 0;
            await collectDocs(e.path, depth + 1);
          } else if (e.isFile) {
            if (depth === 1 && e.isDirectory === false) topDirs['(根目录)'] = topDirs['(根目录)'] || 0;
            if (/\.(md|markdown|txt|rst|adoc|docx|pdf|html|htm)$/i.test(e.name)) {
              if (docFiles.length < 30) docFiles.push({ path: path.relative(wsPath, e.path), size: e.size });
            }
          }
        }
      };
      await collectDocs(wsPath, 1);

      const totalFiles = (statRes.entries || []).length;
      const topDirStats = Object.entries(topDirs)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      return {
        success: true,
        workspace: wsPath,
        projectName,
        readmeContent,
        readmePath,
        structure: structureLines.join('\n'),
        fileStats: { totalFiles, topDirs: topDirStats },
        docFiles,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 扫描当前工作区并返回内容摘要（供 PPT 窗口使用）
  ipcMain.handle('ppt:scanWorkspace', async (_e, wsPath?: string) => {
    const target = wsPath || config.getLastWorkspace();
    if (!target) {
      return { success: false, error: '尚未打开任何工作区，请先在主界面打开文件夹。' };
    }
    return scanWorkspaceSummary(target);
  });

  // 基于当前工作区代码/文档自动生成 PPT 大纲
  ipcMain.handle('ppt:generateFromWorkspace', async (_e, opts?: { wsPath?: string; slideCount?: number; focus?: string }) => {
    const wsPath = opts?.wsPath || config.getLastWorkspace();
    if (!wsPath) {
      return { success: false, error: '尚未打开任何工作区，请先在主界面打开文件夹。' };
    }
    const configs = config.getApiKeyConfigs();
    const activeId = config.get<string>('activeApiConfigId');
    const apiConfig = configs.find((c) => c.id === activeId) || configs[0];
    const n = Math.max(1, Math.min(20, Number(opts?.slideCount) || 8));

    const summary = await scanWorkspaceSummary(wsPath);
    if (!summary.success) {
      return { success: false, error: summary.error };
    }
    if (!apiConfig) {
      return {
        success: true,
        outline: buildFallbackPptOutline(summary.projectName || '项目介绍', n),
        workspace: summary,
        byFallback: true,
        notice: '未配置模型，已根据工作区生成本地 PPT 大纲。',
      };
    }

    try {
      const llm = new LLMProvider();
      const focusHint = opts?.focus?.trim()
        ? `\n用户特别关注的方向：${opts.focus.trim()}`
        : '';
      const prompt = [
        `你是专业的演示文稿策划专家。请基于下面提供的「项目/工作区」信息，自动生成一份 ${n} 页 PPT 大纲，用于向他人介绍、汇报或讲解该项目。`,
        ``,
        `【项目名称】${summary.projectName}`,
        `【README 摘要】${summary.readmeContent ? summary.readmeContent.slice(0, 3000) : '（无 README）'}`,
        `【目录结构】`,
        summary.structure,
        `【文档文件】${summary.docFiles?.length ? summary.docFiles.slice(0, 15).map((d) => d.path).join('、') : '（无）'}`,
        focusHint,
        ``,
        `请提取项目核心内容（定位、功能、技术栈、架构、亮点等），组织成逻辑递进的 ${n} 页大纲。`,
        `严格输出 JSON（不要任何 markdown 代码块、不要多余文字），结构如下：`,
        `{"title":"演示文稿总标题","slides":[{"title":"第 i 页标题","bullets":["要点1","要点2","要点3"]}]}`,
        `要求：每页 2-5 个要点，语言简洁有力，贴合项目实际内容，不要编造不存在的功能。`,
      ].join('\n');

      const resp = await llm.chat({
        apiConfig,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      });
      let text = (resp.content || '').trim();
      const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) text = fenceMatch[1].trim();
      const parsed = JSON.parse(text);
      return { success: true, outline: parsed, workspace: summary };
    } catch (err) {
      console.warn('[ppt] 工作区 AI 大纲生成失败，改用本地保底大纲:', err instanceof Error ? err.message : err);
      return {
        success: true,
        outline: buildFallbackPptOutline(summary.projectName || '项目介绍', n),
        workspace: summary,
        byFallback: true,
        notice: '模型暂不可用，已根据工作区生成本地 PPT 大纲。',
      };
    }
  });

  // ===== PPT Master 原生 PPTX 流水线（替代旧 pptxgenjs 生成链路）=====
  // 说明：PPT Master 走「LLM 逐页画 SVG → Python 转原生 DrawingML」，
  // 产出的是 PowerPoint 原生可编辑对象（母版/版式/形状/占位符），而非扁平文本框。

  /** 环境自检：Python + 技能包 + 依赖 */
  ipcMain.handle('pptmaster:checkEnv', async () => {
    const svc = getPptMasterService();
    if (!svc) {
      const viaSkill = getSkillRootCandidate();
      return {
        success: false,
        error: `PPT Master 未初始化。候选路径：${viaSkill}。请确认 skills/ppt-master 目录随应用分发。`,
      };
    }
    try {
      const env = await svc.checkEnvironment();
      return { success: true, ...env, projectsRoot: getProjectsRoot() };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** 重新解析 Python（用户改了路径后调用） */
  ipcMain.handle('pptmaster:rebindPython', async (_e, pythonPath?: string) => {
    try {
      if (typeof pythonPath === 'string') {
        config.set('pptMaster.pythonPath', pythonPath.trim());
      }
      const r = await rebindPython(config);
      return { success: true, ...r };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** 安装依赖（pip install -r requirements.txt） */
  ipcMain.handle('pptmaster:installDeps', async (e) => {
    const runner = getSkillRunner();
    if (!runner) return { success: false, error: 'PPT Master 未初始化' };
    const py = await runner.ensurePython();
    if (!py) return { success: false, error: '未找到 Python 解释器' };

    const requirements = path.join(runner.getSkillRoot(), 'requirements.txt');
    if (!existsSync(requirements)) {
      return { success: false, error: `未找到 requirements.txt: ${requirements}` };
    }

    const { sender } = e;
    const result = await installDependencies(py.path, requirements, (line) => {
      try {
        sender.send('pptmaster:installOutput', line);
      } catch {
        /* 窗口已关闭 */
      }
    });
    return { success: result.success, error: result.error };
  });

  /** 生成原生 PPTX（主流程）。进度通过 pptmaster:progress 推送 */
  ipcMain.handle(
    'pptmaster:generate',
    async (
      e,
      opts: {
        projectName: string;
        topic: string;
        sources?: string[];
        slideCount?: number;
        canvasFormat?: string;
        deliveryContext?: string;
        styleHint?: string;
        speakerNotes?: boolean;
        animations?: boolean;
        savePath?: string;
      },
    ) => {
      const runner = getSkillRunner();
      if (!runner) {
        return { success: false, error: 'PPT Master 未初始化，请检查 skills/ppt-master 是否存在。' };
      }
      if (!opts?.topic?.trim()) {
        return { success: false, error: '缺少主题（topic）' };
      }

      const { sender } = e;
      const projectsRoot = getProjectsRoot();

      // 项目名安全化 + 时间戳，避免同名覆盖
      const safeName =
        (opts.projectName || opts.topic).replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40) || 'deck';
      const stamp = new Date()
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, '');

      const service = new PptMasterService({
        runner,
        projectsRoot,
        config,
        onEvent: (p) => {
          try {
            sender.send('pptmaster:progress', p);
          } catch {
            /* 窗口已关闭 */
          }
        },
      });

      try {
        const result = await service.generate({
          projectName: `${safeName}_${stamp}`,
          topic: opts.topic,
          sources: opts.sources,
          slideCount: opts.slideCount,
          canvasFormat: opts.canvasFormat,
          deliveryContext: opts.deliveryContext,
          styleHint: opts.styleHint,
          speakerNotes: opts.speakerNotes,
          animations: opts.animations,
          savePath: opts.savePath,
        });
        return result;
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  /** 选择保存路径（导出前调用） */
  ipcMain.handle('pptmaster:pickSavePath', async (_e, defaultName?: string) => {
    const name = (defaultName || '演示文稿').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const r = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('documents'), `${name}.pptx`),
      filters: [{ name: 'PowerPoint 演示文稿', extensions: ['pptx'] }],
    });
    return { success: !r.canceled && !!r.filePath, savePath: r.filePath || '' };
  });

  /** 列出已生成的项目 */
  ipcMain.handle('pptmaster:listProjects', async () => {
    const root = getProjectsRoot();
    try {
      if (!existsSync(root)) return { success: true, projects: [] };
      const entries = await fsp.readdir(root, { withFileTypes: true });
      const projects: Array<{
        name: string;
        path: string;
        pageCount: number;
        pptxPath: string | null;
        mtime: number;
      }> = [];
      for (const en of entries) {
        if (!en.isDirectory()) continue;
        const p = path.join(root, en.name);
        const svgDir = path.join(p, 'svg_output');
        let pageCount = 0;
        let pptxPath: string | null = null;
        try {
          if (existsSync(svgDir)) {
            pageCount = (await fsp.readdir(svgDir)).filter((f) => f.endsWith('.svg')).length;
          }
          const exportsDir = path.join(p, 'exports');
          if (existsSync(exportsDir)) {
            const files = (await fsp.readdir(exportsDir)).filter((f) => f.endsWith('.pptx'));
            pptxPath = files.length ? path.join(exportsDir, files[0]) : null;
          }
        } catch {
          /* ignore */
        }
        let mtime = 0;
        try {
          mtime = (await fsp.stat(p)).mtimeMs;
        } catch {
          /* ignore */
        }
        projects.push({ name: en.name, path: p, pageCount, pptxPath, mtime });
      }
      projects.sort((a, b) => b.mtime - a.mtime);
      return { success: true, projects, root };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), projects: [] };
    }
  });

  /** 打开项目目录 */
  ipcMain.handle('pptmaster:openProjectDir', async (_e, projectPath: string) => {
    try {
      await shell.openPath(projectPath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** 列出技能包内置工作流与参考文档（供 UI 展示能力） */
  ipcMain.handle('pptmaster:listCapabilities', async () => {
    const runner = getSkillRunner();
    if (!runner) return { success: false, error: 'PPT Master 未初始化' };
    const [workflows, references] = await Promise.all([
      runner.listWorkflows(),
      runner.listReferences(),
    ]);
    return {
      success: true,
      skillRoot: runner.getSkillRoot(),
      workflows,
      references,
    };
  });

  // 返回应用退出时的清理函数
  return {
    dispose: () => {
      mcpHub.dispose();
      terminalAdapter.dispose?.();
      // 释放工作区文件监听
      workspaceWatcher.dispose();
      // 落盘尚未持久化的记忆变更
      void memoryStore.flushNow().catch(() => {});
      // 落盘更新日志并清理 autoUpdater 监听
      void updateManager.dispose();
      // 断开公告 SSE 长连接
      try { unsubscribeAnnouncements?.(); } catch { /* 已断链时忽略 */ }
    },
  };
}
