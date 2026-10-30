import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { resolveConversation, type ConversationDecision } from '../../../electron/core-fork/agent/ConversationRouter';

/**
 * agent 事件订阅管理（模块级单例）：
 * sendMessage / regenerateMessage 每次都会订阅 agent:event，但退订仅在收到
 * done/error 事件或 agent.run reject 时执行。若主进程重启 / 窗口重建导致
 * 终止事件丢失，旧订阅会永久残留；下一次发消息再叠加一个 —— 同一事件被
 * N 个监听器各处理一次（重复 set、内容互相覆盖）。
 * 这里保证任意时刻最多只有一个活跃订阅：新订阅前自动清掉上一个。
 */
let activeAgentEventUnsub: (() => void) | null = null;
function subscribeAgentEvents(handler: (event: any) => void): () => void {
  activeAgentEventUnsub?.();
  const unsub = window.cnke.agent.onEvent(handler);
  activeAgentEventUnsub = unsub;
  return () => {
    if (activeAgentEventUnsub === unsub) activeAgentEventUnsub = null;
    unsub();
  };
}

/** 用户上传的文本文件附件（content 为可读文本，已按 MAX_FILE_TEXT_CHARS 截断） */
export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  content: string;
  truncated?: boolean;
}

/** 单文件注入文本上限（字符）：防止超长文件把上下文打爆 */
export const MAX_FILE_TEXT_CHARS = 50_000;
/** 单条消息最多上传文件数 */
export const MAX_UPLOAD_FILES = 6;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** 发送给模型的完整内容（可能已注入 @文件 全文 / 代码库检索结果） */
  content: string;
  /**
   * 气泡里展示给用户的文本。
   * 只有用户消息会用到：@文件 注入后 content 可能几千行，直接渲染会把对话顶爆，
   * 而且每轮 history 都重发一遍会让上下文与费用成倍膨胀。
   * 展示用本字段（用户原话），发给模型的 history 也用它，仅当轮 prompt 带全文。
   */
  displayContent?: string;
  thinking?: string;
  toolCalls?: any[];
  images?: string[];
  /** 用户消息的文件附件（元数据 + 截断内容，随消息持久化，供重新回答时复用） */
  files?: UploadedFile[];
  /** 模型降级提示：请求的模型失败被 fallback 替换时展示（含真实模型名） */
  modelNotice?: string;
  /** 上下文自动压缩提示：早期历史被摘要替换时展示，避免用户误以为 AI「失忆」 */
  contextNotice?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    model?: string;
    prompt_tokens_details?: { cached_tokens?: number; cache_miss_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  timestamp: number;
}

export type AgentMode = 'architect' | 'coder' | 'debugger' | 'ask';

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  /** 该会话绑定的工作区路径（每个对话可绑定不同工作区） */
  workspaceId?: string;
}

interface ChatState {
  messages: ChatMessage[];
  sessionId: string | null;
  /** 全局会话列表（跨工作区，每个对话可绑定不同工作区） */
  sessions: SessionMeta[];
  loading: boolean;
  mode: AgentMode;
  /** 全自动模式：运行时自动批准所有工具调用，不弹确认窗口 */
  autoMode: boolean;
  autoInteraction: boolean;
  conversation: ConversationDecision | null;
  setAutoInteraction: (enabled: boolean) => void;
  /** 当前会话绑定的工作区路径（切换对话时自动切换，驱动 FileTree 等） */
  activeWorkspaceId: string | null;
  setMessages: (msgs: ChatMessage[]) => void;
  setSessionId: (id: string | null) => void;
  /** 直接改「当前会话绑定的工作区」：任务改名把目录搬走后要跟着换绑 */
  setActiveWorkspaceId: (id: string | null) => void;
  setLoading: (v: boolean) => void;
  setMode: (m: AgentMode) => void;
  setAutoMode: (v: boolean) => void;
  initAutoMode: () => Promise<void>;
  clearMessages: () => void;
  /** 拉取全局会话列表 */
  refreshSessions: (workspaceId: string) => Promise<void>;
  /** 新建并切换到空会话 */
  startNewSession: (workspaceId: string) => Promise<void>;
  /** 保存当前会话并切换到指定历史会话 */
  switchSession: (workspaceId: string, sessionId: string) => Promise<void>;
  /** 删除会话；若删除的是当前会话，自动切到最近的其他会话或新建 */
  removeSession: (workspaceId: string, sessionId: string) => Promise<void>;
  sendMessage: (prompt: string, workspaceId: string, images?: string[], files?: UploadedFile[], displayPrompt?: string) => Promise<void>;
  /** 撤销上一轮：删除最后一轮（用户提问 + AI 回复），回到上一轮状态 */
  rollback: (workspaceId: string) => Promise<void>;
  /** 重新回答：删除指定 AI 回复，用其对应的用户提问重新生成 */
  regenerateMessage: (workspaceId: string, assistantId: string) => Promise<void>;
  abort: () => void;
}

