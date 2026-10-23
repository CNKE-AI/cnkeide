import { ConfigAdapter } from '../../adapter/ConfigAdapter';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type McpConnectionStatus = 'connecting' | 'connected' | 'error' | 'stopped';

export interface McpServerConfig {
  id: string;
  name: string;
  protocol: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  autoApprove?: string[];
}

export interface McpTool {
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

interface McpTransportLike {
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
  onerror?: (err: Error) => void;
  onclose?: () => void;
  stderr?: NodeJS.EventEmitter | null;
}

export interface McpServerStatus {
  id: string;
  name: string;
  status: McpConnectionStatus;
  error?: string;
  lastStderr?: string;
  toolCount: number;
  lastConnectedAt?: number;
}

export interface McpServerListItem extends McpServerConfig, McpServerStatus {}

export interface McpCallResult {
  success: boolean;
  content?: string;
  error?: string;
}

interface McpConnection {
  config: McpServerConfig;
  client: Client | null;
  transport: McpTransportLike | null;
  status: McpConnectionStatus;
  error?: string;
  lastStderr: string;
  lastConnectedAt?: number;
  connecting: Promise<void> | null;
  /** 主动关闭中标志：避免 transport.onclose 把主动停止误判为意外断线 */
  closing: boolean;
  /** 最近一次连接失败时间戳（ms），用于自动重试退避 */
  lastFailAt?: number;
}

/** 建立连接超时（stdio 子进程拉起 / HTTP 握手） */
const CONNECT_TIMEOUT_MS = 30_000;
/** 单次工具调用超时：服务器挂死/不响应时避免 Agent 循环永久卡住 */
const CALL_TIMEOUT_MS = 60_000;
/** 连接失败后的自动重试退避窗口：坏服务器不再每轮对话都白等一次 */
const RETRY_BACKOFF_MS = 10_000;
const STDERR_CAP = 4000;

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); }
    );
  });
}

/** MCP callTool content 块（JSON-RPC 载荷，字段随服务器而异） */
interface McpContentBlock {
  type?: string;
  text?: string;
  mimeType?: string;
  data?: unknown;
  resource?: { uri?: string };
  [key: string]: unknown;
}

function serializeToolContent(content: unknown): string {
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') { parts.push(String(raw)); continue; }
    const block = raw as McpContentBlock;
    switch (block.type) {
      case 'text': parts.push(block.text ?? ''); break;
      case 'image': parts.push(`[图片: ${block.mimeType ?? 'unknown'} base64 ${typeof block.data === 'string' ? block.data.length : 0} 字符]`); break;
      case 'audio': parts.push(`[音频: ${block.mimeType ?? 'unknown'}]`); break;
      case 'resource': parts.push(`[资源: ${block.resource?.uri ?? 'unknown'}]`); break;
      default: parts.push(JSON.stringify(block));
    }
  }
  return parts.join('\n').trim();
}

function plainEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return env;
}

/**
 * McpHub - 基于 @modelcontextprotocol/sdk 的完整 MCP 客户端
 * - stdio：StdioClientTransport 全双工 JSON-RPC；http：StreamableHTTPClientTransport（规范 /mcp + SSE）
 * - 连接成功即 tools/list 发现工具，订阅 tools/list_changed 自动刷新
 * - startEnabledServers() 提供应用启动自动恢复
 */
export class McpHub {
  private config: ConfigAdapter;
  private connections = new Map<string, McpConnection>();
  private toolsCache = new Map<string, McpTool[]>();
  private onStatusChange: ((s: McpServerStatus) => void) | null = null;

  constructor(config: ConfigAdapter) {
    this.config = config;
  }

  onStatusChanged(cb: (s: McpServerStatus) => void): void {
    this.onStatusChange = cb;
  }

  listServers(): McpServerConfig[] {
    return this.config.get<McpServerConfig[]>('mcpServers', []);
  }

  /** 应用启动时自动连接所有 enabled 服务器（启动恢复）。并发执行：单台坏配置不再串行拖慢整条启动链 */
  async startEnabledServers(): Promise<void> {
    const enabled = this.listServers().filter((x) => x.enabled);
    await Promise.allSettled(enabled.map((s) => this.startServer(s)));
  }

