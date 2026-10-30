/**
 * W19 任务工作区测试
 * 验证：1) 任务名清洗（非法字符/空白/首尾点/超长/空名/保留名/控制字符）
 *       2) 重名避让（-2/-3）  3) 新建只建空目录、不写标记文件
 *       4) 父目录自动创建  5) 失败回滚不留残留  6) 路径逃逸防护
 *
 * 用法：npx tsx scripts/test_w19_task_workspace.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTaskWorkspace, sanitizeTaskName, taskWorkspaceExists, uniqueDirName, TASK_DIR_MAX_LEN,
} from '../electron/core-fork/tasks/TaskWorkspace.js';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}
const eq = (name, actual, expected) => log(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

/** 每个用例一个干净沙箱，避免相互影响 */
function sandbox(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cnke-w19-${tag}-`));
  return dir;
}
function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ===== 1. 命名清洗 =====
console.log('\n[1] sanitizeTaskName');
eq('中文原样保留', sanitizeTaskName('统计看板导出'), '统计看板导出');
eq('英文与数字原样保留', sanitizeTaskName('api-v2 导出'), 'api-v2-导出');
eq('非法字符替换为连字符', sanitizeTaskName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
eq('空白折叠为单个连字符', sanitizeTaskName('foo   bar\t\tbaz'), 'foo-bar-baz');
eq('换行等控制字符被清理', sanitizeTaskName('a\nb\u0000c'), 'a-b-c');
eq('首尾的点与连字符被去掉', sanitizeTaskName('...名字...'), '名字');
eq('首尾空白被去掉', sanitizeTaskName('   任务   '), '任务');
eq('全非法字符回退为时间戳名', /^task-\d{8}-\d{6}$/.test(sanitizeTaskName('///***', Date.UTC(2026, 9, 28, 3, 4, 5))), true);
eq('空字符串回退为时间戳名', /^task-\d{8}-\d{6}$/.test(sanitizeTaskName('', Date.now())), true);
eq('超长名被截断', sanitizeTaskName('あ'.repeat(120)).length, TASK_DIR_MAX_LEN);
eq('截断后不以连字符结尾', sanitizeTaskName('a'.repeat(TASK_DIR_MAX_LEN - 1) + '-b'), 'a'.repeat(TASK_DIR_MAX_LEN - 1));
eq('Windows 保留名 CON 加前缀', sanitizeTaskName('CON'), 'task-CON');
eq('保留名大小写不敏感', sanitizeTaskName('com1'), 'task-com1');
eq('非保留名不加前缀', sanitizeTaskName('console'), 'console');
eq('emoji 保留', sanitizeTaskName('看板📊'), '看板📊');
eq('重复连字符合并', sanitizeTaskName('a - - b'), 'a-b');

// ===== 2. 重名避让 =====
console.log('\n[2] uniqueDirName');
{
  const dir = sandbox('unique');
  try {
    eq('无冲突时原样返回', uniqueDirName('任务', dir), '任务');
    fs.mkdirSync(path.join(dir, '任务'));
    eq('冲突时追加 -2', uniqueDirName('任务', dir), '任务-2');
    fs.mkdirSync(path.join(dir, '任务-2'));
    fs.mkdirSync(path.join(dir, '任务-3'));
    eq('连续冲突时跳到 -4', uniqueDirName('任务', dir), '任务-4');
  } finally { rm(dir); }
}

// ===== 3. 新建工作区 =====
console.log('\n[3] createTaskWorkspace');
{
  const dir = sandbox('create');
  try {
    const parent = path.join(dir, 'CnkeIDE');
    const r = createTaskWorkspace({ name: '统计看板导出', parentDir: parent, now: 1000 });
    log(r.ok, '创建成功', JSON.stringify(r));
    eq('id 即工作区绝对路径', r.record.id, r.record.workspacePath);
    eq('目录名为清洗后的任务名', r.record.dirName, '统计看板导出');
    eq('工作区路径 = 父目录 + 目录名', r.record.workspacePath, path.join(parent, '统计看板导出'));
    eq('父目录被自动创建', fs.existsSync(parent), true);
    eq('工作区目录已存在', fs.statSync(r.record.workspacePath).isDirectory(), true);
    eq('只建空目录、不写标记文件', fs.readdirSync(r.record.workspacePath).length, 0);
    eq('展示名保留用户输入', r.record.name, '统计看板导出');
    eq('createdAt 采用传入时间', r.record.createdAt, 1000);
    eq('taskWorkspaceExists 为 true', taskWorkspaceExists(r.record.workspacePath), true);

    // 同名再建：绝不覆盖，另建 -2
    const r2 = createTaskWorkspace({ name: '统计看板导出', parentDir: parent, now: 2000 });
    log(r2.ok, '同名任务仍可创建（避让）', JSON.stringify(r2));
    eq('同名避让为 -2', r2.record.dirName, '统计看板导出-2');
    log(r2.record.id !== r.record.id, '两次创建路径不同', `${r.record.id} vs ${r2.record.id}`);
    eq('原目录未被覆盖（仍为空）', fs.readdirSync(r.record.workspacePath).length, 0);

    // 用户往目录里放了文件后，再建同名任务也不该动它
    fs.writeFileSync(path.join(r.record.workspacePath, 'main.ts'), 'export {}');
    const r3 = createTaskWorkspace({ name: '统计看板导出', parentDir: parent, now: 3000 });
    eq('第三次避让为 -3', r3.record.dirName, '统计看板导出-3');
    eq('已有目录里的文件未被触碰', fs.readFileSync(path.join(r.record.workspacePath, 'main.ts'), 'utf8'), 'export {}');

    // 多级父目录
    const deep = path.join(dir, 'a', 'b', 'c');
    const r4 = createTaskWorkspace({ name: 'deep', parentDir: deep });
    log(r4.ok && fs.existsSync(r4.record.workspacePath), '多级父目录可自动创建', JSON.stringify(r4));
  } finally { rm(dir); }
}

// ===== 4. 路径逃逸防护 =====
console.log('\n[4] 路径逃逸防护');
{
  const dir = sandbox('escape');
  try {
    const parent = path.join(dir, 'root');
    const r = createTaskWorkspace({ name: '../../evil', parentDir: parent });
    log(r.ok, '含 .. 的名字仍能创建', JSON.stringify(r));
    eq('工作区落在父目录内', path.dirname(r.record.workspacePath), parent);
    eq('.. 被清洗掉', r.record.dirName.includes('..'), false);
    eq('父目录之上没有多出目录', fs.readdirSync(dir).sort().join(','), 'root');
  } finally { rm(dir); }
}

// ===== 5. 失败与回滚 =====
console.log('\n[5] 失败与回滚');
{
  const dir = sandbox('fail');
  try {
    // 父路径是一个文件 → 必须报错且不留残留
    const filePath = path.join(dir, 'not-a-dir');
    fs.writeFileSync(filePath, 'x');
    const r = createTaskWorkspace({ name: '任务', parentDir: filePath });
    eq('父路径是文件时报错', r.ok, false);
    log(!!r.error, '错误信息非空', r.error);
    eq('未留下任何残留目录', fs.readdirSync(dir).join(','), 'not-a-dir');
    eq('原文件未被破坏', fs.readFileSync(filePath, 'utf8'), 'x');

    // 空父目录参数
    const r2 = createTaskWorkspace({ name: '任务', parentDir: '   ' });
    eq('父目录为空时报错', r2.ok, false);

    // 目录不存在时 exists 判定
    eq('taskWorkspaceExists 对不存在的路径为 false', taskWorkspaceExists(path.join(dir, 'nope')), false);
    eq('taskWorkspaceExists 对文件为 false', taskWorkspaceExists(filePath), false);
    eq('taskWorkspaceExists 对空串为 false', taskWorkspaceExists(''), false);
  } finally { rm(dir); }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
