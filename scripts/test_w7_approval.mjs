/**
 * W7 Checkpoint + Approval 测试
 * 验证：1) computeFileDiff 各种状态  2) generateUnifiedDiff  3) ApprovalPolicy 规则匹配
 *        4) globMatch 路径匹配  5) 规则添加/删除/列出
 *
 * 用法：npx tsx scripts/test_w7_approval.mjs
 */
import {
  computeFileDiff,
  generateUnifiedDiff,
} from '../electron/core-fork/checkpoint/CheckpointManager.js';
import {
  ApprovalPolicy,
  globMatch,
} from '../electron/core-fork/checkpoint/ApprovalPolicy.js';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

// ===== Checkpoint / diff =====
function test1_fileAdded() {
  console.log('\n[1] computeFileDiff 新增文件');
  const d = computeFileDiff('/a.ts', null, 'line1\nline2\nline3');
  log(d.status === 'added', 'status=added', `s=${d.status}`);
  log(d.before === null, 'before=null', '');
  log(d.after === 'line1\nline2\nline3', 'after 正确', '');
  log(d.additions === 3 && d.deletions === 0, '+3/-0', `+${d.additions}/-${d.deletions}`);
  log(d.unifiedDiff.startsWith('+'), 'diff 以 + 开头', '');
}

function test2_fileDeleted() {
  console.log('\n[2] computeFileDiff 删除文件');
  const d = computeFileDiff('/a.ts', 'line1\nline2', null);
  log(d.status === 'deleted', 'status=deleted', `s=${d.status}`);
  log(d.after === null, 'after=null', '');
  log(d.deletions === 2, '-2', `deletions=${d.deletions}`);
}

function test3_fileModified() {
  console.log('\n[3] computeFileDiff 修改文件');
  const before = 'line1\nline2\nline3';
  const after = 'line1\nmodified\nline3';
  const d = computeFileDiff('/a.ts', before, after);
  log(d.status === 'modified', 'status=modified', `s=${d.status}`);
  log(d.additions === 1 && d.deletions === 1, '+1/-1', `+${d.additions}/-${d.deletions}`);
  log(d.unifiedDiff.includes('---') && d.unifiedDiff.includes('+++'), '含文件头', '');
  log(d.unifiedDiff.includes('@@'), '含 hunk 头', '');
  log(d.unifiedDiff.includes('-line2'), '删除行', '');
  log(d.unifiedDiff.includes('+modified'), '新增行', '');
}

function test4_unchanged() {
  console.log('\n[4] computeFileDiff 未变更');
  const d = computeFileDiff('/a.ts', 'same\n', 'same\n');
  log(d.status === 'unchanged', 'status=unchanged', `s=${d.status}`);
  log(d.additions === 0 && d.deletions === 0, '+0/-0', '');
}

function test5_unifiedDiffFormat() {
  console.log('\n[5] generateUnifiedDiff 输出格式');
  const u = generateUnifiedDiff('/a.ts', 'a\nb\nc\nd\ne', 'a\nB\nc\nd\nE');
  log(/^---\s+\/a\.ts/m.test(u), '含 --- file', '');
  log(/^\+\+\+\s+\/a\.ts/m.test(u), '含 +++ file', '');
  log(/^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@/m.test(u), '含 hunk header', '');
  log(u.split('\n').some((l) => l === '-b'), '删除 b 行', '');
  log(u.split('\n').some((l) => l === '+B'), '新增 B 行', '');
  log(u.split('\n').some((l) => l === '-e'), '删除 e 行', '');
  log(u.split('\n').some((l) => l === '+E'), '新增 E 行', '');
}

function test6_diffWithContext() {
  console.log('\n[6] diff 上下文行');
  // 修改第 3 行
  const before = 'a\nb\nc\nd\ne';
  const after = 'a\nb\nC\nd\ne';
  const u = generateUnifiedDiff('/x', before, after, 2);
  const hunkHeader = u.split('\n').find((l) => l.startsWith('@@'));
  log(/^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@$/.test(hunkHeader || ''), 'hunk 头格式正确', hunkHeader);
  // 修改行 -c / +C 应同时存在
  log(u.split('\n').includes('-c'), '删 c', '');
  log(u.split('\n').includes('+C'), '增 C', '');
  // 上下文行 a, b, d, e 存在（带空格前缀）
  log(u.split('\n').some((l) => l === ' a'), '上下文 a', '');
}

// ===== Approval Policy =====
function test7_globMatch() {
  console.log('\n[7] globMatch 路径匹配');
  log(globMatch('**/src/**', '/proj/src/a.ts') === true, '**/src/**', '');
  log(globMatch('**/src/**', '/proj/lib/a.ts') === false, '不匹配非 src', '');
  log(globMatch('*.ts', 'a.ts') === true, '*.ts 匹配 a.ts', '');
  log(globMatch('*.ts', 'a.js') === false, '*.ts 不匹配 a.js', '');
  log(globMatch('/proj/src/*', '/proj/src/a.ts') === true, '单层 *', '');
  log(globMatch('/proj/src/*', '/proj/src/sub/a.ts') === false, '* 不跨层', '');
  log(globMatch('**', 'anything.txt') === true, '** 匹配所有', '');
  // 跨平台
  log(globMatch('**/src/**', 'C:\\proj\\src\\a.ts') === true, 'Windows 路径', '');
}

