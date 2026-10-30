/**
 * Agent 活动日志中文化回归测试
 * 运行：npx tsx scripts/test_activity_labels.mjs
 */
import { TOOL_LABELS, toolLabel, describeToolCall, formatToolCall } from '../renderer/src/store/agentActivityStore.ts';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`);
  }
};

// 内置工具全集（来自 ToolManager 与常见别名）
const TOOLS = [
  'execute_command', 'run_python', 'run_tests', 'format_code',
  'read_file', 'write_to_file', 'create_file', 'delete_file', 'rename_file',
  'apply_diff', 'replace_in_file', 'insert_content',
  'list_directory', 'list_dir', 'search_files', 'search_content', 'grep',
  'get_file_outline', 'search_symbol', 'find_references', 'semantic_search',
  'codebase_search', 'project_structure', 'web_search', 'web_fetch',
  'git_status', 'git_diff', 'git_log', 'git_branch', 'git_commit',
  'git_checkout', 'git_fetch', 'git_pull', 'git_push',
  'create_plan', 'add_plan_item', 'update_plan_status', 'get_plan', 'mark_plan_complete',
  'doc_ingest', 'doc_query', 'doc_list', 'doc_remove',
  'browser_navigate', 'browser_click', 'browser_input', 'browser_extract',
  'browser_screenshot', 'browser_close', 'image_generate',
];

console.log('1) 工具名中文映射覆盖');
for (const t of TOOLS) {
  const label = toolLabel(t);
  ok(`${t} 有中文标签`, label !== t, `得到 ${label}`);
  ok(`${t} 标签非空且无英文下划线`, label.length > 0 && !/_/.test(label), label);
}
ok('映射表条目数 ≥ 50', Object.keys(TOOL_LABELS).length >= 50, String(Object.keys(TOOL_LABELS).length));

console.log('2) 未知工具回退');
ok('未知工具保留原名', toolLabel('mcp_custom_tool') === 'mcp_custom_tool');
ok('空工具名兜底', toolLabel('') === '未知操作');

console.log('3) 参数摘要分类');
const c1 = describeToolCall('execute_command', { command: 'py -m py_compile "a.py"' });
ok('命令 → 执行命令', c1.label === '执行命令');
ok('命令正文原样保留', c1.detail === 'py -m py_compile "a.py"', c1.detail);
ok('命令 hint=command', c1.hint === 'command');

const c2 = describeToolCall('read_file', { path: 'C:\\a\\b.ts' });
ok('路径 → 读取文件', c2.label === '读取文件');
ok('路径 hint=path', c2.hint === 'path');
ok('路径正文', c2.detail === 'C:\\a\\b.ts', c2.detail);

const c3 = describeToolCall('grep', { pattern: 'TODO' });
ok('检索 hint=query', c3.hint === 'query');
ok('检索正文', c3.detail === 'TODO');

const c4 = describeToolCall('web_fetch', { url: 'https://a.cn' });
ok('url 走检索分支', c4.detail === 'https://a.cn', c4.detail);

const c5 = describeToolCall('git_status', {});
ok('空参数不产生正文', c5.detail === '' && c5.hint === 'none');

const c6 = describeToolCall('create_plan', { title: '清理 C 盘', steps: ['a', 'b', 'c'] });
ok('兜底摘要含参数名', c6.detail.includes('title='), c6.detail);

const c7 = describeToolCall('read_file', { path: 'a.ts', filePath: 'b.ts' });
ok('多路径用分隔符连接', c7.detail.includes('·'), c7.detail);

console.log('4) 纯文本摘要');
ok('formatToolCall 命令带 $', formatToolCall('execute_command', { command: 'dir' }) === '执行命令  $ dir');
ok('formatToolCall 检索带引号', formatToolCall('grep', { pattern: 'x' }) === '全文检索  "x"');
ok('formatToolCall 无参只有动作名', formatToolCall('git_status', {}) === '查看状态');

console.log('5) 中文标签唯一性（避免歧义）');
const dup = {};
for (const [k, v] of Object.entries(TOOL_LABELS)) {
  dup[v] = (dup[v] || 0) + 1;
}
// list_dir 与 list_directory 等同义别名允许重复，仅提示
const dupKeys = Object.keys(dup).filter((k) => dup[k] > 1);
ok('重复标签仅为同义别名', dupKeys.every((k) => ['浏览目录', '查找文件', '语义检索'].includes(k)), dupKeys.join(','));

console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
process.exit(fail === 0 ? 0 : 1);