/** 用第一条用户消息做会话标题 */
const titleOf = (messages: ChatMessage[]): string => {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '新对话';
  // 优先用户原话：content 可能已被 @文件 注入内容占满，拿它做标题会变成一整段代码
  const src = first.displayContent ?? first.content;
  const t = typeof src === 'string' ? src : JSON.stringify(src);
  return (t || '新对话').slice(0, 30);
};

/** 保存当前会话（不重复保存空会话） */
async function saveCurrentSession(workspaceId: string) {
  const { sessionId, messages, mode } = useChatStore.getState();
  if (!sessionId || messages.length === 0) return;
  await window.cnke.session.save({
    id: sessionId,
    workspaceId,
    title: titleOf(messages),
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mode,
  });
}

/**
 * 流式增量合帧缓冲。
 *
 * 模型侧一个 token 就是一个 stream 事件，长回复可达每秒上百次。原实现每个
 * delta 同步 set 两次（streamingContent 一次 + messages 一次），等于整个对话
 * 列表每秒重渲染上百次——长会话下明显掉帧。
 * 这里把增量累积到下一帧统一提交：渲染次数降到屏幕刷新率上限，文字在人眼看来
 * 没有任何延迟差异。
 */
let pendingDelta = '';
let streamFrame: number | null = null;

/** 把累积的增量一次性写入最后一条 assistant 消息 */
function commitPendingDelta(): void {
  const delta = pendingDelta;
  pendingDelta = '';
  if (!delta) return;
  const cur = useChatStore.getState().messages;
  const idx = cur.length - 1;
  const last = cur[idx];
  if (!last || last.role !== 'assistant') return;
  const next = cur.slice();
  next[idx] = { ...last, content: (last.content || '') + delta };
  useChatStore.setState({ messages: next });
}

/**
 * 立即提交尚未落地的增量。
 * 终态（done/error）、中断、异常路径必须调用，否则最后一段文字会永久丢失。
 */
function flushPendingDelta(): void {
  if (streamFrame !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(streamFrame);
  }
  streamFrame = null;
  commitPendingDelta();
}

/** 累积增量，并安排到下一帧统一提交 */
function pushDelta(delta: unknown): void {
  if (typeof delta !== 'string' || !delta) return;
  pendingDelta += delta;
  if (streamFrame !== null) return;
  // 极端环境下没有 rAF（如部分测试宿主）：退化为立即提交，保证流式不中断
  if (typeof requestAnimationFrame !== 'function') {
    commitPendingDelta();
    return;
  }
  streamFrame = requestAnimationFrame(() => {
    streamFrame = null;
    commitPendingDelta();
  });
}

/**
 * 订阅 agent 事件并把状态写回 store。
 *
 * 这段逻辑原先在 sendMessage 与 regenerateMessage 里各存了一份完全相同的拷贝
 * （约 50 行 if/else）。两份拷贝带来过真实缺陷：新事件类型（context_compressed）
 * 只在发送路径接入，重答路径就会静默漏掉，用户重答时看不到压缩提示。
 * 故收敛为单一实现，两条路径只传不同的收尾回调。
 *
 * 两个路径的差异仅在「结束时如何落盘」，用 onFinish 参数表达。
 *
 * 返回退订函数：调用方必须在 agent.run 返回/reject 时调用，否则事件监听会残留。
 */
