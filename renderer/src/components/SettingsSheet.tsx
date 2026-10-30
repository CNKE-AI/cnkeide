import React, { useEffect, useState } from 'react';
import type { SkillView, McpCatalogEntry, ProjectInstructionsReport } from '../global';
import { useApp } from '../store/AppProvider';
import { X, Plus, Trash2, Save, KeyRound, Cpu, Info, RefreshCw, LayoutTemplate, Cloud, MessageSquarePlus, Send, Inbox, Pencil, ChevronDown, ChevronRight, Wrench, Sparkles, ShieldCheck, Zap, GitBranch, Layers, Boxes, Network, ScrollText, BrainCircuit, Presentation, Gauge, Loader2 } from 'lucide-react';

import { toast } from '../utils/toast';
import { THEMES, useThemeStore } from '../store/themeStore';
type TabKey = 'models' | 'agent' | 'skills' | 'appearance' | 'about';

const PROVIDERS = [
  { id: 'AI Platform', label: 'AI Platform', baseUrl: 'https://ai.cnkes.cn' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { id: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'glm', label: '智谱GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'claude', label: 'Claude', baseUrl: 'https://api.anthropic.com' },
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434' },
  { id: 'custom', label: '自定义/中转', baseUrl: '' },
];

/** 专业版能力分组：条目均取自当前客户端已实现能力，避免出现未落地功能 */
const PRO_GROUPS = [
  {
    tag: 'CORE',
    label: 'Agent 内核 · 自主规划与执行',
    accent: 'fuchsia',
    items: [
      { icon: BrainCircuit, title: '四模式 Agent 内核', desc: 'Ask 问答 / Craft 编码 / Plan 规划 / Debug 排错，各自独立的工具白名单与迭代上限' },
      { icon: Layers, title: '任务计划状态机', desc: 'create_plan 拆解步骤，逐步推进、失败可跳过或废弃，进度实时同步到计划面板' },
      { icon: Zap, title: '并行工具调度', desc: '按依赖拓扑排序，单轮最多 4 个工具并发：只读并发、同文件写串行、危险操作全局串行' },
    ],
  },
  {
    tag: 'CODE',
    label: '研发闭环 · 读懂 / 改动 / 验证',
    accent: 'cyan',
    items: [
      { icon: Network, title: '三路混合检索', desc: '关键词 + Embedding 语义 + 符号引用融合排序，代码块增量索引，改动后即时生效' },
      { icon: GitBranch, title: 'Checkpoint 快照回滚', desc: '每轮改动自动留痕，逐文件 unified diff 可查，一键回到任意快照' },
      { icon: ShieldCheck, title: '审批与信任规则', desc: '按工具名 / 路径 / 命令 glob 自动放行或询问，写盘与命令执行默认需确认' },
    ],
  },
  {
    tag: 'DELIVER',
    label: '交付能力 · 从代码到演示文稿',
    accent: 'violet',
    items: [
      { icon: Presentation, title: 'AI 演示文稿', desc: '扫描工作区提炼大纲，4 套主题 × 7 类版式，可套用在线模板，导出 PPTX / PDF' },
      { icon: Sparkles, title: '浏览器自动化与图片生成', desc: '6 个 browser_* 动作完成导航 / 点击 / 输入 / 截图 / 取文，image_generate 直出配图' },
      { icon: ScrollText, title: '文档问答 RAG', desc: 'doc_ingest 直接摄入 PDF / DOCX / HTML / Markdown，检索结果带 [1][2] 编号引用' },
    ],
  },
  {
    tag: 'PLATFORM',
    label: '平台与生态 · 模型 / 扩展 / 更新',
    accent: 'emerald',
    items: [
      { icon: Cpu, title: '多模型智能路由', desc: '按任务类型与 @模型 指定自动选档，内置 17+ 模型能力矩阵，主模型失败自动切备用' },
      { icon: Boxes, title: 'MCP 客户端与技能市场', desc: '任意 MCP 服务器（stdio / http）即插即用，技能一键安装启用' },
      { icon: Gauge, title: '上下文追踪与记忆', desc: '实时上下文占用分档提示 + 长会话自动压缩，跨会话保留工作区与偏好' },
      { icon: Cloud, title: '差分增量更新', desc: '后台静默检测，blockmap 差分下载，支持强制更新兜底' },
    ],
  },
] as const;

/** 分组配色：类名需静态出现，故用映射表而非模板字符串拼接 */
const ACCENT_STYLES: Record<string, { chip: string; icon: string }> = {
  fuchsia: { chip: 'from-fuchsia-500 to-violet-500', icon: 'text-fuchsia-400' },
  cyan: { chip: 'from-cyan-500 to-blue-500', icon: 'text-cyan-400' },
  violet: { chip: 'from-violet-500 to-fuchsia-500', icon: 'text-violet-400' },
  emerald: { chip: 'from-emerald-500 to-teal-500', icon: 'text-emerald-400' },
};

/** 专业版关键指标 */
const PRO_STATS: { value: string; label: string }[] = [
  { value: '39', label: '内置工具' },
  { value: '4', label: '交互模式' },
  { value: '3', label: '路混合检索' },
  { value: '7', label: '类演示版式' },
];


interface ApiConfig {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 官方内置模型：只有内置模型参与 AUTO 路由 */
  builtin?: boolean;
  disabled?: boolean;
}

/** AUTO 路由的任务类型与展示名（与 ModelRouter 的 TaskType 对齐） */
const ROUTING_TASKS = [
  { key: 'chat', label: '日常问答' },
  { key: 'code', label: '编码任务' },
  { key: 'reasoning', label: '推理分析' },
  { key: 'vision', label: '图片理解' },
  { key: 'plan', label: '规划任务' },
  { key: 'summarize', label: '总结摘要' },
] as const;

interface McpServerForm {
  id?: string;
  name: string;
  protocol: 'stdio' | 'http';
  command: string;
  args: string;
  url: string;
  enabled: boolean;
}

/** 权限档位说明（渲染层自带一份，避免把主进程模块打进 renderer 包） */
const PERMISSION_MODE_INFO = {
  'read-only': {
    detail:
      '读文件、搜索、网页抓取正常使用；写文件、删除、执行命令、git 提交、MCP 外部调用直接拦截（命中命令白名单的除外）。',
  },
  standard: {
    detail: '读文件与修改文件内容自动放行；删除、重命名、执行命令、git 提交、MCP 外部调用仍然逐次确认。',
  },
  'full-access': {
    detail: '所有工具调用一律放行，只保留你显式配置的「拒绝」信任规则。适合一次性容器或临时目录。',
  },
} as const;

const SettingsSheet: React.FC = () => {
  const { setSettingsOpen, workspacePath } = useApp();
  const { theme, setTheme } = useThemeStore();
  const [tab, setTab] = useState<TabKey>('models');

  // 模型配置
  const [apiConfigs, setApiConfigs] = useState<ApiConfig[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [editing, setEditing] = useState<ApiConfig | null>(null);

  // Agent 设置
  const [agentCfg, setAgentCfg] = useState<any>({
    mode: 'plan',
    maxMode: false,
    maxHistoryMessages: 20,
    systemPrompt: '',
    maxTurns: 50,
    temperature: 0.7,
    topP: 1,
    autoApproveTools: false,
    replyFormat: 'structured',
    enableRouting: true,
    routing: {},
    toolConcurrency: 4,
    maxRetries: 3,
    // 单条命令输出上限（KB）：超限自动截断，避免全盘扫描类命令把界面撑白
    maxCommandOutputKB: 400,
    // Python 解释器路径（留空则自动探测：项目 venv > 内置 > 系统）
    pythonPath: '',
    llmTimeoutMs: 60000,
    fallbackModelIds: [],
    browserAutomation: { enabled: true },
    imageGeneration: { enabled: false, apiConfigId: '' },
    // 仓库级指令文件（AGENTS.md / CNKE.md）自动注入
    useProjectInstructions: true,
    projectInstructionsBudget: 24000,
    // 执行权限档位 + 白名单
    permissionMode: 'standard',
    commandAllowlist: [],
    domainAllowlist: [],
  });

  // 白名单用多行文本框编辑：文本单独存，避免回车被 filter 吃掉
  const [cmdAllowText, setCmdAllowText] = useState('');
  const [domainAllowText, setDomainAllowText] = useState('');

  // 项目指令面板：直观看清「这次对话会注入哪些项目约定」，避免 AI 读了什么全靠猜
  const [instructions, setInstructions] = useState<ProjectInstructionsReport | null>(null);
  const [instructionsLoading, setInstructionsLoading] = useState(false);

  const reloadInstructions = async () => {
    if (!workspacePath) {
      setInstructions(null);
      return;
    }
    setInstructionsLoading(true);
    try {
      setInstructions(await window.cnke.project.instructions(workspacePath));
    } catch (err: any) {
      setInstructions({
        success: false,
        files: [],
        skipped: [],
        totalBytes: 0,
        block: '',
        error: err?.message || String(err),
      });
    } finally {
      setInstructionsLoading(false);
    }
  };

  const createInstructionFile = async () => {
    if (!workspacePath) {
      toast.error('请先打开工作区');
      return;
    }
    const res = await window.cnke.project.createInstruction(workspacePath, 'AGENTS.md');
    if (!res.success) {
      toast.error(res.error || '生成失败');
      return;
    }
    toast.success(res.created ? '已生成 AGENTS.md 模板' : 'AGENTS.md 已存在，未覆盖');
    await reloadInstructions();
    if (res.path) void window.cnke.shell.openPath(res.path);
  };

  // MCP + 技能
  const [mcpServers, setMcpServers] = useState<any[]>([]);
  const [mcpEditing, setMcpEditing] = useState<McpServerForm | null>(null);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  // MCP 连接详情：展开的工具列表 / 刷新加载态
  const [mcpExpanded, setMcpExpanded] = useState<Record<string, boolean>>({});
  const [mcpTools, setMcpTools] = useState<Record<string, any[]>>({});
  const [mcpToolsLoading, setMcpToolsLoading] = useState<Record<string, boolean>>({});
  // MCP 市场
  const [mcpSubTab, setMcpSubTab] = useState<'installed' | 'catalog'>('installed');
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [mcpCatalogLoading, setMcpCatalogLoading] = useState(false);

  const reloadMcpServers = async () => {
    setMcpServers(await window.cnke.mcp.listServers() || []);
  };

  const reloadMcpCatalog = async (forceRefresh = false) => {
    setMcpCatalogLoading(true);
    try {
      setMcpCatalog(await window.cnke.mcp.getCatalog(forceRefresh) || []);
    } finally {
      setMcpCatalogLoading(false);
    }
  };

  const reloadSkills = async (refresh = false) => {
    setSkillsLoading(true);
    try {
      setSkills(await (refresh ? window.cnke.skills.scan() : window.cnke.skills.list()));
    } catch (e: any) {
      // 扫描失败（目录不可读/IPC 异常）不能让加载态卡死，也不能抛未处理拒绝
      toast.error(e?.message || String(e));
    } finally {
      setSkillsLoading(false);
    }
  };

  const mcpDotClass = (s: any) => {
    if (s.status === 'connected') return 'bg-emerald-500';
    if (s.status === 'connecting') return 'bg-amber-400 animate-pulse';
    if (s.status === 'error') return 'bg-red-500';
    return 'bg-zinc-600';
  };

  const mcpStatusText = (s: any) => {
    switch (s.status) {
      case 'connected': return `已连接 · ${s.toolCount ?? 0} 个工具`;
      case 'connecting': return '连接中…';
      case 'error': return '连接失败';
      default: return s.enabled ? '未连接' : '已禁用';
    }
  };

  const toggleMcpExpand = async (id: string) => {
    const next = !mcpExpanded[id];
    setMcpExpanded((prev) => ({ ...prev, [id]: next }));
    if (next && !mcpTools[id]) {
      setMcpToolsLoading((prev) => ({ ...prev, [id]: true }));
      try {
        const tools = await window.cnke.mcp.listTools(id);
        setMcpTools((prev) => ({ ...prev, [id]: tools || [] }));
      } finally {
        setMcpToolsLoading((prev) => ({ ...prev, [id]: false }));
      }
    }
  };

  const refreshMcpTools = async (id: string) => {
    setMcpToolsLoading((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await window.cnke.mcp.refreshTools(id);
      if (res.success) {
        setMcpTools((prev) => ({ ...prev, [id]: res.tools || [] }));
      } else {
        toast.error(res.error || '刷新失败');
      }
      await reloadMcpServers();
    } finally {
      setMcpToolsLoading((prev) => ({ ...prev, [id]: false }));
    }
  };

  // 官方后台：内置模型 / 反馈
  const [officialModels, setOfficialModels] = useState<any[]>([]);
  const [officialLoading, setOfficialLoading] = useState(false);
  const [officialError, setOfficialError] = useState('');
  const [feedbackMsg, setFeedbackMsg] = useState('');
  const [feedbackContact, setFeedbackContact] = useState('');
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackHistory, setFeedbackHistory] = useState<any[]>([]);

  // 远程更新
  const [updateStatus, setUpdateStatus] = useState<any>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  // W14 修复：版本号从主进程动态读取，不再硬编码 "1.2.0"
  const [appVersion, setAppVersion] = useState<string>('1.2.0');

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const v = await window.cnke.app.getVersion();
        if (mounted && v) setAppVersion(v);
      } catch { /* 保持默认值 */ }
    })();
    return () => { mounted = false; };
  }, []);

  const checkUpdate = async () => {
    setUpdateChecking(true);
    // 不在此清空 updateStatus，避免「清空→推送→覆盖」三重驱动导致 UI 抖动。
    // 状态统一由主进程 update:status 事件推送（onStatus 订阅）驱动，此处仅做错误兜底。
    try {
      const res = await window.cnke.update.check('manual');
      if (!res.success) {
        setUpdateStatus({ phase: 'error', error: res.error, message: '检查更新失败' });
      } else if (!res.hasUpdate) {
        // 无更新时确保显示「已是最新」，与主进程推送保持一致
        setUpdateStatus((prev: any) => ({ ...prev, phase: 'not-available', version: res.version, message: '当前已是最新版本' }));
      } else if (res.hasUpdate) {
        // 有更新：自动开始下载（无需用户点击「下载」按钮），实现一键无感更新
        void downloadUpdate();
      }
    } catch (e: any) {
      setUpdateStatus({ phase: 'error', error: e?.message, message: '检查更新失败' });
    } finally {
      setUpdateChecking(false);
    }
  };

  const downloadUpdate = async () => {
    setUpdateDownloading(true);
    try {
      const res = await window.cnke.update.download('manual');
      if (!res.success) {
        setUpdateStatus((prev: any) => ({ ...prev, phase: 'error', error: res.error }));
      }
    } finally {
      setUpdateDownloading(false);
    }
  };

  const installUpdate = async () => {
    await window.cnke.update.install();
  };

  // 订阅更新状态推送（下载进度 / 安装状态）
  useEffect(() => {
    const off = window.cnke.update.onStatus((s: any) => {
      setUpdateStatus(s);
      if (s.phase === 'downloading') setUpdateDownloading(true);
      if (s.phase === 'downloaded' || s.phase === 'error' || s.phase === 'idle') setUpdateDownloading(false);
    });
    return off;
  }, []);

  const loadOfficialModels = async () => {
    setOfficialLoading(true);
    try {
      const res = await window.cnke.backend.getBuiltins();
      // 注意：res 可能因 IPC 通道未注册而整体不返回，这里必须显式捕获，
      // 否则失败会被静默吞掉，界面只剩「暂时无法获取官方模型」，无法区分
      // 「真的没网」和「通道/服务端异常」，排查成本极高。
      if (res?.success && Array.isArray(res.builtins)) {
        setOfficialModels(res.builtins);
        setOfficialError('');
      } else {
        setOfficialError(res?.error || '官方服务器返回异常');
      }
    } catch (e: any) {
      setOfficialError(e?.message || '无法连接官方服务器');
    } finally {
      setOfficialLoading(false);
    }
  };

  const loadFeedback = async () => {
    try {
      const res = await window.cnke.backend.listFeedback(0);
      if (res.success) setFeedbackHistory(res.items || []);
    } catch { /* 网络不可用静默 */ }
  };

  useEffect(() => {
    void window.cnke.config.getApiKeyConfigs().then((configs) => setApiConfigs((configs || []) as ApiConfig[]));
    void window.cnke.config.get('activeApiConfigId').then((id) => { if (typeof id === 'string') setActiveId(id); });
    void window.cnke.config.get('agentConfig').then((cfg) => { if (cfg && typeof cfg === 'object') setAgentCfg((a: any) => ({ ...a, ...cfg })); });
    void reloadMcpServers();
    void reloadSkills();
     
  }, []);

  // 切到 Agent 页时刷新「项目指令」清单（工作区切换后内容会变）
  useEffect(() => {
    if (tab === 'agent') {
      void reloadInstructions();
      // 白名单用多行文本编辑，进页面时从配置回填
      setCmdAllowText(((agentCfg.commandAllowlist as string[]) || []).join('\n'));
      setDomainAllowText(((agentCfg.domainAllowlist as string[]) || []).join('\n'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, workspacePath]);

  // 订阅 MCP 连接状态推送（后端主动推送，如启动恢复/连接结果/断线）
  useEffect(() => {
    const off = window.cnke.mcp.onStatusChanged((s: any) => {
      setMcpServers((prev) => prev.map((p) => (p.id === s.id ? { ...p, ...s } : p)));
    });
    return off;
  }, []);

  useEffect(() => {
    if (tab === 'models') void loadOfficialModels();
    if (tab === 'about') void loadFeedback();
  }, [tab]);

  const importOfficialModel = async (m: any) => {
    const localId = `official_${m.id}`;
    const existing = apiConfigs.find((c) => c.id === localId) || apiConfigs.find((c) => c.name === m.name);
    if (existing) {
      await window.cnke.config.set('activeApiConfigId', existing.id);
      setActiveId(existing.id);
      return toast.success(`已启用官方内置模型「${m.name}」`);
    }
    const cfg: ApiConfig = {
      id: localId,
      name: m.name || '官方模型',
      provider: m.provider || 'AI Platform',
      baseUrl: m.baseUrl,
      apiKey: m.apiKey || '',
      model: m.model,
    };
    const result = await window.cnke.config.saveApiConfig(cfg);
    if (result.success) {
      const list = ((await window.cnke.config.getApiKeyConfigs()) || []) as ApiConfig[];
      setApiConfigs(list);
      await window.cnke.config.set('activeApiConfigId', localId);
      setActiveId(localId);
      toast.success(`已导入并启用官方内置模型「${m.name}」`);
    } else {
      toast.error(result.error || '导入失败');
    }
  };

  const submitFeedback = async () => {
    const msg = feedbackMsg.trim();
    if (!msg) return;
    setFeedbackSending(true);
    try {
      const res = await window.cnke.backend.submitFeedback(msg, feedbackContact.trim());
      if (res.success) {
        setFeedbackMsg('');
        setFeedbackContact('');
        toast.success('反馈已提交，感谢你的支持！');
        void loadFeedback();
      } else {
        toast.error(res.error || '提交失败，请稍后重试');
      }
    } finally {
      setFeedbackSending(false);
    }
  };

  const saveAgentConfig = async () => {
    const current = (await window.cnke.config.get('agentConfig')) || {};
    const clamp = (value: unknown, min: number, max: number, fallback: number) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
    };
    const next = {
      ...current,
      ...agentCfg,
      mode: ['ask', 'craft', 'plan'].includes(agentCfg.mode) ? agentCfg.mode : 'plan',
      maxMode: !!agentCfg.maxMode,
      maxHistoryMessages: clamp(agentCfg.maxHistoryMessages, 2, 200, 20),
      maxTurns: clamp(agentCfg.maxTurns, 1, 100, 50),
      temperature: Math.min(2, Math.max(0, Number(agentCfg.temperature) || 0)),
      topP: Math.min(1, Math.max(0, Number(agentCfg.topP) || 0)),
      autoApproveTools: !!agentCfg.autoApproveTools,
      enableRouting: agentCfg.enableRouting !== false,
      // 只保留合法任务键与有效配置 id，避免脏键写入 agentConfig
      routing: Object.fromEntries(
        ROUTING_TASKS
          .map((t) => [t.key, (agentCfg.routing || {})[t.key] as unknown])
          .filter(([, v]) => typeof v === 'string' && v)
      ),
      toolConcurrency: clamp(agentCfg.toolConcurrency, 1, 8, 4),
      maxRetries: clamp(agentCfg.maxRetries, 0, 5, 3),
      llmTimeoutMs: clamp(agentCfg.llmTimeoutMs, 10000, 300000, 60000),
      maxCommandOutputKB: clamp(agentCfg.maxCommandOutputKB, 50, 4096, 400),
      pythonPath: String(agentCfg.pythonPath || '').trim(),
      fallbackModelIds: Array.isArray(agentCfg.fallbackModelIds) ? agentCfg.fallbackModelIds : [],
      enableInlineCompletion: agentCfg.enableInlineCompletion !== false,
      browserAutomation: { enabled: agentCfg.browserAutomation?.enabled !== false },
      imageGeneration: {
        enabled: !!agentCfg.imageGeneration?.enabled,
        apiConfigId: typeof agentCfg.imageGeneration?.apiConfigId === 'string' ? agentCfg.imageGeneration.apiConfigId : '',
      },
      useProjectInstructions: agentCfg.useProjectInstructions !== false,
      projectInstructionsBudget: clamp(agentCfg.projectInstructionsBudget, 2000, 60000, 24000),
      permissionMode: ['read-only', 'standard', 'full-access'].includes(agentCfg.permissionMode)
        ? agentCfg.permissionMode
        : 'standard',
      commandAllowlist: (Array.isArray(agentCfg.commandAllowlist) ? agentCfg.commandAllowlist : [])
        .map((s: string) => String(s).trim())
        .filter(Boolean),
      domainAllowlist: (Array.isArray(agentCfg.domainAllowlist) ? agentCfg.domainAllowlist : [])
        .map((s: string) => String(s).trim())
        .filter(Boolean),
    };
    await window.cnke.config.set('agentConfig', next);
    setAgentCfg(next);
    toast.success('Agent 设置已保存');
  };

  const saveApiConfig = async () => {
    if (!editing) return;
    const result = await window.cnke.config.saveApiConfig(editing);
    if (result.success) {
      setApiConfigs(((await window.cnke.config.getApiKeyConfigs()) || []) as ApiConfig[]);
      setEditing(null);
    } else {
      toast.error(result.error);
    }
  };

  // 切换厂商时，自动同步切换对应厂商的最新 Base URL（优先官方内置列表，其次静态默认）
  const onProviderChange = (provider: string) => {
    if (!editing) return;
    const official = officialModels.find((m: any) => m.provider === provider && m.baseUrl);
    const fallback = PROVIDERS.find((p) => p.id === provider)?.baseUrl ?? '';
    const baseUrl = official?.baseUrl || fallback;
    setEditing({ ...editing, provider, baseUrl });
  };

  const deleteApiConfig = async (id: string) => {
    await window.cnke.config.deleteApiConfig(id);
    setApiConfigs(((await window.cnke.config.getApiKeyConfigs()) || []) as ApiConfig[]);
    if (activeId === id) setActiveId('');
  };

  const activateApiConfig = async (id: string) => {
    setActiveId(id);
    await window.cnke.config.set('activeApiConfigId', id);
    await window.cnke.config.syncBuiltins();
    setApiConfigs(((await window.cnke.config.getApiKeyConfigs()) || []) as ApiConfig[]);
    // 切换模型后自动关闭设置弹窗，让焦点归还对话输入框，避免输入框被遮罩层挡住而"卡死"
    setSettingsOpen(false);
  };

  const saveMcpServer = async () => {
    if (!mcpEditing) return;
    const payload: any = {
      id: mcpEditing.id || crypto.randomUUID(),
      name: mcpEditing.name,
      protocol: mcpEditing.protocol,
      enabled: mcpEditing.enabled,
    };
    if (mcpEditing.protocol === 'stdio') {
      payload.command = mcpEditing.command;
      payload.args = mcpEditing.args.split(/\s+/).filter(Boolean);
    } else {
      payload.url = mcpEditing.url;
    }
    const res = await window.cnke.mcp.addServer(payload);
    if (!res.success) {
      toast.error(res.error || '保存失败');
      return;
    }
    await reloadMcpServers();
    setMcpEditing(null);
    // 勾选「立即启用」时连接为异步过程，成功/失败结果会通过状态推送更新列表
  };

  const toggleSkill = async (skill: SkillView) => {
    const result = await window.cnke.skills.setEnabled(skill.id, !skill.enabled);
    if (result.success) {
      setSkills(result.skills);
    } else {
      toast.error(result.error || '更新技能状态失败');
    }
  };

  const tabs: { id: TabKey; label: string; icon: React.ReactNode }[] = [
    { id: 'models', label: '模型配置', icon: <Cpu className="w-4 h-4" /> },
    { id: 'agent', label: 'Agent 设置', icon: <KeyRound className="w-4 h-4" /> },
    { id: 'skills', label: '技能/MCP 市场', icon: <LayoutTemplate className="w-4 h-4" /> },
    { id: 'appearance', label: '外观主题', icon: <Sparkles className="w-4 h-4" /> },
    { id: 'about', label: '关于', icon: <Info className="w-4 h-4" /> },
  ];

  return (
    <div className="overlay-mask z-40" onClick={() => setSettingsOpen(false)}>
      <div
        className="settings-sheet glass-strong w-[780px] max-w-[94vw] max-h-[86vh] flex overflow-hidden rounded-[22px] animate-pop-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 侧边栏：半透明侧板，与内容区之间用极淡高光线分隔 */}
        <div className="w-[172px] shrink-0 p-2.5 flex flex-col gap-0.5 border-r border-white/[0.07] bg-white/[0.02]">
          <div className="flex items-center justify-between px-2.5 pb-2 pt-1.5">
            <span className="text-[13px] font-semibold tracking-[0.01em]">设置</span>
            <button
              onClick={() => setSettingsOpen(false)}
              className="icon-btn"
              title="关闭设置"
              aria-label="关闭设置"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`settings-tab ${tab === t.id ? 'settings-tab--active' : ''}`}
            >
              <span className="shrink-0 opacity-90">{t.icon}</span>
              <span className="truncate">{t.label}</span>
            </button>
          ))}
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'appearance' && (
            <section className="space-y-5" aria-labelledby="appearance-heading">
              <div>
                <h3 id="appearance-heading" className="text-base font-semibold">让工作空间，成为你的风格</h3>
                <p className="mt-2 text-xs text-muted-foreground">选择即刻生效，自动保存。标题栏也可快速轮换主题。</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" role="group" aria-label="界面主题">
                {THEMES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={theme === item.id}
                    onClick={() => setTheme(item.id)}
                    className={`rounded-xl border p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${theme === item.id ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
                  >
                    <div className="h-28 rounded-lg overflow-hidden border" style={{ backgroundColor: item.background, borderColor: `${item.foreground}26` }} aria-hidden="true">
                      <div className="h-5 border-b flex items-center gap-1 px-2" style={{ borderColor: `${item.foreground}26` }}>
                        {[item.accent, item.secondary, item.foreground].map((color) => <span key={color} className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />)}
                      </div>
                      <div className="flex h-24">
                        <div className="w-7 shrink-0 border-r" style={{ backgroundColor: `${item.accent}12`, borderColor: `${item.foreground}26` }} />
                        <div className="flex-1 space-y-2 p-3">
                          <div className="h-1.5 w-3/4 rounded" style={{ backgroundColor: item.accent }} />
                          <div className="h-1 w-full rounded opacity-70" style={{ backgroundColor: item.foreground }} />
                          <div className="h-1 w-1/2 rounded" style={{ backgroundColor: item.secondary }} />
                          <div className="h-3 w-8 rounded" style={{ backgroundColor: item.accent }} />
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-1 text-xs font-semibold">
                      {item.label}
                      {theme === item.id && <span className="text-primary text-[10px]">已启用</span>}
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">{item.description}</p>
                  </button>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">新增星云紫、森境、琥珀夜、冰川与樱雾，覆盖深空、自然、暖金与清透浅色风格。共 {THEMES.length} 套主题均可即时切换，编辑器、对话代码块、终端与玻璃面板同步配色，不影响当前文件和任务。</p>
            </section>
          )}
          {/* ===== 模型配置 ===== */}
          {tab === 'models' && (
            <div>
              {/* 官方内置模型 */}
              <div className="mb-5">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Cloud className="w-4 h-4 text-cyan-400" />
                    <h3 className="text-sm font-semibold text-cyan-300">官方内置模型</h3>
                  </div>
                  <button
                    onClick={() => void loadOfficialModels()}
                    disabled={officialLoading}
                    className="flex items-center gap-1 text-[11px] border border-border rounded-md px-2 py-1 hover:bg-accent/60 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${officialLoading ? 'animate-spin' : ''}`} />
                    刷新
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground mb-2">从 CnkeIDE 官方服务器拉取，点击一键导入并设为当前模型（无需填写 API Key）</p>
                {officialLoading && officialModels.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-4 border border-dashed border-border rounded-lg">正在从官方服务器加载…</div>
                ) : officialModels.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-4 border border-dashed border-border rounded-lg">
                    暂时无法获取官方模型
                    {officialError ? (
                      <div className="mt-1 text-[10px] text-amber-400/90 break-all">{officialError}</div>
                    ) : (
                      <div className="mt-1 text-[10px] opacity-70">请检查网络后点击右上角「刷新」重试</div>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {officialModels.map((m) => (
                      <div
                        key={m.id}
                        onClick={() => void importOfficialModel(m)}
                        className="border border-border rounded-lg p-2.5 cursor-pointer transition-all hover:border-cyan-400/50 hover:bg-cyan-400/5 group"
                        title="点击导入并使用"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <div className="w-1.5 h-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-violet-400 shrink-0" />
                            <span className="text-xs font-semibold truncate">{m.name}</span>
                          </div>
                          <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400 shrink-0">官方</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate mt-1 font-mono">{m.model}</div>
                        <div className="text-[9px] text-muted-foreground/70 truncate">{m.provider}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between mb-3 border-t border-border pt-4">
                <h3 className="text-sm font-semibold">我的 API 配置</h3>
                <button
                  onClick={() => setEditing({ id: '', name: '', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat' })}
                  className="flex items-center gap-1 text-xs bg-primary text-primary-foreground px-2.5 py-1.5 rounded-md hover:bg-primary/80 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  添加
                </button>
              </div>

              <div className="space-y-2 mb-4">
                {apiConfigs.length === 0 && (
                  <div className="text-xs text-muted-foreground text-center py-6 border border-dashed border-border rounded-lg">暂无模型配置，点击右上角添加</div>
                )}
                {apiConfigs.map((cfg) => {
                  const isOfficial = cfg.id.startsWith('official_');
                  return (
                  <div
                    key={cfg.id}
                    className={`flex items-center justify-between border rounded-lg px-3 py-2.5 cursor-pointer transition-colors ${activeId === cfg.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40'}`}
                    onClick={() => void activateApiConfig(cfg.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold">{cfg.name || cfg.provider || '未命名'}</span>
                        {activeId === cfg.id && <span className="text-[10px] bg-primary/20 text-primary rounded px-1.5 py-0.5">当前</span>}
                        {isOfficial && <span className="text-[9px] px-1 py-0.5 rounded bg-cyan-500/15 text-cyan-400">官方云端</span>}
                      </div>
                      {!isOfficial && <div className="text-[11px] text-muted-foreground truncate mt-0.5">{cfg.baseUrl} · {cfg.model}</div>}
                    </div>
                    {!isOfficial && (
                      <div className="flex items-center gap-1 ml-2">
                        <button onClick={(e) => { e.stopPropagation(); setEditing({ ...cfg }); }} className="p-1.5 hover:bg-accent hover:text-foreground rounded transition-colors" title="编辑 / 查看 API 地址">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); void deleteApiConfig(cfg.id); }} className="p-1.5 hover:bg-red-500/20 hover:text-red-400 rounded transition-colors" title="删除">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>

              {editing && (
                <div className="border border-primary/30 rounded-lg p-3 bg-secondary/20 space-y-2.5">
                  <h4 className="text-xs font-semibold text-primary">{editing.id ? '编辑配置' : '添加配置'}</h4>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="text-[11px] text-muted-foreground">配置名称</label>
                      <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="如：DeepSeek 主用" className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary" />
                    </div>
                    <div>
                      <label className="text-[11px] text-muted-foreground">提供商</label>
                      <select value={editing.provider} onChange={(e) => onProviderChange(e.target.value)} className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary">
                        {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] text-muted-foreground">Base URL</label>
                    <input value={editing.baseUrl} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} placeholder="https://api.deepseek.com" className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary font-mono" />
                  </div>
                  <div>
                    <label className="text-[11px] text-muted-foreground">API Key</label>
                    <input type="password" value={editing.apiKey} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} placeholder="sk-..." className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary font-mono" />
                  </div>
                  <div>
                    <label className="text-[11px] text-muted-foreground">模型</label>
                    <input value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })} placeholder="deepseek-chat" className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary font-mono" />
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-accent transition-colors">取消</button>
                    <button onClick={() => void saveApiConfig()} className="flex items-center gap-1 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/80 transition-colors">
                      <Save className="w-3 h-3" /> 保存
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ===== Agent 设置 ===== */}
          {tab === 'agent' && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold mb-3">Agent 行为设置</h3>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-[11px] text-muted-foreground">默认工作模式</label>
                  <select value={agentCfg.mode ?? 'plan'} onChange={(e) => setAgentCfg({ ...agentCfg, mode: e.target.value })} className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary">
                    <option value="ask">问答：只读分析，不修改文件</option>
                    <option value="craft">快速：直接执行修改</option>
                    <option value="plan">深度：先规划再执行</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">备用模型（主模型失败后依次尝试）</label>
                  <select
                    multiple
                    value={agentCfg.fallbackModelIds || []}
                    onChange={(e) => setAgentCfg({ ...agentCfg, fallbackModelIds: Array.from(e.target.selectedOptions).map((option) => option.value).slice(0, 3) })}
                    className="mt-0.5 h-[72px] w-full bg-background border border-border rounded-md px-2 py-1 text-xs outline-none focus:border-primary"
                  >
                    {apiConfigs.filter((cfg) => cfg.id !== activeId).map((cfg) => (
                      <option key={cfg.id} value={cfg.id}>{cfg.name || cfg.model}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground">回复格式（注入给模型的排版规范）</label>
                <select value={agentCfg.replyFormat ?? 'structured'} onChange={(e) => setAgentCfg({ ...agentCfg, replyFormat: e.target.value })} className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary">
                  <option value="structured">结构化 Markdown（默认）— 标题/列表/代码块排版，先结论后展开</option>
                  <option value="plain">简洁纯文本 — 不加排版约束</option>
                </select>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground">自定义系统提示词（附加在角色提示词之后）</label>
                <textarea value={agentCfg.systemPrompt} onChange={(e) => setAgentCfg({ ...agentCfg, systemPrompt: e.target.value })} rows={4} placeholder="附加的系统提示词..." className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary resize-y" />
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="text-[11px] text-muted-foreground">历史消息保留数</label>
                  <input type="number" min="2" max="200" value={agentCfg.maxHistoryMessages ?? 20} onChange={(e) => setAgentCfg({ ...agentCfg, maxHistoryMessages: Number(e.target.value) })} className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary" />
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">工具并发数</label>
                  <input type="number" min="1" max="8" value={agentCfg.toolConcurrency ?? 4} onChange={(e) => setAgentCfg({ ...agentCfg, toolConcurrency: Number(e.target.value) })} className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary" />
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">失败重试次数</label>
                  <input type="number" min="0" max="5" value={agentCfg.maxRetries ?? 3} onChange={(e) => setAgentCfg({ ...agentCfg, maxRetries: Number(e.target.value) })} className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary" />
                </div>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground">单次模型请求超时（秒）</label>
                <input type="number" min="10" max="300" value={Math.round((agentCfg.llmTimeoutMs ?? 60000) / 1000)} onChange={(e) => setAgentCfg({ ...agentCfg, llmTimeoutMs: Number(e.target.value) * 1000 })} className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary" />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground">单条命令输出上限（KB）</label>
                <input type="number" min="50" max="4096" value={agentCfg.maxCommandOutputKB ?? 400} onChange={(e) => setAgentCfg({ ...agentCfg, maxCommandOutputKB: Number(e.target.value) })} className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary" />
                <p className="mt-1 text-[10px] text-muted-foreground/70">超出部分自动丢弃并提示模型，避免全盘扫描类命令把界面撑白。默认 400 KB，越小越省内存。</p>
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground">Python 解释器路径（可选）</label>
                <input type="text" value={agentCfg.pythonPath ?? ''} onChange={(e) => setAgentCfg({ ...agentCfg, pythonPath: e.target.value })} placeholder="留空自动探测：项目 .venv > 内置 > 系统 python" className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary" />
                <p className="mt-1 text-[10px] text-muted-foreground/70">供 run_python 使用；脚本输出自动 UTF-8 + 无缓冲，失败返回结构化 traceback。</p>
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="text-[11px] text-muted-foreground">最大迭代轮数</label>
                  <input type="number" value={agentCfg.maxTurns} onChange={(e) => setAgentCfg({ ...agentCfg, maxTurns: Number(e.target.value) })} className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary" />
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">Temperature</label>
                  <input type="number" step="0.1" min="0" max="2" value={agentCfg.temperature} onChange={(e) => setAgentCfg({ ...agentCfg, temperature: Number(e.target.value) })} className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary" />
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">Top P</label>
                  <input type="number" step="0.1" min="0" max="1" value={agentCfg.topP} onChange={(e) => setAgentCfg({ ...agentCfg, topP: Number(e.target.value) })} className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary" />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-1.5 rounded-lg border border-border bg-secondary/20 p-2.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!agentCfg.maxMode} onChange={(e) => setAgentCfg({ ...agentCfg, maxMode: e.target.checked })} className="accent-primary" />
                  <span className="text-xs">Max 模式：保留完整对话历史（关闭时按上方条数裁剪）</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={agentCfg.enableRouting !== false} onChange={(e) => {
                    const checked = e.target.checked;
                    setAgentCfg({ ...agentCfg, enableRouting: checked });
                    // 与模型下拉的 AUTO 保持一致：勾选=自动路由，取消=固定当前模型
                    // （只改 enableRouting 会让开关看起来"无效"，因为路由还要求 modelSelectionMode=auto）
                    void window.cnke.config.set('modelSelectionMode', checked ? 'auto' : 'manual');
                  }} className="accent-primary" />
                  <span className="text-xs">智能模型路由：按任务在内置模型中选择合适模型</span>
                </label>
                {agentCfg.enableRouting !== false && (
                  <div className="rounded-lg border border-border bg-background/40 p-2.5">
                    <p className="text-[11px] text-muted-foreground">任务 → 模型映射（仅内置模型；留空表示跟随 AUTO 自动选档）</p>
                    <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                      {ROUTING_TASKS.map((t) => {
                        const routing = (agentCfg.routing && typeof agentCfg.routing === 'object' ? agentCfg.routing : {}) as Record<string, string>;
                        return (
                          <label key={t.key} className="flex items-center gap-1.5 text-[11px]">
                            <span className="w-14 shrink-0 text-muted-foreground">{t.label}</span>
                            <select
                              value={routing[t.key] || ''}
                              onChange={(e) => {
                                const nextRouting: Record<string, string> = { ...routing };
                                if (e.target.value) nextRouting[t.key] = e.target.value;
                                else delete nextRouting[t.key];
                                setAgentCfg({ ...agentCfg, routing: nextRouting });
                              }}
                              className="min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 py-1 text-[11px] outline-none focus:border-primary"
                            >
                              <option value="">AUTO 自动选档</option>
                              {apiConfigs
                                .filter((c) => !c.disabled && (c.id.startsWith('official_') || c.builtin === true))
                                .map((c) => <option key={c.id} value={c.id}>{c.name || c.model}</option>)}
                            </select>
                          </label>
                        );
                      })}
                    </div>
                    {apiConfigs.filter((c) => !c.disabled && (c.id.startsWith('official_') || c.builtin === true)).length === 0 && (
                      <p className="mt-1.5 text-[10px] text-amber-500/90">暂无内置模型可选，请先在「模型」页导入官方模型；自定义中转不参与 AUTO 路由。</p>
                    )}
                  </div>
                )}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!agentCfg.autoApproveTools} onChange={(e) => setAgentCfg({ ...agentCfg, autoApproveTools: e.target.checked })} className="accent-primary" />
                  <span className="text-xs">自动批准工具调用（不弹确认框）</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={agentCfg.enableInlineCompletion !== false} onChange={(e) => setAgentCfg({ ...agentCfg, enableInlineCompletion: e.target.checked })} className="accent-primary" />
                  <span className="text-xs">AI 行内补全：编辑器内光标停顿给出续写建议（Tab 接受 / Esc 拒绝）</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={agentCfg.browserAutomation?.enabled !== false} onChange={(e) => setAgentCfg({ ...agentCfg, browserAutomation: { ...agentCfg.browserAutomation, enabled: e.target.checked } })} className="accent-primary" />
                  <span className="text-xs">启用浏览器自动化（需本机已安装 Chromium）</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!agentCfg.imageGeneration?.enabled} onChange={(e) => setAgentCfg({ ...agentCfg, imageGeneration: { ...agentCfg.imageGeneration, enabled: e.target.checked } })} className="accent-primary" />
                  <span className="text-xs">启用图片生成（DALL-E 兼容接口）</span>
                </label>
                {agentCfg.imageGeneration?.enabled && (
                  <label className="flex items-center gap-2 text-xs">
                    <span className="shrink-0">图片 API</span>
                    <select value={agentCfg.imageGeneration?.apiConfigId || activeId || ''} onChange={(e) => setAgentCfg({ ...agentCfg, imageGeneration: { ...agentCfg.imageGeneration, apiConfigId: e.target.value } })} className="min-w-0 flex-1 bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary">
                      <option value="">当前启用模型</option>
                      {apiConfigs.map((cfg) => <option key={cfg.id} value={cfg.id}>{cfg.name || cfg.model}</option>)}
                    </select>
                  </label>
                )}
              </div>
              {/* 权限档位：决定 Agent 能动到什么程度 */}
              <div className="space-y-2 rounded-lg border border-border bg-secondary/20 p-2.5">
                <div className="min-w-0">
                  <h4 className="flex items-center gap-1 text-xs font-semibold">
                    <ShieldCheck className="w-3 h-3" /> 权限档位
                  </h4>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    决定 Agent 动手的边界。只读档连确认弹窗都不弹，直接把写文件与执行命令拦回去。
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {[
                    { key: 'read-only', label: '只读', hint: '只能看', detail: PERMISSION_MODE_INFO['read-only'].detail },
                    { key: 'standard', label: '标准', hint: '改文件放行', detail: PERMISSION_MODE_INFO.standard.detail },
                    { key: 'full-access', label: '完全访问', hint: '全部放行', detail: PERMISSION_MODE_INFO['full-access'].detail },
                  ].map((item) => {
                    const active = (agentCfg.permissionMode || 'standard') === item.key;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => setAgentCfg({ ...agentCfg, permissionMode: item.key })}
                        className={`rounded-md border px-2 py-1.5 text-center transition-colors ${
                          active ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent/50'
                        }`}
                      >
                        <div className="text-[11px] font-medium">{item.label}</div>
                        <div className="text-[9px] text-muted-foreground">{item.hint}</div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[9px] leading-relaxed text-muted-foreground">
                  {PERMISSION_MODE_INFO[(agentCfg.permissionMode || 'standard') as keyof typeof PERMISSION_MODE_INFO]?.detail}
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-[10px] text-muted-foreground">命令白名单（每行一条，命中即放行）</span>
                    <textarea
                      value={cmdAllowText}
                      onChange={(e) => {
                        const text = e.target.value;
                        setCmdAllowText(text);
                        setAgentCfg({
                          ...agentCfg,
                          commandAllowlist: text.split('\n').map((s) => s.trim()).filter(Boolean),
                        });
                      }}
                      rows={3}
                      spellCheck={false}
                      placeholder={'git status\nnpm test\ngit *'}
                      className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] outline-none focus:border-primary"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[10px] text-muted-foreground">域名白名单（留空不限制联网）</span>
                    <textarea
                      value={domainAllowText}
                      onChange={(e) => {
                        const text = e.target.value;
                        setDomainAllowText(text);
                        setAgentCfg({
                          ...agentCfg,
                          domainAllowlist: text.split('\n').map((s) => s.trim()).filter(Boolean),
                        });
                      }}
                      rows={3}
                      spellCheck={false}
                      placeholder={'github.com\n*.npmjs.org\napi.github.com/v1'}
                      className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] outline-none focus:border-primary"
                    />
                  </label>
                </div>
                <p className="text-[9px] text-muted-foreground">
                  命令填前缀（npm test 也放行 npm test --coverage）或通配（git *）；域名填 example.com 含子域，*.example.com 含裸域，带 / 时按路径前缀匹配。改完点下方保存生效。
                </p>
              </div>
              {/* 项目指令：按目录层级读取 AGENTS.md / CNKE.md 并注入 systemPrompt */}
              <div className="space-y-2 rounded-lg border border-border bg-secondary/20 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="flex items-center gap-1 text-xs font-semibold">
                      <ScrollText className="w-3 h-3" /> 项目指令（AGENTS.md）
                    </h4>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      仓库自己的约定按目录层级自动读取并注入，换仓库自动切换，不用每轮重复交代。
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => void reloadInstructions()}
                      disabled={instructionsLoading || !workspacePath}
                      className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${instructionsLoading ? 'animate-spin' : ''}`} /> 刷新
                    </button>
                    <button
                      onClick={() => void createInstructionFile()}
                      className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] hover:bg-accent"
                    >
                      <Plus className="w-3 h-3" /> 生成模板
                    </button>
                  </div>
                </div>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={agentCfg.useProjectInstructions !== false}
                    onChange={(e) => setAgentCfg({ ...agentCfg, useProjectInstructions: e.target.checked })}
                    className="accent-primary"
                  />
                  <span className="text-xs">自动加载项目指令文件（AGENTS.md / CNKE.md，含子目录，保存后生效）</span>
                </label>
                {!workspacePath ? (
                  <p className="text-[10px] text-muted-foreground">未打开工作区，无法加载项目指令。</p>
                ) : instructionsLoading && !instructions ? (
                  <p className="text-[10px] text-muted-foreground">正在扫描工作区…</p>
                ) : !instructions || instructions.files.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground">
                    当前工作区没有 AGENTS.md。点「生成模板」创建一份，写明构建/测试命令与代码约定即可。
                  </p>
                ) : (
                  <div className="space-y-1">
                    {instructions.files.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        title={file.path}
                        onClick={() => void window.cnke.shell.openPath(file.path)}
                        className="flex w-full items-center gap-2 rounded border border-border/60 bg-background/60 px-2 py-1 text-left hover:bg-accent/40"
                      >
                        <span className="truncate text-[11px]">{file.relPath}</span>
                        {file.depth > 0 && (
                          <span className="shrink-0 rounded bg-secondary px-1 text-[9px] text-muted-foreground">子目录</span>
                        )}
                        {file.truncated && (
                          <span className="shrink-0 rounded bg-amber-500/20 px-1 text-[9px] text-amber-500">已截断</span>
                        )}
                        <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{formatBytes(file.bytes)}</span>
                      </button>
                    ))}
                    <p className="text-[9px] text-muted-foreground">
                      共 {instructions.files.length} 个文件 · 注入 {formatBytes(instructions.totalBytes)} · 预算{' '}
                      {formatBytes(agentCfg.projectInstructionsBudget ?? 24000)}
                      {instructions.skipped.length > 0 ? ` · 跳过 ${instructions.skipped.length} 个` : ''}
                    </p>
                  </div>
                )}
                {instructions?.error && <p className="text-[9px] text-red-400">{instructions.error}</p>}
              </div>
              <button onClick={() => void saveAgentConfig()} className="flex items-center gap-1 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/80 transition-colors">
                <Save className="w-3 h-3" /> 保存 Agent 设置
              </button>
            </div>
          )}

          {/* ===== 技能/MCP 市场 ===== */}
          {tab === 'skills' && (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2 gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">技能市场</h3>
                    <p className="text-[10px] text-muted-foreground mt-0.5">提示词技能会叠加；本地技能包仅按需提供入口指引。</p>
                  </div>
                  <button
                    onClick={() => void reloadSkills(true)}
                    disabled={skillsLoading}
                    className="flex items-center gap-1 text-[11px] border border-border rounded px-2 py-1 hover:bg-accent disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${skillsLoading ? 'animate-spin' : ''}`} /> 刷新
                  </button>
                </div>
                {skills.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-5 border border-dashed border-border rounded-lg">未发现可用技能</div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {skills.map((skill) => (
                      <button
                        type="button"
                        key={skill.id}
                        onClick={() => void toggleSkill(skill)}
                        disabled={skill.available === false}
                        className={`text-left border rounded-lg p-2.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${skill.enabled ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent/40'}`}
                      >
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${skill.enabled ? 'bg-primary' : 'bg-muted-foreground'}`} />
                          <span className="text-xs font-semibold truncate">{skill.name}</span>
                          <span className="ml-auto text-[9px] text-muted-foreground">{skill.kind === 'prompt' ? '提示词' : '本地包'}</span>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-1 leading-snug">{skill.description}</p>
                        {skill.version && <p className="text-[9px] text-muted-foreground mt-1">v{skill.version} · {skill.source === 'bundled' ? '随应用安装' : '本地发现'}</p>}
                        {skill.error && <p className="text-[9px] text-red-400 mt-1">{skill.error}</p>}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-border pt-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1 bg-secondary rounded-md p-0.5">
                    <button
                      onClick={() => setMcpSubTab('installed')}
                      className={`px-2.5 py-1 text-[11px] rounded transition-colors ${mcpSubTab === 'installed' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      已装服务器 ({mcpServers.length})
                    </button>
                    <button
                      onClick={() => { setMcpSubTab('catalog'); if (mcpCatalog.length === 0) void reloadMcpCatalog(); }}
                      className={`px-2.5 py-1 text-[11px] rounded transition-colors ${mcpSubTab === 'catalog' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      MCP 市场
                    </button>
                  </div>
                  {mcpSubTab === 'installed' ? (
                    <button
                      onClick={() => setMcpEditing({ id: '', name: '', protocol: 'stdio', command: '', args: '', url: '', enabled: true })}
                      className="flex items-center gap-1 text-xs bg-primary text-primary-foreground px-2 py-1 rounded-md hover:bg-primary/80 transition-colors"
                    >
                      <Plus className="w-3 h-3" /> 添加
                    </button>
                  ) : (
                    <button
                      onClick={() => void reloadMcpCatalog(true)}
                      disabled={mcpCatalogLoading}
                      className="flex items-center gap-1 text-[11px] border border-border rounded px-2 py-1 hover:bg-accent disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${mcpCatalogLoading ? 'animate-spin' : ''}`} /> 刷新目录
                    </button>
                  )}
                </div>

                {/* 已装服务器 */}
                {mcpSubTab === 'installed' && (
                  <>
                    {mcpServers.length === 0 ? (
                      <div className="text-xs text-muted-foreground text-center py-5 border border-dashed border-border rounded-lg">暂无 MCP 服务器配置，点击右上角添加或从 MCP 市场安装</div>
                    ) : (
                      <div className="space-y-2">
                        {mcpServers.map((s) => (
                          <div key={s.id} className={`border rounded-lg overflow-hidden transition-colors ${mcpExpanded[s.id] ? 'border-primary/40 bg-secondary/10' : 'border-border'}`}>
                            <div className="flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-accent/30 transition-colors" onClick={() => void toggleMcpExpand(s.id)}>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  {mcpExpanded[s.id]
                                    ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                    : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                                  <span className={`w-2 h-2 rounded-full shrink-0 ${mcpDotClass(s)}`} />
                                  <span className="text-xs font-semibold">{s.name}</span>
                                  <span className="text-[10px] px-1 py-0.5 rounded bg-secondary text-muted-foreground shrink-0">{s.protocol}</span>
                                </div>
                                <div className="text-[11px] text-muted-foreground truncate mt-0.5 pl-5">{s.command ? `${s.command} ${(Array.isArray(s.args) ? s.args.join(' ') : typeof s.args === 'string' ? s.args : '')}` : s.url}</div>
                                <div className={`text-[11px] mt-0.5 pl-5 ${s.status === 'error' ? 'text-red-400' : 'text-muted-foreground'}`}>
                                  {s.status === 'error' ? `⚠ ${s.error || mcpStatusText(s)}` : mcpStatusText(s)}
                                </div>
                              </div>
                              <div className="flex items-center gap-1 ml-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                                <button
                                  onClick={() => { void (async () => {
                                    const r = await window.cnke.mcp.toggleServer(s.id, !s.enabled);
                                    if (!r.success) toast.error(r.error || '操作失败');
                                    await reloadMcpServers();
                                  })(); }}
                                  className={`px-2 py-1 text-[11px] rounded-md transition-colors ${s.enabled ? 'bg-secondary text-muted-foreground hover:bg-accent' : 'bg-primary/20 text-primary hover:bg-primary/30'}`}
                                >
                                  {s.enabled ? '禁用' : '启用'}
                                </button>
                                <button
                                  onClick={() => void refreshMcpTools(s.id)}
                                  disabled={mcpToolsLoading[s.id]}
                                  className="p-1.5 hover:bg-accent rounded transition-colors disabled:opacity-50"
                                  title={s.status === 'error' ? '重新连接并获取工具' : '刷新工具列表'}
                                >
                                  <RefreshCw className={`w-3.5 h-3.5 ${mcpToolsLoading[s.id] ? 'animate-spin' : ''}`} />
                                </button>
                                <button onClick={() => setMcpEditing({ id: s.id, name: s.name, protocol: s.protocol, command: s.command || '', args: (Array.isArray(s.args) ? s.args.join(' ') : typeof s.args === 'string' ? s.args : ''), url: s.url || '', enabled: s.enabled })} className="p-1.5 hover:bg-accent rounded transition-colors" title="编辑">
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => { void (async () => { await window.cnke.mcp.removeServer(s.id); await reloadMcpServers(); })(); }} className="p-1.5 hover:bg-red-500/20 hover:text-red-400 rounded transition-colors" title="删除">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                            {mcpExpanded[s.id] && (
                              <div className="border-t border-border px-3 py-2.5 space-y-2">
                                {mcpToolsLoading[s.id] ? (
                                  <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                                    <RefreshCw className="w-3 h-3 animate-spin" /> 获取工具中…
                                  </div>
                                ) : (
                                  <>
                                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                      <Wrench className="w-3 h-3" />
                                      已发现工具（{(mcpTools[s.id] || []).length}）
                                    </div>
                                    {(mcpTools[s.id] || []).length === 0 ? (
                                      <div className="text-[11px] text-muted-foreground/80 text-center py-2 border border-dashed border-border rounded">
                                        {s.status === 'connected' ? '服务器未返回任何工具' : '服务器未连接，点右侧刷新按钮连接并获取工具'}
                                      </div>
                                    ) : (
                                      <div className="max-h-44 overflow-y-auto space-y-1">
                                        {(mcpTools[s.id] || []).map((t) => (
                                          <div key={t.name} className="flex items-center gap-2 bg-background/60 border border-border/60 rounded px-2 py-1" title={t.description || ''}>
                                            <span className="text-[11px] font-mono text-cyan-300 shrink-0">{t.name}</span>
                                            <span className="text-[10px] text-muted-foreground truncate">{t.description || '无描述'}</span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {(s.status === 'error' || s.error) && (
                                      <div className="text-[11px] text-red-400/90 border border-red-500/20 bg-red-500/5 rounded px-2 py-1.5 whitespace-pre-wrap break-all">
                                        {s.error}
                                        {s.lastStderr ? `\n[stderr]\n${s.lastStderr.slice(-800)}` : ''}
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* MCP 市场 */}
                {mcpSubTab === 'catalog' && (
                  <>
                    {mcpCatalogLoading ? (
                      <div className="text-xs text-muted-foreground text-center py-8 flex items-center justify-center gap-2">
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" /> 正在加载 MCP 目录…
                      </div>
                    ) : mcpCatalog.length === 0 ? (
                      <div className="text-xs text-muted-foreground text-center py-5 border border-dashed border-border rounded-lg">
                        目录为空，点击右上角"刷新目录"重试（离线预设始终可用）
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-3 max-h-[440px] overflow-y-auto pr-1">
                        {mcpCatalog.map((entry) => {
                          const installed = mcpServers.some((s: any) =>
                            (entry.source === 'builtin'
                              ? s.command === entry.installConfig.command && (s.args || '').includes(entry.installConfig.args?.split(' ')[0] || '')
                              : s.url === entry.installConfig.url)
                          );
                          return (
                            <div key={entry.id} className="min-w-0 border border-border/80 bg-background/40 rounded-xl p-3 hover:border-primary/40 hover:bg-secondary/30 transition-colors">
                              <div className="flex items-center gap-1.5">
                                <span className={`text-[9px] px-1 py-0.5 rounded shrink-0 ${entry.source === 'builtin' ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground'}`}>
                                  {entry.source === 'builtin' ? '离线预设' : '官方目录'}
                                </span>
                                {entry.version && <span className="text-[9px] text-muted-foreground shrink-0">v{entry.version}</span>}
                                <button
                                  onClick={() => { void (async () => {
                                    const r = await window.cnke.mcp.installFromCatalog(entry);
                                    if (!r.success) toast.error(r.error || '安装失败');
                                    await reloadMcpServers();
                                  })(); }}
                                  disabled={installed}
                                  className={`ml-auto flex items-center gap-1 px-2 py-1 text-[10px] rounded-md shrink-0 transition-colors ${installed ? 'bg-secondary text-muted-foreground cursor-not-allowed' : 'bg-primary text-primary-foreground hover:bg-primary/80'}`}
                                >
                                  {installed ? '已装' : <><Plus className="w-2.5 h-2.5" />安装</>}
                                </button>
                              </div>
                              <div className="text-[13px] font-semibold mt-3 truncate">{entry.name}</div>
                              <p className="text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-2 min-h-[39px]">{entry.description || '暂无描述'}</p>
                              <div className="text-xs text-muted-foreground mt-3 pt-2 border-t border-border/60 font-mono truncate">
                                {entry.installConfig.protocol === 'http' ? entry.installConfig.url : `${entry.installConfig.command} ${(entry.installConfig.args || '').split(' ').slice(0, 3).join(' ')}…`}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>

              {mcpEditing && (
                <div className="border border-primary/30 rounded-lg p-3 bg-secondary/20 space-y-2.5">
                  <h4 className="text-xs font-semibold text-primary">{mcpEditing.id ? '编辑 MCP 服务器' : '添加 MCP 服务器'}</h4>
                  <div>
                    <label className="text-[11px] text-muted-foreground">名称</label>
                    <input value={mcpEditing.name} onChange={(e) => setMcpEditing({ ...mcpEditing, name: e.target.value })} className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary" />
                  </div>
                  <div>
                    <label className="text-[11px] text-muted-foreground">协议</label>
                    <select value={mcpEditing.protocol} onChange={(e) => setMcpEditing({ ...mcpEditing, protocol: e.target.value as any })} className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary">
                      <option value="stdio">stdio（命令）</option>
                      <option value="http">HTTP（SSE/流）</option>
                    </select>
                  </div>
                  {mcpEditing.protocol === 'stdio' ? (
                    <>
                      <div>
                        <label className="text-[11px] text-muted-foreground">命令</label>
                        <input value={mcpEditing.command} onChange={(e) => setMcpEditing({ ...mcpEditing, command: e.target.value })} placeholder="npx" className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary font-mono" />
                      </div>
                      <div>
                        <label className="text-[11px] text-muted-foreground">参数（空格分隔）</label>
                        <input value={mcpEditing.args} onChange={(e) => setMcpEditing({ ...mcpEditing, args: e.target.value })} placeholder="-y @modelcontextprotocol/server-filesystem ." className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary font-mono" />
                      </div>
                    </>
                  ) : (
                    <div>
                      <label className="text-[11px] text-muted-foreground">URL</label>
                      <input value={mcpEditing.url} onChange={(e) => setMcpEditing({ ...mcpEditing, url: e.target.value })} placeholder="http://localhost:3001/mcp（Streamable HTTP 端点）" className="mt-0.5 w-full bg-background border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary font-mono" />
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <input id="mcp-enabled" type="checkbox" checked={mcpEditing.enabled} onChange={(e) => setMcpEditing({ ...mcpEditing, enabled: e.target.checked })} className="accent-primary" />
                    <label htmlFor="mcp-enabled" className="text-xs">立即启用</label>
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button onClick={() => setMcpEditing(null)} className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-accent transition-colors">取消</button>
                    <button onClick={() => void saveMcpServer()} className="flex items-center gap-1 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/80 transition-colors">
                      <Save className="w-3 h-3" /> 保存
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ===== 关于 ===== */}
          {tab === 'about' && (
            <div className="py-2">
              <div className="text-center">
                <div className="w-16 h-16 rounded-2xl mx-auto mb-3 overflow-hidden">
                  <img src="./logo.png" alt="CnkeIDE" className="w-16 h-16 object-contain" />
                </div>
                <div className="flex items-center justify-center gap-1.5">
                  <h3 className="text-lg font-bold bg-gradient-to-r from-cyan-300 via-violet-300 to-fuchsia-300 bg-clip-text text-transparent">CnkeIDE</h3>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-gradient-to-r from-fuchsia-500 to-violet-500 text-white">专业版</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">自研 Agent 内核的独立桌面 AI 编程 IDE</p>
                <p className="text-xs text-muted-foreground mt-0.5">版本 {appVersion} · 全部能力已内置</p>
                <div className="mt-3 text-[11px] text-muted-foreground leading-relaxed">
                  <p>Electron + React + CodeMirror 6</p>
                  <p>主进程与 Agent 子进程隔离 · 工作区文件不出本机</p>
                </div>
              </div>

              {/* 关键指标 */}
              <div className="mt-4 grid grid-cols-2 gap-1.5">
                {PRO_STATS.map((s) => (
                  <div key={s.label} className="border border-border rounded-lg py-2 bg-secondary/30 text-center">
                    <div className="text-sm font-bold bg-gradient-to-r from-cyan-300 to-violet-300 bg-clip-text text-transparent">{s.value}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{s.label}</div>
                  </div>
                ))}
              </div>

              {/* 专业版能力 */}
              <div className="mt-5 text-left">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="w-4 h-4 text-fuchsia-400" />
                  <h3 className="text-sm font-semibold text-fuchsia-300">专业版能力</h3>
                </div>

                {PRO_GROUPS.map((g) => (
                  <div key={g.tag} className="mb-3 last:mb-0">
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded bg-gradient-to-r ${ACCENT_STYLES[g.accent].chip} text-white`}>{g.tag}</span>
                      <span className="text-[10px] text-muted-foreground">{g.label}</span>
                    </div>
                    <div className="grid grid-cols-1 gap-1.5">
                      {g.items.map((f) => (
                        <div key={f.title} className="flex items-start gap-2 border border-border rounded-lg p-2 bg-secondary/30">
                          <f.icon className={`w-4 h-4 mt-0.5 shrink-0 ${ACCENT_STYLES[g.accent].icon}`} />
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-foreground">{f.title}</div>
                            <div className="text-[10px] text-muted-foreground leading-relaxed">{f.desc}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* 专业版说明 */}
              <div className="mt-4 text-left border border-violet-500/30 rounded-lg p-2.5 bg-violet-500/5">
                <div className="flex items-center gap-1.5 mb-1">
                  <ShieldCheck className="w-3.5 h-3.5 text-violet-400" />
                  <span className="text-xs font-semibold text-violet-300">专业版说明</span>
                </div>
                <ul className="space-y-1 text-[10px] text-muted-foreground leading-relaxed">
                  <li>· 以上能力随客户端完整提供，无需授权码，也不另收版本费用。</li>
                  <li>· 模型调用按你配置的服务商计费（API Key 自带），客户端不代收、不加价。</li>
                  <li>· 更换服务商或模型不改变功能可用性，仅影响回答质量与推理速度。</li>
                </ul>
              </div>

              {/* 远程更新 */}
              <div className="mt-5 text-left">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 text-cyan-400" />
                    <h3 className="text-sm font-semibold text-cyan-300">软件更新</h3>
                  </div>
                  <button
                    onClick={() => void checkUpdate()}
                    disabled={updateChecking || updateDownloading}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs bg-gradient-to-r from-cyan-500 to-violet-500 text-white rounded-md hover:opacity-90 transition-opacity disabled:opacity-40"
                  >
                    <RefreshCw className={`w-3 h-3 ${updateChecking ? 'animate-spin' : ''}`} />
                    {updateChecking ? '检查中…' : '检查更新'}
                  </button>
                </div>

                {updateStatus && updateStatus.phase !== 'idle' && (
                  <div className="mt-2 border border-border rounded-lg p-2.5 text-left">
                    {updateStatus.phase === 'checking' && (
                      <div className="text-xs text-muted-foreground flex items-center gap-2">
                        <RefreshCw className="w-3 h-3 animate-spin" /> {updateStatus.message || '正在检查更新…'}
                      </div>
                    )}

                    {updateStatus.phase === 'available' && (
                      <div>
                        <div className="flex items-center gap-2 text-xs text-cyan-300 font-medium">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          正在自动下载更新 v{updateStatus.version}…
                        </div>
                        {updateStatus.minimumRunVersion && (
                          <div className="mt-1 text-[11px] text-amber-400 font-medium">⚠ 该版本为强制更新，旧版本将无法继续使用</div>
                        )}
                        {updateStatus.releaseNotes && (
                          <div className="mt-1 text-[11px] text-muted-foreground whitespace-pre-wrap max-h-24 overflow-y-auto">{updateStatus.releaseNotes}</div>
                        )}
                      </div>
                    )}

                    {updateStatus.phase === 'downloading' && (
                      <div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-cyan-300">{updateStatus.message || '正在下载更新…'}</span>
                          <span className="text-muted-foreground">{updateStatus.differential ? '差分增量' : '全量'} {Math.floor(updateStatus.percent || 0)}%</span>
                        </div>
                        <div className="mt-2 h-1.5 bg-background rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-cyan-400 to-violet-500 rounded-full transition-all" style={{ width: `${Math.max(2, updateStatus.percent || 0)}%` }} />
                        </div>
                        <div className="mt-1 text-[10px] text-muted-foreground text-right">
                          {formatBytes(updateStatus.transferred)} / {formatBytes(updateStatus.total)}
                        </div>
                      </div>
                    )}

                    {updateStatus.phase === 'downloaded' && (
                      <div>
                        <div className="flex items-center gap-2 text-xs text-emerald-400">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          v{updateStatus.version} 已下载，{updateStatus.message || '准备自动安装…'}
                        </div>
                        <div className="mt-1 text-[10px] text-muted-foreground">安装完成后将自动重启到新版本</div>
                      </div>
                    )}

                    {updateStatus.phase === 'installing' && (
                      <div className="text-xs text-emerald-400 flex items-center gap-2">
                        <RefreshCw className="w-3 h-3 animate-spin" /> {updateStatus.message || '正在安装，应用即将重启…'}
                      </div>
                    )}

                    {updateStatus.phase === 'not-available' && (
                      <div className="text-xs text-muted-foreground">✓ 当前已是最新版本</div>
                    )}

                    {updateStatus.phase === 'error' && (
                      <div className="text-xs text-red-400">{updateStatus.error || updateStatus.message || '更新失败'}</div>
                    )}
                  </div>
                )}
              </div>

              {/* 意见反馈 */}
              <div className="border-t border-border pt-4 mt-5 text-left">
                <div className="flex items-center gap-2 mb-1">
                  <MessageSquarePlus className="w-4 h-4 text-violet-400" />
                  <h3 className="text-sm font-semibold text-violet-300">意见反馈</h3>
                </div>
                <p className="text-[11px] text-muted-foreground mb-2">提交你的建议或 Bug 描述，我们将通过官方服务器回复（可留联系方式）。</p>
                <textarea
                  value={feedbackMsg}
                  onChange={(e) => setFeedbackMsg(e.target.value)}
                  rows={3}
                  placeholder="描述遇到的问题或建议…"
                  className="w-full bg-background border border-border rounded-md px-2.5 py-2 text-xs outline-none focus:border-violet-500/60 resize-y"
                />
                <div className="flex items-center gap-2 mt-2">
                  <input
                    value={feedbackContact}
                    onChange={(e) => setFeedbackContact(e.target.value)}
                    placeholder="联系方式（可选，邮箱 / 微信 / QQ）"
                    className="flex-1 bg-background border border-border rounded-md px-2.5 py-1.5 text-xs outline-none focus:border-violet-500/60"
                  />
                  <button
                    onClick={() => void submitFeedback()}
                    disabled={feedbackSending || !feedbackMsg.trim()}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white rounded-md hover:opacity-90 transition-opacity disabled:opacity-40 shrink-0"
                  >
                    <Send className="w-3 h-3" /> {feedbackSending ? '提交中…' : '提交反馈'}
                  </button>
                </div>

                {/* 历史反馈 */}
                <div className="mt-4">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Inbox className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-[11px] text-muted-foreground font-medium">我的反馈与官方回复</span>
                    <button onClick={() => void loadFeedback()} className="ml-auto text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors">
                      <RefreshCw className="w-2.5 h-2.5" /> 刷新
                    </button>
                  </div>
                  {feedbackHistory.length === 0 ? (
                    <div className="text-[11px] text-muted-foreground/60 text-center py-3 border border-dashed border-border rounded-lg">暂无反馈记录</div>
                  ) : (
                    <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                      {feedbackHistory.map((fb: any) => (
                        <div key={fb.id} className="border border-border rounded-lg p-2">
                          <div className="text-[11px] text-foreground/85">{fb.msg}</div>
                          <div className="flex items-center gap-2 mt-1 text-[9px] text-muted-foreground">
                            <span>{new Date(Number(fb.time) * 1000 || Number(fb.time)).toLocaleString()}</span>
                            {fb.contact && <span>· {fb.contact}</span>}
                            <span className="ml-auto text-emerald-400/80">设备 {fb.device || ''}</span>
                          </div>
                          {(fb.replies && fb.replies.length > 0) && (
                            <div className="mt-1.5 border-l-2 border-emerald-500/40 pl-2 space-y-1">
                              {fb.replies.map((r: any, i: number) => (
                                <div key={i} className="text-[10px]">
                                  <span className="text-emerald-400">官方回复：</span>
                                  <span className="text-foreground/80">{r.content}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/** 字节数格式化（用于更新包大小显示） */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export default SettingsSheet;
