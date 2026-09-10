/**
 * W14 PPT 生成测试
 * 验证 PptxTools（pptxgenjs）真实生成 .pptx 文件
 * 运行：npx tsx scripts/test_w14_pptx.mjs
 */
import { createPptxAdapter, MockPptxAdapter, PptxGenAdapter } from '../electron/core-fork/tools/PptxTools.ts';
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, name) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

async function main() {
  console.log('\n=== W14 PPT 生成测试 ===\n');

  // 1. Mock adapter 契约
  console.log('[1] MockPptxAdapter 契约');
  const mock = new MockPptxAdapter();
  assert(mock.available === false, 'mock.available === false');
  assert(mock.provider === 'mock', 'mock.provider === "mock"');
  const mockRes = await mock.generate({}, '/tmp/x.pptx');
  assert(mockRes.success === false, 'mock.generate 返回 success=false');
  assert(typeof mockRes.error === 'string' && mockRes.error.length > 0, 'mock.generate 返回错误提示');

  // 2. 真实 adapter 探测
  console.log('\n[2] createPptxAdapter 探测');
  const adapter = await createPptxAdapter();
  assert(adapter.available === true, 'createPptxAdapter 返回可用 adapter');
  assert(adapter.provider === 'pptxgenjs', 'provider === "pptxgenjs"');
  assert(adapter instanceof PptxGenAdapter, 'adapter 是 PptxGenAdapter 实例');

  // 3. 真实生成 .pptx
  console.log('\n[3] 真实生成 .pptx');
  const outPath = path.join(process.cwd(), 'scripts', '__test_w14_output.pptx');
  const req = {
    title: 'W14 测试演示',
    author: 'CnkeIDE',
    subject: '测试',
    size: '16x9',
    slides: [
      { title: '封面页', subtitle: '这是一个副标题', bullets: [{ text: '要点一' }, { text: '要点二' }, { text: '要点三' }] },
      { title: '数据页', bullets: [{ text: '增长', level: 0 }, { text: '子项', level: 1 }] },
      {
        title: '表格页',
        table: { headers: ['指标', '2024', '2025'], rows: [['营收', '100', '150'], ['用户', '50', '80']] },
      },
      { title: '图表页', chart: { type: 'bar', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: '系列A', values: [10, 20, 30] }] } },
    ],
  };
  const res = await adapter.generate(req, outPath);
  assert(res.success === true, `generate 返回 success=true (${res.error || ''})`);
  assert(res.slideCount === 4, `slideCount === 4 (实际 ${res.slideCount})`);
  assert(res.path === outPath, 'path 正确');
  assert(fs.existsSync(outPath), '输出文件存在');
  if (fs.existsSync(outPath)) {
    const stat = fs.statSync(outPath);
    assert(stat.size > 5000, `文件大小 > 5KB (实际 ${stat.size})`);
  }

  // 4. 空 slides 也应成功
  console.log('\n[4] 空 slides 生成');
  const emptyRes = await adapter.generate({ title: '空', slides: [] }, outPath + '.empty.pptx');
  assert(emptyRes.success === true, '空 slides 生成成功');
  assert(emptyRes.slideCount === 0, 'slideCount === 0');

  // 清理
  try {
    fs.unlinkSync(outPath);
    fs.unlinkSync(outPath + '.empty.pptx');
  } catch {}

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  if (fail > 0) {
    console.log('失败项：', failures.join(', '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
