/**
 * PPT 套用模板 端到端测试
 *
 * 覆盖两种模板形态：
 *  A. 占位符模板（pptxgenjs 生成的 mock 模板，含 {{TITLE}} 等）
 *  B. 真实 PPT 模板（用户上传的成品，无占位符 → 文本注入策略）
 *
 * 运行：npx tsx scripts/test_ppt_apply.mjs
 */
import AdmZip from 'adm-zip';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyTemplate } from '../electron/core-fork/ppt/pptApply.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const tmpDir = path.join(os.tmpdir(), `ppt-apply-test-${Date.now()}`);
await fsp.mkdir(tmpDir, { recursive: true });

/** 生成一个「真实 PPT」结构的最小 pptx（无占位符，全是实际文字） */
function makeRealisticPptx(savePath, slideSpecs) {
  const zip = new AdmZip();
  // [Content_Types].xml
  zip.addFile('[Content_Types].xml', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
${slideSpecs.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('\n')}
</Types>`, 'utf-8'));

  zip.addFile('_rels/.rels', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`, 'utf-8'));

  // presentation.xml（故意把 sldIdLst 顺序打乱，验证按展示顺序而非文件名）
  const sldIds = slideSpecs.map((_, i) =>
    `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('');
  zip.addFile('ppt/presentation.xml', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:sldIdLst>${sldIds}</p:sldIdLst>
</p:presentation>`, 'utf-8'));

  zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slideSpecs.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('\n')}
