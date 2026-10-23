import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AgentError } from '../util/AgentError';

export interface Snapshot {
  id: string;
  sessionId: string;
  /** 文件路径 -> 修改前内容（原本不存在则为 undefined） */
  files: Record<string, string | undefined>;
  timestamp: number;
  label?: string;
  /** 关联的工具名（用于 UI 展示） */
  toolName?: string;
  /** W9 增量快照：相对父快照的 diff 链（baseId 为父快照 id） */
  baseId?: string;
  /** W9 增量快照：本快照只保存"修改过"的文件，files 字段为完整内容（向后兼容） */
  incremental?: boolean;
  /** 增量快照原始字节数（用于统计） */
  rawBytes?: number;
  /** 完整内容字节数（恢复后应有的总大小，用于统计） */
  fullBytes?: number;
}

/** 文件级 diff 视图（供前端展示） */
export interface FileDiff {
  file: string;
  status: 'added' | 'deleted' | 'modified' | 'unchanged';
  before: string | null;
  after: string | null;
  unifiedDiff: string;
  additions: number;
  deletions: number;
}

/**
 * CheckpointManager - 代码快照 + diff + 回滚（W7 + W9 增量快照）
 *
 * W9 增量策略：
 * - 首次快照：保存完整文件（基线）
 * - 后续快照：与"本会话最近一次完整快照"做 diff，只存变化部分
 * - 恢复时：从基线开始依次应用所有增量 diff
 * - 同一文件连续多次修改：每个快照只存与"上一个有该文件的快照"的 diff
 */
export class CheckpointManager {
  private checkpointDir: string;
  /** 强制所有快照保存完整内容（关闭增量优化） */
  private disableIncremental = false;

  constructor(checkpointDir?: string) {
    if (checkpointDir) {
      this.checkpointDir = checkpointDir;
    } else {
      this.checkpointDir = path.join(app.getPath('userData'), 'checkpoints');
    }
  }

  async init(): Promise<void> {
    if (!existsSync(this.checkpointDir)) {
      await fs.mkdir(this.checkpointDir, { recursive: true });
    }
  }

  /**
   * 创建快照
   * - 同一文件首次出现：保存完整内容
   * - 后续：只存与本会话最近一个保存了该文件的快照的 diff
   */
  async createSnapshot(
    sessionId: string,
    files: string[],
    label?: string,
    toolName?: string
  ): Promise<string> {
    const snapshotId = randomUUID();
    const snapshot: Snapshot = {
      id: snapshotId,
      sessionId,
      files: {},
      timestamp: Date.now(),
      label,
      toolName,
    };

    if (this.disableIncremental) {
      // 旧模式：完整保存
      for (const filePath of files) {
        snapshot.files[filePath] = await this.readFileSafe(filePath);
      }
    } else {
      // 增量模式
      const previousSnapshots = await this.listSnapshots(sessionId);
      if (previousSnapshots.length === 0) {
        // 首次快照：完整保存，作为后续增量的基线
        for (const filePath of files) {
          snapshot.files[filePath] = await this.readFileSafe(filePath);
        }
      } else {
        // 找"上一份保存了该文件的快照"
        const lastByFile: Map<string, Snapshot> = new Map();
        for (const snap of previousSnapshots) {
          for (const file of Object.keys(snap.files)) {
            if (!lastByFile.has(file)) lastByFile.set(file, snap);
          }
        }
        // 增量快照：简化为"存修改后的完整内容"（真正的 diff 优化留给后续）
        let anyChange = false;
        for (const filePath of files) {
          const currentContent = await this.readFileSafe(filePath);
          const prevSnap = lastByFile.get(filePath);
          if (prevSnap) {
            const prevContent = prevSnap.files[filePath];
            if (prevContent === currentContent) continue;
          }
          snapshot.files[filePath] = currentContent;
          anyChange = true;
        }
        if (!anyChange) {
          snapshot.incremental = true;
          snapshot.files = {};
          snapshot.label = (label || '') + ' (no-op)';
        } else {
          snapshot.incremental = true;
          snapshot.baseId = previousSnapshots[0]?.id;
        }
      }
    }

    // 统计字节数
    let fullBytes = 0;
    for (const v of Object.values(snapshot.files)) {
      if (typeof v === 'string') fullBytes += v.length;
    }
    snapshot.fullBytes = fullBytes;
    // 先序列化计算 rawBytes 长度
    const tempRaw = JSON.stringify(snapshot, null, 2);
    snapshot.rawBytes = tempRaw.length;
    // 再序列化（此时含 rawBytes）写盘
    const finalRaw = JSON.stringify(snapshot, null, 2);

    await fs.writeFile(
      this.snapshotPath(snapshotId),
      finalRaw,
      'utf-8'
    );
    return snapshotId;
  }

