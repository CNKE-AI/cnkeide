/**
 * W4 缺失工具补齐测试
 * 验证：1) web_fetch HTML→文本  2) grep Node 兜底 / glob / ignoreCase
 *        3) detectTestFramework  4) detectFormatter  5) ToolManager 注册
 *        6) 并发策略注册
 *
 * 用法：npx tsx scripts/test_w4_tools.mjs
 */
import { ToolManager } from '../electron/core-fork/tools/ToolManager.js';
import { webFetch } from '../electron/core-fork/tools/WebTools.js';
import { grep } from '../electron/core-fork/tools/GrepTool.js';
import { detectFormatter } from '../electron/core-fork/tools/CodeFormatter.js';
import { detectTestFramework } from '../electron/core-fork/tools/TestRunner.js';
import { DEFAULT_TOOL_POLICIES } from '../electron/core-fork/tools/ParallelToolScheduler.js';
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

async function test1_webFetchExample() {
  console.log('\n[1] web_fetch 抓 example.com');
  const r = await webFetch('https://example.com/', { maxBytes: 50000 });
  if (r.success && r.result) {
    log(/Example Domain/.test(r.result.text), '含 Example Domain', `out=${r.result.text.slice(0, 100)}`);
    log(r.result.status === 200, '200 OK', `status=${r.result.status}`);
    log(!/<script|<\/script>/i.test(r.result.text), '去除了 script 标签', '');
  } else {
    // 如果是离线环境，跳过而非 fail
    console.log('  SKIP  离线环境跳过网络测试');
  }
}

async function test2_webFetchInvalidUrl() {
  console.log('\n[2] web_fetch 拒绝非法 URL');
  const r1 = await webFetch('file:///etc/passwd');
  log(r1.success === false, '拒绝 file://', `err=${r1.error}`);
  const r2 = await webFetch('not-a-url');
  log(r2.success === false, '拒绝非法 URL', `err=${r2.error}`);
}