  /** 新增（无 id）或整体更新（带 id，供编辑） */
  async addServer(cfg: McpServerConfig): Promise<{ success: boolean; error?: string }> {
    const servers = this.listServers();
    const existed = cfg.id && servers.some((s) => s.id === cfg.id);
    if (existed) {
      await this.stopServer(cfg.id);
      const idx = servers.findIndex((s) => s.id === cfg.id);
      servers[idx] = { ...cfg };
    } else {
      servers.push({ ...cfg, id: cfg.id || randomUUID() });
    }
    this.config.set('mcpServers', servers);
    if (cfg.enabled) {
      const fresh = this.listServers().find((s) => s.id === cfg.id) || { ...cfg, id: cfg.id || servers[servers.length - 1].id };
      const r = await this.startServer(fresh);
      if (!r.success) return { success: true, error: r.error };
    }
    return { success: true };
  }

  async removeServer(id: string): Promise<{ success: boolean; error?: string }> {
    await this.stopServer(id);
    this.config.set('mcpServers', this.listServers().filter((s) => s.id !== id));
    return { success: true };
  }

  async toggleServer(id: string, enabled: boolean): Promise<{ success: boolean; error?: string }> {
    const servers = this.listServers();
    const server = servers.find((s) => s.id === id);
    if (!server) return { success: false, error: '服务器不存在' };
    server.enabled = enabled;
    this.config.set('mcpServers', servers);
    if (enabled) return this.startServer(server);
    await this.stopServer(id);
    return { success: true };
  }

  // ===== 连接生命周期 =====

  async startServer(server: McpServerConfig): Promise<{ success: boolean; error?: string }> {
    const conn = this.getOrCreateConn(server);
    conn.config = server;
    if (conn.client && conn.status === 'connected') return { success: true };
    if (conn.connecting) {
      try { await conn.connecting; } catch { /* 等待已有连接尝试结束 */ }
      return conn.client ? { success: true } : { success: false, error: conn.error };
    }
    conn.status = 'connecting';
    conn.error = undefined;
    this.emit(conn);
    conn.connecting = this.doConnect(conn).finally(() => { conn.connecting = null; });
    try {
      await conn.connecting;
      return conn.client ? { success: true } : { success: false, error: conn.error };
    } catch {
      return { success: false, error: conn.error || '连接失败' };
    }
  }

  private async doConnect(conn: McpConnection): Promise<void> {
    const { config } = conn;
    conn.closing = false;
    let transport: McpTransportLike | null = null;
    try {
      if (config.protocol === 'stdio') {
        if (!config.command) throw new Error('stdio 服务器缺少 command');
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: plainEnv(),
          stderr: 'pipe',
        });
        const stderrStream = transport.stderr;
        if (stderrStream) {
          stderrStream.on('data', (buf: Buffer) => {
            const text = buf.toString();
            conn.lastStderr = (conn.lastStderr + '\n' + text).slice(-STDERR_CAP).trimStart();
          });
        }
      } else if (config.protocol === 'http') {
        if (!config.url) throw new Error('HTTP 服务器缺少 url');
        transport = new StreamableHTTPClientTransport(new URL(config.url));
      } else {
        throw new Error(`未知协议: ${String(config.protocol)}`);
      }
      // 带外错误：仅记录，不断言断线（HTTP 瞬时错误不代表连接失效）
      transport.onerror = (e: Error) => {
        if (!conn.closing) conn.error = e?.message || String(e);
      };
      // 断线感知：stdio 子进程退出 / HTTP 传输关闭都会触发 onclose（SDK 行为已核实）。
      // 之前未监听 → 服务器崩溃后界面仍显示 connected，直到下次调用才暴露。
      // 连接建立中（connect 后 tools/list 阶段）进程中途退出也走这里置 error。
      transport.onclose = () => {
        if (conn.closing) return;
        conn.status = 'error';
        conn.error = conn.error || '连接已断开（服务器进程退出或网络中断）';
        conn.lastFailAt = Date.now();
        // 置空 client/transport：SDK 连接关闭后不可复用，下次调用走 startServer 重建
        conn.client = null;
        conn.transport = null;
        this.emit(conn);
      };