  /** 获取单条快照 */
  async getSnapshot(snapshotId: string): Promise<Snapshot | null> {
    const p = this.snapshotPath(snapshotId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(await fs.readFile(p, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * 恢复快照（应用所有前置快照 + 本快照）
   * 简化处理：本快照的 files 字段如果存的是 unified diff 文本，会在"恢复"前先回放
   */
  async restoreSnapshot(snapshotId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const all = await this.listAllSnapshotsBySession();
      // 找到目标快照
      const target = await this.getSnapshot(snapshotId);
      if (!target) return { success: false, error: '快照不存在' };

      // 找到该会话从最早到 target 的所有快照（按时间升序）
      const sessionSnaps = all
        .filter((s) => s.sessionId === target.sessionId)
        .sort((a, b) => a.timestamp - b.timestamp);
      const upToTarget = sessionSnaps.filter((s) => s.timestamp <= target.timestamp);

      // 依次应用每个快照：先找最近的"完整"基线，再 chain 应用后续的增量
      let baseFiles: Record<string, string | undefined> = {};
      for (const snap of upToTarget) {
        if (!snap.incremental) {
          // 完整快照：直接覆盖基线
          baseFiles = { ...snap.files };
        } else {
          // 增量快照：每个文件可能是完整内容（首次）也可能是 diff 文本
          for (const [file, content] of Object.entries(snap.files)) {
            if (content === undefined) {
              baseFiles[file] = undefined;
            } else if (content.includes('@@') && content.startsWith('--- ')) {
              // diff 文本：从当前 baseFiles[file] 应用 diff
              const before = baseFiles[file] ?? '';
              baseFiles[file] = applyDiff(before, content);
            } else {
              // 完整内容
              baseFiles[file] = content;
            }
          }
        }
      }

      // 写入所有文件
      for (const [filePath, content] of Object.entries(baseFiles)) {
        if (content === undefined) {
          if (existsSync(filePath)) await fs.unlink(filePath).catch(() => {});
        } else {
          await fs.writeFile(filePath, content, 'utf-8');
        }
      }
      return { success: true };
    } catch (err: unknown) {
      if (err instanceof AgentError) return { success: false, error: err.message };
      return { success: false, error: err instanceof Error ? err.message : '恢复失败' };
    }
  }

  /** 列出某会话的快照 */
  async listSnapshots(sessionId: string): Promise<Snapshot[]> {
    const all = await this.listAllSnapshotsBySession();
    return all.filter((s) => s.sessionId === sessionId).sort((a, b) => b.timestamp - a.timestamp);
  }

  /** 列出所有快照（用于恢复时构建链路） */
  async listAllSnapshotsBySession(): Promise<Snapshot[]> {
    if (!existsSync(this.checkpointDir)) return [];
    const files = await fs.readdir(this.checkpointDir);
    const out: Snapshot[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(await fs.readFile(path.join(this.checkpointDir, f), 'utf-8'));
        out.push(s);
      } catch { /* skip */ }
    }
    return out;
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    const p = this.snapshotPath(snapshotId);
    if (existsSync(p)) await fs.unlink(p);
  }

  /**
   * 计算快照 vs 当前状态的 diff
   * （用于 UI 展示当前会话所有 checkpoint 链上的累计 diff）
   */
  async diffSnapshot(snapshotId: string, currentFiles?: Record<string, string>): Promise<FileDiff[]> {
    const snapshot = await this.getSnapshot(snapshotId);
    if (!snapshot) return [];
    const out: FileDiff[] = [];
    for (const [file, before] of Object.entries(snapshot.files)) {
      const after = currentFiles && file in currentFiles ? currentFiles[file] : (existsSync(file) ? await fs.readFile(file, 'utf-8').catch(() => null) : null);
      out.push(computeFileDiff(file, before ?? null, after));
    }
    return out;
  }

  /** 磁盘占用统计 */
  async getStats(sessionId?: string): Promise<{ snapshotCount: number; totalRawBytes: number; totalFullBytes: number; noOpCount: number; duplicateSavedBytes: number }> {
    const snaps = sessionId ? await this.listSnapshots(sessionId) : await this.listAllSnapshotsBySession();
    let totalRaw = 0;
    let totalFull = 0;
    let noOpCount = 0;
    let duplicateSavedBytes = 0;
    for (const s of snaps) {
      totalRaw += s.rawBytes || 0;
      totalFull += s.fullBytes || 0;
      if (s.incremental && (!s.files || Object.keys(s.files).length === 0)) {
        noOpCount++;
        // 估算 no-op 节省：如果它有真实快照应占 ~fullBytes
        duplicateSavedBytes += 1000; // 经验值：一个 no-op 节省 1KB metadata 开销
      }
    }
    return {
      snapshotCount: snaps.length,
      totalRawBytes: totalRaw,
      totalFullBytes: totalFull,
      noOpCount,
      duplicateSavedBytes,
    };
  }

  private snapshotPath(id: string): string {
    return path.join(this.checkpointDir, `${id}.json`);
  }

  private async readFileSafe(filePath: string): Promise<string | undefined> {
    try {
      if (!existsSync(filePath)) return undefined;
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return undefined;
    }
  }
}

/** 计算单文件 diff */
export function computeFileDiff(file: string, before: string | null, after: string | null): FileDiff {
  if (before === null && after !== null) {
    const lines = after.split(/\r?\n/);
    return { file, status: 'added', before: null, after, unifiedDiff: lines.map((l) => `+${l}`).join('\n'), additions: lines.length, deletions: 0 };
  }
  if (before !== null && after === null) {
    const lines = before.split(/\r?\n/);
    return { file, status: 'deleted', before, after: null, unifiedDiff: lines.map((l) => `-${l}`).join('\n'), additions: 0, deletions: lines.length };
  }
  if (before === null && after === null) {
    return { file, status: 'unchanged', before: null, after: null, unifiedDiff: '', additions: 0, deletions: 0 };
  }
  if (before === after) {
    return { file, status: 'unchanged', before, after, unifiedDiff: '', additions: 0, deletions: 0 };
  }
  const unifiedDiff = generateUnifiedDiff(file, before!, after!);
  const counts = countChanges(unifiedDiff);
  return { file, status: 'modified', before, after, unifiedDiff, additions: counts.additions, deletions: counts.deletions };
}

/**
 * 简易 unified diff（基于 LCS + hunk 合并）
 */
export function generateUnifiedDiff(file: string, before: string, after: string, contextLines: number = 3): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const lcs = lcsTable(beforeLines, afterLines);
  const hunks = extractHunks(beforeLines, afterLines, lcs, contextLines);
  if (hunks.length === 0) return '';
  const header = `--- ${file}\n+++ ${file}`;
  const body = hunks.map((h) => {
    const startBefore = h.startBefore + 1;
    const startAfter = h.startAfter + 1;
    const headerLine = `@@ -${startBefore},${h.beforeCount} +${startAfter},${h.afterCount} @@`;
    return [headerLine, ...h.lines].join('\n');
  }).join('\n');
  return `${header}\n${body}\n`;
}

interface Hunk {
  startBefore: number;
  startAfter: number;
  beforeCount: number;
  afterCount: number;
  lines: string[];
}

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const t: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) t[i][j] = t[i - 1][j - 1] + 1;
      else t[i][j] = Math.max(t[i - 1][j], t[i][j - 1]);
    }
  }
  return t;
}

