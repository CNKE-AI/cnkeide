/**
 * ParallelToolScheduler - 多工具并发调度器（W2）
 *
 * 目标：把 Agent 单轮里的串行工具调用改成按依赖自动并发，
 * 同时保证写操作不冲突、读依赖写时正确排序。
 *
 * 设计：
 * - 工具声明 parallel 策略：
 *   'safe'：只读/幂等，可任意并发
 *   'path-serial'：按路径串行（同一文件路径的写操作排队，不同路径可并发）
 *   'global-serial'：全局串行（命令执行、目录级删除/重命名等）
 * - 依赖推断（默认规则）：
 *   1. 所有写工具之间若有相同 path/oldPath/newPath，建立依赖边（后面的依赖前面的）
 *   2. 读工具的 path 出现在前面写目标路径中时，读依赖该写
 *   3. execute_command 默认全局互斥，与所有写工具串行；与读工具可并发
 *   4. MCP 工具默认 'global-serial'，除非显式标记 safe
 * - 调度算法：Kahn 拓扑排序 + 按层并发，每层同时启动无前驱节点，
 *   但受 concurrencyLimit（默认 4）限制
 */

export type ParallelPolicy = 'safe' | 'path-serial' | 'global-serial';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolExecutionResult {
  toolCallId: string;
  result: any;
}

export interface SchedulerOptions {
  /** 最大并发数，默认 4 */
  concurrencyLimit?: number;
  /** 单工具执行函数 */
  execute: (call: ToolCall) => Promise<any>;
  /** 工具策略映射 */
  policyMap: Record<string, ParallelPolicy>;
  /** 自定义依赖边：[后执行的 toolCallId, 先执行的 toolCallId] */
  extraEdges?: [string, string][];
}

/** 内置工具的默认并发策略 */
export const DEFAULT_TOOL_POLICIES: Record<string, ParallelPolicy> = {
  read_file: 'safe',
  search_files: 'safe',
  list_directory: 'safe',
  get_file_outline: 'safe',
  search_symbol: 'safe',
  find_references: 'safe',
  project_structure: 'safe',
  // W4 新增：只读联网/搜索/symbol 工具都是 safe
  web_search: 'safe',
  web_fetch: 'safe',
  grep: 'safe',
  git_status: 'safe',
  git_log: 'safe',
  git_diff: 'safe',
  semantic_search: 'safe',
  // W10 RAG 工具：ingest 写操作（内存），query/list/remove 都是只读
  doc_ingest: 'global-serial',
  doc_query: 'safe',
  doc_list: 'safe',
  doc_remove: 'global-serial',
  // W12 Playwright：单例浏览器，全局互斥
  browser_navigate: 'global-serial',
  browser_screenshot: 'global-serial',
  browser_click: 'global-serial',
  browser_input: 'global-serial',
  browser_extract: 'global-serial',
  browser_close: 'global-serial',
  // W12 图片生成
  image_generate: 'global-serial',
  // plan 工具
  create_plan: 'global-serial',
  update_plan_status: 'global-serial',
  add_plan_item: 'global-serial',
  get_plan: 'safe',
  mark_plan_complete: 'global-serial',
  // 写工具
  write_to_file: 'path-serial',
  create_file: 'path-serial',
  delete_file: 'path-serial',
  rename_file: 'path-serial',
  apply_diff: 'path-serial',
  // W4：format 改文件，并发按路径串行
  format_code: 'path-serial',
  // 命令 / git commit / 测试：全局互斥
  execute_command: 'global-serial',
  run_python: 'global-serial',
  git_commit: 'global-serial',
  // W26：分支/远程操作会改 .git 里的共享状态，必须全局串行
  git_branch: 'global-serial',
  git_checkout: 'global-serial',
  git_fetch: 'global-serial',
  git_pull: 'global-serial',
  git_push: 'global-serial',
  run_tests: 'global-serial',
  // W27：自愈循环内部会跑测试 + 改文件，必须全局串行
  auto_fix_tests: 'global-serial',
};

function getPolicy(name: string, policyMap: Record<string, ParallelPolicy>): ParallelPolicy {
  return policyMap[name] || DEFAULT_TOOL_POLICIES[name] || 'global-serial';
}