      const client = new Client({ name: 'CnkeIDE', version: '1.0.0' }, {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: (err) => {
              if (!err && conn.client && conn.status === 'connected') {
                void this.discoverTools(conn).catch(() => { /* 忽略刷新失败 */ });
              }
            },
          },
        },
      });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接超时(${CONNECT_TIMEOUT_MS / 1000}s)，请检查服务器`);
      conn.client = client;
      conn.transport = transport;
      await this.discoverTools(conn);
      // 双保险：连接过程末尾 transport 若已被 onclose 置为关闭（进程中途退出），不再宣称为 connected
      if (conn.transport !== transport) {
        throw new Error(conn.error || '连接已断开');
      }
      conn.status = 'connected';
      conn.lastConnectedAt = Date.now();
      conn.error = undefined;
      conn.lastFailAt = undefined;
      this.emit(conn);
    } catch (e: unknown) {
      conn.error = this.describeConnectError(e);
      conn.status = 'error';
      conn.lastFailAt = Date.now();
      if (transport) { try { await transport.close(); } catch { /* ignore */ } }
      conn.client = null;
      conn.transport = null;
      this.emit(conn);
      throw e;
    }
  }

  /** 把启动失败的错误翻译成可操作的中文提示（含 Windows 命令兼容建议） */
  private describeConnectError(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    // 命令不存在 / 找不到：最常见于 Windows 的 npx、uvx 等 PATH 问题
    if (/ENOENT|spawn\s+\S+\s+ENOENT/i.test(raw)) {
      if (process.platform === 'win32') {
        return `${raw}。Windows 下找不到可执行命令：请确认 Node/npm 已安装且在 PATH 中；命令为 npx/uvx 时可直接填裸名（已兼容），自定义脚本/程序请填完整路径或 .cmd/.exe 全名`;
      }
      return `${raw}。找不到可执行命令，请确认已安装且在 PATH 中`;
    }
    return raw;
  }

  private async stopServer(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    // 先标记主动关闭 + 摘除引用，再 close：transport.onclose 回调到来时已无对象可误伤
    conn.closing = true;
    conn.status = 'stopped';
    const { client, transport } = conn;
    conn.client = null;
    conn.transport = null;
    conn.connecting = null;
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
    if (transport) {
      try { await transport.close(); } catch { /* ignore */ }
    }
    conn.closing = false;
    this.emit(conn);
  }

  private getOrCreateConn(server: McpServerConfig): McpConnection {
    let conn = this.connections.get(server.id);
    if (!conn) {
      conn = {
        config: server,
        client: null,
        transport: null,
        status: server.enabled ? 'connecting' : 'stopped',
        lastStderr: '',
        connecting: null,
        closing: false,
      };
      this.connections.set(server.id, conn);
    }
    return conn;
  }

  private async discoverTools(conn: McpConnection): Promise<McpTool[]> {
    if (!conn.client) return [];
    const { tools } = await conn.client.listTools();
    const mapped: McpTool[] = (tools || []).map((t) => ({
      serverId: conn.config.id,
      serverName: conn.config.name,
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
    this.toolsCache.set(conn.config.id, mapped);
    this.emit(conn);
    return mapped;
  }

  private emit(conn: McpConnection): void {
    try {
      this.onStatusChange?.({
        id: conn.config.id,
        name: conn.config.name,
        status: conn.status,
        error: conn.error,
        lastStderr: conn.lastStderr || undefined,
        toolCount: (this.toolsCache.get(conn.config.id) || []).length,
        lastConnectedAt: conn.lastConnectedAt,
      });
    } catch { /* 订阅方异常不影响 */ }
  }

  // ===== 查询与工具 =====

  listServersWithStatus(): McpServerListItem[] {
    return this.listServers().map((s) => {
      const conn = this.connections.get(s.id);
      const tools = this.toolsCache.get(s.id) || [];
      return {
        ...s,
        status: conn?.status || 'stopped',
        error: conn?.error,
        lastStderr: conn?.lastStderr || undefined,
        toolCount: tools.length,
        lastConnectedAt: conn?.lastConnectedAt,
      };
    });
  }

  getStatus(serverId: string): McpServerStatus | null {
    const s = this.listServers().find((x) => x.id === serverId);
    if (!s) return null;
    return this.listServersWithStatus().find((x) => x.id === serverId) || null;
  }

  listTools(serverId: string): McpTool[] {
    return this.toolsCache.get(serverId) || [];
  }

  /** 主动刷新工具列表；连接中断时会先自动重连一次 */
  async refreshTools(serverId: string): Promise<{ success: boolean; tools?: McpTool[]; error?: string }> {
    const conn = this.connections.get(serverId);
    if (!conn || !conn.client || conn.status !== 'connected') {
      const server = this.listServers().find((s) => s.id === serverId);
      if (!server) return { success: false, error: '服务器不存在' };
      if (!server.enabled) return { success: false, error: '服务器未启用' };
      const r = await this.startServer(server);
      if (!r.success) return { success: false, error: r.error };
    }
    const c = this.connections.get(serverId);
    if (!c || !c.client) return { success: false, error: '服务器未连接' };
    try {
      const tools = await this.discoverTools(c);
      return { success: true, tools };
    } catch (e: unknown) {
      c.status = 'error';
      c.error = e instanceof Error ? e.message : String(e);
      c.lastFailAt = Date.now();
      this.emit(c);
      return { success: false, error: c.error };
    }
  }

  getAllTools(): Promise<McpTool[]> {
    const all: McpTool[] = [];
    for (const [id, tools] of this.toolsCache.entries()) {
      const conn = this.connections.get(id);
      if (conn?.status === 'connected') all.push(...tools);
    }
    return Promise.resolve(all);
  }

  /** 连接刚失败且仍在退避窗口内（避免 Agent 每轮对话都去打一台已挂的服务器） */
  private inBackoff(conn?: McpConnection): boolean {
    return !!conn?.lastFailAt && Date.now() - conn.lastFailAt < RETRY_BACKOFF_MS;
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const conn = this.connections.get(serverId);
    if (!conn || !conn.client || conn.status !== 'connected') {
      const server = this.listServers().find((s) => s.id === serverId);
      if (!server) return { success: false, error: '服务器不存在' };
      if (!server.enabled) return { success: false, error: `服务器「${server.name}」未启用` };
      if (this.inBackoff(conn)) {
        return { success: false, error: `服务器「${server.name}」刚连接失败，${Math.ceil((RETRY_BACKOFF_MS - (Date.now() - (conn?.lastFailAt ?? 0))) / 1000)} 秒后再试或点击重连` };
      }
      const r = await this.startServer(server);
      if (!r.success) return { success: false, error: r.error || '服务器连接失败' };
    }
    const c = this.connections.get(serverId);
    if (!c?.client) return { success: false, error: '服务器未连接' };
    try {
      return await this.doCallTool(c, toolName, args);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e && typeof e === 'object' && 'code' in e ? (e as { code?: unknown }).code : undefined;
      // JSON-RPC 协议级错误（服务器返回 error，如未知工具/参数校验失败）直接返回，不重连
      const isTransportError = code === undefined || /connection closed|transport closed|socket hang up|fetch failed|ECONNREFUSED|ECONNRESET|getaddrinfo|timed out/i.test(msg);
      if (!isTransportError) return { success: false, error: msg };
      // 传输断开：标记状态并自动重连重试一次（退避期内不再尝试）
      c.status = 'error';
      c.error = msg;
      c.lastFailAt = Date.now();
      this.emit(c);
      const server = this.listServers().find((s) => s.id === serverId);
      if (server?.enabled && !this.inBackoff(this.connections.get(serverId))) {
        const r = await this.startServer(server);
        const cc = this.connections.get(serverId);
        if (r.success && cc?.client) {
          try { return await this.doCallTool(cc, toolName, args); } catch (e2: unknown) { return { success: false, error: e2 instanceof Error ? e2.message : String(e2) }; }
        }
      }
      return { success: false, error: msg };
    }
  }

  private async doCallTool(conn: McpConnection, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!conn.client) return { success: false, error: '服务器未连接' };
    // 单次调用硬超时：服务器挂死/不响应时不再永久卡住 Agent 工具循环
    const result = await withTimeout(
      conn.client.callTool({ name: toolName, arguments: args ?? {} }),
      CALL_TIMEOUT_MS,
      `工具调用超时(${CALL_TIMEOUT_MS / 1000}s)：${toolName} 未在限定时间内返回，服务器可能已挂死`,
    );
    const content = serializeToolContent(result.content);
    if (result.isError) return { success: false, error: content || '工具执行出错' };
    return { success: true, content };
  }

  dispose(): void {
    for (const id of Array.from(this.connections.keys())) {
      void this.stopServer(id);
    }
  }
}