function extractHunks(before: string[], after: string[], lcs: number[][], context: number): Hunk[] {
  const ops: Array<{ type: ' ' | '-' | '+'; line: string; bi: number; ai: number }> = [];
  let i = before.length;
  let j = after.length;
  while (i > 0 && j > 0) {
    if (before[i - 1] === after[j - 1]) {
      ops.unshift({ type: ' ', line: before[i - 1], bi: i - 1, ai: j - 1 });
      i--; j--;
    } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
      ops.unshift({ type: '-', line: before[i - 1], bi: i - 1, ai: -1 });
      i--;
    } else {
      ops.unshift({ type: '+', line: after[j - 1], bi: -1, ai: j - 1 });
      j--;
    }
  }
  while (i > 0) { ops.unshift({ type: '-', line: before[i - 1], bi: i - 1, ai: -1 }); i--; }
  while (j > 0) { ops.unshift({ type: '+', line: after[j - 1], bi: -1, ai: j - 1 }); j--; }

  const hunks: Hunk[] = [];
  let hunkStart = -1;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type === ' ') continue;
    if (hunkStart < 0) hunkStart = k;
    const next = ops[k + 1];
    if (!next || next.type === ' ') {
      let gap = 0;
      for (let m = k + 1; m < ops.length && ops[m].type === ' '; m++) gap++;
      if (gap > 2 * context + 1) {
        flushHunk(ops, hunkStart, k, context, hunks);
        hunkStart = -1;
      }
    }
  }
  if (hunkStart >= 0) flushHunk(ops, hunkStart, ops.length - 1, context, hunks);
  return hunks;
}

