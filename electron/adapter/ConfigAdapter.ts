import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * ConfigAdapter - 配置适配层
 * 替换 VSCode globalState / workspace configuration
 * 全部写入 Electron userData 目录的本地 JSON 文件
 */
export class ConfigAdapter {
  private configDir: string = '';
  private dataFile: string = '';
  private data: Record<string, any> = {};
  private writeTimer: NodeJS.Timeout | null = null;

  async init(): Promise<void> {
    this.configDir = path.join(app.getPath('userData'), 'config');
    this.dataFile = path.join(this.configDir, 'app-config.json');

    // 迁移旧 productName（cnke-claw）的配置：之前 productName 从 cnke-claw 改为 CnkeIDE，
    // 导致 app.getPath('userData') 变化，旧配置（工作区/API Key 等）在新目录找不到。
    // 检测到新配置不存在时，从旧目录复制一份，实现无缝迁移。
    if (!existsSync(this.dataFile)) {
      const oldUserData = path.join(path.dirname(app.getPath('userData')), 'cnke-claw');
      const oldConfigFile = path.join(oldUserData, 'config', 'app-config.json');
      if (existsSync(oldConfigFile)) {
        try {
          if (!existsSync(this.configDir)) {
            await fs.mkdir(this.configDir, { recursive: true });
          }
          await fs.copyFile(oldConfigFile, this.dataFile);
        } catch {
          // 迁移失败不阻断启动，继续走默认配置流程
        }
      }
    }

    if (!existsSync(this.configDir)) {
      await fs.mkdir(this.configDir, { recursive: true });
    }

    if (existsSync(this.dataFile)) {
      try {
        const raw = await fs.readFile(this.dataFile, 'utf-8');
        this.data = JSON.parse(raw);
      } catch {
        this.data = {};
      }
    }

    // 注入默认配置
    this.data = { ...this.getDefaultConfig(), ...this.data };
  }

  private getDefaultConfig(): Record<string, any> {
    return {
      theme: 'dark',
      fontSize: 14,
      editorTabSize: 2,
      autoSave: true,
      autoSaveDelay: 1000,
      proxy: {
        enabled: false,
        host: '127.0.0.1',
        port: 7890,
      },
      apiConfigs: [],
      activeApiConfigId: null,
      mcpServers: [],
      // 已启用技能 ID；技能详情由本地扫描/内置注册表在运行时提供。
      enabledSkills: [],
      agentConfig: {
        mode: 'plan',          // ask | craft | plan
        maxMode: false,
        // 历史消息保留条数上限：超出部分在每轮发送前裁剪，防止 prompt token 随多轮对话无限增长
        maxHistoryMessages: 20,
        maxTurns: 50,
        temperature: 0.7,
        topP: 1.0,
        autoApproveTools: false,
        systemPrompt: '',
        // W1 新增：LLM 容错
        maxRetries: 3,
        retryBaseDelayMs: 1000,
        retryMaxDelayMs: 8000,
        llmTimeoutMs: 60000,
        llmTotalTimeoutMs: 180000,
        // Fallback 模型 ID 列表（按顺序）
        fallbackModelIds: [],
        // W2 新增：单轮工具最大并发数（并行工具调度）
        toolConcurrency: 4,
        // W5 新增：embedding 模型（用于 semantic_search 语义召回）
        embeddingModel: 'text-embedding-3-small',
        // W6 新增：模型路由（首轮按任务类型自动选 model）
        enableRouting: true,
        routing: {
          // 各任务类型默认配置 id，留空表示按 tier 自动选
          // code: 'cfg-deepseek',
          // reasoning: 'cfg-deepseek-r1',
        },
        // W7 新增：工具调用信任规则（按 toolName / pathPattern / commandPattern 匹配）
        approvalRules: [],
        // 可选运行时工具：浏览器默认尝试启用，图片生成必须由用户显式启用并绑定 API 配置。
        browserAutomation: { enabled: true },
        imageGeneration: { enabled: false, apiConfigId: '' },
      },
      workspace: {
        lastWorkspace: null,
        recentWorkspaces: [],
      },
      update: {
        // 静默后台自动检测开关（true 时启动自动检查）
        autoCheck: true,
        // 静默检测启动延迟（毫秒）
        autoCheckDelayMs: 8000,
        // 下载完成后自动安装（无需用户点击「立即重启安装」按钮，实现真正无感更新）
        autoInstall: true,
        // 自动安装前等待秒数（给用户看「即将重启安装…」提示的时间，0 = 立即安装）
        autoInstallDelaySec: 3,
        // 失败重试配置
        retry: {
          maxRetries: 3,
          retryDelayMs: 2000,
        },
        // 增量/差分更新开关（electron-updater blockmap）
        differential: true,
      },
    };
  }

  get<T = any>(key: string, defaultValue?: T): T {
    const keys = key.split('.');
    let val: any = this.data;
    for (const k of keys) {
      if (val && typeof val === 'object' && k in val) {
        val = val[k];
      } else {
        return (defaultValue ?? undefined) as T;
      }
    }
    return val as T;
  }

