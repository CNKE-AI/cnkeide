import { StorageAdapter } from '../../adapter/StorageAdapter';
import { randomUUID } from 'node:crypto';

/**
 * 本地记忆系统
 * - 在多次模型调用之间持久化保存关键上下文 / 用户偏好 / 对话摘要，
 *   避免每次调用重复输入相同内容浪费 token
 * - 数据落盘：userData/data/memories.json（复用 StorageAdapter 集合）
 * - 读取高效：内存缓存 + 惰性加载；写入可靠：300ms 防抖合并 + 异步写盘
 * - 大小限制：单条内容上限 / 总条数上限 / 单次注入预算（字符）
 * - 过期策略：条目级 expiresAt，惰性清理（读取/落盘时剔除过期项）
 */

export type MemoryType = 'preference' | 'project' | 'summary' | 'manual';
export type MemoryScope = 'global' | 'workspace';

export interface MemoryItem {
  id: string;
  /** 记忆正文（纯文本 / Markdown 均可） */
  content: string;
  /** preference=用户偏好 · project=项目事实/决策 · summary=对话摘要 · manual=手动 */
  type: MemoryType;
  /** global=全局生效 · workspace=仅指定工作区生效 */
  scope: MemoryScope;
  /** scope=workspace 时归属的工作区路径 */
  workspaceId?: string;
  /** 重要性 1-3，注入排序时高者优先 */
  importance: number;
  createdAt: number;
  updatedAt: number;
  /** 最近一次被注入/访问时间（LRU 参考） */
  lastAccessAt: number;
  /** 过期时间戳（ms）；缺省 = 永不过期 */
  expiresAt?: number;
  /** auto=运行自动提取 · manual=用户手动创建/编辑 */
  source: 'auto' | 'manual';
  enabled: boolean;
}

export interface MemoryItemInput {
  content: string;
  type?: MemoryType;
  scope?: MemoryScope;
  workspaceId?: string;
  importance?: number;
  /** 可选：有效期（天），>0 时写入 expiresAt */
  expiresInDays?: number;
  expiresAt?: number;
  source?: 'auto' | 'manual';
  enabled?: boolean;
}

export interface MemorySettings {
  /** 总开关：关闭后既不注入也不自动提取 */
  enabled: boolean;
  /** 自动加载：每次调用时自动注入匹配记忆 */
  autoLoad: boolean;
  /** 自动提取：每次对话结束后用 LLM 提炼值得记住的信息 */
  autoExtract: boolean;
  /** 每次调用注入的记忆总预算（字符），防止挤占上下文 */
  injectBudgetChars: number;
}

export const MEMORY_DEFAULT_SETTINGS: MemorySettings = {
  enabled: true,
  autoLoad: true,
  autoExtract: false,
  injectBudgetChars: 5000,
};

export const MEMORY_LIMITS = {
  /** 单条记忆内容上限（字符） */
  maxCharsPerItem: 4000,
  /** 记忆总条数上限 */
  maxItems: 120,
  /** 自动提取的记忆默认有效期（天） */
  autoExpireDays: 90,
} as const;

/** 归一化磁盘上的原始记录，非法/空记录返回 null */
function normalize(raw: unknown): MemoryItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const content = typeof rec.content === 'string' ? rec.content.trim() : '';
  if (!content) return null;
  const now = Date.now();
  const types: MemoryType[] = ['preference', 'project', 'summary', 'manual'];
  const importance = rec.importance;
  return {
    id: typeof rec.id === 'string' && rec.id ? rec.id : randomUUID(),
    content,
    type: types.includes(rec.type as MemoryType) ? (rec.type as MemoryType) : 'manual',
    scope: rec.scope === 'global' ? 'global' : 'workspace',
    workspaceId: typeof rec.workspaceId === 'string' ? rec.workspaceId : undefined,
    importance: Number.isInteger(importance) && (importance as number) >= 1 && (importance as number) <= 3 ? (importance as number) : 1,
    createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : now,
    updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : now,
    lastAccessAt: typeof rec.lastAccessAt === 'number' ? rec.lastAccessAt : (typeof rec.updatedAt === 'number' ? rec.updatedAt : now),
    expiresAt: typeof rec.expiresAt === 'number' && rec.expiresAt > 0 ? rec.expiresAt : undefined,
    source: rec.source === 'auto' ? 'auto' : 'manual',
    enabled: rec.enabled !== false,
  };
}

