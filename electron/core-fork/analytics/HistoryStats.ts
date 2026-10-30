/**
 * HistoryStats —— 历史记录聚合层（W18 统计看板）
 *
 * 职责：把 SessionStore 里的历史会话"压平"成图表可直接消费的结构
 *   - 按天聚合（趋势图 / 热力）
 *   - 按模型 / 工具聚合（分布图）
 *   - 会话级明细（历史记录表格，支持筛选与分页）
 *
 * 设计约束：
 *   1. 纯函数 + 零依赖（不 import electron），跑 tsx 单测无需启动 Electron；
 *   2. 输入全部为宽松类型，历史数据缺字段（老版本会话没有 usage）时按 0 兜底；
 *   3. 时间一律用**本地时区**归日，用户看到的日期与系统日历一致。
 */

export const DAY_MS = 86_400_000;

export type StatsRange = '7d' | '30d' | '90d' | 'all';
export const STATS_RANGES: StatsRange[] = ['7d', '30d', '90d', 'all'];

export interface StatsFilter {
  range?: StatsRange;
  /** 'all' / undefined 表示不按工作区过滤；NO_WORKSPACE_ID 表示只看未归属会话 */
  workspaceId?: string | null;
  /** 标题 / 首条消息预览的关键词过滤（大小写不敏感） */
  keyword?: string | null;
}

/**
 * 「未归属工作区」的伪工作区 id。
 *
 * 没打开文件夹就开始聊天时，会话的 workspaceId 会是空字符串，
 * 这类会话既进不了下拉列表的任何一个真实工作区，也不该被永久隐藏，
 * 所以给它一个显式入口，避免这部分历史数据在看板上"不可达"。
 */
export const NO_WORKSPACE_ID = '__none__';

/** 把外部传入的工作区筛选值规整成内部判定用的形态（null 表示不过滤） */
function normalizeWorkspaceFilter(workspaceId?: string | null): string | null {
  if (!workspaceId || workspaceId === 'all') return null;
  return workspaceId;
}

/** 会话是否属于指定的工作区筛选（支持 NO_WORKSPACE_ID） */
function workspaceMatches(sessionWorkspace: string | undefined, filterWs: string | null): boolean {
  if (!filterWs) return true;
  const ws = typeof sessionWorkspace === 'string' ? sessionWorkspace : '';
  if (filterWs === NO_WORKSPACE_ID) return !ws;
  return ws === filterWs;
}

/**
 * 生成互不重名的显示名。
 *
 * 只取路径最后一段时，`C:\a\src` 与 `D:\b\src` 会同时显示成 `src`，
 * 下拉里无法分辨；这里从"最后一段"开始，遇到重名就逐层补父目录，
 * 直到互不相同（最坏情况退化为完整路径，必然唯一）。
 */
function uniqueLabels(ids: string[]): Map<string, string> {
  const segs = new Map<string, string[]>();
  for (const id of ids) {
    const parts = id.replace(/\\/g, '/').split('/').filter(Boolean);
    segs.set(id, parts.length ? parts : [id]);
  }
  const labels = new Map<string, string>();
  for (const id of ids) labels.set(id, segs.get(id)!.slice(-1).join('/'));

  const maxDepth = Math.max(1, ...Array.from(segs.values(), (p) => p.length));
  for (let depth = 2; depth <= maxDepth; depth++) {
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const label = labels.get(id)!;
      groups.set(label, [...(groups.get(label) || []), id]);
    }
    const dupes = Array.from(groups.values()).filter((g) => g.length > 1);
    if (dupes.length === 0) break;
    for (const group of dupes) {
      for (const id of group) labels.set(id, segs.get(id)!.slice(-depth).join('/'));
    }
  }
  return labels;
}