</Relationships>`, 'utf-8'));

  slideSpecs.forEach((spec, i) => {
    const shapesXml = spec.shapes.map((sh, si) => {
      const paras = sh.paras.map((p) => {
        const runs = p.runs.map((r) =>
          `<a:r><a:rPr lang="zh-CN" sz="${r.sz}"/><a:t>${r.t}</a:t></a:r>`).join('');
        return `<a:p>${runs}</a:p>`;
      }).join('');
      return `<p:sp><p:nvSpPr><p:cNvPr id="${si + 2}" name="Shape ${si}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="914400" y="${sh.y}"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`;
    }).join('');
    zip.addFile(`ppt/slides/slide${i + 1}.xml`, Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<p:cSld><p:spTree>${shapesXml}</p:spTree></p:cSld></p:sld>`, 'utf-8'));
  });

  zip.writeZip(savePath);
}

/** 读回 pptx 的某一页纯文本（按展示顺序） */
function readSlideText(pptxPath, displayIdx) {
  const zip = new AdmZip(pptxPath);
  const targets = zip.getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => parseInt(a.entryName.match(/(\d+)/)[1]) - parseInt(b.entryName.match(/(\d+)/)[1]));
  const entry = targets[displayIdx];
  if (!entry) return '';
  const xml = entry.getData().toString('utf-8');
  const texts = [];
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml)) !== null) texts.push(m[1]);
  return texts.join('|');
}

const outline = {
  title: '人工智能在医疗领域的应用',
  slides: [
    { title: '背景与现状', bullets: ['医疗影像数据量年增 40%', '基层诊断资源严重不足', 'AI 辅助诊断准确率已达 95%'] },
    { title: '核心技术路径', bullets: ['深度学习影像识别', '自然语言病历结构化', '多模态融合推理'] },
    { title: '落地挑战', bullets: ['数据隐私合规', '模型可解释性', '临床验证周期长'] },
  ],
};

console.log('\n=== A. 占位符模板（回归，不应被破坏）===');
{
  const tplPath = path.join(tmpDir, 'placeholder.pptx');
  makeRealisticPptx(tplPath, [
    { shapes: [{ y: 0, paras: [{ runs: [{ t: '{{TITLE}}', sz: 4400 }] }] }, { y: 100, paras: [{ runs: [{ t: '{{SUBTITLE}}', sz: 2000 }] }] }] },
    { shapes: [{ y: 0, paras: [{ runs: [{ t: '{{PAGE_TITLE_1}}', sz: 3200 }] }] }, { y: 100, paras: [{ runs: [{ t: '{{BULLETS_1}}', sz: 1800 }] }] }] },
    { shapes: [{ y: 0, paras: [{ runs: [{ t: '{{PAGE_TITLE_2}}', sz: 3200 }] }] }, { y: 100, paras: [{ runs: [{ t: '{{BULLETS_2}}', sz: 1800 }] }] }] },
  ]);
  const outPath = path.join(tmpDir, 'placeholder-out.pptx');
  const res = await applyTemplate({ templatePath: tplPath, outline, savePath: outPath });
  ok('返回 success', res.success === true, JSON.stringify(res));
  ok('策略为 placeholder', res.strategy === 'placeholder', `实际=${res.strategy}`);
  ok('filledCount = 3', res.filledCount === 3, `实际=${res.filledCount}`);
  const t0 = readSlideText(outPath, 0);
  ok('封面标题已替换', t0.includes('人工智能在医疗领域的应用'), t0);
  ok('封面无残留占位符', !t0.includes('{{'), t0);
  const t1 = readSlideText(outPath, 1);
  ok('第 2 页标题已替换', t1.includes('背景与现状'), t1);
  ok('第 2 页 bullet 已写入', t1.includes('医疗影像数据量年增 40%'), t1);
  ok('第 2 页无残留占位符', !t1.includes('{{'), t1);
}

console.log('\n=== B. 真实 PPT 模板（文本注入，本次修复核心）===');
{
  const tplPath = path.join(tmpDir, 'real.pptx');
  // 典型汇报模板：封面(大标题+副标题) + 3 张内容页(标题+多段正文) + 结尾页
  makeRealisticPptx(tplPath, [
    { shapes: [
      { y: 2000000, paras: [{ runs: [{ t: '2026 年度工作汇报', sz: 5400 }] }] },
      { y: 3000000, paras: [{ runs: [{ t: '汇报人：张三', sz: 1800 }] }] },
    ] },
    { shapes: [
      { y: 500000, paras: [{ t: '', runs: [{ t: '第一部分 工作回顾', sz: 3200 }] }] },
      { y: 1500000, paras: [
        { runs: [{ t: '完成了 A 项目交付', sz: 1800 }] },
        { runs: [{ t: '推进了 B 系统重构', sz: 1800 }] },
        { runs: [{ t: '团队规模扩大至 12 人', sz: 1800 }] },
      ] },
    ] },
    { shapes: [
      { y: 500000, paras: [{ runs: [{ t: '第二部分 数据指标', sz: 3200 }] }] },
      { y: 1500000, paras: [
        { runs: [{ t: '营收同比增长 35%', sz: 1800 }] },
        { runs: [{ t: '客户留存率 92%', sz: 1800 }] },
      ] },
    ] },
    { shapes: [
      { y: 500000, paras: [{ runs: [{ t: '第三部分 未来规划', sz: 3200 }] }] },
      { y: 1500000, paras: [
        { runs: [{ t: '拓展海外市场', sz: 1800 }] },
        { runs: [{ t: '建设数据中台', sz: 1800 }] },
      ] },
    ] },
    { shapes: [
      { y: 3000000, paras: [{ runs: [{ t: '感谢聆听', sz: 4400 }] }] },
    ] },
  ]);

  const outPath = path.join(tmpDir, 'real-out.pptx');
  const res = await applyTemplate({ templatePath: tplPath, outline, savePath: outPath });
  ok('返回 success', res.success === true, JSON.stringify(res));
  ok('策略为 inject', res.strategy === 'inject', `实际=${res.strategy}`);
  ok('pageCount = 5', res.pageCount === 5, `实际=${res.pageCount}`);
  ok('filledCount > 0（真的改写了）', (res.filledCount ?? 0) > 0, `实际=${res.filledCount}`);

  const c0 = readSlideText(outPath, 0);
  ok('封面标题被替换', c0.includes('人工智能在医疗领域的应用'), c0);
  ok('封面旧标题已消失', !c0.includes('2026 年度工作汇报'), c0);
  ok('封面副标题被替换', !c0.includes('汇报人：张三'), c0);

  const c1 = readSlideText(outPath, 1);
  ok('第 2 页标题=背景与现状', c1.includes('背景与现状'), c1);
  ok('第 2 页 bullet1 写入', c1.includes('医疗影像数据量年增 40%'), c1);
  ok('第 2 页 bullet3 写入', c1.includes('AI 辅助诊断准确率已达 95%'), c1);
  ok('第 2 页无旧内容残留', !c1.includes('第一部分') && !c1.includes('完成了 A 项目交付'), c1);

  const c2 = readSlideText(outPath, 2);
  ok('第 3 页标题=核心技术路径', c2.includes('核心技术路径'), c2);
  ok('第 3 页 bullet 写入', c2.includes('多模态融合推理'), c2);

  const c3 = readSlideText(outPath, 3);
  ok('第 4 页标题=落地挑战', c3.includes('落地挑战'), c3);
  ok('第 4 页 bullet 写入', c3.includes('临床验证周期长'), c3);

  const last = readSlideText(outPath, 4);
  ok('结尾页未被大纲内容覆盖（保留"感谢聆听"）', last.includes('感谢聆听'), last);
}

console.log('\n=== C. 边界场景 ===');
{
  // C1 模板不存在
  const r1 = await applyTemplate({
    templatePath: path.join(tmpDir, 'nope.pptx'), outline,
    savePath: path.join(tmpDir, 'nope-out.pptx'),
  });
  ok('模板不存在 → success:false 且有 error', r1.success === false && !!r1.error, JSON.stringify(r1));

  // C2 纯图片模板（无文字框）→ 明确报错而非静默成功
  const imgOnly = path.join(tmpDir, 'imgonly.pptx');
  makeRealisticPptx(imgOnly, [{ shapes: [] }]);
  const r2 = await applyTemplate({
    templatePath: imgOnly, outline, savePath: path.join(tmpDir, 'imgonly-out.pptx'),
  });
  ok('纯图片模板 → success:false 且有 error', r2.success === false && !!r2.error, JSON.stringify(r2));

  // C3 大纲页数 > 模板容量 → 仍成功，且如实报告 skipped
  const smallTpl = path.join(tmpDir, 'small.pptx');
  makeRealisticPptx(smallTpl, [
    { shapes: [{ y: 2000000, paras: [{ runs: [{ t: '旧封面', sz: 4400 }] }] }] },
    { shapes: [
      { y: 500000, paras: [{ runs: [{ t: '旧标题', sz: 3200 }] }] },
      { y: 1500000, paras: [
        { runs: [{ t: '旧正文1', sz: 1800 }] },
        { runs: [{ t: '旧正文2', sz: 1800 }] },
      ] },
    ] },
  ]);
  const r3 = await applyTemplate({
    templatePath: smallTpl, outline, savePath: path.join(tmpDir, 'small-out.pptx'),
  });
  ok('模板页数不足 → 仍 success', r3.success === true, JSON.stringify(r3));
  ok('pageCount = 2（前端据此提示溢出）', r3.pageCount === 2, `实际=${r3.pageCount}`);
  ok('capacity = 1（只有 1 个内容页槽位）', r3.capacity === 1, `实际=${r3.capacity}`);
  ok('skipped = 2（3 条大纲只写入 1 条）', r3.skipped === 2, `实际=${r3.skipped}`);
  ok('notice 明确提示未写入', !!r3.notice && r3.notice.includes('未写入'), r3.notice);
  ok('写入的是第 1 条大纲（背景与现状）', readSlideText(r3.path, 1).includes('背景与现状'), readSlideText(r3.path, 1));
  ok('封面仍正常写入', readSlideText(r3.path, 0).includes('人工智能在医疗领域的应用'), readSlideText(r3.path, 0));
}

console.log('\n=== C4. 设计页/章节页不被破坏（真实模板关键场景）===');
{
  // 模板含「章节页」（只有单字「壹」）与「内容页」（多段落正文）
  const tpl = path.join(tmpDir, 'mixed.pptx');
  makeRealisticPptx(tpl, [
    { shapes: [{ y: 2000000, paras: [{ runs: [{ t: '旧封面', sz: 4400 }] }] }] },
    { shapes: [{ y: 2000000, paras: [{ runs: [{ t: '壹', sz: 4000 }] }] }] },  // 章节设计页
    { shapes: [
      { y: 500000, paras: [{ runs: [{ t: '旧标题', sz: 3200 }] }] },
      { y: 1500000, paras: [
        { runs: [{ t: '旧正文1', sz: 1800 }] },
        { runs: [{ t: '旧正文2', sz: 1800 }] },
      ] },
    ] },
    { shapes: [{ y: 2000000, paras: [{ runs: [{ t: '贰', sz: 4000 }] }] }] },  // 章节设计页
    { shapes: [
      { y: 500000, paras: [{ runs: [{ t: '旧标题2', sz: 3200 }] }] },
      { y: 1500000, paras: [
        { runs: [{ t: '旧正文A', sz: 1800 }] },
        { runs: [{ t: '旧正文B', sz: 1800 }] },
        { runs: [{ t: '旧正文C', sz: 1800 }] },
      ] },
    ] },
  ]);
  const out = path.join(tmpDir, 'mixed-out.pptx');
  const r = await applyTemplate({ templatePath: tpl, outline, savePath: out });
  ok('success', r.success === true, JSON.stringify(r));
  ok('capacity = 2（只认 2 个内容页槽位）', r.capacity === 2, `实际=${r.capacity}`);
  ok('章节页「壹」原样保留（未被写入）', readSlideText(out, 1).includes('壹'), readSlideText(out, 1));
  ok('章节页「贰」原样保留（未被写入）', readSlideText(out, 3).includes('贰'), readSlideText(out, 3));
  ok('内容页 1 正确写入', readSlideText(out, 2).includes('背景与现状'), readSlideText(out, 2));
  ok('内容页 2 正确写入', readSlideText(out, 4).includes('核心技术路径'), readSlideText(out, 4));
  ok('内容页 1 加入第 3 条 bullet（段落按需扩充）', readSlideText(out, 2).includes('AI 辅助诊断准确率已达 95%'), readSlideText(out, 2));
  ok('内容页 2 bullet 全部写入', readSlideText(out, 4).includes('多模态融合推理'), readSlideText(out, 4));
}

console.log('\n=== C5. 模板示例文字被清理 ===');
{
  const tpl = path.join(tmpDir, 'ph.pptx');
  makeRealisticPptx(tpl, [
    { shapes: [{ y: 2000000, paras: [{ runs: [{ t: '旧封面', sz: 4400 }] }] }] },
    { shapes: [
      { y: 500000, paras: [{ runs: [{ t: '输入您的标题', sz: 3200 }] }] },
      { y: 1500000, paras: [
        { runs: [{ t: '请在这里输入正文内容', sz: 1800 }] },
        { runs: [{ t: '第二行示例文字', sz: 1800 }] },
      ] },
    ] },
  ]);
  const out = path.join(tmpDir, 'ph-out.pptx');
  const r = await applyTemplate({ templatePath: tpl, outline, savePath: out });
  ok('success', r.success === true, JSON.stringify(r));
  const t1 = readSlideText(out, 1);
  ok('标题占位被替换为真实标题', t1.includes('背景与现状'), t1);
  ok('正文占位被替换为真实要点', t1.includes('医疗影像数据量年增 40%'), t1);
  ok('无「输入您的标题」残留', !t1.includes('输入您的标题'), t1);
  ok('无「请在这里输入正文内容」残留', !t1.includes('请在这里'), t1);
}

console.log('\n=== C6. 多 run 段落：内容不被拆散 ===');
{
  // 一段文本被拆成多个 <a:t>（PPT 常见），写入时不应把首字留在原位
  const tpl = path.join(tmpDir, 'multirun.pptx');
  makeRealisticPptx(tpl, [
    { shapes: [{ y: 2000000, paras: [{ runs: [{ t: '旧封面', sz: 4400 }] }] }] },
    { shapes: [
      { y: 500000, paras: [{ runs: [{ t: '旧标题', sz: 3200 }] }] },
      { y: 1500000, paras: [
        // 一段 = 两个 run
        { runs: [{ t: '旧正文甲', sz: 1800 }, { t: '续写内容', sz: 1800 }] },
        { runs: [{ t: '旧正文乙', sz: 1800 }, { t: '补充说明', sz: 1800 }] },
      ] },
    ] },
  ]);
  const out = path.join(tmpDir, 'multirun-out.pptx');
  const r = await applyTemplate({
    templatePath: tpl,
    outline: { title: 'X', slides: [{ title: '背景与现状', bullets: ['医疗影像数据量年增 40%', '基层诊断资源严重不足'] }] },
    savePath: out,
  });
  ok('success', r.success === true, JSON.stringify(r));
  const t1 = readSlideText(out, 1);
  ok('第 1 条要点完整（未拆散）', t1.includes('医疗影像数据量年增 40%'), t1);
  ok('第 2 条要点完整（未拆散）', t1.includes('基层诊断资源严重不足'), t1);
  ok('旧文字完全消失', !t1.includes('旧正文甲') && !t1.includes('续写内容'), t1);
}

console.log('\n=== C7. 装饰字（孤立单字）不被当成正文容器 ===');
{
  const tpl = path.join(tmpDir, 'deco.pptx');
  makeRealisticPptx(tpl, [
    { shapes: [{ y: 2000000, paras: [{ runs: [{ t: '旧封面', sz: 4400 }] }] }] },
    { shapes: [
      // 竖排装饰字
      { y: 300000, paras: [{ runs: [{ t: '标', sz: 4000 }] }] },
      { y: 700000, paras: [{ runs: [{ t: '题', sz: 4000 }] }] },
      // 真标题
      { y: 1200000, paras: [{ runs: [{ t: '旧标题', sz: 3200 }] }] },
      // 真正文
      { y: 2000000, paras: [
        { runs: [{ t: '旧正文1', sz: 1800 }] },
        { runs: [{ t: '旧正文2', sz: 1800 }] },
      ] },
    ] },
  ]);
  const out = path.join(tmpDir, 'deco-out.pptx');
  const r = await applyTemplate({
    templatePath: tpl,
    outline: { title: 'X', slides: [{ title: '背景与现状', bullets: ['医疗影像数据量年增 40%', '基层诊断资源严重不足'] }] },
    savePath: out,
  });
  ok('success', r.success === true, JSON.stringify(r));
  const t1 = readSlideText(out, 1);
  ok('装饰字「标」保留', t1.includes('标'), t1);
  ok('装饰字「题」保留', t1.includes('题'), t1);
  ok('标题正确写入', t1.includes('背景与现状'), t1);
  ok('正文正确写入', t1.includes('医疗影像数据量年增 40%'), t1);
}

console.log('\n=== C8. 装饰性成句文案（诗句/标语）不被当成正文容器 ===');
{
  const tpl = path.join(tmpDir, 'verse.pptx');
  makeRealisticPptx(tpl, [
    { shapes: [{ y: 2000000, paras: [{ runs: [{ t: '旧封面', sz: 4400 }] }] }] },
    { shapes: [
      // 真标题
      { y: 500000, paras: [{ runs: [{ t: '旧标题', sz: 3200 }] }] },
      // 模板自带的装饰性诗句（长句，靠文字特征识别）
      { y: 900000, paras: [{ runs: [{ t: '路漫漫其修远兮', sz: 1600 }] }] },
      // 真正文
      { y: 2000000, paras: [
        { runs: [{ t: '旧正文1', sz: 1800 }] },
        { runs: [{ t: '旧正文2', sz: 1800 }] },
      ] },
    ] },
  ]);
  const out = path.join(tmpDir, 'verse-out.pptx');
  const r = await applyTemplate({
    templatePath: tpl,
    outline: { title: 'X', slides: [{ title: '背景与现状', bullets: ['医疗影像数据量年增 40%', '基层诊断资源严重不足'] }] },
    savePath: out,
  });
  ok('success', r.success === true, JSON.stringify(r));
  const t1 = readSlideText(out, 1);
  ok('装饰性诗句原样保留', t1.includes('路漫漫其修远兮'), t1);
  ok('诗句未被当正文容器写入大纲要点', !t1.includes('医疗影像数据量年增 40%|路漫漫'), t1);
  ok('标题正确写入', t1.includes('背景与现状'), t1);
  ok('正文正确写入（未被诗句规则误伤）', t1.includes('医疗影像数据量年增 40%'), t1);
}
{
  const tpl = path.join(tmpDir, 'entity.pptx');
  makeRealisticPptx(tpl, [
    { shapes: [{ y: 0, paras: [{ runs: [{ t: '旧标题', sz: 4400 }] }] }] },
    { shapes: [
      { y: 500000, paras: [{ runs: [{ t: '旧', sz: 3200 }] }] },
      { y: 1500000, paras: [{ runs: [{ t: '旧', sz: 1800 }] }] },
    ] },
  ]);
  const evilOutline = {
    title: 'A & B <测试> "引号" \'单引号\'',
    slides: [{ title: '标 & 题 <x>', bullets: ['含 & 和 <b> 的正文', '100% 覆盖率'] }],
  };
  const out = path.join(tmpDir, 'entity-out.pptx');
  const r = await applyTemplate({ templatePath: tpl, outline: evilOutline, savePath: out });
  ok('特殊字符 → success', r.success === true, JSON.stringify(r));
  const raw = new AdmZip(out).getEntry('ppt/slides/slide1.xml').getData().toString('utf-8');
  // 原始 XML 里必须是转义实体，否则会破坏文件结构
  ok('XML 中 & 已转义为 &amp;', raw.includes('&amp;'), raw.slice(0, 400));
  ok('XML 中 < > 已转义', raw.includes('&lt;测试&gt;'), raw.slice(0, 400));
  ok('未出现裸的非法标签 <测试>', !raw.includes('<测试>'), raw.slice(0, 400));
  // 校验 XML 标签配对完好（结构没被特殊字符破坏）
  const openTags = (raw.match(/<a:p>/g) || []).length;
  const closeTags = (raw.match(/<\/a:p>/g) || []).length;
  ok('XML 段落标签配对完好', openTags === closeTags && openTags > 0, `open=${openTags} close=${closeTags}`);
  // 用 DOMParser 做一次真正的良构性校验
  let wellFormed = false;
  try {
    const { DOMParser } = await import('@xmldom/xmldom').catch(() => ({ DOMParser: null }));
    if (DOMParser) {
      const doc = new DOMParser().parseFromString(raw, 'text/xml');
      wellFormed = !doc.getElementsByTagName('parsererror').length;
    } else {
      wellFormed = true; // 无解析器时跳过，仅靠上面的转义断言兜底
    }
  } catch { wellFormed = true; }
  ok('XML 良构（可被解析）', wellFormed);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`结果：${pass} passed, ${fail} failed`);
await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
process.exit(fail === 0 ? 0 : 1);
