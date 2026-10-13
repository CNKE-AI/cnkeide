/**
 * W14 工作区识别修复测试
 *
 * 背景：模型天然输出相对路径（src/index.ts / "." / "src"），而 fsAdapter 只认绝对路径，
 *       相对路径直接透传必然 ENOENT，表现为「Agent 识别不了工作区」。
 * 修复：1) ToolManager.resolvePath() 以工作区根目录为基准解析相对路径
 *       2) AgentManager.buildWorkspaceInfo() 把工作区根目录显式写进系统提示词
 *
 * 用法：npx tsx scripts/test_w14_workspace.mjs
 */
import { ToolManager } from '../electron/core-fork/tools/ToolManager.js';
import { FileSystemAdapter } from '../electron/adapter/FileSystemAdapter.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 构造一个只装了 fsAdapter + workspaceId 的 ToolManager（避免依赖 mcpHub 等） */
function makeTM(workspaceId) {
  const tm = Object.create(ToolManager.prototype);
  tm.fsAdapter = new FileSystemAdapter();
  tm.terminalAdapter = {
    exec: async (cmd, cwd) => ({ success: true, stdout: `cwd=${cwd}` }),
  };
  tm.mcpHub = null;
  tm.checkpointManager = null;
  tm.codebaseIndexer = null;
  tm.ragManager = null;
  tm.planManager = null;
  tm.config = { get: () => undefined };
  tm.sessionId = 'test-session';
  tm.workspaceId = workspaceId;
  tm.modifiedFiles = new Set();
  return tm;
}

// ---------- 1. resolvePath 纯函数语义 ----------
async function test1_resolvePathBasics() {
  console.log('\n[1] resolvePath 路径解析语义');
  const ws = path.join(os.tmpdir(), 'cnke-ws-root');
  const tm = makeTM(ws);

  log(tm.resolvePath('src/index.ts') === path.join(ws, 'src', 'index.ts'),
    '相对路径 → 拼接工作区根', `got=${tm.resolvePath('src/index.ts')}`);

  log(tm.resolvePath('.') === ws, '"." → 工作区根', `got=${tm.resolvePath('.')}`);

  log(tm.resolvePath('./src') === path.join(ws, 'src'),
    '"./src" 去掉前缀后拼接', `got=${tm.resolvePath('./src')}`);

  // 反斜杠风格（模型在 Windows 常犯）
  log(tm.resolvePath('src\\index.ts') === path.join(ws, 'src', 'index.ts'),
    'Windows 反斜杠风格归一化', `got=${tm.resolvePath('src\\index.ts')}`);

  // 已是绝对路径 → 原样返回
  const abs = path.join(ws, 'a.ts');
  log(tm.resolvePath(abs) === abs, '绝对路径原样返回', `got=${tm.resolvePath(abs)}`);

  // 空串 → 回退到工作区根
  log(tm.resolvePath('') === ws, '空路径 → 工作区根', `got=${tm.resolvePath('')}`);

  // Windows 盘符绝对路径识别
  if (process.platform === 'win32') {
    log(tm.resolvePath('C:\\other\\a.ts') === 'C:\\other\\a.ts',
      '盘符绝对路径原样返回', `got=${tm.resolvePath('C:\\other\\a.ts')}`);
  } else {
    log(tm.resolvePath('/etc/hosts') === '/etc/hosts', 'POSIX 绝对路径原样返回', `got=${tm.resolvePath('/etc/hosts')}`);
  }
}

// ---------- 2. 无工作区时的降级 ----------
async function test2_noWorkspace() {
  console.log('\n[2] 无工作区时降级（不抛异常）');
  const tm = makeTM('');
  const r = tm.resolvePath('src/a.ts');
  log(typeof r === 'string', '返回字符串而非抛错', `got=${r}`);
  log(r === 'src/a.ts', '无工作区时原样返回（交由底层报错）', `got=${r}`);
}

