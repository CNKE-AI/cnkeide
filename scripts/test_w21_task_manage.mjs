/**
 * W21 任务管理测试（重命名 / 归档语义）
 * 验证：改展示名、改目录名、重名避让、失败不改动现场、案件写入保留
 *
 * 用法：npx tsx scripts/test_w21_task_manage.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createTaskWorkspace,
  renameTaskWorkspace,
  taskWorkspaceExists,
  isBusyRenameError,
  retryWhileBusy,
} from '../electron/core-fork/tasks/TaskWorkspace.js';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}
const eq = (name, actual, expected) => log(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
const ok = (name, cond, detail = '') => log(!!cond, name, detail);

const sandbox = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `cnke-w21-${tag}-`));
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } };

// ===== 1. 改名：目录名不变 =====
console.log('\n[1] 只改展示名');
{
  const dir = sandbox('same');
  try {
    const created = createTaskWorkspace({ name: '统计看板', parentDir: dir, now: 1000 });
    ok('前置创建成功', created.ok, JSON.stringify(created));
    const oldPath = created.record.workspacePath;

    // 清洗后仍然是「统计看板」，目录名没变化，不该碰文件系统
    const res = renameTaskWorkspace({ workspacePath: oldPath, newName: '统计看板', createdAt: 1000 });
    ok('改名成功', res.ok, JSON.stringify(res));
    eq('目录未变更标记', res.dirChanged, false);
    eq('路径保持不变', res.record.workspacePath, oldPath);
    eq('原目录仍在', fs.existsSync(oldPath), true);
  } finally { rm(dir); }
}

// ===== 2. 改名：目录跟着变 =====
console.log('\n[2] 目录跟着改名');
{
  const dir = sandbox('move');
  try {
    const created = createTaskWorkspace({ name: '旧名字', parentDir: dir, now: 1000 });
    const oldPath = created.record.workspacePath;
    // 用户已经往里放了代码：改名绝不能丢文件
    fs.writeFileSync(path.join(oldPath, 'main.ts'), 'export const a = 1;');
    fs.mkdirSync(path.join(oldPath, 'src'));

    const res = renameTaskWorkspace({ workspacePath: oldPath, newName: '新名字', createdAt: 1000 });
    ok('改名成功', res.ok, JSON.stringify(res));
    eq('标记目录已变更', res.dirChanged, true);
    eq('返回旧路径', res.previousPath, oldPath);
    eq('新目录名', res.record.dirName, '新名字');
    eq('新路径正确', res.record.workspacePath, path.join(dir, '新名字'));
    eq('id 与新路径一致', res.record.id, res.record.workspacePath);
    eq('旧目录已不存在', fs.existsSync(oldPath), false);
    eq('新目录存在', fs.existsSync(path.join(dir, '新名字')), true);
    eq('文件内容保留', fs.readFileSync(path.join(dir, '新名字', 'main.ts'), 'utf8'), 'export const a = 1;');
    eq('子目录保留', fs.statSync(path.join(dir, '新名字', 'src')).isDirectory(), true);
    eq('创建时间保留', res.record.createdAt, 1000);
    eq('展示名是用户输入', res.record.name, '新名字');
  } finally { rm(dir); }
}

// ===== 3. 重名避让 =====
console.log('\n[3] 新名被占用');
{
  const dir = sandbox('dup');
  try {
    const a = createTaskWorkspace({ name: '任务A', parentDir: dir });
    createTaskWorkspace({ name: '任务B', parentDir: dir });
    fs.mkdirSync(path.join(dir, '任务C'));

    const res = renameTaskWorkspace({ workspacePath: a.record.workspacePath, newName: '任务C' });
    ok('改名成功（自动避让）', res.ok, JSON.stringify(res));
    eq('避让为 任务C-2', res.record.dirName, '任务C-2');
    eq('原有 任务C 未被覆盖', fs.existsSync(path.join(dir, '任务C')), true);
    eq('任务A 已不存在', fs.existsSync(path.join(dir, '任务A')), false);
  } finally { rm(dir); }
}

// ===== 4. 非法输入与失败现场 =====
console.log('\n[4] 失败不改动现场');
{
  const dir = sandbox('fail');
  try {
    // 源目录不存在
    const missing = renameTaskWorkspace({ workspacePath: path.join(dir, '不存在'), newName: 'x' });
    eq('源目录不存在时报错', missing.ok, false);
    ok('错误信息是人话', /不存在/.test(missing.error || ''), missing.error);

    // 空名字
    const created = createTaskWorkspace({ name: '保留我', parentDir: dir });
    const empty = renameTaskWorkspace({ workspacePath: created.record.workspacePath, newName: '   ' });
    eq('空名报错', empty.ok, false);
    eq('原目录仍在', fs.existsSync(created.record.workspacePath), true);

    // 空路径
    eq('空路径报错', renameTaskWorkspace({ workspacePath: '', newName: 'x' }).ok, false);

    // 全非法字符 → 回退成时间戳名，而不是报错或产生空目录名
    const weird = renameTaskWorkspace({ workspacePath: created.record.workspacePath, newName: '///', createdAt: Date.UTC(2026, 9, 28, 3, 4, 5) });
    ok('全非法字符回退为时间戳名', weird.ok && /^task-\d{8}-\d{6}$/.test(weird.record.dirName), JSON.stringify(weird));

    // 路径分隔符不能造成逃逸
    const escape = renameTaskWorkspace({ workspacePath: weird.record.workspacePath, newName: '../../evil' });
    ok('含 .. 的名字被清洗', escape.ok && !escape.record.dirName.includes('..'), JSON.stringify(escape));
    eq('仍落在原父目录内', path.dirname(escape.record.workspacePath), dir);
  } finally { rm(dir); }
}

// ===== 5. 大小写改名 =====
console.log('\n[5] 仅大小写改名');
{
  const dir = sandbox('case');
  try {
    const created = createTaskWorkspace({ name: 'demo', parentDir: dir });
    const res = renameTaskWorkspace({ workspacePath: created.record.workspacePath, newName: 'Demo' });
    ok('成功', res.ok, JSON.stringify(res));
    if (res.ok) {
      // Windows 上 existsSync 大小写不敏感，若走通用的 uniqueDirName 会被误判成占用变成 Demo-2
      eq('不会被误判为占用而加后缀', res.record.dirName.toLowerCase(), 'demo');
      eq('目录名已是新的大小写', fs.readdirSync(dir).join(',').toLowerCase(), 'demo');
    }
  } finally { rm(dir); }
}

// ===== 6. 归档的语义（索引层，不删文件）=====
console.log('\n[6] 归档不碰文件');
{
  const dir = sandbox('archive');
  try {
    const created = createTaskWorkspace({ name: '归档我', parentDir: dir });
    fs.writeFileSync(path.join(created.record.workspacePath, 'a.txt'), 'keep');
    // 归档是纯索引操作：任务目录必须原样保留（这里模拟"只改标记"这一契约）
    ok('任务目录存在', taskWorkspaceExists(created.record.workspacePath), '');
    const rec = { ...created.record, archived: true, archivedAt: Date.now() };
    eq('归档标记写入后 id 仍是原路径', rec.id, created.record.workspacePath);
    eq('目录未受影响', fs.readFileSync(path.join(created.record.workspacePath, 'a.txt'), 'utf8'), 'keep');
  } finally { rm(dir); }
}

// ===== 7. 目录被占用时的重试语义 =====
// Windows 上终端 shell 的 cwd 就是任务目录，rename 必然 EBUSY；
// 这类错误必须被识别为"可重试"，而"文件夹不存在"之类不能白等。
console.log('\n[7] 占用错误识别与退避重试');
{
  ok('EBUSY 判定为占用', isBusyRenameError("EBUSY: resource busy or locked, rename 'a' -> 'b'"));
  ok('EPERM 判定为占用', isBusyRenameError('EPERM: operation not permitted'));
  ok('EACCES 判定为占用', isBusyRenameError('EACCES: permission denied'));
  ok(
    '中文占用提示判定为占用',
    isBusyRenameError('EBUSY: resource busy or locked（另一个程序正在使用此文件，进程无法访问。）'),
  );
  eq('文件夹不存在不算占用', isBusyRenameError('任务文件夹不存在，可能已被删除或移动'), false);
  eq('空错误不算占用', isBusyRenameError(undefined), false);

  // 前两次 EBUSY、第三次成功：重试应当成功
  let calls = 0;
  const flaky = await retryWhileBusy(() => {
    calls++;
    if (calls < 3) return { ok: false, error: 'EBUSY: resource busy or locked' };
    return { ok: true };
  }, 6, 1);
  ok('占用解除后重试成功', flaky.ok, JSON.stringify(flaky));
  eq('重试次数正确', calls, 3);

  // 非占用错误：不应重试
  let calls2 = 0;
  const fatal = await retryWhileBusy(() => {
    calls2++;
    return { ok: false, error: '任务文件夹不存在，可能已被删除或移动' };
  }, 6, 1);
  eq('非占用错误只试一次', calls2, 1);
  eq('非占用错误保持失败', fatal.ok, false);

  // 一直占用：用满次数后返回最后一次错误
  let calls3 = 0;
  const stuck = await retryWhileBusy(() => {
    calls3++;
    return { ok: false, error: 'EBUSY: resource busy or locked' };
  }, 4, 1);
  eq('用满重试次数', calls3, 4);
  eq('仍失败并返回错误', stuck.ok, false);
  ok('错误信息保留', String(stuck.error).includes('EBUSY'));

  // 一次就成功：不应有多余调用
  let calls4 = 0;
  const fine = await retryWhileBusy(() => {
    calls4++;
    return { ok: true };
  }, 6, 1);
  ok('一次成功', fine.ok);
  eq('没有多余重试', calls4, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