export interface TokenUsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  model?: string;
  prompt_tokens_details?: { cached_tokens?: number; cache_miss_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ToolCallLike {
  id?: string;
  name?: string;
  arguments?: unknown;
  /** 工具结果在 tool_result 事件回填，成功与否都落在这里 */
  result?: { success?: boolean; error?: unknown } | null;
}

export interface MessageLike {
  id?: string;
  role?: string;
  content?: unknown;
  displayContent?: string;
  timestamp?: number;
  usage?: TokenUsageLike;
  toolCalls?: ToolCallLike[];
}

export interface SessionLike {
  id: string;
  title?: string;
  workspaceId?: string;
  mode?: string;
  createdAt?: number;
  updatedAt?: number;
  messages?: MessageLike[];
}

/** 按天聚合点（date 为本地日期 YYYY-MM-DD） */
export interface DailyPoint {
  date: string;
  sessions: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolFailures: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StatsSummary {
  sessions: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolFailures: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** 缓存命中率 0-100（缓存 token / prompt token） */
  cacheHitRate: number;
  /** 工具失败率 0-100 */
  toolFailureRate: number;
  /** 有活动的天数 */
  activeDays: number;
  /** 覆盖的自然日跨度（含空白日） */
  spanDays: number;
  avgTokensPerSession: number;
  avgMessagesPerSession: number;
  avgTokensPerMessage: number;
  /** 峰值日 */
  peakDate: string | null;
  peakTokens: number;
  /** 数据覆盖的最早/最晚时间戳 */
  firstAt: number | null;
  lastAt: number | null;
}

export interface ModelSlice {
  model: string;
  messages: number;
  tokens: number;
  /** 占全部 token 的百分比 0-100 */
  share: number;
}

export interface ToolSlice {
  tool: string;
  count: number;
  failures: number;
  share: number;
}

/** 历史记录表格的一行（会话级） */
export interface SessionRow {
  id: string;
  title: string;
  workspaceId: string;
  mode: string;
  createdAt: number;
  updatedAt: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolFailures: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  models: string[];
  /** 会话内首条/末条消息时间，用于算实际对话时长 */
  firstMessageAt: number | null;
  lastMessageAt: number | null;
  durationMs: number;
  /** 首条用户消息前 80 字，作为表格摘要 */
  preview: string;
}

// ===== 基础工具 =====

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** 时间戳 → 本地日期键 YYYY-MM-DD */
export function toDayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 当天 0 点的时间戳 */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** range → 自然日数量；'all' 返回 null 表示不设上限 */
export function rangeDays(range: StatsRange | undefined): number | null {
  switch (range) {
    case '7d':
      return 7;
    case '30d':
      return 30;
    case '90d':
      return 90;
    default:
      return null;
  }
}

/** range 起始时间戳（含当天 0 点）；'all' 返回 0 */
export function rangeStart(range: StatsRange | undefined, now: number = Date.now()): number {
  const days = rangeDays(range);
  if (days === null) return 0;
  return startOfDay(now) - (days - 1) * DAY_MS;
}

export function normalizeUsage(msg: MessageLike): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  model: string;
} {
  const u = msg?.usage || {};
  const promptTokens = num(u.prompt_tokens);
  const completionTokens = num(u.completion_tokens);
  const totalTokens = num(u.total_tokens) || promptTokens + completionTokens;
  const cachedTokens = num(u.prompt_tokens_details?.cached_tokens);
  const reasoningTokens = num(u.completion_tokens_details?.reasoning_tokens);
  const model = typeof u.model === 'string' && u.model.trim() ? u.model.trim() : '未知模型';
  return { promptTokens, completionTokens, totalTokens, cachedTokens, reasoningTokens, model };
}

/** 工具调用是否算失败：显式 success === false 或带 error 字段 */
export function isToolFailure(tc: ToolCallLike): boolean {
  const r = tc?.result;
  if (!r || typeof r !== 'object') return false;
  if (r.success === false) return true;
  return r.error !== undefined && r.error !== null && r.error !== '';
}

export function toolName(tc: ToolCallLike): string {
  const n = typeof tc?.name === 'string' ? tc.name.trim() : '';
  return n || '未知工具';
}

/** 消息文本（用于关键词过滤与预览），兼容 content 为多模态数组 */
export function messageText(msg: MessageLike): string {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const part of c) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object') {
        const t = (part as { text?: unknown }).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    return parts.join(' ');
  }
  return '';
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 会话的"代表时间"：优先 updatedAt，退化到 createdAt / 末条消息 */
export function sessionTime(s: SessionLike): number {
  if (typeof s.updatedAt === 'number' && s.updatedAt > 0) return s.updatedAt;
  if (typeof s.createdAt === 'number' && s.createdAt > 0) return s.createdAt;
  const msgs = s.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = msgs[i]?.timestamp;
    if (typeof t === 'number' && t > 0) return t;
  }
  return 0;
}

// ===== 过滤 =====

/**
 * 按时间范围 / 工作区 / 关键词过滤会话。
 * 时间判定用"会话代表时间"，但**只要有任意一条消息落在范围内也算命中**，
 * 避免长会话在月初创建、月末还在用时被 7d 视图整条丢掉。
 */
