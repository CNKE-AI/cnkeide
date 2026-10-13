import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFileSafe } from '../core-fork/util/SafeSpawn';

const execFileAsync = promisify(execFileSafe as any) as (
  file: string,
  args: string[],
  options: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: number;
}

export interface SearchResult {
  path: string;
  relativePath: string;
  line: number;
  column: number;
  match: string;
}

/**
 * FileSystemAdapter - 文件系统适配层
 * 替换 VSCode workspace.fs API
 * 用 Node.js fs 原生实现全部文件操作
 */
export class FileSystemAdapter {
  async readFile(filePath: string): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, content };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async writeFile(filePath: string, content: string): Promise<{ success: boolean; error?: string }> {
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async listDir(dirPath: string, showHidden: boolean = false): Promise<{ success: boolean; entries?: DirEntry[]; error?: string }> {
    try {
      if (!existsSync(dirPath)) {
        return { success: false, error: '目录不存在' };
      }
      const items = await fs.readdir(dirPath);
      const entries: DirEntry[] = [];

      for (const name of items) {
        if (!showHidden && name.startsWith('.')) continue;
        const fullPath = path.join(dirPath, name);
        try {
          const stat = await fs.stat(fullPath);
          entries.push({
            name,
            path: fullPath,
            isDirectory: stat.isDirectory(),
            isFile: stat.isFile(),
            size: stat.size,
            modified: stat.mtime.getTime(),
          });
        } catch {
          // skip
        }
      }

      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return { success: true, entries };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async createFile(filePath: string, content: string = ''): Promise<{ success: boolean; error?: string }> {
    try {
      if (existsSync(filePath)) {
        return { success: false, error: '文件已存在' };
      }
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async createDir(dirPath: string): Promise<{ success: boolean; error?: string }> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async deletePath(targetPath: string): Promise<{ success: boolean; error?: string }> {
    // 优先移入系统回收站/废纸篓：误删可恢复。原先直接 rm/unlink 永久删除，
    // 叠加 IPC 层无路径边界校验时存在全盘误删风险。
    try {
      const { shell } = await import('electron');
      await shell.trashItem(targetPath);
      return { success: true };
    } catch {
      /* 回收站不可用（网络盘/权限等）：回退到原删除逻辑 */
    }
    try {
      const stat = await fs.stat(targetPath);
      if (stat.isDirectory()) {
        await fs.rm(targetPath, { recursive: true, force: true });
      } else {
        await fs.unlink(targetPath);
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async renamePath(oldPath: string, newPath: string): Promise<{ success: boolean; error?: string }> {
    try {
      await fs.rename(oldPath, newPath);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async exists(targetPath: string): Promise<boolean> {
    return existsSync(targetPath);
  }

  async searchFiles(rootPath: string, pattern: string): Promise<{ success: boolean; results?: SearchResult[]; error?: string }> {
    try {
      // 尝试 ripgrep
      try {
        const { stdout } = await execFileAsync('rg', [
          '--line-number', '--column', '--no-heading',
          '--color', 'never', '--max-count', '100',
          pattern, rootPath,
        ], { maxBuffer: 10 * 1024 * 1024, timeout: 15000 });

        const results: SearchResult[] = stdout
          .split('\n')
          .filter((l) => l.trim())
          .slice(0, 100)
          .map((line) => {
            const parts = line.split(':');
            return {
              path: parts[0] || '',
              relativePath: path.relative(rootPath, parts[0] || ''),
              line: parseInt(parts[1] || '0', 10),
              column: parseInt(parts[2] || '0', 10),
              match: parts.slice(3).join(':'),
            };
          });

        return { success: true, results };
      } catch {
        // ripgrep 不可用，回退
      }

      // Node.js 回退方案
      const results: SearchResult[] = [];
      const regex = new RegExp(pattern, 'i');

      const walk = async (dir: string) => {
        if (results.length >= 100) return;
        const items = await fs.readdir(dir, { withFileTypes: true });
        for (const item of items) {
          if (results.length >= 100) return;
          if (item.name.startsWith('.') || item.name === 'node_modules') continue;
          const fullPath = path.join(dir, item.name);
          if (item.isDirectory()) {
            await walk(fullPath);
          } else if (item.isFile()) {
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length && results.length < 100; i++) {
                if (regex.test(lines[i])) {
                  results.push({
                    path: fullPath,
                    relativePath: path.relative(rootPath, fullPath),
                    line: i + 1,
                    column: 0,
                    match: lines[i].trim().slice(0, 200),
                  });
                }
              }
            } catch { /* skip */ }
          }
        }
      };

      await walk(rootPath);
      return { success: true, results };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