function test8_policyDefaultAsk() {
  console.log('\n[8] 默认无规则 → ask');
  const p = new ApprovalPolicy();
  const d = p.evaluate({ name: 'write_to_file', arguments: { path: '/a.ts' } });
  log(d.action === 'ask', 'action=ask', `a=${d.action}`);
  log(/需要用户确认/.test(d.reason), 'reason 含 ask', d.reason);
}

function test9_policyAllowByTool() {
  console.log('\n[9] 工具级 allow 规则');
  const p = new ApprovalPolicy([
    { toolName: 'read_file', action: 'allow', source: 'always-allow-read' },
  ]);
  log(p.evaluate({ name: 'read_file', arguments: { path: '/a.ts' } }).action === 'allow', 'read_file 命中 allow', '');
  log(p.evaluate({ name: 'write_to_file', arguments: { path: '/a.ts' } }).action === 'ask', 'write_to_file 默认 ask', '');
}

function test10_policyPathPattern() {
  console.log('\n[10] 路径模式匹配');
  const p = new ApprovalPolicy([
    { toolName: 'write_to_file', pathPattern: '**/src/**', action: 'allow', source: 'trust-src' },
  ]);
  const r1 = p.evaluate({ name: 'write_to_file', arguments: { path: '/proj/src/a.ts' } });
  const r2 = p.evaluate({ name: 'write_to_file', arguments: { path: '/proj/lib/a.ts' } });
  log(r1.action === 'allow', '/src/ 允许', `a=${r1.action}`);
  log(r2.action === 'ask', '/lib/ 仍 ask', `a=${r2.action}`);
  log(/trust-src/.test(r1.reason), 'reason 含 source', r1.reason);
}

function test11_policyCommand() {
  console.log('\n[11] 命令子串匹配');
  const p = new ApprovalPolicy([
    { toolName: 'execute_command', commandPattern: 'git status', action: 'allow' },
    { toolName: 'execute_command', commandPattern: 'rm -rf', action: 'deny' },
  ]);
  const r1 = p.evaluate({ name: 'execute_command', arguments: { command: 'git status' } });
  const r2 = p.evaluate({ name: 'execute_command', arguments: { command: 'rm -rf /' } });
  const r3 = p.evaluate({ name: 'execute_command', arguments: { command: 'ls -la' } });
  log(r1.action === 'allow', 'git status allow', `a=${r1.action}`);
  log(r2.action === 'deny', 'rm -rf deny', `a=${r2.action}`);
  log(r3.action === 'ask', '其它 ask', `a=${r3.action}`);
}

function test12_policyDenyFirst() {
  console.log('\n[12] 规则顺序：第一条 deny 优先');
  const p = new ApprovalPolicy([
    { toolName: 'execute_command', commandPattern: 'dangerous', action: 'deny' },
    { toolName: 'execute_command', action: 'allow' },
  ]);
  const r = p.evaluate({ name: 'execute_command', arguments: { command: 'dangerous op' } });
  log(r.action === 'deny', 'deny 优先', `a=${r.action}`);
}

function test13_policyCRUD() {
  console.log('\n[13] 规则增删查');
  const p = new ApprovalPolicy();
  p.add({ toolName: 'write_to_file', action: 'allow' });
  p.add({ toolName: 'execute_command', action: 'ask' });
  log(p.list().length === 2, 'add 后 2 条', `n=${p.list().length}`);
  p.remove(0);
  log(p.list().length === 1, 'remove(0) 后 1 条', `n=${p.list().length}`);
  p.load([
    { toolName: 'x', action: 'allow' },
    { toolName: 'y', action: 'deny' },
  ]);
  log(p.list().length === 2, 'load 覆盖后 2 条', `n=${p.list().length}`);
}

function test14_denyShortcut() {
  console.log('\n[14] deny 短路：工具匹配 deny 后跳过审批');
  const p = new ApprovalPolicy([
    { toolName: 'delete_file', action: 'deny', source: 'never-delete' },
  ]);
  const r = p.evaluate({ name: 'delete_file', arguments: { path: '/a.ts' } });
  log(r.action === 'deny', 'deny 命中', `a=${r.action}`);
}

(async () => {
  console.log('=== W7 Checkpoint + Approval 测试 ===');
  test1_fileAdded();
  test2_fileDeleted();
  test3_fileModified();
  test4_unchanged();
  test5_unifiedDiffFormat();
  test6_diffWithContext();
  test7_globMatch();
  test8_policyDefaultAsk();
  test9_policyAllowByTool();
  test10_policyPathPattern();
  test11_policyCommand();
  test12_policyDenyFirst();
  test13_policyCRUD();
  test14_denyShortcut();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
