import { create } from 'zustand';
import { nanoid } from 'nanoid';

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
  content: string;
  thinking?: string;
  toolCalls?: any[];
  images?: string[];
  /** 用户消息的文件附件（元数据 + 截断内容，随消息持久化，供重新回答时复用） */
  files?: UploadedFile[];
  /** 模型降级提示：请求的模型失败被 fallback 替换时展示（含真实模型名） */
  modelNotice?: string;
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
  streamingContent: string;
  /** 当前会话绑定的工作区路径（切换对话时自动切换，驱动 FileTree 等） */
  activeWorkspaceId: string | null;
  setMessages: (msgs: ChatMessage[]) => void;
  setSessionId: (id: string | null) => void;
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
  sendMessage: (prompt: string, workspaceId: string, images?: string[], files?: UploadedFile[]) => Promise<void>;
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
  const t = typeof first.content === 'string' ? first.content : JSON.stringify(first.content);
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

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  sessionId: null,
  sessions: [],
  loading: false,
  mode: 'coder',
  autoMode: false,
  streamingContent: '',
  activeWorkspaceId: null,
  setMessages: (msgs) => set({ messages: msgs }),
  setSessionId: (id) => set({ sessionId: id }),
  setLoading: (v) => set({ loading: v }),
  setMode: (m) => set({ mode: m }),
  setAutoMode: (v) => {
    set({ autoMode: v });
    window.cnke.config.set('agentConfig.autoApproveTools', v);
  },
  initAutoMode: async () => {
    const v = await window.cnke.config.get('agentConfig.autoApproveTools');
    set({ autoMode: !!v });
  },
  clearMessages: () => set({ messages: [], streamingContent: '' }),

  refreshSessions: async (_workspaceId?: string) => {
    // 全局拉取所有会话（跨工作区），每个对话可绑定不同工作区
    const list = await window.cnke.session.listAll();
    set({
      sessions: (list || []).map((s: any) => ({ id: s.id, title: s.title || '新对话', updatedAt: s.updatedAt || 0, workspaceId: s.workspaceId })),
    });
  },

  startNewSession: async (workspaceId: string) => {
    const { loading, sessionId, messages } = get();
    if (loading) return;
    if (sessionId && messages.length) await saveCurrentSession(workspaceId);
    const session = await window.cnke.session.create(workspaceId, '新对话');
    set({ sessionId: session.id, messages: [], streamingContent: '', activeWorkspaceId: workspaceId });
    await get().refreshSessions(workspaceId);
  },

  switchSession: async (workspaceId: string, sessionId: string) => {
    const { sessionId: cur, messages, loading } = get();
    if (loading || cur === sessionId) return;
    if (cur && messages.length) await saveCurrentSession(workspaceId);
    const session = await window.cnke.session.load(sessionId);
    if (!session) {
      await get().refreshSessions(workspaceId);
      return;
    }
    set({
      sessionId: session.id,
      messages: session.messages || [],
      streamingContent: '',
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
        set({ sessionId: session.id, messages: [], streamingContent: '', activeWorkspaceId: workspaceId });
      }
    }
    await window.cnke.session.delete(sessionId);
    await get().refreshSessions(workspaceId);
  },

  sendMessage: async (prompt: string, workspaceId: string, images?: string[], files?: UploadedFile[]) => {
    const { mode, sessionId, messages, autoMode } = get();
    let sid = sessionId;
    if (!sid) {
      const session = await window.cnke.session.create(workspaceId, prompt.slice(0, 30));
      sid = session.id;
      set({ sessionId: sid });
    }
    const userMsg: ChatMessage = {
      id: nanoid(),
      role: 'user',
      content: prompt,
      images,
      files: files && files.length > 0 ? files : undefined,
      timestamp: Date.now(),
    };
    const assistantMsg: ChatMessage = { id: nanoid(), role: 'assistant', content: '', timestamp: Date.now() };
    set((s) => ({ messages: [...s.messages, userMsg, assistantMsg], loading: true, streamingContent: '' }));

    const removeEvent = window.cnke.agent.onEvent((event) => {
      const s = get();
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== 'assistant') return;
      if (event.type === 'stream') {
        const newContent = s.streamingContent + event.data.delta;
        set({ streamingContent: newContent });
        msgs[msgs.length - 1] = { ...last, content: newContent };
        set({ messages: msgs });
      } else if (event.type === 'thinking') {
        msgs[msgs.length - 1] = { ...last, thinking: event.data.thinking };
        set({ messages: msgs });
      } else if (event.type === 'tool_call') {
        const tc = last.toolCalls || [];
        msgs[msgs.length - 1] = { ...last, toolCalls: [...tc, event.data] };
        set({ messages: msgs });
      } else if (event.type === 'model_fallback') {
        // 模型请求失败自动降级：显式告知用户实际使用的模型，避免"切换成功"的错觉
        msgs[msgs.length - 1] = {
          ...last,
          modelNotice: `模型 ${event.data.requestedModel || '?'} 请求失败，已自动切换备用模型：${event.data.actualName || event.data.actualModel || '?'}`,
        };
        set({ messages: msgs });
      } else if (event.type === 'done' || event.type === 'error') {
        set({ loading: false, streamingContent: '' });
        if (event.type === 'error') {
          msgs[msgs.length - 1] = { ...last, content: `Error: ${event.data.error}` };
          set({ messages: msgs });
          window.cnke.notify.show({ type: 'error', title: '任务异常', message: event.data.error || 'AI 任务异常退出' });
        } else {
          if (event.data?.usage) {
            msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], usage: event.data.usage };
            set({ messages: msgs });
          }
          window.cnke.notify.show({ type: 'done', title: '任务完成', message: prompt.slice(0, 50) });
        }
        removeEvent?.();
        const finalMsgs = get().messages;
        window.cnke.session.save({ id: sid, workspaceId, title: prompt.slice(0, 30), messages: finalMsgs, createdAt: Date.now(), updatedAt: Date.now(), mode });
        get().refreshSessions(workspaceId);
      }
    });

    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    try {
      await window.cnke.agent.run({ sessionId: sid, workspaceId, prompt, history, mode, images, files, autoApprove: autoMode });
    } catch (err: any) {
      // agent.run 抛出（如 IPC 断开 / 主进程崩溃后 invoke reject）：
      // 兜底重置 loading 并向用户提示，避免输入框永久卡死
      const msgs = get().messages;
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        const patched = [...msgs];
        patched[patched.length - 1] = { ...last, content: last.content || `Error: ${err?.message || '请求失败'}` };
        set({ messages: patched, loading: false, streamingContent: '' });
      } else {
        set({ loading: false, streamingContent: '' });
      }
      removeEvent?.();
    }
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
    set({ messages: next, streamingContent: '' });
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
    const history = messages.slice(0, idx);
    set({ messages: history, streamingContent: '', loading: true });

    const assistantMsg: ChatMessage = { id: nanoid(), role: 'assistant', content: '', timestamp: Date.now() };
    set((s) => ({ messages: [...s.messages, assistantMsg] }));

    let sid = sessionId;
    if (!sid) {
      const session = await window.cnke.session.create(workspaceId, prompt.slice(0, 30));
      sid = session.id;
      set({ sessionId: sid });
    }

    const removeEvent = window.cnke.agent.onEvent((event) => {
      const s = get();
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== 'assistant') return;
      if (event.type === 'stream') {
        const newContent = s.streamingContent + event.data.delta;
        set({ streamingContent: newContent });
        msgs[msgs.length - 1] = { ...last, content: newContent };
        set({ messages: msgs });
      } else if (event.type === 'thinking') {
        msgs[msgs.length - 1] = { ...last, thinking: event.data.thinking };
        set({ messages: msgs });
      } else if (event.type === 'tool_call') {
        const tc = last.toolCalls || [];
        msgs[msgs.length - 1] = { ...last, toolCalls: [...tc, event.data] };
        set({ messages: msgs });
      } else if (event.type === 'model_fallback') {
        // 模型请求失败自动降级：显式告知用户实际使用的模型，避免"切换成功"的错觉
        msgs[msgs.length - 1] = {
          ...last,
          modelNotice: `模型 ${event.data.requestedModel || '?'} 请求失败，已自动切换备用模型：${event.data.actualName || event.data.actualModel || '?'}`,
        };
        set({ messages: msgs });
      } else if (event.type === 'done' || event.type === 'error') {
        set({ loading: false, streamingContent: '' });
        if (event.type === 'error') {
          msgs[msgs.length - 1] = { ...last, content: `Error: ${event.data.error}` };
          set({ messages: msgs });
          window.cnke.notify.show({ type: 'error', title: '任务异常', message: event.data.error || 'AI 任务异常退出' });
        } else {
          if (event.data?.usage) {
            msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], usage: event.data.usage };
            set({ messages: msgs });
          }
          window.cnke.notify.show({ type: 'done', title: '任务完成', message: prompt.slice(0, 50) });
        }
        removeEvent?.();
        const finalMsgs = get().messages;
        window.cnke.session.save({ id: sid, workspaceId, title: prompt.slice(0, 30), messages: finalMsgs, createdAt: Date.now(), updatedAt: Date.now(), mode });
        get().refreshSessions(workspaceId);
      }
    });

    const historyForRun = history.map((m) => ({ role: m.role, content: m.content }));
    try {
      await window.cnke.agent.run({ sessionId: sid, workspaceId, prompt, history: historyForRun, mode, images, files, autoApprove: autoMode });
    } catch (err: any) {
      const msgs = get().messages;
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        const patched = [...msgs];
        patched[patched.length - 1] = { ...last, content: last.content || `Error: ${err?.message || '请求失败'}` };
        set({ messages: patched, loading: false, streamingContent: '' });
      } else {
        set({ loading: false, streamingContent: '' });
      }
      removeEvent?.();
    }
  },

  abort: () => {
    const { sessionId } = get();
    if (sessionId) {
      window.cnke.agent.abort(sessionId);
      set({ loading: false, streamingContent: '' });
    }
  },
}));
