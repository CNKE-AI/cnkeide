/**
 * W22 全文搜索测试
 * 验证：字面量/正则匹配、大小写、全词、目录与二进制/大文件跳过、上限与超时保护
 *
 * 用法：npx tsx scripts/test_w22_content_search.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMatcher, looksBinary, searchContent, shouldSkipDir } from '../electron/core-fork/search/ContentSearch.js';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}
const eq = (name, actual, expected) => log(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
const ok = (name, cond, detail = '') => log(!!cond, name, detail);

/** 建一棵小工程：src/ 里两个文件、node_modules 里一个诱饵、一个二进制、一个大文件 */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cnke-w22-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'fake'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'a.ts'),
    ['const target = 1;', 'function run() {', '  return target + 1; // target', '}', ''].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'src', 'b.md'), '# 文档\n这里也提到 target 这个词\n');
  // 诱饵：node_modules 里的命中必须被忽略
  fs.writeFileSync(path.join(root, 'node_modules', 'fake', 'index.js'), 'const target = 999;\n');
  // 二进制：含 NUL
  fs.writeFileSync(path.join(root, 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]));
  // 大文件：超过 maxFileSize 的命中必须被跳过
  fs.writeFileSync(path.join(root, 'big.txt'), 'target\n'.repeat(4000));
  return root;
}
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } };

// ===== 1. 匹配器 =====
console.log('\n[1] buildMatcher');
{
  eq('空串返回 null', buildMatcher('   '), null);
  const lit = buildMatcher('a.b(');
  ok('字面量模式转义特殊字符', lit && lit.test('x a.b( y'), String(lit));
  ok('不会把点当通配符', buildMatcher('a.b').test('axb') === false, '');
  eq('非法正则返回 null', buildMatcher('([', { regex: true }), null);
  ok('正则模式生效', buildMatcher('t\\w+get', { regex: true }).test('target'), '');
  ok('全词匹配拒绝子串', buildMatcher('get', { wholeWord: true }).test('target') === false, '');
  ok('全词匹配接受独立词', buildMatcher('get', { wholeWord: true }).test('a get b'), '');
  ok('默认大小写不敏感', buildMatcher('TARGET').test('target'), '');
  ok('可开启大小写敏感', buildMatcher('TARGET', { caseSensitive: true }).test('target') === false, '');
}

// ===== 2. 目录/二进制判定 =====
console.log('\n[2] 跳过规则');
{
  ok('node_modules 被跳过', shouldSkipDir('node_modules'), '');
  ok('.git 被跳过', shouldSkipDir('.git'), '');
  ok('大小写不敏感', shouldSkipDir('NODE_MODULES'), '');
  ok('src 不跳过', shouldSkipDir('src') === false, '');
  ok('含 NUL 判定为二进制', looksBinary(Buffer.from([0x61, 0x00, 0x62])), '');
  ok('纯文本不判为二进制', looksBinary(Buffer.from('hello 世界')) === false, '');
}

// ===== 3. 基本搜索 =====
console.log('\n[3] searchContent');
{
  const root = makeProject();
  try {
    const res = await searchContent(root, 'target', { maxFileSize: 1024 });
    ok('无错误', !res.error, res.error);
    // a.ts 三处 + b.md 一处 = 4；node_modules 与 big.txt 都不算
    eq('命中数正确', res.matches.length, 4);
    eq('未截断', res.truncated, false);
    eq('跳过了大文件', res.skippedLarge, 1);
    ok('扫描过文件', res.filesScanned >= 2, String(res.filesScanned));

    const first = res.matches[0];
    eq('相对路径用 / 分隔', first.relativePath, 'src/a.ts');
    eq('行号从 1 开始', first.line, 1);
    eq('列号从 1 开始', first.column, 7);
    eq('返回该行原文', first.text, 'const target = 1;');
    ok('绝对路径可定位文件', fs.existsSync(first.file), first.file);

    // node_modules 里的 999 不能出现在结果里
    ok('未命中 node_modules', !res.matches.some((m) => m.relativePath.includes('node_modules')), JSON.stringify(res.matches));
    // 二进制文件不产生命中
    ok('未命中二进制文件', !res.matches.some((m) => m.relativePath.endsWith('.bin')), '');

    // 同一行多处命中会产出多条（列号不同）
    const sameLine = res.matches.filter((m) => m.relativePath === 'src/a.ts' && m.line === 3);
    eq('同一行两处命中各记一条', sameLine.length, 2);
    ok('列号递增', sameLine[0].column < sameLine[1].column, JSON.stringify(sameLine.map((m) => m.column)));
  } finally { rm(root); }
}

// ===== 4. 选项 =====
console.log('\n[4] 大小写 / 全词 / 正则');
{
  const root = makeProject();
  try {
    const ci = await searchContent(root, 'TARGET', { maxFileSize: 1024 });
    ok('默认不区分大小写', ci.matches.length > 0, '');

    const cs = await searchContent(root, 'TARGET', { caseSensitive: true, maxFileSize: 1024 });
    eq('区分大小写时无命中', cs.matches.length, 0);
    ok('即使无命中也会报告扫描数', cs.filesScanned > 0, String(cs.filesScanned));

    const ww = await searchContent(root, 'targe', { wholeWord: true, maxFileSize: 1024 });
    eq('全词匹配不含子串', ww.matches.length, 0);

    const re = await searchContent(root, 'const\\s+\\w+', { regex: true, maxFileSize: 1024 });
    ok('正则匹配可用', re.matches.length > 0, '');
    eq('正则命中第一行整段', re.matches[0].text, 'const target = 1;');
  } finally { rm(root); }
}

// ===== 5. 上限与边界 =====
console.log('\n[5] 上限与边界');
{
  const root = makeProject();
  try {
    const capped = await searchContent(root, 'target', { maxFileSize: 1024, maxResults: 2 });
    eq('命中数被限制', capped.matches.length, 2);
    eq('标记为已截断', capped.truncated, true);

    const none = await searchContent(root, '绝不存在的字符串xyz', { maxFileSize: 1024 });
    eq('无命中时结果为空', none.matches.length, 0);
    eq('无命中不标记截断', none.truncated, false);

    eq('空查询报错', (await searchContent(root, '  ')).error, '请输入搜索内容');
    eq('空路径报错', (await searchContent('', 'x')).error, '未打开工作区');
    eq('路径不存在报错', (await searchContent(path.join(root, 'nope'), 'x')).error, '工作区目录不存在');
    eq('文件当根目录报错', (await searchContent(path.join(root, 'src', 'a.ts'), 'x')).error, '工作区不是文件夹');

    // 超小预算：要么拿到结果，要么被标记超时，但绝不能挂住
    const fast = await searchContent(root, 'e', { maxFileSize: 1024, maxDurationMs: 0 });
    ok('耗时预算耗尽时正常返回', typeof fast.timedOut === 'boolean', '');
  } finally { rm(root); }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
