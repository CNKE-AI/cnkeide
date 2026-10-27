/**
 * MCP Catalog Service —— 开源 MCP 远程目录 + 本地离线预设
 *
 * 架构：
 * 1. 远程主源 = 官方 MCP Registry（registry.modelcontextprotocol.io/v0/servers）
 *    - 主进程直接 fetch，避免 CORS 与暴露第三方 URL 到 renderer
 *    - TTL 24h 本地缓存（userDataDir/mcp_catalog.json）
 * 2. 离线兜底 = 内置 10 个常用 stdio 服务器预设（官方 Registry 主要收 HTTP，stdio 场景需本地补）
 *    - 预设与远程条目同构展示，安装时走同一条 mcp:addServer IPC
 * 3. 一键安装：catalog entry → McpServerConfig 字段映射 → 调 McpHub.addServer
 *
 * 远程条目（官方 Registry）字段映射：
 *   server.title           → name
 *   server.description     → description
 *   remotes[first streamable-http].url → url, protocol='http'
 *   name 与 version 保留为 id 前缀 + 版本展示
 *
 * 预设条目（stdio）：直接提供 McpServerConfig 形态
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface McpCatalogEntry {
  /** 唯一 key（远程用 registry.name，预设用固定 id） */
  id: string;
  /** 显示名称 */
  name: string;
  /** 简要描述 */
  description: string;
  /** 来源 */
  source: 'registry' | 'builtin';
  /** 版本（远程有，预设一般不填） */
  version?: string;
  /** 官方仓库 URL（可空） */
  repositoryUrl?: string;
  /** 作者/机构（可空） */
  author?: string;
  /** 安装后会写入 McpHub 的配置 */
  installConfig: {
    protocol: 'stdio' | 'http';
    /** stdio: 命令；http: 忽略 */
    command?: string;
    /** stdio: 参数；http: 忽略 */
    args?: string;
    /** http: URL；stdio: 忽略 */
    url?: string;
  };
}

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** 把命令行参数串按空白拆成数组（内置预设均不含带引号的参数，无需完整 shell 解析） */
function splitArgs(s?: string): string[] {
  if (!s) return [];
  return s.trim().split(/\s+/).filter(Boolean);
}

