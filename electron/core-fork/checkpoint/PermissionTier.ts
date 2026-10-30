/**
 * PermissionTier - 执行权限档位（W25）
 *
 * 解决的问题：原来只有"工具级审批"（每次弹窗 / 一律放行）两种极端，
 * 用户没法说"这次只许看，不许改"。档位把工具按副作用分类，再按档位给默认裁决：
 *
 *   read-only    只读：读/搜/网页抓取放行；写文件、删除、执行命令、git 提交、MCP 一律拦截
 *   standard      标准（默认）：读 + 修改文件内容放行（可快照回滚）；删除/命令/git/MCP 逐次确认
 *   full-access  完全访问：全部放行，只保留用户显式配置的"拒绝"规则
 *
 * 与已有机制的优先级（从高到低，先命中先返回）：
 *   1. 用户信任规则的 deny（agentConfig.approvalRules，用户显式说了不许，永远最高）
 *   2. 档位硬拦截（read-only 的写/执行/MCP；这一条不能被信任规则 allow 绕过）
 *   3. 用户信任规则的 allow
 *   4. 关闭 zeroApprovalMode 后，标准档位的自动放行降级为询问
 *   5. 档位默认裁决
 *
 * 另有两份白名单（配置为空即不启用）：
 *   - commandAllowlist：命令前缀/通配，命中后 execute_command 直接放行（只读档也放行，
 *     因为白名单是用户显式授权的"这些命令随便跑"，如 `git status`、`npm test`）
 *   - domainAllowlist：域名/域名+路径前缀，非空时 web_fetch / web_search / 浏览器导航
 *     只允许访问白名单内的地址，其余一律拒绝
 */

import { globMatch } from './ApprovalPolicy';

export type PermissionMode = 'read-only' | 'standard' | 'full-access';

/** 工具副作用分类 */
export type ToolEffect =
  | 'read' // 纯读：读文件/搜索/git 只读/计划工具
  | 'network' // 只读联网：web_search / web_fetch
  | 'browser' // 浏览器只读动作：导航/截图/提取
  | 'write' // 改文件内容或本地索引（可被 checkpoint 回滚）
  | 'destructive' // 删除/重命名
  | 'exec' // 执行命令/跑测试/格式化/git 写
  | 'external' // MCP 外部服务调用
  | 'unknown'; // 未分类（按最危险的对待）

export type PermissionAction = 'allow' | 'deny' | 'ask';

export const PERMISSION_MODES: readonly PermissionMode[] = ['read-only', 'standard', 'full-access'];

export interface PermissionModeInfo {
  label: string;
  summary: string;
  detail: string;
}

export const PERMISSION_MODE_INFO: Record<PermissionMode, PermissionModeInfo> = {
  'read-only': {
    label: '只读',
    summary: '只能看，不能改',
    detail:
      '读文件、搜索、网页抓取正常使用；写文件、删除、执行命令、git 提交、MCP 外部调用一律拦截（命中命令白名单的除外）。适合"只让它帮我看看代码"。',
  },
  standard: {
    label: '标准',
    summary: '改文件自动放行，危险操作要确认',
    detail:
      '读文件与修改文件内容（可被快照回滚）自动放行；删除、重命名、执行命令、git 提交、MCP 外部调用仍然逐次确认。默认档位。',
  },
  'full-access': {
    label: '完全访问',
    summary: '不再弹窗，全部放行',
    detail:
      '所有工具调用一律放行，只保留你显式配置的「拒绝」信任规则。适合在一次性容器或临时目录里跑长任务。',
  },
};

/** 纯读工具：任何档位都放行（read-only 也不拦） */
const READ_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'get_file_outline',
  'search_symbol',
  'find_references',
  'project_structure',
  'grep',
  'semantic_search',
  'git_status',
  'git_log',
  'git_diff',
  'doc_query',
  'doc_list',
  'browser_close',
  // 计划工具只改内存里的计划状态，没有外部副作用
  'create_plan',
  'update_plan_status',
  'add_plan_item',
  'get_plan',
  'mark_plan_complete',
  // 子 Agent 委派本身不产生副作用，其内部每次工具调用同样过本闸门
  'delegate_subagent',
]);

/** 只读联网：标准档位也放行（与 ask 模式的工具白名单保持一致） */
const NETWORK_TOOLS = new Set(['web_search', 'web_fetch']);

/** 浏览器只读动作：标准档位仍然询问（会拉起浏览器、访问任意站点） */
const BROWSER_READ_TOOLS = new Set(['browser_navigate', 'browser_screenshot', 'browser_extract']);

/** 写文件内容 / 本地索引（可被快照或索引重建恢复） */
const WRITE_TOOLS = new Set(['write_to_file', 'create_file', 'apply_diff', 'doc_ingest', 'doc_remove', 'image_generate']);

