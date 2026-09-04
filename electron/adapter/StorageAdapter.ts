import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * StorageAdapter - 存储适配层
 * 替换 VSCode globalState / workspaceState / secretStorage
 * 用 Electron userData 目录下 JSON 文件持久化
 */
export class StorageAdapter {
  private dataDir: string = '';

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
   * 读取一个集合中的所有记录
   */
  async getAll<T = any>(collection: string): Promise<T[]> {
    const file = this.getFilePath(collection);
    if (!existsSync(file)) return [];
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : Object.values(data);
    } catch {
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
   * 插入或更新记录
   */
  async upsert<T extends { id: string }>(collection: string, record: T): Promise<void> {
    const all = await this.getAll<any>(collection);
    const idx = all.findIndex((item) => item.id === record.id);
    if (idx >= 0) {
      all[idx] = record;
    } else {
      all.push(record);
    }
    await this.writeCollection(collection, all);
  }

  /**
   * 批量写入
   */
  async writeCollection(collection: string, data: any[]): Promise<void> {
    const file = this.getFilePath(collection);
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * 删除记录
   */
  async delete(collection: string, id: string): Promise<void> {
    const all = await this.getAll<any>(collection);
    const filtered = all.filter((item) => item.id !== id);
    await this.writeCollection(collection, filtered);
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