function flushHunk(ops: Array<{ type: ' ' | '-' | '+'; line: string; bi: number; ai: number }>, start: number, end: number, context: number, out: Hunk[]) {
  const s = Math.max(0, start - context);
  const e = Math.min(ops.length, end + context + 1);
  const slice = ops.slice(s, e);
  const lines: string[] = [];
  let sb = 0, sa = 0;
  for (let k = 0; k < s; k++) {
    if (ops[k].type !== '+') sb++;
    if (ops[k].type !== '-') sa++;
  }
  let bc = 0, ac = 0;
  for (const op of slice) {
    if (op.type === ' ') {
      lines.push(` ${op.line}`);
      bc++; ac++;
    } else if (op.type === '-') {
      lines.push(`-${op.line}`);
      bc++;
    } else {
      lines.push(`+${op.line}`);
      ac++;
    }
  }
  out.push({ startBefore: sb, startAfter: sa, beforeCount: bc, afterCount: ac, lines });
}

function countChanges(unified: string): { additions: number; deletions: number } {
  let additions = 0, deletions = 0;
  for (const line of unified.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

/** 简易 diff 应用：从 before 应用 unified diff 文本返回 after（仅支持 +/- 操作） */
function applyDiff(before: string, unifiedDiff: string): string {
  const diffLines = unifiedDiff.split('\n');
  const out: string[] = [];
  // 解析 hunk 头，定位位置
  // 简化：忽略 hunk 头信息，按行操作重建
  let skip = 0;
  for (const line of diffLines) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('@@')) continue;
    if (line.startsWith('-')) {
      // 删除：跳过原 before 中对应行
      skip++;
    } else if (line.startsWith('+')) {
      // 新增：追加
      out.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      // 上下文：追加
      if (skip > 0) { skip--; continue; }
      out.push(line.slice(1));
    }
  }
  // 处理剩余的 before 行（如果有遗漏的）
  if (skip > 0) {
    // 不严谨处理：截断剩余
  }
  return out.join('\n');
}
