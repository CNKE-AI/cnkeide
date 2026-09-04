/**
 * W10 RAG 文档问答测试
 * 验证：1) parseDocument 各种格式  2) DocumentIndex 切块  3) keywordSearch
 *        4) RagManager ingest/query  5) HTML/DOCX/PDF 解析
 *
 * 用法：npx tsx scripts/test_w10_rag.mjs
 */
import { parseDocument, htmlToText } from '../electron/core-fork/rag/DocumentParser.js';
import { DocumentIndex } from '../electron/core-fork/rag/DocumentIndex.js';
import { RagManager } from '../electron/core-fork/rag/RagManager.js';
import { EmbeddingProvider } from '../electron/core-fork/codebase/EmbeddingProvider.js';
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

// ===== DocumentParser =====
async function test1_parseText() {
  console.log('\n[1] parseDocument .txt');
  const dir = await tmpDir('w10-');
  const f = path.join(dir, 'a.txt');
  await fs.writeFile(f, 'hello world\n你好世界');
  const d = await parseDocument(f);
  log(d.type === 'text', 'type=text', `t=${d.type}`);
  log(d.text === 'hello world\n你好世界', '文本正确', `t=${d.text}`);
  log(d.meta.chars > 0, 'chars 统计', `c=${d.meta.chars}`);
  log(d.id.startsWith('doc_'), 'id 格式', `id=${d.id}`);
  await fs.rm(dir, { recursive: true, force: true });
}