function subscribeRunEvents(opts: {
  sessionId: string;
  /** 原始提问，用于系统通知摘要与保存会话标题 */
  prompt: string;
  workspaceId: string;
  onFinish: (sessionId: string, workspaceId: string) => void;
}): () => void {
  const { sessionId: sid, prompt, workspaceId, onFinish } = opts;

  /** 只更新最后一条 assistant 消息：避免每个事件都重建整个数组 */
  const patchLast = (patch: (m: ChatMessage) => ChatMessage) => {
    const cur = useChatStore.getState().messages;
    const idx = cur.length - 1;
    const last = cur[idx];
    if (!last || last.role !== 'assistant') return;
    const next = cur.slice();
    next[idx] = patch(last);
    useChatStore.setState({ messages: next });
  };

  return subscribeAgentEvents((event) => {
    if (event.type === 'stream') {
      pushDelta(event.data?.delta);
    } else if (event.type === 'thinking') {
      patchLast((last) => ({ ...last, thinking: event.data?.thinking }));
    } else if (event.type === 'tool_call') {
      patchLast((last) => ({ ...last, toolCalls: [...(last.toolCalls || []), event.data] }));
    } else if (event.type === 'tool_result') {
      // 工具结果回填到对应 toolCall（按 id 匹配），供审查视图展示状态/diff/回滚
      const d = event.data || {};
      patchLast((last) => ({
        ...last,
        toolCalls: (last.toolCalls || []).map((tc: any) =>
          tc && tc.id === d.toolCallId ? { ...tc, result: d.result } : tc
        ),
      }));
    } else if (event.type === 'tool_progress') {
      // 长命令实时进度：回填到对应 toolCall，渲染层据此画进度条
      const d = event.data || {};
      if (d.toolCallId) {
        patchLast((last) => ({
          ...last,
          toolCalls: (last.toolCalls || []).map((tc: any) =>
            tc && tc.id === d.toolCallId
              ? { ...tc, progress: { current: d.current, total: d.total, percent: d.percent } }
              : tc
          ),
        }));
      }
    } else if (event.type === 'model_fallback') {
      // 模型请求失败自动降级：显式告知用户实际使用的模型，避免"切换成功"的错觉
      const d = event.data || {};
      patchLast((last) => ({
        ...last,
        modelNotice: `模型 ${d.requestedModel || '?'} 请求失败，已自动切换备用模型：${d.actualName || d.actualModel || '?'}`,
      }));
    } else if (event.type === 'context_compressed') {
      // 上下文自动压缩：必须显式告知，否则用户只会觉得"AI 突然忘了前面聊过什么"
      const d = event.data || {};
      patchLast((last) => ({
        ...last,
        contextNotice: `上下文已自动压缩：${d.beforeMessages ?? '?'} → ${d.afterMessages ?? '?'} 条消息，约省 ${d.savedTokens ?? 0} tokens（保留最近数轮，早期历史已摘要为一条系统消息）`,
      }));
    } else if (event.type === 'done' || event.type === 'error') {
      // 先把还没落地的流式增量刷出去，否则最后一段文字会丢
      flushPendingDelta();
      // 任务结束：解除窗口保护（允许正常最小化 / 直接关闭）
      window.cnke.window.setAgentBusy(false);
      if (event.type === 'error') {
        patchLast((last) => ({ ...last, content: `Error: ${event.data?.error || '未知错误'}` }));
        window.cnke.notify.show({ type: 'error', title: '任务异常', message: event.data?.error || 'AI 任务异常退出' });
      } else {
        if (event.data?.usage) {
          patchLast((last) => ({ ...last, usage: event.data.usage }));
        }
        if (event.data?.aborted) {
          // 用户主动中止：不算异常，也不该报"完成"，如实提示
          window.cnke.notify.show({ type: 'done', title: '已停止', message: 'AI 任务已被用户中止' });
        } else {
          window.cnke.notify.show({ type: 'done', title: '任务完成', message: prompt.slice(0, 50) });
        }
      }
      // 先落消息补丁、再清 loading：两者都是终态，各一次 set 无性能影响，
      // 但顺序保证"内容已完整"的那一帧不会仍带着 loading 光标。
      useChatStore.setState({ loading: false });
      onFinish(sid, workspaceId);
    }
  });
}

