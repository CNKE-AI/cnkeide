import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * StorageAdapter - 存储适配层
 * 替换 VSCode globalState / workspaceState / secretStorage
 * 用 Electron userData 目录下 JSON 文件持久化
 *
 * 数据完整性三重防护：
 * 1. 原子写：先写临时文件再 rename 替换，写一半崩溃不会产生截断 JSON；
 * 2. 写队列：同一 collection 的读改写按序串行执行，防止并发 upsert/delete
 *    互相覆盖（丢失更新 / 删除复活）；
 * 3. 损坏隔离：JSON 解析失败时先把损坏文件改名备份（.corrupt-<ts>）再返回空，
 *    防止后续 upsert 以空集合整体覆盖导致历史数据被物理清空。
 */
export class StorageAdapter {
  private dataDir: string = '';
  /** 按 collection 串行化写事务的队列尾（读改写排队执行） */
  private writeQueues: Map<string, Promise<unknown>> = new Map();

  async init(): Promise<void> {
    this.dataDir = path.join(app.getPath('userData'), 'data');
    if (!existsSync(this.dataDir)) {
      await fs.mkdir(this.dataDir, { recursive: true });
    }
  }

  private getFilePath(collection: string): string {
    return path.join(this.dataDir, `${collection}.json`);
  }

  /**
   * 把任务排到 collection 的写队列尾部，返回排队后的 Promise。
   * 同一 collection 的写操作（upsert/delete/writeCollection）串行执行，
   * 消除「getAll → 内存修改 → 整体写回」模式下的并发覆盖。
   */
  private enqueue<T>(collection: string, task: () => Promise<T>): Promise<T> {
    const prev = this.writeQueues.get(collection) || Promise.resolve();
    const next = prev.then(task, task);
    this.writeQueues.set(collection, next);
    // 队列消化完后清理引用，避免长期持有已完成的 Promise
    void next.finally(() => {
      if (this.writeQueues.get(collection) === next) {
        this.writeQueues.delete(collection);
      }
    });
    return next;
  }

  /**
   * 读取一个集合中的所有记录
   */
  async getAll<T = any>(collection: string): Promise<T[]> {
    const file = this.getFilePath(collection);
    if (!existsSync(file)) return [];
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : Object.values(data);
    } catch (err) {
      // 文件损坏（写一半崩溃/断电等）：先备份现场再返回空。
      // 若直接返回空，下一次 upsert 会以「空数组 + 新记录」整体覆盖写回，
      // 导致整个集合的历史数据被物理销毁。
      try {
        await fs.rename(file, `${file}.corrupt-${Date.now()}`);
        console.error(`[Storage] ${collection}.json 解析失败，已备份为 .corrupt-* 以防数据被覆盖清空：`, err);
      } catch {
        console.error(`[Storage] ${collection}.json 解析失败且备份失败：`, err);
      }
      return [];
    }
  }

  /**
   * 按 id 读取单条记录
   */
  async getById<T = any>(collection: string, id: string): Promise<T | null> {
    const all = await this.getAll<T>(collection);
    return all.find((item: any) => item.id === id) || null;
  }

  /**
   * 插入或更新记录（经写队列串行化，防并发覆盖）
   */
  async upsert<T extends { id: string }>(collection: string, record: T): Promise<void> {
    return this.enqueue(collection, async () => {
      const all = await this.getAll<any>(collection);
      const idx = all.findIndex((item) => item.id === record.id);
      if (idx >= 0) {
        all[idx] = record;
      } else {
        all.push(record);
      }
      await this.writeCollectionInternal(collection, all);
    });
  }

  /**
   * 批量写入（经写队列串行化 + 原子落盘）
   */
  async writeCollection(collection: string, data: any[]): Promise<void> {
    return this.enqueue(collection, () => this.writeCollectionInternal(collection, data));
  }

  /**
   * 实际落盘：写临时文件 → rename 原子替换。
   * 仅在写队列任务内被调用（或由 writeCollection 排队后调用），不要直接使用。
   */
  private async writeCollectionInternal(collection: string, data: any[]): Promise<void> {
    const file = this.getFilePath(collection);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    // Windows 上 rename 对已存在目标文件等效替换（Node 用 MoveFileEx REPLACE_EXISTING）
    await fs.rename(tmp, file);
  }

  /**
   * 删除记录（经写队列串行化，防并发覆盖）
   */
  async delete(collection: string, id: string): Promise<void> {
    return this.enqueue(collection, async () => {
      const all = await this.getAll<any>(collection);
      const filtered = all.filter((item) => item.id !== id);
      await this.writeCollectionInternal(collection, filtered);
    });
  }

  /**
   * 清空集合
   */
  async clear(collection: string): Promise<void> {
    await this.writeCollection(collection, []);
  }

  /**
   * 生成 UUID
   */
  uuid(): string {
    return randomUUID();
  }

  /**
   * 获取数据目录
   */
  getDataDir(): string {
    return this.dataDir;
  }
}
