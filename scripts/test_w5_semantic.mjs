/**
 * W5 语义检索测试
 * 验证：1) chunkFile 切块  2) cosine 相似度  3) SemanticIndex 索引与查询
 *        4) SemanticRetriever 关键词召回  5) Tokenize  6) Mock embedding 链路
 *
 * 用法：npx tsx scripts/test_w5_semantic.mjs
 */
import {
  SemanticIndex, chunkFile, cosine,
} from '../electron/core-fork/codebase/SemanticIndex.js';
import {
  SemanticRetriever, tokenize,
} from '../electron/core-fork/codebase/SemanticRetriever.js';
import { EmbeddingProvider } from '../electron/core-fork/codebase/EmbeddingProvider.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

async function test1_chunkFile() {
  console.log('\n[1] chunkFile 切块');
  const content = `import { foo } from 'bar';

export function hello(name) {
  return 'Hello ' + name;
}

export class Greeter {
  greet(name) {
    return 'Hi ' + name;
  }
}
`;
  const chunks = chunkFile('test.ts', content);
  log(chunks.length >= 2, '切出 >= 2 块', `n=${chunks.length}`);
  log(chunks.every((c) => c.id.startsWith('test.ts#')), 'chunk id 格式', chunks[0]?.id);
  log(chunks.some((c) => c.symbolName === 'hello'), '识别到 hello', chunks.map((c) => c.symbolName).join(','));
  log(chunks.some((c) => c.symbolName === 'Greeter'), '识别到 Greeter', '');
}

async function test2_cosine() {
  console.log('\n[2] cosine 相似度');
  const a = [1, 0, 0];
  const b = [1, 0, 0];
  const c = [0, 1, 0];
  log(Math.abs(cosine(a, b) - 1) < 1e-6, '同向量=1', `${cosine(a, b)}`);
  log(Math.abs(cosine(a, c) - 0) < 1e-6, '正交=0', `${cosine(a, c)}`);
  log(cosine([0, 0, 0], [1, 0, 0]) === 0, '零向量=0', '');
}

async function test3_semanticIndex() {
  console.log('\n[3] SemanticIndex 索引 + 检索');
  const idx = new SemanticIndex();
  const file = '/a.ts';
  const content = `export function authLogin() { return 1; }
export function authLogout() { return 0; }
export function dataSave() { return true; }`;
  const chunks = idx.indexFile(file, content);
  log(chunks.length >= 2, '切出 >= 2 块', `n=${chunks.length}`);

  // 手动注入 mock embedding（按 symbolName 维度聚类）
  const vectorMap = new Map([
    ['authLogin', [1, 0, 0, 0]],
    ['authLogout', [0.9, 0.1, 0, 0]],
    ['dataSave', [0, 0, 1, 0]],
  ]);
  for (const c of chunks) {
    if (c.symbolName && vectorMap.has(c.symbolName)) {
      c.embedding = vectorMap.get(c.symbolName);
    }
  }
  // 查询 "auth"
  const r1 = idx.search([1, 0, 0, 0], 3);
  log(r1.length > 0, '查到结果', `n=${r1.length}`);
  log(r1[0]?.chunk.symbolName === 'authLogin' || r1[0]?.chunk.symbolName === 'authLogout', 'top1 是 auth*', `top=${r1[0]?.chunk.symbolName}`);
  log(r1[0]?.score > r1[1]?.score || r1.length === 1, 'top1 分数 >= top2', `${r1[0]?.score} vs ${r1[1]?.score}`);
}