/**
 * 发起一轮 agent 运行并接管其事件流。
 *
 * 两条路径（发送 / 重新回答）在「消息怎么准备」上不同，但订阅、窗口保护、
 * 异常兜底、终态落盘完全一致，故统一收口到这里。
 */
async function startAgentRun(
  params: {
    sid: string;
    prompt: string;
    workspaceId: string;
    mode: AgentMode;
    history: { role: string; content: string }[];
    images?: string[];
    files?: UploadedFile[];
    autoMode?: boolean;
  },
  set: (patch: Partial<ChatState>) => void,
  get: () => ChatState
): Promise<void> {
  const { sid, prompt, workspaceId, images, files, autoMode } = params;
  const autoInteraction = get().autoInteraction;
  const originalMessage = [...get().messages].reverse().find((m) => m.role === 'user');
  const originalPrompt = originalMessage?.displayContent ?? originalMessage?.content ?? prompt;
  const routed = resolveConversation(originalPrompt, workspaceId, params.history, autoInteraction ? undefined : params.mode);
  const mode = routed.decision.mode;
  const history = routed.history;
  set({ mode, conversation: routed.decision });

  const removeEvent = subscribeRunEvents({
    sessionId: sid,
    prompt,
    workspaceId,
    onFinish: (finishedSessionId, finishedWorkspaceId) => {
      // 终态已到：先退订，避免残留监听把后续事件重复写进新会话
      removeEvent();
      const finalMsgs = get().messages;
      // 标题与 saveCurrentSession 保持一致：原实现用 prompt.slice(0,30)，
      // @文件引用展开后标题会变成注入代码块的开头，与左侧列表里显示的标题对不上
      window.cnke.session.save({ id: finishedSessionId, workspaceId: finishedWorkspaceId, title: titleOf(finalMsgs), messages: finalMsgs, createdAt: Date.now(), updatedAt: Date.now(), mode });
      get().refreshSessions(finishedWorkspaceId);
    },
  });

  // 任务开始：通知主进程启用窗口保护（防误最小化 / 关闭需二次确认）
  window.cnke.window.setAgentBusy(true);
  try {
    await window.cnke.agent.run({ sessionId: sid, workspaceId, prompt, history, mode, images, files, autoApprove: autoMode, autoInteraction: false, originalPrompt });
  } catch (err: any) {
    // agent.run 抛出（如 IPC 断开 / 主进程崩溃后 invoke reject）
    window.cnke.window.setAgentBusy(false);
    // 先冲掉残留增量，保证已收到的文字不丢，再写错误兜底
    flushPendingDelta();
    // 异常路径也要退订，否则下一次发消息会叠加一个僵尸监听
    removeEvent();
    const msgs = get().messages;
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'assistant') {
      const patched = [...msgs];
      patched[patched.length - 1] = { ...last, content: last.content || `Error: ${err?.message || '请求失败'}` };
      set({ messages: patched, loading: false });
    } else {
      set({ loading: false });
    }
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  sessionId: null,
  sessions: [],
  loading: false,
  mode: 'coder',
  autoMode: false,
  autoInteraction: true,
  conversation: null,
  setAutoInteraction: (enabled) => {
    if (get().loading) return;
    set({ autoInteraction: enabled });
    void window.cnke.config.set('agentConfig.autoInteraction', enabled);
  },
  activeWorkspaceId: null,
  setMessages: (msgs) => set({ messages: msgs }),
  setSessionId: (id) => set({ sessionId: id, conversation: null }),
  setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id, conversation: null }),
  setLoading: (v) => set({ loading: v }),
  setMode: (m) => {
    if (get().loading) return;
    set({ mode: m, autoInteraction: false });
    void window.cnke.config.set('agentConfig.autoInteraction', false);
  },
  setAutoMode: (v) => {
    set({ autoMode: v });
    window.cnke.config.set('agentConfig.autoApproveTools', v);
  },
  initAutoMode: async () => {
    const [v, interaction] = await Promise.all([
      window.cnke.config.get('agentConfig.autoApproveTools'),
      window.cnke.config.get('agentConfig.autoInteraction'),
    ]);
    set({ autoMode: !!v, autoInteraction: interaction !== false });
  },
  clearMessages: () => set({ messages: [], conversation: null }),

  refreshSessions: async (_workspaceId?: string) => {
    // 全局拉取所有会话（跨工作区），每个对话可绑定不同工作区
    const list = await window.cnke.session.listAll();
    set({
      sessions: (list || []).map((s: any) => ({ id: s.id, title: s.title || '新对话', updatedAt: s.updatedAt || 0, workspaceId: s.workspaceId })),
    });
  },

  startNewSession: async (workspaceId: string) => {
    const { loading, sessionId, messages, activeWorkspaceId } = get();
    if (loading) return;
    // 保存的是"当前会话"，必须用它自己的 workspaceId；
    // 用新会话的 workspaceId 会把旧会话整体搬到新工作区，导致会话归属错乱
    if (sessionId && messages.length) await saveCurrentSession(activeWorkspaceId || workspaceId);
    const session = await window.cnke.session.create(workspaceId, '新对话');
    set({ sessionId: session.id, messages: [], activeWorkspaceId: workspaceId, conversation: null });
    await get().refreshSessions(workspaceId);
  },

  switchSession: async (workspaceId: string, sessionId: string) => {
    const { sessionId: cur, messages, loading, activeWorkspaceId } = get();
    if (loading || cur === sessionId) return;
    // 同 startNewSession：保存当前会话时不能用目标会话的 workspaceId
    if (cur && messages.length) await saveCurrentSession(activeWorkspaceId || workspaceId);
    const session = await window.cnke.session.load(sessionId);
    if (!session) {
      await get().refreshSessions(workspaceId);
      return;
    }
    set({
      sessionId: session.id,
      messages: session.messages || [],
      mode: (session.mode as AgentMode) || get().mode,
      // 切换对话时同步切换工作区（每个对话绑定各自的工作区）
      activeWorkspaceId: session.workspaceId || workspaceId,
    });
    await get().refreshSessions(session.workspaceId || workspaceId);
  },

  removeSession: async (workspaceId: string, sessionId: string) => {
    const { sessionId: cur, loading } = get();
    if (loading) return;
    const rest = get().sessions.filter((s) => s.id !== sessionId);
    // 若删除的是当前会话，先切换走（switchSession 内部的 saveCurrentSession 会把当前会话
    // 重新保存，因此必须先切换、再删除，否则被删会话会被 saveCurrentSession 写回存储）
    if (cur === sessionId) {
      if (rest.length > 0) {
        // 切换到剩余会话的第一个，用其自己的 workspaceId
        await get().switchSession(rest[0].workspaceId || workspaceId, rest[0].id);
      } else {
        const session = await window.cnke.session.create(workspaceId, '新对话');
        set({ sessionId: session.id, messages: [], activeWorkspaceId: workspaceId, conversation: null });
      }
    }
    await window.cnke.session.delete(sessionId);
    await get().refreshSessions(workspaceId);
  },

  sendMessage: async (prompt: string, workspaceId: string, images?: string[], files?: UploadedFile[], displayPrompt?: string) => {
    if (get().loading) return;
    if (get().activeWorkspaceId && get().activeWorkspaceId !== workspaceId) {
      await get().startNewSession(workspaceId);
    }
    const { mode, sessionId, messages, autoMode } = get();
    let sid = sessionId;
    if (!sid) {
      const session = await window.cnke.session.create(workspaceId, (displayPrompt || prompt).slice(0, 30));
      sid = session.id;
      set({ sessionId: sid });
    }
    const userMsg: ChatMessage = {
      id: nanoid(),
      role: 'user',
      content: prompt,
      // 有注入内容时另存展示文本，气泡只显示用户原话
      displayContent: displayPrompt && displayPrompt !== prompt ? displayPrompt : undefined,
      images,
      files: files && files.length > 0 ? files : undefined,
      timestamp: Date.now(),
    };
    const assistantMsg: ChatMessage = { id: nanoid(), role: 'assistant', content: '', timestamp: Date.now() };
    set((s) => ({ messages: [...s.messages, userMsg, assistantMsg], loading: true }));

    // 历史消息取本轮追加之前的内容，当前提问单独通过 prompt 传入。
    // 用户消息优先用 displayContent：注入的 @文件 全文只在当轮发送，
    // 否则每一轮 history 都会把同一份文件内容重复带上，几十轮后上下文直接爆掉。
    const history = messages.map((m) => ({
      role: m.role,
      content: m.role === 'user' ? (m.displayContent ?? m.content) : m.content,
    }));

    await startAgentRun({ sid, prompt, workspaceId, mode, history, images, files, autoMode }, set, get);
  },

  rollback: async (workspaceId: string) => {
    const { loading, messages } = get();
    if (loading || messages.length === 0) return;
    // 找到最后一条用户消息，删除从它开始到结尾的全部消息（撤销最后一轮）
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return;
    const next = messages.slice(0, lastUserIdx);
    set({ messages: next });
    await saveCurrentSession(workspaceId);
  },

  regenerateMessage: async (workspaceId: string, assistantId: string) => {
    const { loading, messages, sessionId, mode, autoMode } = get();
    if (loading) return;
    const idx = messages.findIndex((m) => m.id === assistantId && m.role === 'assistant');
    if (idx === -1) return;
    // 找到该 AI 回复对应的用户提问（其前一条用户消息）
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { userIdx = i; break; }
    }
    if (userIdx === -1) return;
    const userMsg = messages[userIdx];
    const prompt = typeof userMsg.content === 'string' ? userMsg.content : '';
    const images = userMsg.images;
    const files = userMsg.files;
    // 删除该 AI 回复及其之后的所有消息（回到该问题待回答状态）
    set({ messages: messages.slice(0, idx), loading: true });

    const assistantMsg: ChatMessage = { id: nanoid(), role: 'assistant', content: '', timestamp: Date.now() };
    set((s) => ({ messages: [...s.messages, assistantMsg] }));

    let sid = sessionId;
    if (!sid) {
      // 标题用用户原话，不要用注入后的 prompt（会变成一整段文件内容）
      const session = await window.cnke.session.create(workspaceId, (userMsg.displayContent ?? prompt).slice(0, 30));
      sid = session.id;
      set({ sessionId: sid });
    }

    // 当前提问已通过 prompt 单独传入：history 必须止于该提问之前，
    // 否则模型会收到两遍相同的问题（原实现 slice(0, idx) 把 userMsg 也带了进去）
    const historyForRun = messages.slice(0, userIdx).map((m) => ({
      role: m.role,
      content: m.role === 'user' ? (m.displayContent ?? m.content) : m.content,
    }));
    await startAgentRun({ sid, prompt, workspaceId, mode, history: historyForRun, images, files, autoMode }, set, get);
  },

  abort: () => {
    const { sessionId } = get();
    if (!sessionId) return;
    window.cnke.agent.abort(sessionId);
    // 中断前把已收到的文字落盘，否则最后一段会消失
    flushPendingDelta();
    set({ loading: false });
    // 用户主动中断：立即解除窗口保护
    window.cnke.window.setAgentBusy(false);
    // 兜底退订：若主进程因 worker 崩溃 / 端口断开而没有回 done，
    // 订阅会永久残留，下一轮运行的事件会被重复处理（重复 set、内容互相覆盖）。
    // 4s 后若仍是这次订阅（说明没开始新一轮）就主动释放。
    const mine = activeAgentEventUnsub;
    if (mine) {
      setTimeout(() => {
        if (activeAgentEventUnsub === mine) {
          mine();
          activeAgentEventUnsub = null;
        }
      }, 4000);
    }
  },
}));
