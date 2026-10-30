import { create } from 'zustand';

/** 上下文占用状态（对应 ContextTracker 的 ContextState） */
export interface ContextUsage {
  sessionId: string;
  model: string;
  maxContextTokens: number;
  promptTokens: number;
  completionTokens: number;
  currentChars: number;
  estimatedTokens: number;
  messageCount: number;
  updatedAt: number;
  /** 占用比例 0-1 */
  ratio: number;
  /** 等级：safe / warning / critical */
  level: 'safe' | 'warning' | 'critical';
}

/** 计划步骤状态（对应 PlanManager 的 PlanItem） */
export interface PlanStep {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  error?: string;
  /** 关联工具名（如 write_to_file），用于展示该步在做什么 */
  toolName?: string;
  /** 关联文件路径 */
  filePath?: string;
}

export interface PlanState {
  sessionId: string;
  title: string;
  steps: PlanStep[];
  progress: {
    done: number;
    total: number;
    failed: number;
    skipped: number;
    pending: number;
    running: number;
  } | null;
}

export interface ModelConfig {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  provider?: string;
  disabled?: boolean;
  /** 官方内置模型：只有内置模型参与 AUTO 路由 */
  builtin?: boolean;
}

export interface ModelDecision {
  sessionId: string;
  model: string;
  reason: string;
  taskType: string;
  mode: 'auto' | 'manual';
}

interface UiState {
  /** 当前会话上下文占用 */
  contextUsage: ContextUsage | null;
  /** 当前会话计划 */
  plan: PlanState | null;
  /** 可用模型配置列表 */
  models: ModelConfig[];
  /** 当前激活模型配置 id */
  activeModelId: string | null;
  modelSelectionMode: 'auto' | 'manual';
  routingEnabled: boolean;
  modelDecision: ModelDecision | null;
  modelSwitching: boolean;
  modelError: string | null;
  /** 上下文占用条是否展开（显示详情） */
  contextExpanded: boolean;
  /** 待注入到对话输入框的提示（编辑器选区发送） */
  pendingPrompt: string | null;

  setContextUsage: (u: ContextUsage | null) => void;
  setPlan: (p: PlanState | null) => void;
  setModels: (m: ModelConfig[]) => void;
  setActiveModelId: (id: string | null) => void;
  setContextExpanded: (v: boolean) => void;
  /** 设置待注入提示（编辑器选区 → 对话） */
  setPendingPrompt: (p: string | null) => void;

  /** 从主进程拉取模型配置列表 + 激活 id */
  refreshModels: () => Promise<void>;
  /** 切换激活模型；'auto' 代表启用任务路由 */
  switchModel: (id: string) => Promise<void>;
  /** 拉取当前会话上下文占用 */
  refreshContext: (sessionId: string) => Promise<void>;
  /** 拉取当前会话计划 */
  refreshPlan: (sessionId: string) => Promise<void>;
  /** 清空会话相关状态（切换会话时调用） */
  resetSession: () => void;
  /** 处理 agent 事件（context_state / plan），供全局监听器调用 */
  handleAgentEvent: (event: any) => void;
}

/** 根据 ContextState 计算 ratio / level */
function deriveUsage(raw: any): ContextUsage | null {
  if (!raw) return null;
  const max = raw.maxContextTokens || 128000;
  const estimated = raw.estimatedTokens ?? Math.ceil((raw.currentChars || 0) / 2);
  const ratio = max > 0 ? Math.min(1, estimated / max) : 0;
  const level: ContextUsage['level'] = ratio >= 0.85 ? 'critical' : ratio >= 0.6 ? 'warning' : 'safe';
  return {
    sessionId: raw.sessionId,
    model: raw.model || '',
    maxContextTokens: max,
    promptTokens: raw.promptTokens || 0,
    completionTokens: raw.completionTokens || 0,
    currentChars: raw.currentChars || 0,
    estimatedTokens: estimated,
    messageCount: raw.messageCount || 0,
    updatedAt: raw.updatedAt || Date.now(),
    ratio,
    level,
  };
}

/** 从 plan:get 返回的 { plan, progress } 推导 PlanState */
export function derivePlan(raw: any): PlanState | null {
  if (!raw) return null;
  const plan = raw.plan || raw;
  if (!plan || !Array.isArray(plan.items)) return null;
  return {
    sessionId: plan.sessionId || '',
    title: plan.title || '任务计划',
    steps: plan.items.map((it: any) => ({
      id: String(it.id ?? it.order ?? Math.random()),
      // 后端 PlanItem 的步骤文本字段是 content（见 PlanManager.ts），
      // 早期这里只读 title/description，导致计划项标题恒为空、面板只剩空白圆圈
      title: it.content || it.title || it.description || '',
      status: it.status || 'pending',
      error: it.error || undefined,
      toolName: it.toolName || undefined,
      filePath: it.filePath || undefined,
    })),
    progress: raw.progress || null,
  };
}