/** 提取工具调用涉及的路径集合（path / oldPath / newPath） */
function extractPaths(call: ToolCall): string[] {
  const args = call.arguments || {};
  const paths: string[] = [];
  if (args.path && typeof args.path === 'string') paths.push(args.path);
  if (args.oldPath && typeof args.oldPath === 'string') paths.push(args.oldPath);
  if (args.newPath && typeof args.newPath === 'string') paths.push(args.newPath);
  // diff 编辑的目标文件
  return paths;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function pathsOverlap(a: ToolCall, b: ToolCall): boolean {
  const setA = new Set(extractPaths(a).map(normalizePath));
  const setB = new Set(extractPaths(b).map(normalizePath));
  for (const p of setA) if (setB.has(p)) return true;
  return false;
}

/**
 * 构建依赖图（有向边：a -> b 表示 a 必须先执行，b 依赖 a）
 */
function buildDependencyGraph(
  calls: ToolCall[],
  policyMap: Record<string, ParallelPolicy>,
  extraEdges?: [string, string][]
): Map<string, Set<string>> {
  const n = calls.length;
  const graph = new Map<string, Set<string>>();
  for (const c of calls) graph.set(c.id, new Set());

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = calls[i];
      const b = calls[j];
      const policyA = getPolicy(a.name, policyMap);
      const policyB = getPolicy(b.name, policyMap);

      // 全局串行：与任何其它全局串行工具之间加边（按调用顺序）
      if (policyA === 'global-serial' && policyB === 'global-serial') {
        graph.get(b.id)!.add(a.id);
        continue;
      }
      if (policyA === 'global-serial' && policyB !== 'safe') {
        graph.get(b.id)!.add(a.id);
        continue;
      }
      if (policyB === 'global-serial' && policyA !== 'safe') {
        graph.get(b.id)!.add(a.id);
        continue;
      }

      // 写操作之间：路径重叠则串行
      if (policyA === 'path-serial' && policyB === 'path-serial' && pathsOverlap(a, b)) {
        graph.get(b.id)!.add(a.id);
        continue;
      }

      // 读依赖写：只要读的目标路径出现在任意写操作的目标路径中，读必须等写完成
      //（无论读写原始顺序如何，都以数据依赖为准）
      if (policyA === 'path-serial' && policyB === 'safe' && pathsOverlap(a, b)) {
        graph.get(b.id)!.add(a.id);
        continue;
      }
      if (policyA === 'safe' && policyB === 'path-serial' && pathsOverlap(a, b)) {
        graph.get(a.id)!.add(b.id);
        continue;
      }
    }
  }

  if (extraEdges) {
    for (const [later, earlier] of extraEdges) {
      if (graph.has(later) && graph.has(earlier)) {
        graph.get(later)!.add(earlier);
      }
    }
  }

  return graph;
}

function detectCycle(graph: Map<string, Set<string>>): boolean {
  const visited = new Set<string>();
  const recStack = new Set<string>();
  function dfs(node: string): boolean {
    visited.add(node);
    recStack.add(node);
    for (const dep of graph.get(node) || []) {
      if (!visited.has(dep)) {
        if (dfs(dep)) return true;
      } else if (recStack.has(dep)) {
        return true;
      }
    }
    recStack.delete(node);
    return false;
  }
  for (const node of graph.keys()) {
    if (!visited.has(node) && dfs(node)) return true;
  }
  return false;
}

/**
 * 调度执行
 * @returns 按原始调用顺序排列的结果数组
 */
export async function scheduleToolCalls(
  calls: ToolCall[],
  options: SchedulerOptions
): Promise<ToolExecutionResult[]> {
  if (calls.length === 0) return [];
  if (calls.length === 1) {
    const result = await options.execute(calls[0]);
    return [{ toolCallId: calls[0].id, result }];
  }

  const graph = buildDependencyGraph(calls, options.policyMap, options.extraEdges);

  if (detectCycle(graph)) {
    // 出现循环依赖时回退串行（安全兜底）
    const results: ToolExecutionResult[] = [];
    for (const c of calls) {
      results.push({ toolCallId: c.id, result: await options.execute(c) });
    }
    return results;
  }

  const inDegree = new Map<string, number>();
  for (const c of calls) inDegree.set(c.id, 0);
  for (const [id, deps] of graph) {
    // id 依赖 deps 里的每个前驱节点，所以 id 的入度增加
    for (const d of deps) {
      inDegree.set(id, (inDegree.get(id) || 0) + 1);
    }
  }

  const remaining = new Map<string, Set<string>>();
  for (const [id, deps] of graph) remaining.set(id, new Set(deps));
  const resultsMap = new Map<string, any>();
  const completed = new Set<string>();
  const limit = Math.max(1, options.concurrencyLimit || 4);

  return new Promise((resolve, reject) => {
    const results: ToolExecutionResult[] = [];
    let running = 0;
    let rejected = false;

    function trySchedule() {
      if (rejected) return;
      const ready: string[] = [];
      for (const [id, deg] of inDegree) {
        if (deg === 0 && !completed.has(id) && running + ready.length < limit) {
          ready.push(id);
        }
      }
      if (ready.length === 0 && running === 0 && completed.size === calls.length) {
        // 全部完成，按原始顺序输出
        for (const c of calls) {
          results.push({ toolCallId: c.id, result: resultsMap.get(c.id) });
        }
        resolve(results);
        return;
      }

      for (const id of ready) {
        const call = calls.find((c) => c.id === id)!;
        running++;
        // 从 inDegree 中移除，避免重复调度
        inDegree.set(id, -1);
        options
          .execute(call)
          .then((res) => {
            if (rejected) return;
            resultsMap.set(id, res);
            completed.add(id);
            running--;
            // 减少后继节点入度
            for (const [nid, deps] of remaining) {
              if (deps.has(id)) {
                deps.delete(id);
                inDegree.set(nid, (inDegree.get(nid) || 0) - 1);
              }
            }
            trySchedule();
          })
          .catch((err) => {
            if (rejected) return;
            rejected = true;
            reject(err);
          });
      }
    }

    trySchedule();
  });
}

/** 判断某工具是否可安全并发（用于日志/诊断） */
export function isSafeTool(name: string, policyMap?: Record<string, ParallelPolicy>): boolean {
  return getPolicy(name, policyMap || {}) === 'safe';
}