export class MemoryStore {
  private items: MemoryItem[] | null = null;
  private loading: Promise<void> | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private writing = false;

  constructor(private storage: StorageAdapter) {}

  /** 立即初始化（惰性加载已在首次 list/add 时发生，此方法供启动预载使用） */
  async warmUp(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<MemoryItem[]> {
    if (this.items) return this.items;
    if (!this.loading) {
      this.loading = (async () => {
        const now = Date.now();
        const raw = await this.storage.getAll<Record<string, unknown>>('memories');
        const kept: MemoryItem[] = [];
        for (const r of raw || []) {
          const item = normalize(r);
          if (!item) continue;
          // 惰性清理过期项：直接丢弃，不写回（避免高频读触发写盘）
          if (item.expiresAt && item.expiresAt <= now) continue;
          kept.push(item);
        }
        this.items = kept;
      })().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
    return this.items!;
  }

  /** 全部有效记忆（含禁用项，管理界面用）；过期项自动过滤 */
  async list(): Promise<MemoryItem[]> {
    const items = await this.load();
    const now = Date.now();
    return items
      .filter((m) => !(m.expiresAt && m.expiresAt <= now))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 新增记忆；内容重复（同 scope 前 40 字相同）时合并更新旧条目 */
  async add(input: MemoryItemInput): Promise<{ success: boolean; item?: MemoryItem; error?: string }> {
    const items = await this.load();
    const content = (input.content || '').trim();
    if (!content) return { success: false, error: '记忆内容不能为空' };
    if (content.length > MEMORY_LIMITS.maxCharsPerItem) {
      return { success: false, error: `单条记忆不能超过 ${MEMORY_LIMITS.maxCharsPerItem} 字符（当前 ${content.length} 字符）` };
    }
    const now = Date.now();
    const scope: MemoryScope = input.scope === 'global' ? 'global' : 'workspace';
    const workspaceId = scope === 'workspace' ? (input.workspaceId || undefined) : undefined;
    const type: MemoryType = input.type || 'manual';
    const importance = input.importance && input.importance >= 1 && input.importance <= 3 ? Math.round(input.importance) : 1;
    let expiresAt: number | undefined = input.expiresAt;
    if (input.expiresInDays && input.expiresInDays > 0) {
      expiresAt = now + input.expiresInDays * 24 * 60 * 60 * 1000;
    }

    // 去重合并：同一归属下已有内容高度相似的记忆，更新而非新增
    const dup = items.find(
      (m) => m.scope === scope && (m.workspaceId || undefined) === workspaceId && m.content.slice(0, 40) === content.slice(0, 40),
    );
    if (dup) {
      dup.content = content;
      dup.type = type;
      dup.importance = Math.max(dup.importance, importance);
      dup.updatedAt = now;
      dup.lastAccessAt = now;
      dup.expiresAt = expiresAt;
      dup.source = input.source === 'auto' ? 'auto' : dup.source;
      dup.enabled = true;
      this.schedulePersist();
      return { success: true, item: dup };
    }

    if (items.length >= MEMORY_LIMITS.maxItems) {
      return { success: false, error: `记忆已满（最多 ${MEMORY_LIMITS.maxItems} 条），请先删除部分旧记忆` };
    }

    const item: MemoryItem = {
      id: randomUUID(),
      content,
      type,
      scope,
      workspaceId,
      importance,
      createdAt: now,
      updatedAt: now,
      lastAccessAt: now,
      expiresAt,
      source: input.source === 'auto' ? 'auto' : 'manual',
      enabled: input.enabled !== false,
    };
    items.push(item);
    this.schedulePersist();
    return { success: true, item };
  }

  /** 更新一条记忆（只允许更新白名单字段） */
  async update(id: string, patch: Partial<MemoryItemInput>): Promise<{ success: boolean; item?: MemoryItem; error?: string }> {
    const items = await this.load();
    const item = items.find((m) => m.id === id);
    if (!item) return { success: false, error: '未找到该记忆（可能已过期删除）' };
    const now = Date.now();
    if (typeof patch.content === 'string') {
      const content = patch.content.trim();
      if (!content) return { success: false, error: '记忆内容不能为空' };
      if (content.length > MEMORY_LIMITS.maxCharsPerItem) {
        return { success: false, error: `单条记忆不能超过 ${MEMORY_LIMITS.maxCharsPerItem} 字符` };
      }
      item.content = content;
    }
    if (patch.type) item.type = patch.type;
    if (patch.scope) item.scope = patch.scope === 'global' ? 'global' : 'workspace';
    if (item.scope === 'workspace' && typeof patch.workspaceId === 'string') item.workspaceId = patch.workspaceId || undefined;
    if (patch.importance !== undefined && patch.importance >= 1 && patch.importance <= 3) item.importance = Math.round(patch.importance);
    if (patch.enabled !== undefined) item.enabled = patch.enabled;
    if (patch.expiresAt !== undefined) item.expiresAt = patch.expiresAt || undefined;
    if (patch.expiresInDays !== undefined) {
      item.expiresAt = patch.expiresInDays > 0 ? now + patch.expiresInDays * 24 * 60 * 60 * 1000 : undefined;
    }
    item.updatedAt = now;
    this.schedulePersist();
    return { success: true, item };
  }

  /** 删除一条记忆 */
  async remove(id: string): Promise<{ success: boolean; error?: string }> {
    const items = await this.load();
    const idx = items.findIndex((m) => m.id === id);
    if (idx === -1) return { success: false, error: '未找到该记忆' };
    items.splice(idx, 1);
    this.schedulePersist();
    return { success: true };
  }

  /** 清空全部记忆 */
  clear(): Promise<{ success: boolean; error?: string }> {
    this.items = [];
    this.dirty = true;
    this.schedulePersist();
    return Promise.resolve({ success: true });
  }

  /**
   * 构造注入文本：筛选当前工作区可用记忆，按 重要性>最近访问 排序，
   * 在字符预算内取最多 N 条；被选中的记忆记录访问时间（LRU）
   * @returns 注入文本（空串表示无可用记忆）
   */
  async buildInjection(workspaceId: string | undefined, budgetChars: number): Promise<string> {
    const items = await this.load();
    if (items.length === 0) return '';
    const now = Date.now();
    const usable = items
      .filter(
        (m) =>
          m.enabled &&
          !(m.expiresAt && m.expiresAt <= now) &&
          (m.scope === 'global' || (workspaceId && m.workspaceId === workspaceId)),
      )
      .sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance;
        return b.lastAccessAt - a.lastAccessAt;
      });

    if (usable.length === 0) return '';

    const chosen: MemoryItem[] = [];
    let used = 0;
    let touched = false;
    for (const m of usable) {
      if (used >= budgetChars) break;
      if (chosen.length >= 15) break;
      chosen.push(m);
      used += m.content.length;
      // 命中即记录访问（更新 lastAccessAt），仅当确有写入时才落盘
      m.lastAccessAt = now;
      touched = true;
    }
    if (touched) this.schedulePersist();

    const lines = chosen.map((m, i) => `${i + 1}. ${m.content.replace(/\s*\n+\s*/g, ' ').trim()}`);
    const total = lines.reduce((s, l) => s + l.length, 0);
    return (
      `\n\n[本地记忆] 系统保存了你过往的偏好/项目上下文/对话要点（自动持久化，供本次对话参考）。` +
      `若其中与你当前任务相关的内容，请将其作为既定事实与偏好；无关内容请忽略：\n` +
      lines.join('\n') +
      `\n（以上记忆共 ${chosen.length} 条 / 约 ${total} 字符）`
    );
  }

  /** 移除已过期项并立即落盘（供退出前调用） */
  async flushNow(): Promise<void> {
    if (this.items) {
      const now = Date.now();
      const before = this.items.length;
      this.items = this.items.filter((m) => !(m.expiresAt && m.expiresAt <= now));
      if (this.items.length !== before) this.dirty = true;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) {
      const snapshot = this.items ? [...this.items] : [];
      this.dirty = false;
      await this.storage.writeCollection('memories', snapshot);
    }
  }

  // ===== 内部：防抖 + 防并发写盘 =====

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, 300);
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    if (this.writing) return; // 正在写盘：dirty 保持 true，写完后再补一轮
    const snapshot = this.items ? [...this.items] : [];
    this.dirty = false;
    this.writing = true;
    try {
      await this.storage.writeCollection('memories', snapshot);
    } catch {
      this.dirty = true; // 写失败标记重试
    } finally {
      this.writing = false;
      if (this.dirty) void this.flush();
    }
  }
}