/** 破坏性：删除、重命名 */
const DESTRUCTIVE_TOOLS = new Set(['delete_file', 'rename_file']);

/** 执行类：能跑任意代码、提交代码或改动分支/远程 */
const EXEC_TOOLS = new Set([
  'execute_command',
  'run_python',
  'run_tests',
  'format_code',
  'git_commit',
  // W26：git 写操作（改 ref / 改工作区 / 动远程）一律按执行类对待
  'git_branch',
  'git_checkout',
  'git_fetch',
  'git_pull',
  'git_push',
  // W27：自愈循环会跑测试并让子 Agent 改代码，性质等于「执行命令 + 写文件」
  'auto_fix_tests',
  'browser_click',
  'browser_input',
]);

/** 工具副作用分类（未知工具按 unknown 处理，read-only 下会被拦） */
export function classifyTool(toolName: string): ToolEffect {
  const name = String(toolName ?? '')
    .trim()
    .toLowerCase();
  if (!name) return 'unknown';
  if (READ_TOOLS.has(name)) return 'read';
  if (NETWORK_TOOLS.has(name)) return 'network';
  if (BROWSER_READ_TOOLS.has(name)) return 'browser';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (DESTRUCTIVE_TOOLS.has(name)) return 'destructive';
  if (EXEC_TOOLS.has(name)) return 'exec';
  if (name.startsWith('mcp__') || name.startsWith('mcp_') || name.startsWith('mcp.')) return 'external';
  return 'unknown';
}

const EFFECT_LABEL: Record<ToolEffect, string> = {
  read: '只读操作',
  network: '联网读取',
  browser: '浏览器读取',
  write: '写文件',
  destructive: '删除/重命名',
  exec: '执行命令',
  external: 'MCP 外部调用',
  unknown: '未分类工具',
};

export function describeEffect(effect: ToolEffect): string {
  return EFFECT_LABEL[effect] || '未知操作';
}

export interface PermissionCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface PermissionOptions {
  mode?: PermissionMode;
  /** 命令白名单：前缀或含 * 的通配 */
  commandAllowlist?: string[];
  /** 域名白名单：example.com / *.example.com / api.example.com/v1 */
  domainAllowlist?: string[];
  /** 用户信任规则命中的动作（ApprovalPolicy.evaluate）；未命中传 undefined */
  userAction?: PermissionAction;
  userReason?: string;
  /** 关闭后标准档位的自动放行降级为询问（保留旧行为） */
  zeroApprovalMode?: boolean;
}

export interface PermissionResult {
  action: PermissionAction;
  effect: ToolEffect;
  mode: PermissionMode;
  matchedBy: 'user-rule' | 'mode' | 'command-allowlist' | 'domain-allowlist' | 'default';
  reason: string;
  /** deny 时给用户看的完整提示（会作为工具结果回给模型和 UI） */
  message?: string;
}

export function normalizeMode(mode?: string): PermissionMode {
  const value = String(mode ?? '')
    .trim()
    .toLowerCase();
  if (value === 'read-only' || value === 'readonly' || value === 'read_only') return 'read-only';
  if (value === 'full-access' || value === 'fullaccess' || value === 'full_access' || value === 'full') {
    return 'full-access';
  }
  return 'standard';
}

/** 各档位对各类副作用的默认裁决 */
function baseline(mode: PermissionMode, effect: ToolEffect): PermissionAction {
  if (mode === 'full-access') return 'allow';
  if (mode === 'read-only') {
    if (effect === 'read' || effect === 'network' || effect === 'browser') return 'allow';
    return 'deny';
  }
  // standard
  if (effect === 'read' || effect === 'network' || effect === 'write') return 'allow';
  return 'ask';
}