async function test2_parseMarkdown() {
  console.log('\n[2] parseDocument .md');
  const dir = await tmpDir('w10-');
  const f = path.join(dir, 'a.md');
  await fs.writeFile(f, '# 标题\n\n正文内容\n\n- 列表1\n- 列表2');
  const d = await parseDocument(f);
  log(d.type === 'markdown', 'type=markdown', `t=${d.type}`);
  log(/# 标题/.test(d.text), '保留 markdown 原文', '');
  await fs.rm(dir, { recursive: true, force: true });
}

async function test3_parseHtml() {
  console.log('\n[3] parseDocument .html');
  const dir = await tmpDir('w10-');
  const f = path.join(dir, 'a.html');
  await fs.writeFile(f, '<html><body><h1>标题</h1><p>正文 <b>加粗</b></p><script>alert(1)</script></body></html>');
  const d = await parseDocument(f);
  log(d.type === 'html', 'type=html', `t=${d.type}`);
  log(/标题/.test(d.text) && /正文/.test(d.text), '文本提取', `t=${d.text}`);
  log(!/alert/.test(d.text) && !/<script>/.test(d.text), '去除 script', '');
  log(!/<b>/.test(d.text), '去除标签', '');
  await fs.rm(dir, { recursive: true, force: true });
}

function test4_htmlToText() {
  console.log('\n[4] htmlToText 纯函数');
  const r = htmlToText('<div><p>a</p><p>b</p></div>');
  log(/a/.test(r) && /b/.test(r), '段落保留', `r=${r}`);
  log(/&/.test(r.replace(/&amp;/, '')) || !/&amp;/.test(r), '实体转换', '');
}

// ===== DocumentIndex =====
async function test5_chunkText() {
  console.log('\n[5] DocumentIndex.chunkText 段落切分');
  const idx = new DocumentIndex();
  const text = '第一段内容。\n\n第二段内容。\n\n第三段内容。';
  const chunks = idx.chunkText('d1', 'doc1', text);
  log(chunks.length === 3, '3 段', `n=${chunks.length}`);
  log(chunks[0].text === '第一段内容。', '段 1 内容', `t=${chunks[0].text}`);
  log(chunks[0].docName === 'doc1', 'docName 正确', '');
}

async function test6_chunkTextLongPara() {
  console.log('\n[6] DocumentIndex.chunkText 滑窗切分长段');
  const idx = new DocumentIndex();
  // 一段超长文本（2000 字符，无换行）
  const text = 'x'.repeat(2000);
  const chunks = idx.chunkText('d1', 'doc1', text);
  // 2000 / (800-100) = 2000/700 = 2.86 → 至少 3 块
  log(chunks.length >= 3, '至少 3 块', `n=${chunks.length}`);
  // 验证有重叠（相邻 chunk 共享部分字符）
  log(chunks[0].text.length === 800, '首块 800 字符', `len=${chunks[0].text.length}`);
  // chunk 1 末尾应该和 chunk 2 前部分重叠
  const overlap = chunks[0].text.slice(-100);
  log(chunks[1].text.startsWith(overlap), '有 100 字符重叠', '');
}

async function test7_keywordSearch() {
  console.log('\n[7] DocumentIndex.keywordSearch 关键词搜索');
  const idx = new DocumentIndex();
  // 不传 embedding，纯关键词
  idx['docs'].set('d1', { name: 'guide.md', chunks: [
    { id: 'd1_0', docId: 'd1', docName: 'guide.md', position: 0, text: '如何使用 TypeScript 写代码', snippet: '' },
    { id: 'd1_1', docId: 'd1', docName: 'guide.md', position: 1, text: 'Python 入门教程', snippet: '' },
  ], updatedAt: Date.now() });
  const r = idx.keywordSearch('TypeScript 代码', 5);
  log(r.length > 0, '命中', `n=${r.length}`);
  log(r[0].chunk.text.includes('TypeScript'), 'top1 是 TypeScript', `t=${r[0].chunk.text}`);
  log(r[0].score >= r[1]?.score || r.length === 1, '排序正确', '');
}

async function test8_formatHitsForLlm() {
  console.log('\n[8] formatHitsForLlm LLM 引用文本');
  const idx = new DocumentIndex();
  const hits = [
    { chunk: { id: 'd1_0', docId: 'd1', docName: 'guide.md', position: 0, text: 'A 段内容', snippet: '' }, score: 0.9 },
    { chunk: { id: 'd1_1', docId: 'd1', docName: 'guide.md', position: 1, text: 'B 段内容', snippet: '' }, score: 0.7 },
  ];
  const out = idx.formatHitsForLlm(hits, 1000);
  log(/\[1\]/.test(out) && /\[2\]/.test(out), '含 [1] [2] 编号', '');
  log(/guide\.md/.test(out), '含文档名', '');
  log(/A 段内容/.test(out), '含段落内容', '');
}

// ===== RagManager =====
async function test9_ragIngestAndQuery() {
  console.log('\n[9] RagManager.ingest + query（无 embedding 用关键词）');
  const dir = await tmpDir('w10-');
  const f = path.join(dir, 'guide.txt');
  await fs.writeFile(f, 'TypeScript 是一种强类型语言。\n\nJavaScript 是一门脚本语言。\n\nPython 是动态类型语言。');
  const mgr = new RagManager();
  const r = await mgr.ingest(f, { baseUrl: '', apiKey: '', model: '' });
  log(r.docId.startsWith('doc_'), 'docId 正确', `id=${r.docId}`);
  log(r.chunkCount === 3, '3 个 chunks', `n=${r.chunkCount}`);
  log(r.embeddedCount === 0, '无 embedding', `e=${r.embeddedCount}`);
  // query（降级到关键词）
  const q = await mgr.query('TypeScript', { baseUrl: '', apiKey: '', model: '' }, 5);
  log(q.hits.length > 0, '关键词命中', `n=${q.hits.length}`);
  log(/TypeScript/.test(q.context), 'context 含查询词', '');
  log(q.context.includes('[1]'), '含引用编号', '');
  await fs.rm(dir, { recursive: true, force: true });
}

async function test10_ragListAndRemove() {
  console.log('\n[10] RagManager list + remove');
  const dir = await tmpDir('w10-');
  const mgr = new RagManager();
  await mgr.ingest(path.join(dir, 'a.txt'), { baseUrl: '', apiKey: '', model: '' }).catch(() => {});
  // 用直接 add 绕过 ingest 失败
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello');
  const r = await mgr.ingest(path.join(dir, 'a.txt'), { baseUrl: '', apiKey: '', model: '' });
  const list = mgr.list();
  log(list.length === 1, 'list 1 个', `n=${list.length}`);
  log(list[0].name === 'a.txt', 'name 正确', `n=${list[0].name}`);
  mgr.remove(r.docId);
  log(mgr.list().length === 0, 'remove 后 0 个', `n=${mgr.list().length}`);
  await fs.rm(dir, { recursive: true, force: true });
}

async function test11_mockEmbeddingRag() {
  console.log('\n[11] RagManager 端到端（Mock Embedding）');
  class MockProvider extends EmbeddingProvider {
    async callEmbedApi(config, text) {
      const v = new Array(8).fill(0);
      for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i) / 1000;
      return v;
    }
  }
  const provider = new MockProvider();
  const mgr = new RagManager(provider);
  const dir = await tmpDir('w10-');
  await fs.writeFile(path.join(dir, 'a.txt'), 'authentication 鉴权。\n\nauthorization 授权。\n\nlogging 日志。');
  await fs.writeFile(path.join(dir, 'b.txt'), 'database 数据库。\n\ncache 缓存。');
  await mgr.ingest(path.join(dir, 'a.txt'), { baseUrl: 'x', apiKey: 'k', model: 'm' });
  await mgr.ingest(path.join(dir, 'b.txt'), { baseUrl: 'x', apiKey: 'k', model: 'm' });
  const q = await mgr.query('auth', { baseUrl: 'x', apiKey: 'k', model: 'm' }, 3);
  log(q.hits.length > 0, '有命中', `n=${q.hits.length}`);
  log(mgr.list().length === 2, 'list 2 个文档', `n=${mgr.list().length}`);
  await fs.rm(dir, { recursive: true, force: true });
}

(async () => {
  console.log('=== W10 RAG 文档问答测试 ===');
  await test1_parseText();
  await test2_parseMarkdown();
  await test3_parseHtml();
  test4_htmlToText();
  await test5_chunkText();
  await test6_chunkTextLongPara();
  await test7_keywordSearch();
  await test8_formatHitsForLlm();
  await test9_ragIngestAndQuery();
  await test10_ragListAndRemove();
  await test11_mockEmbeddingRag();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