export function filterSessions(
  sessions: SessionLike[],
  filter: StatsFilter = {},
  now: number = Date.now(),
): SessionLike[] {
  const from = rangeStart(filter.range, now);
  const ws = normalizeWorkspaceFilter(filter.workspaceId);
  const kw = typeof filter.keyword === 'string' ? filter.keyword.trim().toLowerCase() : '';

  return (sessions || []).filter((s) => {
    if (!s || typeof s.id !== 'string') return false;
    if (!workspaceMatches(s.workspaceId, ws)) return false;

    if (from > 0) {
      const t = sessionTime(s);
      const inRangeByTime = t >= from;
      const inRangeByMsg = (s.messages || []).some((m) => {
        const mt = typeof m?.timestamp === 'number' ? m.timestamp : 0;
        return mt >= from;
      });
      if (!inRangeByTime && !inRangeByMsg) return false;
    }

    if (kw) {
      const hay = `${s.title || ''} ${(s.messages || []).map((m) => messageText(m)).join(' ')}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
}

// ===== 按天聚合 =====

/**
 * 生成连续日期序列的每日聚合点。
 *
 * - 指定 range 时：从 range 起始日到今天，**空白天补 0**（趋势图不能断线）
 * - range = 'all'：覆盖数据实际跨度，最多回看 maxDays 天（默认 180，防脏时间戳炸图）
 */
export function collectDaily(
  sessions: SessionLike[],
  options: { range?: StatsRange; now?: number; maxDays?: number } = {},
): DailyPoint[] {
  const now = options.now ?? Date.now();
  const from = rangeStart(options.range, now);
  const buckets = new Map<string, DailyPoint>();

  const ensure = (date: string): DailyPoint => {
    let p = buckets.get(date);
    if (!p) {
      p = {
        date,
        sessions: 0,
        messages: 0,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolFailures: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      buckets.set(date, p);
    }
    return p;
  };

  for (const s of sessions || []) {
    // 会话级计数落在"代表时间"那天，避免一次会话被重复计入多天
    const st = sessionTime(s);
    if (st > 0 && st >= from) ensure(toDayKey(st)).sessions += 1;

    for (const m of s.messages || []) {
      const ts = typeof m?.timestamp === 'number' ? m.timestamp : 0;
      if (ts <= 0 || ts < from) continue;
      const p = ensure(toDayKey(ts));
      p.messages += 1;
      if (m.role === 'user') p.userMessages += 1;
      else if (m.role === 'assistant') p.assistantMessages += 1;

      const u = normalizeUsage(m);
      p.promptTokens += u.promptTokens;
      p.completionTokens += u.completionTokens;
      p.totalTokens += u.totalTokens;

      for (const tc of m.toolCalls || []) {
        p.toolCalls += 1;
        if (isToolFailure(tc)) p.toolFailures += 1;
      }
    }
  }

  // 补齐连续日期
  const dayKeys = Array.from(buckets.keys()).sort();
  let cursor: number;
  let end: number;
  if (from > 0) {
    cursor = startOfDay(from);
    end = startOfDay(now);
  } else if (dayKeys.length > 0) {
    const earliest = new Date(`${dayKeys[0]}T00:00:00`).getTime();
    const maxDays = options.maxDays ?? 180;
    const limit = startOfDay(now) - (maxDays - 1) * DAY_MS;
    cursor = Math.max(startOfDay(earliest), limit);
    end = startOfDay(now);
  } else {
    return [];
  }

  const points: DailyPoint[] = [];
  for (let t = cursor; t <= end; t += DAY_MS) {
    const key = toDayKey(t);
    points.push(ensure(key));
  }
  return points;
}

// ===== 汇总指标 =====

export function summarize(sessions: SessionLike[], daily: DailyPoint[] = []): StatsSummary {
  let messages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;

  for (const s of sessions || []) {
    const st = sessionTime(s);
    if (st > 0) {
      firstAt = firstAt === null ? st : Math.min(firstAt, st);
      lastAt = lastAt === null ? st : Math.max(lastAt, st);
    }
    for (const m of s.messages || []) {
      messages += 1;
      if (m.role === 'user') userMessages += 1;
      else if (m.role === 'assistant') assistantMessages += 1;
      const u = normalizeUsage(m);
      promptTokens += u.promptTokens;
      completionTokens += u.completionTokens;
      totalTokens += u.totalTokens;
      cachedTokens += u.cachedTokens;
      reasoningTokens += u.reasoningTokens;
      for (const tc of m.toolCalls || []) {
        toolCalls += 1;
        if (isToolFailure(tc)) toolFailures += 1;
      }
      if (typeof m.timestamp === 'number' && m.timestamp > 0) {
        firstAt = firstAt === null ? m.timestamp : Math.min(firstAt, m.timestamp);
        lastAt = lastAt === null ? m.timestamp : Math.max(lastAt, m.timestamp);
      }
    }
  }

  let peakDate: string | null = null;
  let peakTokens = 0;
  let activeDays = 0;
  for (const p of daily) {
    if (p.totalTokens > peakTokens) {
      peakTokens = p.totalTokens;
      peakDate = p.date;
    }
    if (p.messages > 0 || p.sessions > 0) activeDays += 1;
  }

  const sessionCount = (sessions || []).length;
  return {
    sessions: sessionCount,
    messages,
    userMessages,
    assistantMessages,
    toolCalls,
    toolFailures,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    reasoningTokens,
    cacheHitRate: promptTokens > 0 ? round1((cachedTokens / promptTokens) * 100) : 0,
    toolFailureRate: toolCalls > 0 ? round1((toolFailures / toolCalls) * 100) : 0,
    activeDays,
    spanDays: daily.length,
    avgTokensPerSession: sessionCount > 0 ? Math.round(totalTokens / sessionCount) : 0,
    avgMessagesPerSession: sessionCount > 0 ? round1(messages / sessionCount) : 0,
    avgTokensPerMessage: messages > 0 ? Math.round(totalTokens / messages) : 0,
    peakDate,
    peakTokens,
    firstAt,
    lastAt,
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// ===== 分布统计 =====

export function modelDistribution(sessions: SessionLike[]): ModelSlice[] {
  const map = new Map<string, { messages: number; tokens: number }>();
  let totalTokens = 0;
  for (const s of sessions || []) {
    for (const m of s.messages || []) {
      // 老会话的 assistant 消息可能没有 usage，无法归属到任何模型，直接跳过
      if (m.role !== 'assistant' || !m.usage) continue;
      const u = normalizeUsage(m);
      const cur = map.get(u.model) || { messages: 0, tokens: 0 };
      cur.messages += 1;
      cur.tokens += u.totalTokens;
      map.set(u.model, cur);
      totalTokens += u.totalTokens;
    }
  }
  return Array.from(map.entries())
    .map(([model, v]) => ({
      model,
      messages: v.messages,
      tokens: v.tokens,
      share: totalTokens > 0 ? round1((v.tokens / totalTokens) * 100) : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens || b.messages - a.messages);
}

export function toolDistribution(sessions: SessionLike[]): ToolSlice[] {
  const map = new Map<string, { count: number; failures: number }>();
  let total = 0;
  for (const s of sessions || []) {
    for (const m of s.messages || []) {
      for (const tc of m.toolCalls || []) {
        const name = toolName(tc);
        const cur = map.get(name) || { count: 0, failures: 0 };
        cur.count += 1;
        if (isToolFailure(tc)) cur.failures += 1;
        map.set(name, cur);
        total += 1;
      }
    }
  }
  return Array.from(map.entries())
    .map(([tool, v]) => ({
      tool,
      count: v.count,
      failures: v.failures,
      share: total > 0 ? round1((v.count / total) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

/** 24 小时活跃度（按消息时间戳统计，用于时段热力） */
export function hourlyActivity(sessions: SessionLike[]): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const s of sessions || []) {
    for (const m of s.messages || []) {
      const ts = typeof m?.timestamp === 'number' ? m.timestamp : 0;
      if (ts <= 0) continue;
      const h = new Date(ts).getHours();
      if (h >= 0 && h < 24) hours[h] += 1;
    }
  }
  return hours;
}

// ===== 会话级明细 =====

export function sessionRows(sessions: SessionLike[]): SessionRow[] {
  return (sessions || []).map((s) => {
    const msgs = s.messages || [];
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolFailures = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let firstMessageAt: number | null = null;
    let lastMessageAt: number | null = null;
    const modelSet = new Set<string>();
    let preview = '';

    for (const m of msgs) {
      if (m.role === 'user') userMessages += 1;
      else if (m.role === 'assistant') assistantMessages += 1;

      const u = normalizeUsage(m);
      promptTokens += u.promptTokens;
      completionTokens += u.completionTokens;
      totalTokens += u.totalTokens;
      if (m.role === 'assistant' && m.usage) modelSet.add(u.model);

      for (const tc of m.toolCalls || []) {
        toolCalls += 1;
        if (isToolFailure(tc)) toolFailures += 1;
      }

      const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
      if (ts > 0) {
        firstMessageAt = firstMessageAt === null ? ts : Math.min(firstMessageAt, ts);
        lastMessageAt = lastMessageAt === null ? ts : Math.max(lastMessageAt, ts);
      }

      if (!preview && m.role === 'user') {
        preview = clip(typeof m.displayContent === 'string' && m.displayContent ? m.displayContent : messageText(m), 80);
      }
    }

    return {
      id: s.id,
      title: (typeof s.title === 'string' && s.title.trim()) || '未命名会话',
      workspaceId: typeof s.workspaceId === 'string' ? s.workspaceId : '',
      mode: typeof s.mode === 'string' ? s.mode : '',
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : 0,
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : sessionTime(s),
      messages: msgs.length,
      userMessages,
      assistantMessages,
      toolCalls,
      toolFailures,
      promptTokens,
      completionTokens,
      totalTokens,
      models: Array.from(modelSet),
      firstMessageAt,
      lastMessageAt,
      durationMs: firstMessageAt !== null && lastMessageAt !== null ? Math.max(0, lastMessageAt - firstMessageAt) : 0,
      preview,
    };
  });
}

/** 历史记录表格的关键词/维度过滤（在 sessionRows 之上） */
export function filterRows(rows: SessionRow[], filter: StatsFilter = {}): SessionRow[] {
  const kw = typeof filter.keyword === 'string' ? filter.keyword.trim().toLowerCase() : '';
  const ws = normalizeWorkspaceFilter(filter.workspaceId);
  return (rows || []).filter((r) => {
    if (!workspaceMatches(r.workspaceId, ws)) return false;
    if (!kw) return true;
    const hay = `${r.title} ${r.preview} ${r.models.join(' ')} ${r.mode}`.toLowerCase();
    return hay.includes(kw);
  });
}

/** 历史记录表格的排序维度 */
export type StatsSortBy = 'updatedAt' | 'totalTokens' | 'messages' | 'toolCalls';

export interface StatsQuery extends StatsFilter {
  page?: number;
  pageSize?: number;
  sortBy?: StatsSortBy;
}

/** 排序：默认按更新时间倒序（最近用过的在最上面） */
export function sortRows(rows: SessionRow[], sortBy: StatsSortBy = 'updatedAt'): SessionRow[] {
  const out = rows.slice();
  switch (sortBy) {
    case 'totalTokens':
      out.sort((a, b) => b.totalTokens - a.totalTokens || b.updatedAt - a.updatedAt);
      break;
    case 'messages':
      out.sort((a, b) => b.messages - a.messages || b.updatedAt - a.updatedAt);
      break;
    case 'toolCalls':
      out.sort((a, b) => b.toolCalls - a.toolCalls || b.updatedAt - a.updatedAt);
      break;
    default:
      out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return out;
}

export interface WorkspaceOption {
  id: string;
  /** 取路径最后一段作为显示名 */
  label: string;
  sessions: number;
}

/**
 * 工作区筛选下拉的数据源（按会话数倒序，「未归属」固定排最后）。
 *
 * 调用方应传入**已按时间范围/关键词筛选**的会话，这样下拉里的数字就是
 * 「选中它之后能看到多少条」，不会出现"标着 3 条、选进去只有 2 条"的错位。
 */
export function workspaceOptions(sessions: SessionLike[]): WorkspaceOption[] {
  const map = new Map<string, number>();
  let orphan = 0;
  for (const s of sessions || []) {
    const ws = typeof s?.workspaceId === 'string' ? s.workspaceId : '';
    if (!ws) {
      orphan++;
      continue;
    }
    map.set(ws, (map.get(ws) || 0) + 1);
  }

  const labels = uniqueLabels(Array.from(map.keys()));
  const options = Array.from(map.entries())
    .map(([id, count]) => ({ id, label: labels.get(id) || id, sessions: count }))
    .sort((a, b) => b.sessions - a.sessions);

  if (orphan > 0) {
    options.push({ id: NO_WORKSPACE_ID, label: '未归属工作区', sessions: orphan });
  }
  return options;
}

export interface PagedResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

/** 分页（page 从 1 开始，越界自动收敛到最后一页） */
export function paginate<T>(rows: T[], page = 1, pageSize = 10): PagedResult<T> {
  const size = Math.max(1, Math.floor(pageSize) || 10);
  const total = (rows || []).length;
  const pages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (safePage - 1) * size;
  return { rows: rows.slice(start, start + size), total, page: safePage, pageSize: size, pages };
}
