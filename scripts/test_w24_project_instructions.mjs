/**
 * W24 仓库级指令文件（AGENTS.md / CNKE.md）测试
 * 验证：1) BOM 剥离  2) 按字节截断（不切坏多字节字符）  3) 提示块拼装
 *       4) 目录层级扫描与跳过规则  5) 单文件/总量预算  6) 空工作区与空文件
 *       7) 模板生成不覆盖  8) 扫描缓存
 *
 * 用法：npx tsx scripts/test_w24_project_instructions.mjs
 */
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  stripBom,
  truncateToBytes,
  buildInstructionBlock,
  scanInstructionFiles,
  loadProjectInstructions,
  createInstructionTemplate,
  invalidateInstructionCache,
  INSTRUCTION_TEMPLATE,
} from '../electron/core-fork/agent/ProjectInstructions.js';

let pass = 0;
let fail = 0;
function log(ok, name, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} :: ${detail}`);
  }
}

async function makeTree(files) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cnke-w24-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf-8');
  }
  return root;
}

// ===== 1. BOM =====
async function test1_bom() {
  console.log('\n[1] BOM 剥离');
  log(stripBom('\uFEFF# hi') === '# hi', '去掉 UTF-8 BOM');
  log(stripBom('# hi') === '# hi', '无 BOM 原样返回');
}

// ===== 2. 按字节截断 =====
async function test2_truncate() {
  console.log('\n[2] 按字节截断');
  const short = truncateToBytes('hello', 100);
  log(short.text === 'hello' && short.truncated === false, '未超限不截断');

  const long = truncateToBytes('a'.repeat(50), 10);
  log(long.text.length === 10 && long.truncated === true, 'ASCII 截到上限');

  // 中文 3 字节/字：上限 7 字节只能容纳 2 个字符，且不能出现替换字符
  const cn = truncateToBytes('中文测试内容', 7);
  log(!cn.text.includes('\uFFFD'), '多字节边界不产生替换字符', JSON.stringify(cn.text));
  log(Buffer.byteLength(cn.text, 'utf-8') <= 7, '多字节截断后不超上限');
  log(cn.truncated === true, '多字节截断标记');

  const zero = truncateToBytes('abc', 0);
  log(zero.text === 'abc', '非法上限（0）视为不截断');
}

// ===== 3. 提示块拼装 =====
async function test3_block() {
  console.log('\n[3] 提示块拼装');
  log(buildInstructionBlock([]) === '', '无文件返回空串');

  const block = buildInstructionBlock([
    { relPath: 'AGENTS.md', content: '# 根约定\n用 pnpm', depth: 0 },
    { relPath: 'src/AGENTS.md', content: 'src 下用 camelCase', depth: 1, truncated: true },
  ]);
  log(block.includes('[项目指令]'), '包含标题');
  log(block.includes('用户本轮的明确要求 > 项目指令'), '声明优先级');
  log(block.includes('<<< AGENTS.md · 仓库根目录 >>>'), '根目录来源标注');
  log(block.includes('<<< src/AGENTS.md · 目录 src/ >>>'), '子目录来源标注');
  log(block.includes('内容超长'), '截断提示');
  log(block.indexOf('根约定') < block.indexOf('camelCase'), '浅层在前、深层在后');
}

// ===== 4. 扫描规则 =====
async function test4_scan() {
  console.log('\n[4] 目录扫描');
  const root = await makeTree({
    'AGENTS.md': '# root',
    'CNKE.md': '# cnke',
    'docs/AGENTS.md': '# docs',
    'docs/deep/AGENTS.md': '# deep',
    'node_modules/pkg/AGENTS.md': '# nm',
    '.git/AGENTS.md': '# git',
    'src/index.ts': 'export {}',
  });
  invalidateInstructionCache();

  const found = await scanInstructionFiles({ root });
  const rels = found.map((f) => f.relPath);
  log(rels[0] === 'AGENTS.md', '根目录 AGENTS.md 最先', rels.join(','));
  log(rels.includes('CNKE.md'), '识别 CNKE.md');
  log(rels.includes('docs/AGENTS.md'), '识别一级子目录');
  log(rels.includes('docs/deep/AGENTS.md'), '识别二级子目录');
  log(!rels.some((r) => r.includes('node_modules')), '跳过 node_modules');
  log(!rels.some((r) => r.startsWith('.git')), '跳过 .git');
  log(new Set(rels).size === rels.length, '无重复');

  const shallow = await scanInstructionFiles({ root, maxDepth: 1 });
  log(!shallow.some((f) => f.relPath === 'docs/deep/AGENTS.md'), 'maxDepth=1 不进入二级目录');

  const only = await scanInstructionFiles({ root, fileNames: ['CNKE.md'] });
  log(only.length === 1 && only[0].relPath === 'CNKE.md', 'fileNames 可自定义');

  // 缓存：同一参数第二次调用命中缓存，结果一致
  const again = await scanInstructionFiles({ root });
  log(again.length === found.length, '缓存命中结果一致');
  const nocache = await scanInstructionFiles({ root, useCache: false });
  log(nocache.length === found.length, 'useCache=false 结果一致');

  await fsp.rm(root, { recursive: true, force: true });
}

// ===== 5. 预算与容错 =====
async function test5_budget() {
  console.log('\n[5] 预算与容错');
  const bigRoot = '# big\n' + 'x'.repeat(20000);
  const root = await makeTree({
    'AGENTS.md': '# root rules',
    'sub/AGENTS.md': bigRoot,
    'empty/AGENTS.md': '',
  });
  invalidateInstructionCache();

  const res = await loadProjectInstructions({ root, maxTotalBytes: 24000, maxBytesPerFile: 12000 });
  log(res.files.length === 2, '两根文件被加载（空文件跳过）', res.files.map((f) => f.relPath).join(','));
  const sub = res.files.find((f) => f.relPath === 'sub/AGENTS.md');
  log(sub?.truncated === true, '超单文件上限被截断');
  log(res.skipped.some((s) => s.relPath === 'empty/AGENTS.md'), '空文件计入 skipped');
  log(res.totalBytes <= 24000, '总量不超预算', `total=${res.totalBytes}`);
  log(res.block.includes('root rules'), '块内含根指令');

  // 预算紧张：根目录文件优先占用，剩余额度不足一小段时整份跳过
  const tightRoot = await makeTree({
    'AGENTS.md': '# root rules\n' + 'y'.repeat(900),
    'sub/AGENTS.md': '# sub rules\n' + 'z'.repeat(3000),
  });
  invalidateInstructionCache();
  const tight = await loadProjectInstructions({ root: tightRoot, maxTotalBytes: 1024, maxBytesPerFile: 12000 });
  log(tight.files.length === 1 && tight.files[0].relPath === 'AGENTS.md', '预算紧张时优先保留浅层文件');
  log(tight.skipped.some((s) => s.reason.includes('超出总量上限')), '超出总量被记入 skipped');
  log(tight.totalBytes <= 1024, '严格压到预算内', `total=${tight.totalBytes}`);
  await fsp.rm(tightRoot, { recursive: true, force: true });

  // 空工作区 / 无指令文件
  const empty = await loadProjectInstructions({ root: '' });
  log(empty.block === '' && empty.files.length === 0, '空 root 返回空结果');

  const plain = await makeTree({ 'README.md': '# hi' });
  invalidateInstructionCache();
  const none = await loadProjectInstructions({ root: plain });
  log(none.block === '' && none.files.length === 0, '无指令文件时 block 为空（不浪费 token）');

  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(plain, { recursive: true, force: true });
}

// ===== 6. 模板生成 =====
async function test6_template() {
  console.log('\n[6] 模板生成');
  const root = await makeTree({ 'README.md': '# hi' });
  const first = await createInstructionTemplate(root);
  log(first.success && first.created === true, '首次生成成功');
  const written = await fsp.readFile(path.join(root, 'AGENTS.md'), 'utf-8');
  log(written === INSTRUCTION_TEMPLATE, '写入内容与模板一致');

  await fsp.writeFile(path.join(root, 'AGENTS.md'), '# 我自己的约定', 'utf-8');
  const second = await createInstructionTemplate(root);
  log(second.success && second.created === false, '已存在时不覆盖');
  const kept = await fsp.readFile(path.join(root, 'AGENTS.md'), 'utf-8');
  log(kept === '# 我自己的约定', '用户内容保持不变');

  const bad = await createInstructionTemplate(root, '../evil.md');
  log(bad.success === false, '拒绝非法文件名');
  const noRoot = await createInstructionTemplate('');
  log(noRoot.success === false, '未打开工作区时报错');

  await fsp.rm(root, { recursive: true, force: true });
}

async function main() {
  console.log('===== W24 项目指令（AGENTS.md）测试 =====');
  await test1_bom();
  await test2_truncate();
  await test3_block();
  await test4_scan();
  await test5_budget();
  await test6_template();
  console.log(`\n===== 结果：${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
