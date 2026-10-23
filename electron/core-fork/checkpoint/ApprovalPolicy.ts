/**
 * ApprovalPolicy - 工具调用的智能审批规则（W7）
 *
 * 规则维度：(toolName, pathPattern?, commandPattern?, action)
 * - 规则按优先级匹配（先具体后通用）
 * - action: 'allow' | 'deny' | 'ask'（ask 是默认行为）
 * - 规则可存于 ConfigAdapter（agentConfig.approvalRules）
 *
 * 匹配算法：
 * 1. 取出本调用的 toolName 与关键参数（path / command）
 * 2. 按规则顺序匹配，第一条命中即返回
 * 3. pathPattern 支持 glob（** / * / ?）
 * 4. commandPattern 支持子串匹配
 */

export type ApprovalAction = 'allow' | 'deny' | 'ask';

export interface ApprovalRule {
  /** 工具名（如 'write_to_file' / 'execute_command'） */
  toolName: string;
  /** 路径 glob（仅对 path 类工具有效），可空表示匹配所有路径 */
  pathPattern?: string;
  /** 命令子串（仅对 execute_command 有效），可空表示匹配所有命令 */
  commandPattern?: string;
  /** 动作 */
  action: ApprovalAction;
  /** 规则来源标识（用于 UI 展示） */
  source?: string;
  /** 创建时间 */
  createdAt?: number;
}

export interface PolicyDecision {
  action: ApprovalAction;
  matchedRule?: ApprovalRule;
  reason: string;
}

export class ApprovalPolicy {
  private rules: ApprovalRule[] = [];

  constructor(rules: ApprovalRule[] = []) {
    this.rules = [...rules];
  }

  /** 添加规则（追加到末尾） */
  add(rule: ApprovalRule): void {
    this.rules.push({ ...rule, createdAt: rule.createdAt || Date.now() });
  }

  /** 删除规则（按索引） */
  remove(index: number): boolean {
    if (index < 0 || index >= this.rules.length) return false;
    this.rules.splice(index, 1);
    return true;
  }

  /** 列出所有规则 */
  list(): ApprovalRule[] {
    return [...this.rules];
  }

  /** 加载规则（覆盖） */
  load(rules: ApprovalRule[]): void {
    this.rules = [...rules];
  }

  /** 核心：评估调用是否需要审批 */
  evaluate(call: { name: string; arguments: Record<string, unknown> }): PolicyDecision {
    for (const rule of this.rules) {
      if (rule.toolName !== call.name) continue;

      // 路径匹配
      if (rule.pathPattern) {
        const rawPath: unknown = call.arguments?.path || call.arguments?.oldPath || '';
        const filePath = typeof rawPath === 'string' ? rawPath : String(rawPath);
        if (!filePath) continue;
        if (!globMatch(rule.pathPattern, filePath)) continue;
      }

      // 命令匹配
      if (rule.commandPattern) {
        const rawCmd: unknown = call.arguments?.command || '';
        const cmd = typeof rawCmd === 'string' ? rawCmd : String(rawCmd);
        if (!cmd.includes(rule.commandPattern)) continue;
      }

      return {
        action: rule.action,
        matchedRule: rule,
        reason: `匹配规则：${rule.toolName}${rule.pathPattern ? ` @ ${rule.pathPattern}` : ''}${rule.commandPattern ? ` (cmd: ${rule.commandPattern})` : ''} → ${rule.action}${rule.source ? `（${rule.source}）` : ''}`,
      };
    }
    return { action: 'ask', reason: '无匹配规则，需要用户确认' };
  }
}

/** 简易 glob 匹配：支持 ** / * / ? */
export function globMatch(pattern: string, input: string): boolean {
  if (!pattern) return true;
  // 路径统一
  const p = pattern.replace(/\\/g, '/');
  const i = input.replace(/\\/g, '/');
  // 转成正则
  const re = globToRegex(p);
  return re.test(i);
}

function globToRegex(glob: string): RegExp {
  // 顺序很重要：先转义特殊字符，再把 glob 元字符替换回来
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', 'i');
}