/** 核心裁决 */
export function evaluatePermission(call: PermissionCall, options: PermissionOptions = {}): PermissionResult {
  const effect = classifyTool(call.name);
  const mode = normalizeMode(options.mode);
  const modeInfo = PERMISSION_MODE_INFO[mode];
  const build = (
    action: PermissionAction,
    matchedBy: PermissionResult['matchedBy'],
    reason: string,
    message?: string
  ): PermissionResult => ({ action, effect, mode, matchedBy, reason, message });

  // 1) 用户显式拒绝规则：优先级最高，任何档位都不能绕过
  if (options.userAction === 'deny') {
    const reason = options.userReason || '命中用户的拒绝规则';
    return build('deny', 'user-rule', reason, `⛔ 已被信任规则拦截：${reason}`);
  }

  // 2) 域名白名单：非空时只允许白名单内的地址（对所有档位生效）
  const domainAllowlist = (options.domainAllowlist || []).map((s) => String(s).trim()).filter(Boolean);
  if (domainAllowlist.length > 0 && isNetworkEffect(effect)) {
    const url = extractUrl(call.arguments);
    if (url) {
      const parsed = parseUrl(url);
      if (parsed && !domainAllowlist.some((pattern) => matchDomain(pattern, url))) {
        return build(
          'deny',
          'domain-allowlist',
          `目标域名 ${parsed.host} 不在白名单内`,
          `⛔ 域名白名单拦截：只允许访问 ${domainAllowlist.join('、')}，本次目标是 ${parsed.host}`
        );
      }
    }
  }

  // 3) 命令白名单：命中即放行（只读档也放行——白名单本身就是用户的显式授权）
  if (call.name === 'execute_command') {
    const allowlist = (options.commandAllowlist || []).map((s) => String(s).trim()).filter(Boolean);
    const command = String(call.arguments?.command ?? '');
    if (allowlist.length > 0 && command) {
      const hit = allowlist.find((pattern) => matchCommand(pattern, command));
      if (hit) {
        return build('allow', 'command-allowlist', `命令命中白名单「${hit}」`);
      }
    }
  }

  // 4) 档位硬拦截：只读档的写/执行/MCP 不能被信任规则的 allow 绕过
  const base = baseline(mode, effect);
  if (base === 'deny') {
    const hint =
      mode === 'read-only'
        ? `只读档位下${describeEffect(effect)}已拦截。需要动手时把档位切到「标准」或「完全访问」，或把该命令加进命令白名单。`
        : `${describeEffect(effect)}已拦截。`;
    return build('deny', 'mode', `${modeInfo.label}档位不允许${describeEffect(effect)}`, `⛔ ${hint}`);
  }

  // 5) 用户显式放行规则：把"要问的"提升为放行
  if (options.userAction === 'allow' && base === 'ask') {
    return build('allow', 'user-rule', options.userReason || '命中用户的放行规则');
  }

  // 6) zeroApprovalMode 关闭时，标准档位的自动放行降级为询问
  if (options.zeroApprovalMode === false && mode === 'standard' && base === 'allow') {
    return build('ask', 'mode', '已关闭零弹窗模式，需逐次确认');
  }

  return build(base, options.userAction ? 'user-rule' : 'default', base === 'ask' ? `${describeEffect(effect)}需确认` : `${modeInfo.label}档位允许${describeEffect(effect)}`);
}

function isNetworkEffect(effect: ToolEffect): boolean {
  return effect === 'network' || effect === 'browser';
}

/** 从工具参数里取 URL（web_fetch / browser_navigate 都用 url） */
export function extractUrl(args?: Record<string, unknown>): string {
  if (!args) return '';
  for (const key of ['url', 'href', 'uri', 'link']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export interface ParsedUrl {
  host: string;
  /** host + pathname，供白名单写路径前缀时匹配 */
  full: string;
}

export function parseUrl(url: string): ParsedUrl | null {
  const raw = String(url ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const pathname = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return { host, full: `${host}${pathname}` };
  } catch {
    return null;
  }
}

/**
 * 域名匹配：
 *   example.com          → 精确或任意子域（a.example.com）
 *   *.example.com        → 任意子域（含裸域）
 *   api.example.com/v1   → host + 路径前缀（* 通配）
 */
export function matchDomain(pattern: string, url: string): boolean {
  const p = String(pattern ?? '')
    .trim()
    .toLowerCase();
  if (!p) return false;
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const { host, full } = parsed;

  if (p.includes('/')) {
    const normalized = p.replace(/^https?:\/\//, '');
    if (!normalized.includes('*')) {
      return full === normalized || full.startsWith(normalized.endsWith('/') ? normalized : `${normalized}/`) || full.startsWith(`${normalized}?`) || full === `${normalized}/`;
    }
    return globMatch(normalized, full) || globMatch(`${normalized}**`, full);
  }

  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // .example.com
    return host === p.slice(2) || host.endsWith(suffix);
  }
  return host === p || host.endsWith(`.${p}`);
}

/**
 * 命令白名单匹配：
 *   npm test       → 精确，或以 shell 分隔符续写（npm test --coverage / npm test && ...）
 *   git *          → 通配（* → 任意字符，? → 单字符）
 */
export function matchCommand(pattern: string, command: string): boolean {
  const p = String(pattern ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  const c = String(command ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!p || !c) return false;

  if (p.includes('*') || p.includes('?')) {
    // 通配模式：先按 path glob 转成 / 无关的正则（globMatch 的 * 不跨 /，命令里没有用 / 作分隔的语义，
    // 故这里把 / 也当作普通字符处理，用 ** 语义匹配整串）
    const escaped = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
      .replace(/\u0000/g, '.*');
    return new RegExp(`^${escaped}$`).test(c);
  }

  if (c === p) return true;
  // 后续跟着别的命令（--flag / && 后续 / ; 串联）也算命中：白名单是"这个命令可以跑"
  return c.startsWith(`${p} `) || c.startsWith(`${p}&&`) || c.startsWith(`${p};`) || c.startsWith(`${p}|`);
}