// ---------- 3. 端到端：相对路径真的能读到文件 ----------
async function test3_relativePathE2E() {
  console.log('\n[3] 端到端：相对路径 read_file / list_directory / write_to_file');
  const ws = await tmpDir('w14-ws-');
  try {
    await fs.mkdir(path.join(ws, 'src'), { recursive: true });
    await fs.writeFile(path.join(ws, 'src', 'index.ts'), 'export const answer = 42;', 'utf8');
    await fs.writeFile(path.join(ws, 'package.json'), '{"name":"demo"}', 'utf8');

    const tm = makeTM(ws);

    // read_file 用相对路径
    const rf = await tm.execute('read_file', { path: 'src/index.ts' });
    log(rf.success === true, 'read_file("src/index.ts") 成功', `err=${rf.error}`);
    log(String(rf.output).includes('answer = 42'), '读到正确内容', `out=${String(rf.output).slice(0, 60)}`);

    // read_file 用 "." 相对根
    const rf2 = await tm.execute('read_file', { path: './package.json' });
    log(rf2.success === true, 'read_file("./package.json") 成功', `err=${rf2.error}`);

    // list_directory 用 "."
    const ld = await tm.execute('list_directory', { path: '.' });
    log(ld.success === true, 'list_directory(".") 成功', `err=${ld.error}`);
    log(String(ld.output).includes('[目录] src'), '列出 src 目录', `out=${String(ld.output)}`);
    log(String(ld.output).includes('[文件] package.json'), '列出 package.json', `out=${String(ld.output)}`);

    // list_directory 用相对子目录
    const ld2 = await tm.execute('list_directory', { path: 'src' });
    log(ld2.success === true, 'list_directory("src") 成功', `err=${ld2.error}`);
    log(String(ld2.output).includes('index.ts'), '列出 index.ts', `out=${String(ld2.output)}`);

    // write_to_file 用相对路径 —— 关键：不能写到进程 cwd 去
    const wf = await tm.execute('write_to_file', { path: 'src/new.ts', content: 'export {};' });
    log(wf.success === true, 'write_to_file("src/new.ts") 成功', `err=${wf.error}`);
    const written = await fs.readFile(path.join(ws, 'src', 'new.ts'), 'utf8').catch(() => null);
    log(written === 'export {};', '文件确实落在工作区内', `content=${written}`);

    // 反向确认：没被写到进程 cwd
    const strayPath = path.join(process.cwd(), 'src', 'new.ts');
    const stray = await fs.readFile(strayPath, 'utf8').catch(() => null);
    log(stray === null, '没有误写到进程 cwd', `stray=${stray}`);

    // create_file 相对路径
    const cf = await tm.execute('create_file', { path: 'docs/readme.md', content: '# hi' });
    log(cf.success === true, 'create_file("docs/readme.md") 成功', `err=${cf.error}`);
    const created = await fs.readFile(path.join(ws, 'docs', 'readme.md'), 'utf8').catch(() => null);
    log(created === '# hi', '新建文件落在工作区内', `content=${created}`);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
}

// ---------- 4. execute_command 的 cwd 也解析 ----------
async function test4_commandCwd() {
  console.log('\n[4] execute_command 的 cwd 按工作区解析');
  const ws = path.join(os.tmpdir(), 'cnke-ws-cmd');
  const tm = makeTM(ws);

  const r1 = await tm.execute('execute_command', { command: 'dir' });
  log(String(r1.output).includes(`cwd=${ws}`), '无 cwd 时默认工作区根', `out=${r1.output}`);

  const r2 = await tm.execute('execute_command', { command: 'dir', cwd: '.' });
  log(String(r2.output).includes(`cwd=${ws}`), 'cwd="." → 工作区根', `out=${r2.output}`);

  const r3 = await tm.execute('execute_command', { command: 'dir', cwd: 'src' });
  log(String(r3.output).includes(`cwd=${path.join(ws, 'src')}`), 'cwd="src" → 工作区/src', `out=${r3.output}`);
}

// ---------- 5. 错误信息带解析后的路径（便于诊断） ----------
async function test5_errorIncludesResolvedPath() {
  console.log('\n[5] 失败时错误信息包含解析后路径');
  const ws = await tmpDir('w14-err-');
  try {
    const tm = makeTM(ws);
    const r = await tm.execute('read_file', { path: 'not/exist.ts' });
    log(r.success === false, '不存在的文件返回失败', '');
    log(String(r.error).includes(path.join(ws, 'not', 'exist.ts')),
      '错误信息含解析后的绝对路径', `err=${r.error}`);
    log(String(r.error).includes('解析路径'),
      '错误信息带「解析路径」标记', `err=${r.error}`);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
}

// ---------- 6. 系统提示词包含工作区锚点 ----------
async function test6_systemPromptContainsWorkspace() {
  console.log('\n[6] buildWorkspaceInfo 生成工作区锚点');
  const { AgentManager } = await import('../electron/core-fork/agent/AgentManager.js');

  const ws = path.join(os.tmpdir(), 'cnke-ws-prompt');
  const tm = makeTM(ws);
  const fakeMgr = {
    buildWorkspaceInfo: AgentManager.prototype.buildWorkspaceInfo,
  };

  const info = fakeMgr.buildWorkspaceInfo.call({ }, ws);
  log(typeof info === 'string' && info.length > 0, '返回非空字符串', `len=${info?.length}`);
  log(info.includes('[工作区]'), '包含 [工作区] 标记', `info=${info.slice(0, 80)}`);
  log(info.includes(ws), '包含工作区绝对路径', '');
  log(info.includes('相对路径'), '说明相对路径书写规范', '');
  log(info.includes('list_directory'), '引导先看目录结构', '');

  // 无工作区时给出明确提示而不是空白
  const empty = fakeMgr.buildWorkspaceInfo.call({ }, '');
  log(empty.includes('没有打开任何工作区'), '无工作区时明确提示', `info=${empty.slice(0, 80)}`);
  log(!empty.includes(ws), '无工作区时不泄漏旧路径', '');
}

// ---------- 7. 会话上下文设置后解析生效 ----------
async function test7_setSessionContext() {
  console.log('\n[7] setSessionContext 后解析立即生效');
  const ws = path.join(os.tmpdir(), 'cnke-ws-ctx');
  const tm = makeTM('');

  log(tm.resolvePath('a.ts') === 'a.ts', '设置前原样返回', `got=${tm.resolvePath('a.ts')}`);

  tm.setSessionContext('sess-1', ws);
  log(tm.workspaceId === ws, 'setSessionContext 写入 workspaceId', `got=${tm.workspaceId}`);
  log(tm.resolvePath('a.ts') === path.join(ws, 'a.ts'),
    '设置后相对路径基于新工作区解析', `got=${tm.resolvePath('a.ts')}`);
}

async function main() {
  console.log('=== W14 工作区识别修复测试 ===');
  await test1_resolvePathBasics();
  await test2_noWorkspace();
  await test3_relativePathE2E();
  await test4_commandCwd();
  await test5_errorIncludesResolvedPath();
  await test6_systemPromptContainsWorkspace();
  await test7_setSessionContext();
  console.log(`\n=== 结果: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