/** 本地离线预设（stdio 场景，官方 Registry 主要收 HTTP） */
const BUILTIN_PRESETS: McpCatalogEntry[] = [
  {
    id: 'builtin-filesystem',
    name: 'File System',
    description: '读取/写入/浏览本地文件系统，指定允许访问的根目录',
    source: 'builtin',
    installConfig: { protocol: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem .' },
  },
  {
    id: 'builtin-github',
    name: 'GitHub',
    description: '通过 GitHub API 访问仓库 Issues/PR/代码/搜索等',
    source: 'builtin',
    installConfig: { protocol: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-github' },
  },
  {
    id: 'builtin-fetch',
    name: 'Fetch / Puppeteer',
    description: '抓取网页内容（纯 HTTP fetch 或浏览器 Puppeteer）',
    source: 'builtin',
    installConfig: { protocol: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-fetch' },
  },
  {
    id: 'builtin-sqlite',
    name: 'SQLite',
    description: '本地 SQLite 数据库只读/读写查询',
    source: 'builtin',
    installConfig: { protocol: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-sqlite' },
  },
  {
    id: 'builtin-git',
    name: 'Git',
    description: '执行 git 命令（log/blame/show/diff 等）',
    source: 'builtin',
    installConfig: { protocol: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-git' },
  },
  {
    id: 'builtin-time',
    name: 'Time / Date',
    description: '当前时间、时区转换、日期计算',
    source: 'builtin',
    installConfig: { protocol: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-time' },
  },
  {
    id: 'builtin-postgres',
    name: 'PostgreSQL',
    description: 'PostgreSQL 数据库只读查询（需要连接字符串）',
    source: 'builtin',
    installConfig: { protocol: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-postgres' },
  },
  {
    id: 'builtin-tavily',
    name: 'Tavily Search',
    description: '基于 Tavily API 的互联网搜索（需要 API Key）',
    source: 'builtin',
    installConfig: { protocol: 'stdio', command: 'npx', args: '-y @tavily/mcp-server-tavily' },
  },
  {
    id: 'builtin-playwright',
    name: 'Playwright',
    description: '浏览器自动化（截图/点击/填写表单）',
    source: 'builtin',
    installConfig: { protocol: 'stdio', command: 'npx', args: '-y @playwright/mcp' },
  },
  {
    id: 'builtin-memory',
    name: 'Memory (persistent notes)',
    description: '跨会话持久化的记忆/笔记（本地文件存储）',
    source: 'builtin',
    installConfig: { protocol: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-memory' },
  },
];

interface CacheShape {
  fetchedAt: number;
  entries: McpCatalogEntry[];
}

export class McpCatalogService {
  private cache: CacheShape | null = null;
  private cachePath: string;
  private fetching: Promise<McpCatalogEntry[]> | null = null;

  constructor(userDataDir: string) {
    this.cachePath = path.join(userDataDir, 'mcp_catalog_cache.json');
  }

  /** 主入口：合并远程（带缓存）+ 离线预设 */
  async getCatalog(forceRefresh = false): Promise<McpCatalogEntry[]> {
    const remote = await this.getRemoteEntries(forceRefresh);
    return [...BUILTIN_PRESETS, ...remote];
  }

  /** 仅远程条目（带 TTL 缓存 + 失败降级返回空数组） */
  private async getRemoteEntries(forceRefresh: boolean): Promise<McpCatalogEntry[]> {
    if (!forceRefresh) {
      const cached = await this.readCache();
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.entries;
      }
    }
    // 并发去重：多次同时请求只 fetch 一次
    if (this.fetching) return this.fetching;
    this.fetching = this.fetchFromRegistry()
      .catch(async () => (await this.readCache())?.entries ?? [])
      .finally(() => { this.fetching = null; });
    return this.fetching;
  }

  private async fetchFromRegistry(): Promise<McpCatalogEntry[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const resp = await fetch(REGISTRY_URL, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`registry ${resp.status}`);
      const data: any = await resp.json();
      const rawList = (data?.servers ?? []) as any[];
      const entries: McpCatalogEntry[] = [];
      for (const item of rawList) {
        const srv = item?.server;
        if (!srv) continue;
        // 取第一个 HTTP remote（官方 Registry 全部是 streamable-http）
        const httpRemote = (srv.remotes || []).find((r: any) => r?.type === 'streamable-http');
        if (!httpRemote?.url) continue;
        entries.push({
          id: srv.name,
          name: srv.title || srv.name,
          description: srv.description || '',
          source: 'registry',
          version: srv.version,
          installConfig: { protocol: 'http', url: httpRemote.url },
        });
      }
      await this.writeCache({ fetchedAt: Date.now(), entries });
      return entries;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async readCache(): Promise<CacheShape | null> {
    if (this.cache) return this.cache;
    try {
      const txt = await fsp.readFile(this.cachePath, 'utf-8');
      const j = JSON.parse(txt) as CacheShape;
      if (Array.isArray(j.entries) && typeof j.fetchedAt === 'number') {
        this.cache = j;
        return j;
      }
    } catch { /* ignore */ }
    return null;
  }

  private async writeCache(c: CacheShape): Promise<void> {
    this.cache = c;
    try {
      await fsp.writeFile(this.cachePath, JSON.stringify(c), 'utf-8');
    } catch { /* ignore */ }
  }

  /** 把 catalog entry 转成 McpHub.addServer 接受的 McpServerConfig（带唯一 id） */
  static toServerConfig(entry: McpCatalogEntry): any {
    const id = `mcp_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
    const base: any = {
      id,
      name: entry.name,
      enabled: true,
    };
    if (entry.installConfig.protocol === 'http') {
      base.protocol = 'http';
      base.url = entry.installConfig.url;
    } else {
      base.protocol = 'stdio';
      base.command = entry.installConfig.command;
      // args 必须是 string[]（McpServerConfig.args 与 StdioClientTransport 均要求数组），
      // 预设里存的是整串命令行，需按空白拆分，否则 stdio 服务器装得上但永远起不来
      base.args = splitArgs(entry.installConfig.args);
    }
    return base;
  }
}