async function test4_keywordRetriever() {
  console.log('\n[4] SemanticRetriever 关键词召回（无 embedding 降级）');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'w5-kw-'));
  try {
    await fs.writeFile(path.join(dir, 'auth.ts'), 'export function login() {}\nexport function logout() {}');
    await fs.writeFile(path.join(dir, 'data.ts'), 'export function save() {}\nexport function load() {}');
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'node_modules', 'x.js'), 'const login = "skip"');

    const ret = new SemanticRetriever(dir);
    const stats = await ret.rebuild();
    log(stats.fileCount === 2, '索引 2 个文件（node_modules 跳过）', `n=${stats.fileCount}`);
    log(stats.chunkCount > 0, '生成 chunks', `n=${stats.chunkCount}`);

    const r = await ret.search('login', { rootPath: dir, enableEmbedding: false, topK: 5 });
    log(r.length > 0, '命中结果', `n=${r.length}`);
    log(r.some((x) => x.sources.includes('keyword')), '含关键词来源', `sources=${r[0]?.sources.join(',')}`);
    log(r.every((x) => !x.relativeFile.includes('node_modules')), 'node_modules 排除', '');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function test5_tokenize() {
  console.log('\n[5] tokenize');
  const toks = tokenize('Hello World! 你好, World-2024');
  log(toks.includes('hello'), '小写化', toks.join(','));
  log(toks.includes('world'), 'world 命中', '');
  log(toks.includes('你好'), '中文保留', toks.join(','));
  log(toks.includes('world2024') || toks.includes('2024'), '数字拼接', toks.join(','));
}

async function test6_mockEmbedding() {
  console.log('\n[6] Mock Embedding 链路（端到端 3 路召回）');
  // 构造 mock provider：按文本长度生成"特征向量"
  class MockProvider extends EmbeddingProvider {
    async callEmbedApi(config, text) {
      // 简单 hash-based 模拟
      const v = new Array(8).fill(0);
      for (let i = 0; i < text.length; i++) {
        v[i % 8] += text.charCodeAt(i) / 1000;
      }
      return v;
    }
  }
  const provider = new MockProvider();
  // 直接测 embed
  const r1 = await provider.embed({ baseUrl: 'x', apiKey: 'k', model: 'm' }, 'hello');
  log(r1 && r1.embedding.length === 8, 'mock embed 返回 8 维向量', `len=${r1?.embedding.length}`);
  log(r1 && r1.cached === false, '首次未命中缓存', `cached=${r1?.cached}`);
  const r2 = await provider.embed({ baseUrl: 'x', apiKey: 'k', model: 'm' }, 'hello');
  log(r2 && r2.cached === true, '第二次命中缓存', `cached=${r2?.cached}`);

  // 端到端：retriever + mock provider
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'w5-e2e-'));
  try {
    await fs.writeFile(path.join(dir, 'auth.ts'), 'export function login() {}\nexport function logout() {}');
    await fs.writeFile(path.join(dir, 'data.ts'), 'export function save() {}\nexport function load() {}');
    const ret = new SemanticRetriever(dir);
    await ret.rebuild();
    // 用 mock provider 跑 embedAll
    const mockProvider = new MockProvider();
    // 替换 inflight 调用：让 SemanticIndex 用我们的 mock
    const stats = await ret.embedAll({ baseUrl: 'x', apiKey: 'k', model: 'm' }, mockProvider);
    log(stats.embedded > 0, 'embedAll 写入向量', `embedded=${stats.embedded}`);

    const r = await ret.search('login', { rootPath: dir, enableEmbedding: true, embedding: { baseUrl: 'x', apiKey: 'k', model: 'm' }, topK: 5 });
    log(r.length > 0, '3 路召回有结果', `n=${r.length}`);
    // 至少含 keyword 或 semantic
    const hasSource = r.some((x) => x.sources.includes('keyword') || x.sources.includes('semantic') || x.sources.includes('symbol'));
    log(hasSource, '含召回来源', r[0]?.sources.join(','));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function test7_incrementalIndex() {
  console.log('\n[7] 增量索引（文件签名）');
  const idx = new SemanticIndex();
  const file = '/a.ts';
  const content1 = 'function foo() { return 1; }';
  const content2 = 'function foo() { return 2; }';
  const content3 = 'function foo() { return 1; }'; // 同 1
  const c1 = idx.indexFile(file, content1);
  const c1Size = c1.length;
  idx.indexFile(file, content2);
  const c3 = idx.indexFile(file, content3);
  log(idx.getFiles().length === 1, '1 个文件', `n=${idx.getFiles().length}`);
  log(idx.chunkCount === c1Size, '同内容不重复', `n=${idx.chunkCount}`);
  log(c3.length === c1Size, '返回 chunks 数量一致', '');
}

(async () => {
  console.log('=== W5 语义检索测试 ===');
  await test1_chunkFile();
  await test2_cosine();
  await test3_semanticIndex();
  await test4_keywordRetriever();
  await test5_tokenize();
  await test6_mockEmbedding();
  await test7_incrementalIndex();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