async function test3_grepNodeFallback() {
  console.log('\n[3] grep Node 兜底（搜索 2 个匹配 + 跳过 node_modules）');
  const dir = await tmpDir('w4-grep-');
  try {
    await fs.writeFile(path.join(dir, 'a.ts'), 'const foo = 1;\nconst bar = 2;\nfunction baz() { return foo + bar; }');
    await fs.writeFile(path.join(dir, 'b.ts'), 'const qux = 3;\nfunction baz() { return qux; }');
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'node_modules', 'skip.js'), 'const foo = "ignored"');

    const r = await grep({ path: dir, pattern: 'baz', maxResults: 50 });
    log(r.success === true, '搜索成功', `err=${r.error}`);
    log(r.matches.length === 2, '找到 2 处（node_modules 跳过）', `n=${r.matches.length}`);
    const paths = r.matches.map((m) => path.basename(m.file));
    log(!paths.includes('skip.js'), 'node_modules 跳过', `paths=${paths.join(',')}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function test4_grepGlob() {
  console.log('\n[4] grep glob 过滤');
  const dir = await tmpDir('w4-grep-glob-');
  try {
    await fs.writeFile(path.join(dir, 'a.ts'), 'let target = 1;');
    await fs.writeFile(path.join(dir, 'b.js'), 'let target = 2;');
    const r = await grep({ path: dir, pattern: 'target', glob: ['*.ts'], maxResults: 50 });
    log(r.success, '搜索成功', '');
    log(r.matches.length === 1 && r.matches[0].file.endsWith('a.ts'), '只匹配 .ts', `n=${r.matches.length}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function test5_grepIgnoreCase() {
  console.log('\n[5] grep ignoreCase');
  const dir = await tmpDir('w4-grep-case-');
  try {
    await fs.writeFile(path.join(dir, 'x.ts'), 'const FOO = 1;\nconst foo = 2;');
    const r1 = await grep({ path: dir, pattern: 'foo', ignoreCase: false, maxResults: 50 });
    const r2 = await grep({ path: dir, pattern: 'foo', ignoreCase: true, maxResults: 50 });
    log(r1.matches.length === 1, 'case sensitive: 1 条', `n=${r1.matches.length}`);
    log(r2.matches.length === 2, 'case insensitive: 2 条', `n=${r2.matches.length}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function test6_grepNoMatch() {
  console.log('\n[6] grep 无匹配返回空数组（不是错误）');
  const dir = await tmpDir('w4-grep-empty-');
  try {
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello');
    const r = await grep({ path: dir, pattern: 'xxxxnotfoundxxxx' });
    log(r.success === true && r.matches.length === 0, '无匹配', `n=${r.matches.length}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function test7_detectTestFramework() {
  console.log('\n[7] detectTestFramework');
  const dir1 = await tmpDir('w7-npm-');
  try {
    await fs.writeFile(path.join(dir1, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    const r = await detectTestFramework(dir1);
    log(r.framework === 'npm', 'npm detected', `f=${r.framework}`);
    log(r.command === 'npm test', 'command correct', `c=${r.command}`);
  } finally {
    await fs.rm(dir1, { recursive: true, force: true });
  }

  const dir2 = await tmpDir('w7-pnpm-');
  try {
    await fs.writeFile(path.join(dir2, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    await fs.writeFile(path.join(dir2, 'pnpm-lock.yaml'), '');
    const r = await detectTestFramework(dir2);
    log(r.framework === 'pnpm', 'pnpm detected', `f=${r.framework}`);
  } finally {
    await fs.rm(dir2, { recursive: true, force: true });
  }

  const dir3 = await tmpDir('w7-py-');
  try {
    await fs.writeFile(path.join(dir3, 'pyproject.toml'), '[tool.pytest]');
    const r = await detectTestFramework(dir3);
    log(r.framework === 'pytest', 'pytest detected', `f=${r.framework}`);
  } finally {
    await fs.rm(dir3, { recursive: true, force: true });
  }

  const dir4 = await tmpDir('w7-unknown-');
  try {
    const r = await detectTestFramework(dir4);
    log(r.framework === 'unknown', 'unknown when no signal', `f=${r.framework}`);
  } finally {
    await fs.rm(dir4, { recursive: true, force: true });
  }
}

async function test8_formatDetector() {
  console.log('\n[8] detectFormatter');
  const dir = await tmpDir('w8-fmt-');
  try {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { prettier: '^3.0.0' } }));
    const r = await detectFormatter(dir, path.join(dir, 'a.ts'));
    log(r === 'prettier', 'prettier detected', `fmt=${r}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  const dir2 = await tmpDir('w8-py-');
  try {
    const r = await detectFormatter(dir2, path.join(dir2, 'a.py'));
    log(r === 'black', 'black for .py', `fmt=${r}`);
  } finally {
    await fs.rm(dir2, { recursive: true, force: true });
  }
}

async function test9_toolRegistration() {
  console.log('\n[9] ToolManager 注册 9 个新工具');
  const tm = Object.create(ToolManager.prototype);
  tm.fsAdapter = null;
  tm.terminalAdapter = null;
  tm.mcpHub = null;
  tm.checkpointManager = null;
  tm.codebaseIndexer = null;
  tm.sessionId = null;
  tm.workspaceId = null;
  tm.modifiedFiles = new Set();
  const tools = await tm.getAvailableTools('coder');
  const names = new Set(tools.map((t) => t.name));
  for (const n of ['web_search', 'web_fetch', 'git_status', 'git_diff', 'git_commit', 'git_log', 'grep', 'run_tests', 'format_code']) {
    log(names.has(n), `已注册: ${n}`, '');
  }
}

async function test10_concurrencyPolicies() {
  console.log('\n[10] 并发策略注册');
  log(DEFAULT_TOOL_POLICIES.web_search === 'safe', 'web_search safe', `p=${DEFAULT_TOOL_POLICIES.web_search}`);
  log(DEFAULT_TOOL_POLICIES.web_fetch === 'safe', 'web_fetch safe', '');
  log(DEFAULT_TOOL_POLICIES.grep === 'safe', 'grep safe', '');
  log(DEFAULT_TOOL_POLICIES.git_status === 'safe', 'git_status safe', '');
  log(DEFAULT_TOOL_POLICIES.git_diff === 'safe', 'git_diff safe', '');
  log(DEFAULT_TOOL_POLICIES.git_commit === 'global-serial', 'git_commit serial', '');
  log(DEFAULT_TOOL_POLICIES.run_tests === 'global-serial', 'run_tests serial', '');
  log(DEFAULT_TOOL_POLICIES.format_code === 'path-serial', 'format_code path-serial', '');
}

(async () => {
  console.log('=== W4 缺失工具补齐测试 ===');
  await test1_webFetchExample();
  await test2_webFetchInvalidUrl();
  await test3_grepNodeFallback();
  await test4_grepGlob();
  await test5_grepIgnoreCase();
  await test6_grepNoMatch();
  await test7_detectTestFramework();
  await test8_formatDetector();
  await test9_toolRegistration();
  await test10_concurrencyPolicies();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
