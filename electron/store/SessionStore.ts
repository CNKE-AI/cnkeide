import { StorageAdapter } from '../adapter/StorageAdapter';
import { ConfigAdapter } from '../adapter/ConfigAdapter';
import { randomUUID } from 'node:crypto';

export interface ChatSession {
  id: string;
  workspaceId: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  mode?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | any[];
  /** 用户原话：content 可能已被 @文件 注入全文占满，回显与历史都用这个 */
  displayContent?: string;
  thinking?: string;
  toolCalls?: any[];
  timestamp: number;
  images?: string[];
}

/**
 * SessionStore - 会话持久化存储
 * 替换 VSCode extension context.globalState
 * 用 StorageAdapter 存储到 userData
 */
export class SessionStore {
  constructor(
    private storage: StorageAdapter,
    private config: ConfigAdapter,
  ) {}

  async listByWorkspace(workspaceId: string): Promise<ChatSession[]> {
    const all = await this.storage.getAll<ChatSession>('sessions');
    return all
      .filter((s) => s.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 全局会话列表（跨工作区，用于多工作区自由切换） */
  async listAll(): Promise<ChatSession[]> {
    const all = await this.storage.getAll<ChatSession>('sessions');
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(sessionId: string): Promise<ChatSession | null> {
    return this.storage.getById<ChatSession>('sessions', sessionId);
  }

  async save(session: ChatSession): Promise<{ success: boolean; error?: string }> {
    try {
      session.updatedAt = Date.now();
      await this.storage.upsert('sessions', session);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async delete(sessionId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.storage.delete('sessions', sessionId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async create(workspaceId: string, title?: string): Promise<ChatSession> {
    const session: ChatSession = {
      id: randomUUID(),
      workspaceId,
      title: title || '新对话',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: this.config.get('agentConfig.mode', 'plan'),
    };
    await this.save(session);
    return session;
  }
}
