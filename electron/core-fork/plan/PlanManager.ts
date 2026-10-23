/**
 * PlanManager - 任务规划状态机（W3）
 *
 * 目标：让 Agent 的多步任务显式化、可视化、可中途干预
 * 借鉴 Claude Code / Cursor 的 Plan 模式：创建计划 → 逐步追踪 → 标记完成
 *
 * 设计原则：
 * 1. 每个会话独立一个 Plan（sessionId 隔离）
 * 2. 状态机严格：pending → running → completed | failed | skipped
 * 3. 支持中途追加步骤
 * 4. 支持用户跳过 / 取消某个步骤
 * 5. 提供 summary() 给 LLM 注入上下文
 */

export type PlanItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PlanItem {
  id: string;
  content: string;
  status: PlanItemStatus;
  /** 关联的工具名（如 read_file / write_to_file 等） */
  toolName?: string;
  /** 关联的文件路径（用于回滚关联） */
  filePath?: string;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface Plan {
  id: string;
  sessionId: string;
  title?: string;
  items: PlanItem[];
  createdAt: number;
  updatedAt: number;
}

export interface PlanEvent {
  type: 'created' | 'updated' | 'item-status-changed' | 'item-added' | 'completed' | 'abandoned';
  planId: string;
  plan?: Plan;
  item?: PlanItem;
}

const VALID_STATUSES: PlanItemStatus[] = ['pending', 'running', 'completed', 'failed', 'skipped'];

/** plans 缓存的容量上限：超出后按插入顺序淘汰最早的计划 */
const MAX_CACHED_PLANS = 200;

export class PlanManager {
  private plans: Map<string, Plan> = new Map();
  private listeners: Set<(e: PlanEvent) => void> = new Set();

  /**
   * 淘汰最旧计划，防止 plans 无限增长。
   *
   * 这个 Map 以 sessionId 为 key，而 clear() 虽已存在却长期没有任何调用点：
   * 用户删掉的会话，其计划一直留在内存里。单个 Plan 不大，但会话数量会随时间
   * 累积，属于典型的小而持续的泄漏。
   * 正常路径由 session:delete 调用 clear() 精确释放；这里只是兜底上限，
   * 防止其它入口（如新建后未保存的会话）漏掉清理。
   */
  private evictOldest(): void {
    if (this.plans.size < MAX_CACHED_PLANS) return;
    // Map 保持插入顺序，最前面的即为最早创建的计划
    const overflow = this.plans.size - MAX_CACHED_PLANS + 1;
    let removed = 0;
    for (const key of this.plans.keys()) {
      if (removed >= overflow) break;
      this.plans.delete(key);
      removed++;
    }
  }

  /** 当前会话是否存在 plan */
  hasPlan(sessionId: string): boolean {
    return this.plans.has(sessionId);
  }

  getPlan(sessionId: string): Plan | undefined {
    return this.plans.get(sessionId);
  }

  /** 创建计划（每个会话只允许一个；已存在则覆盖） */
  create(sessionId: string, items: { content: string; toolName?: string; filePath?: string }[], title?: string): Plan {
    const now = Date.now();
    const plan: Plan = {
      id: `plan_${sessionId}_${now}`,
      sessionId,
      title,
      items: items.map((it, idx) => ({
        id: `item_${now}_${idx}`,
        content: it.content,
        status: 'pending',
        toolName: it.toolName,
        filePath: it.filePath,
      })),
      createdAt: now,
      updatedAt: now,
    };
    this.evictOldest();
    // 先 delete 再 set：Map 对已存在的 key 执行 set 不更新插入序，
    // 直接覆盖会让"老会话重建计划"仍排在最旧位置，被 evictOldest 误淘汰
    this.plans.delete(sessionId);
    this.plans.set(sessionId, plan);
    this.emit({ type: 'created', planId: plan.id, plan });
    return plan;
  }

  /** 追加步骤 */
  addItem(sessionId: string, content: string, toolName?: string, filePath?: string): PlanItem | null {
    const plan = this.plans.get(sessionId);
    if (!plan) return null;
    const item: PlanItem = {
      id: `item_${Date.now()}_${plan.items.length}`,
      content,
      status: 'pending',
      toolName,
      filePath,
    };
    plan.items.push(item);
    plan.updatedAt = Date.now();
    this.emit({ type: 'item-added', planId: plan.id, plan, item });
    return item;
  }

  /** 更新步骤状态（状态机校验） */
  updateStatus(sessionId: string, itemId: string, status: PlanItemStatus, error?: string): boolean {
    if (!VALID_STATUSES.includes(status)) {
      return false;
    }
    const plan = this.plans.get(sessionId);
    if (!plan) return false;
    const item = plan.items.find((i) => i.id === itemId);
    if (!item) return false;

    // 所有终态只能通过 retryItem 显式重试，避免跳过或失败步骤被工具调用意外恢复。
    const isTerminal = (s: PlanItemStatus) => s === 'completed' || s === 'failed' || s === 'skipped';
    if (isTerminal(item.status) && status !== item.status) {
      return false;
    }

    const now = Date.now();
    if (status === 'running' && !item.startedAt) {
      item.startedAt = now;
    }
    if (status === 'completed' || status === 'failed' || status === 'skipped') {
      item.completedAt = now;
    }
    item.status = status;
    if (error) item.error = error;
    plan.updatedAt = now;

    this.emit({ type: 'item-status-changed', planId: plan.id, plan, item });

    // 全部完成事件
    if (plan.items.every((i) => i.status === 'completed' || i.status === 'skipped' || i.status === 'failed')) {
      this.emit({ type: 'completed', planId: plan.id, plan });
    }
    return true;
  }

  /** 标记某步骤为 running（开始执行） */
  startItem(sessionId: string, itemId: string): boolean {
    return this.updateStatus(sessionId, itemId, 'running');
  }

  /** 标记某步骤为 completed */
  completeItem(sessionId: string, itemId: string): boolean {
    return this.updateStatus(sessionId, itemId, 'completed');
  }

  /** 标记失败（带错误信息） */
  failItem(sessionId: string, itemId: string, error: string): boolean {
    return this.updateStatus(sessionId, itemId, 'failed', error);
  }

  /** 将失败或跳过的步骤恢复为待执行。 */
  retryItem(sessionId: string, itemId: string): boolean {
    const plan = this.plans.get(sessionId);
    const item = plan?.items.find((entry) => entry.id === itemId);
    if (!plan || !item || (item.status !== 'failed' && item.status !== 'skipped')) return false;
    item.startedAt = undefined;
    item.completedAt = undefined;
    item.error = undefined;
    item.status = 'pending';
    plan.updatedAt = Date.now();
    this.emit({ type: 'item-status-changed', planId: plan.id, plan, item });
    return true;
  }

  /** 用户跳过某步骤 */
  skipItem(sessionId: string, itemId: string): boolean {
    return this.updateStatus(sessionId, itemId, 'skipped');
  }

  /** 用户中止计划 */
  abandon(sessionId: string): void {
    const plan = this.plans.get(sessionId);
    if (!plan) return;
    // 其它 pending/running 全部标 skipped
    for (const it of plan.items) {
      if (it.status === 'pending' || it.status === 'running') {
        it.status = 'skipped';
        it.completedAt = Date.now();
      }
    }
    plan.updatedAt = Date.now();
    this.emit({ type: 'abandoned', planId: plan.id, plan });
  }

  /** 清除会话的 plan */
  clear(sessionId: string): void {
    this.plans.delete(sessionId);
  }

  /** 会话的 plan 进度（已完成/总步骤） */
  progress(sessionId: string): { done: number; total: number; failed: number; skipped: number; pending: number; running: number } | null {
    const plan = this.plans.get(sessionId);
    if (!plan) return null;
    const stats = { done: 0, total: plan.items.length, failed: 0, skipped: 0, pending: 0, running: 0 };
    for (const it of plan.items) {
      if (it.status === 'completed') stats.done++;
      else if (it.status === 'failed') stats.failed++;
      else if (it.status === 'skipped') stats.skipped++;
      else if (it.status === 'running') stats.running++;
      else if (it.status === 'pending') stats.pending++;
    }
    return stats;
  }

  /** 给 LLM 注入的 plan 摘要 */
  summaryForLlm(sessionId: string): string {
    const plan = this.plans.get(sessionId);
    if (!plan) return '';
    const lines: string[] = [];
    lines.push(`[当前计划] ${plan.title || '任务计划'}`);
    plan.items.forEach((it, idx) => {
      const mark =
        it.status === 'completed' ? '✅' :
        it.status === 'failed' ? '❌' :
        it.status === 'running' ? '▶️' :
        it.status === 'skipped' ? '⏭️' : '⬜';
      lines.push(`${idx + 1}. ${mark} ${it.content}${it.error ? ` (错误: ${it.error})` : ''}`);
    });
    const stats = this.progress(sessionId);
    if (stats) {
      const parts = [`${stats.done}/${stats.total} 完成`];
      if (stats.running) parts.push(`${stats.running} 进行中`);
      if (stats.pending) parts.push(`${stats.pending} 待执行`);
      if (stats.failed) parts.push(`${stats.failed} 失败`);
      if (stats.skipped) parts.push(`${stats.skipped} 跳过`);
      lines.push(`\n进度：${parts.join('，')}`);
    }
    return lines.join('\n');
  }

  /** 事件订阅 */
  on(listener: (e: PlanEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: PlanEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* ignore */
      }
    }
  }
}
