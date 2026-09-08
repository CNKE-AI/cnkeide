import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { ConfigAdapter } from './ConfigAdapter';

/**
 * BackendAdapter - CnkeIDE 官方后台客户端
 * 对接 https://ai.cnkes.cn 的远程配置与反馈服务：
 *   - 配置中心  https://ai.cnkes.cn/cnkeide/config/api.php
 *   - 反馈服务  https://ai.cnkes.cn/feedback/api.php
 *
 * 所有请求走主进程，避免渲染层 CORS/CSP 限制。
 */
const CONFIG_API = 'https://ai.cnkes.cn/cnkeide/config/api.php';
const FEEDBACK_API = 'https://ai.cnkes.cn/feedback/api.php';

export interface BuiltinApi {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface RemoteAnnouncement {
  id: string;
  title: string;
  content: string;
  type: 'info' | 'warning' | 'urgent';
  once: boolean;
  createdAt: string;
}

export interface FeedbackItem {
  id: string;
  msg: string;
  time: number;
  contact?: string;
  version?: string;
  replies?: { content: string; time: number }[];
}

export class BackendAdapter {
  private deviceId: string = '';
  private version: string = app.getVersion() || '1.0.0';

  constructor(private config: ConfigAdapter) {
    // 设备标识：持久化于本地配置
    let id = this.config.get<string>('deviceId', '');
    if (!id) {
      id = `cnke_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      this.config.set('deviceId', id);
    }
    this.deviceId = id;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  getPlatform(): string {
    if (process.platform === 'darwin') return 'mac';
    if (process.platform === 'linux') return 'linux';
    return 'win';
  }

  /** 健康检查 */
  async ping(): Promise<{ success: boolean; latency?: number; error?: string }> {
    const start = Date.now();
    try {
      const resp = await fetch(`${CONFIG_API}?action=ping`, { method: 'GET', timeout: 8000 } as any);
      const data: any = await resp.json();
      return { success: !!data?.success, latency: Date.now() - start };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** 拉取官方内置 API 列表（公开） */
  async getBuiltins(): Promise<{ success: boolean; builtins?: BuiltinApi[]; error?: string }> {
    try {
      const resp = await fetch(`${CONFIG_API}?action=get`, { method: 'GET', timeout: 10000 } as any);
      const data: any = await resp.json();
      if (!data?.success) return { success: false, error: data?.error || '拉取失败' };
      return { success: true, builtins: data.builtins || [] };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** 拉取远程公告（公开，服务端已按版本/平台/时间过滤） */
  async getAnnouncements(): Promise<{ success: boolean; announcements?: RemoteAnnouncement[]; error?: string }> {
    const url = `${CONFIG_API}?action=announcements&version=${encodeURIComponent(this.version)}&platform=${encodeURIComponent(this.getPlatform())}`;
    try {
      const resp = await fetch(url, { method: 'GET', timeout: 10000 } as any);
      const data: any = await resp.json();
      if (!data?.success) return { success: false, error: data?.error || '拉取失败' };
      return { success: true, announcements: data.announcements || [] };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 订阅远程公告 SSE 实时推送。
   * 主进程建立长连接（服务端 85s 自动断开，断线后此处自动重连），
   * 每次收到公告列表变化或心跳，通过 onEvent 回调回传。
   * 返回取消函数。
   */
  subscribeAnnouncements(onEvent: (evt: { type: string; announcements?: RemoteAnnouncement[]; serverTime?: number }) => void): () => void {
    const url = `${CONFIG_API}?action=stream&version=${encodeURIComponent(this.version)}&platform=${encodeURIComponent(this.getPlatform())}`;
    let aborted = false;
    let controller: AbortController | null = null;
    let timer: NodeJS.Timeout | null = null;

    const connect = () => {
      if (aborted) return;
      controller = new AbortController();
      // 兜底超时（略大于服务端 85s），防止异常卡死
      const guard = setTimeout(() => {
        try { controller?.abort(); } catch {}
      }, 95 * 1000);

      fetch(url, { method: 'GET', signal: controller.signal } as any)
        .then(async (resp: any) => {
          if (aborted) return;
          if (!resp.ok || !resp.body) {
            throw new Error(`SSE 连接失败: ${resp.status}`);
          }
          const reader = resp.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';

          const processChunk = (chunk: string) => {
            buffer += chunk;
            // 按空行分隔 SSE 事件块
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              let event = 'message';
              let data = '';
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data += line.slice(5).trim();
              }
              if (event === 'ready' || event === 'ping' || event === 'timeout') {
                continue; // 心跳/就绪/超时通知无需业务处理
              }
              if (!data) continue;
              try {
                const payload = JSON.parse(data);
                onEvent({ type: event, announcements: payload.announcements, serverTime: payload.serverTime });
              } catch {
                /* 忽略无法解析的帧 */
              }
            }
          };

          // 读取循环
          for (;;) {
            if (aborted) { try { reader.cancel(); } catch {} return; }
            const { done, value } = await reader.read();
            if (done) break;
            processChunk(decoder.decode(value, { stream: true }));
          }
          processChunk(decoder.decode()); // flush 残留
        })
        .catch((err: any) => {
          if (aborted) return;
          // 网络异常 / 服务端断开，稍后重连
          onEvent({ type: 'disconnect', serverTime: undefined });
        })
        .finally(() => {
          clearTimeout(guard);
          if (aborted) return;
          // 服务端最长 85s，断开后 3s 重连，保持长连接
          timer = setTimeout(connect, 3000);
        });
    };

    connect();

    return () => {
      aborted = true;
      if (timer) clearTimeout(timer);
      try { controller?.abort(); } catch {}
    };
  }

  /** 提交意见反馈（公开） */
  async submitFeedback(msg: string, contact?: string): Promise<{ success: boolean; item?: FeedbackItem; error?: string }> {
    const body = new URLSearchParams();
    body.append('action', 'submit');
    body.append('device', this.deviceId);
    body.append('msg', msg);
    body.append('contact', contact || '');
    body.append('version', this.version);
    try {
      const resp = await fetch(FEEDBACK_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        timeout: 10000,
      } as any);
      const data: any = await resp.json();
      if (!data?.success) return { success: false, error: data?.error || '提交失败' };
      return { success: true, item: data.item };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** 拉取本机历史反馈与官方回复（公开） */
  async listFeedback(since = 0): Promise<{ success: boolean; items?: FeedbackItem[]; newReplyCount?: number; serverTime?: number; error?: string }> {
    const url = `${FEEDBACK_API}?action=list&device=${encodeURIComponent(this.deviceId)}&since=${Number(since) || 0}`;
    try {
      const resp = await fetch(url, { method: 'GET', timeout: 10000 } as any);
      const data: any = await resp.json();
      if (!data?.success) return { success: false, error: data?.error || '拉取失败' };
      return { success: true, items: data.items || [], newReplyCount: data.newReplyCount || 0, serverTime: data.serverTime };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