export const useUiStore = create<UiState>((set, get) => ({
  contextUsage: null,
  plan: null,
  models: [],
  activeModelId: null,
  modelSelectionMode: 'manual',
  routingEnabled: true,
  modelDecision: null,
  modelSwitching: false,
  modelError: null,
  contextExpanded: false,
  pendingPrompt: null,

  setContextUsage: (u) => set({ contextUsage: u }),
  setPlan: (p) => set({ plan: p }),
  setModels: (m) => set({ models: m }),
  setActiveModelId: (id) => set({ activeModelId: id }),
  setContextExpanded: (v) => set({ contextExpanded: v }),
  setPendingPrompt: (p) => set({ pendingPrompt: p }),

  refreshModels: async () => {
    try {
      // 先同步官方内置 API（合并进本地配置，内置项直接出现在下拉框，无需二次配置）
      try {
        await window.cnke.config.syncBuiltins();
      } catch {
        /* 同步失败不阻断，继续展示已配置的模型 */
      }
      const configs = (await window.cnke.config.getApiKeyConfigs()) || [];
      const [activeId, mode, routing] = await Promise.all([
        window.cnke.config.get('activeApiConfigId'),
        window.cnke.config.get('modelSelectionMode'),
        window.cnke.config.get('agentConfig.enableRouting'),
      ]);
      set({
        models: configs.map((c: any) => ({
          id: c.id,
          name: c.name || c.model || c.id,
          model: c.model || '',
          baseUrl: c.baseUrl || '',
          provider: c.provider,
          disabled: !!c.disabled,
          builtin: c.builtin === true || String(c.id || '').startsWith('official_'),
        })),
        activeModelId: activeId as string | null,
        modelSelectionMode: mode === 'auto' ? 'auto' : 'manual',
        routingEnabled: routing !== false,
      });
    } catch {
      /* ignore */
    }
  },

  switchModel: async (id) => {
    if (get().modelSwitching) return;
    set({ modelSwitching: true, modelError: null });
    try {
      const enabled = get().models.filter((m) => !m.disabled);
      if (!enabled.length || (id !== 'auto' && !enabled.some((m) => m.id === id))) {
        throw new Error('模型不可用，请先检查模型配置');
      }
      if (id === 'auto') {
        await window.cnke.config.set('agentConfig.enableRouting', true);
        await window.cnke.config.set('modelSelectionMode', 'auto');
        set({ modelSelectionMode: 'auto', routingEnabled: true });
      } else {
        await window.cnke.config.set('activeApiConfigId', id);
        await window.cnke.config.set('modelSelectionMode', 'manual');
        set({ activeModelId: id, modelSelectionMode: 'manual' });
      }
      set({ modelDecision: null });
    } catch (e) {
      set({ modelError: e instanceof Error ? e.message : '切换失败，请重试' });
      await get().refreshModels();
    } finally {
      set({ modelSwitching: false });
    }
  },

  refreshContext: async (sessionId) => {
    try {
      const raw = await window.cnke.context.getState(sessionId);
      set({ contextUsage: deriveUsage(raw) });
    } catch {
      /* ignore */
    }
  },

  refreshPlan: async (sessionId) => {
    try {
      const raw = await window.cnke.plan.get(sessionId);
      set({ plan: derivePlan(raw) });
    } catch {
      /* ignore */
    }
  },

  resetSession: () => set({ contextUsage: null, plan: null, contextExpanded: false, modelDecision: null }),

  handleAgentEvent: (event) => {
    if (!event) return;
    if (event.type === 'start') {
      set({ modelDecision: null });
    } else if (event.type === 'model_routed') {
      set({ modelDecision: { ...event.data, sessionId: event.sessionId } });
    } else if (event.type === 'model_fallback') {
      const previous = get().modelDecision;
      if (previous && previous.sessionId === event.sessionId) {
        const data = event.data || {};
        set({ modelDecision: { ...previous, model: data.actualModel || data.actualName || previous.model, reason: `已切换备用模型：${data.requestedModel || previous.model} 请求失败` } });
      }
    } else if (event.type === 'context_state') {
      set({ contextUsage: deriveUsage(event.data) });
    } else if (event.type === 'plan') {
      // plan 事件 data 为 PlanEvent，含 plan（完整 Plan 对象）
      const data = event.data;
      const planObj = data?.plan || data;
      const sessionId = data?.sessionId || planObj?.sessionId || '';
      set({ plan: derivePlan({ plan: planObj, progress: data?.progress }) });
      // 若 plan 事件携带 sessionId，也可触发 context 刷新（可选）
      void sessionId;
    }
  },
}));
