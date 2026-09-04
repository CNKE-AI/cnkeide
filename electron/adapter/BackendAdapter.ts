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