  set(key: string, value: any): void {
    const keys = key.split('.');
    let obj = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') {
        obj[keys[i]] = {};
      }
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(async () => {
      try {
        await fs.writeFile(this.dataFile, JSON.stringify(this.data, null, 2), 'utf-8');
      } catch {
        // 写入失败静默忽略，避免 unhandled rejection；下次写入会再次尝试
      }
    }, 300);
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await fs.writeFile(this.dataFile, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  // ===== API 配置管理 =====
  getApiKeyConfigs(): any[] {
    return this.get('apiConfigs', []);
  }

  saveApiConfig(config: any): { success: boolean; error?: string } {
    const configs = this.getApiKeyConfigs();
    const idx = configs.findIndex((c) => c.id === config.id);
    if (idx >= 0) {
      configs[idx] = { ...configs[idx], ...config };
    } else {
      configs.push(config);
    }
    this.set('apiConfigs', configs);
    return { success: true };
  }

  deleteApiConfig(id: string): { success: boolean; error?: string } {
    const configs = this.getApiKeyConfigs().filter((c) => c.id !== id);
    this.set('apiConfigs', configs);
    if (this.get('activeApiConfigId') === id) {
      this.set('activeApiConfigId', null);
    }
    return { success: true };
  }

  /**
   * 严格同步官方内置 API 列表到本地 apiConfigs（强一致模式）。
   *
   * 内置项 id 统一加 `official_` 前缀，与设置页官方模型识别逻辑（id.startsWith('official_')）保持一致，
   * 从而内置模型不会被当作普通配置，避免暴露 API 地址、允许编辑/删除。
   *
   * 同步规则：
   *   1. 字段强制刷新：已存在的官方项用官方最新值覆盖 name/provider/model/baseUrl/apiKey；
   *   2. 下线即删除：本地存在但官方列表已不包含的官方项被移除；
   *   3. 新增：官方列表里有、本地没有的官方项 push；
   *   4. 用户自定义配置（id 非 official_ 前缀）完全不受影响。
   *
   * 返回 { added, updated, removed } 变更统计。
   */
  mergeBuiltinApis(builtins: any[]): { added: number; updated: number; removed: number } {
    const empty = { added: 0, updated: 0, removed: 0 };
    if (!Array.isArray(builtins)) return empty;
    // 空列表防御：后端异常/中间代理故障可能返回 success:true + 空 builtins，
    // 若照常执行"下线即删除"会误删全部官方模型并清空 activeApiConfigId，
    // 导致 resolveApiConfig 兜底到 configs[0]（旧模型）——"切换了但实际没换"的根源之一。
    if (builtins.length === 0) return empty;

    const configs = this.getApiKeyConfigs();
    // 官方项本地 id 集合（含本次传入的全部官方项）
    const officialLocalIds = new Set<string>();
    const officialFingerprints = new Set<string>();
    for (const b of builtins) {
      if (!b?.id) continue;
      officialLocalIds.add(`official_${b.id}`);
      officialFingerprints.add(this.apiFingerprint(b));
    }

    let added = 0;
    let updated = 0;

    // 1/3. 新增 + 字段强制刷新
    for (const b of builtins) {
      if (!b || !b.id) continue;
      const localId = `official_${b.id}`;
      const next = {
        id: localId,
        name: b.name || b.model || b.id,
        provider: b.provider || '',
        model: b.model || '',
        baseUrl: b.baseUrl || '',
        // 后端未下发 key 时保留本地已有值（避免有效 key 被空值覆盖 → 401 → fallback 旧模型）
        apiKey: b.apiKey || '',
        builtin: true,
      };
      const idx = configs.findIndex((c) => c.id === localId);
      if (idx >= 0) {
        // 强制刷新为官方最新字段（保留 id 与 builtin 标记）
        const prev = configs[idx];
        // apiKey 降级保护：后端空 key 不覆盖本地非空 key
        const merged = { ...prev, ...next };
        if (!next.apiKey && prev.apiKey) merged.apiKey = prev.apiKey;
        if (
          prev.name !== next.name ||
          prev.provider !== next.provider ||
          prev.model !== next.model ||
          prev.baseUrl !== next.baseUrl ||
          prev.apiKey !== merged.apiKey
        ) {
          configs[idx] = merged;
          updated++;
        }
      } else {
        configs.push(next);
        added++;
      }
    }

    // 2. 下线即删除：移除已不在官方列表中的官方项，以及历史版本按名称/连接信息导入的旧模型。
    const before = configs.length;
    const remaining = configs.filter((c) => {
      if (c.id.startsWith('official_')) return officialLocalIds.has(c.id);
      return !officialFingerprints.has(this.apiFingerprint(c));
    });
    const removed = before - remaining.length;

    // 若激活项是被删除的官方项，清理失效引用
    const activeId = this.get('activeApiConfigId');
    if (activeId && activeId.startsWith('official_') && !officialLocalIds.has(activeId)) {
      this.set('activeApiConfigId', null);
    }

    if (added > 0 || updated > 0 || removed > 0) {
      this.set('apiConfigs', remaining);
    }

    return { added, updated, removed };
  }

  /** 用模型、地址和密钥识别同一官方配置，兼容历史版本未使用 official_ 前缀的导入项。 */
  private apiFingerprint(config: { model?: string; baseUrl?: string; apiKey?: string }): string {
    return [config.model, config.baseUrl, config.apiKey]
      .map((value) => String(value || '').trim().toLowerCase())
      .join('\0');
  }

  // ===== 工作区管理 =====
  getLastWorkspace(): string | null {
    return this.get('workspace.lastWorkspace', null);
  }

  setLastWorkspace(wsPath: string): void {
    this.set('workspace.lastWorkspace', wsPath);
    const recent = this.get<string[]>('workspace.recentWorkspaces', []);
    const filtered = recent.filter((w) => w !== wsPath);
    filtered.unshift(wsPath);
    this.set('workspace.recentWorkspaces', filtered.slice(0, 10));
  }

  getRecentWorkspaces(): string[] {
    return this.get('workspace.recentWorkspaces', []);
  }
}
