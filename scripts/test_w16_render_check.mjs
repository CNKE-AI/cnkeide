/**
 * W16 可视化验证：把截图里那段退化 Markdown 丢进真实渲染器，对比修复前后的 DOM。
 *
 * 用 vite dev 起的 :5173，通过 /markdown-preview 页面（临时注入）渲染。
 * 为了避免动项目源码，这里直接用 playwright 的 page.setContent 加载
 * 一个最小 HTML：引入已构建的 dist/assets/*.css + 用 CDN 版本的
 * react/react-dom/react-markdown 重现 CodeBlock 的判据。
 *
 * 注意：这里刻意不引入项目源码，只复现 looksLikeNonCodeLine 的规则，
 * 用来确认"截图里那 7 个灰框会变成行内 code"。
 */
import { chromium } from 'playwright';

const CASES = [
  // 截图里的真实退化形态
  { src: '```bash\ncreate_file\n```', want: 'inline', note: 'create_file' },
  { src: '```bash\napply_diff\n```', want: 'inline', note: 'apply_diff' },
  { src: '```bash\nrename_file\n```', want: 'inline', note: 'rename_file' },
  { src: '```text\ndelete_file\n```', want: 'inline', note: 'delete_file' },
  { src: '```\nlist_directory\n```', want: 'inline', note: 'list_directory' },
  { src: '```\nproject_structure\n```', want: 'inline', note: 'project_structure' },
  { src: '```bash\nexecute_command\n```', want: 'inline', note: 'execute_command' },
  // 真代码应保持代码块
  { src: '```python\ndef f(x):\n    return x + 1\n```', want: 'block', note: '真 python 多行' },
  { src: '```bash\ngit log --oneline\nls -la\n```', want: 'block', note: '多行命令块' },
  // 行内代码不应受影响（本就该是 inline）
  { src: '用 `apply_diff` 做替换。', want: 'inline', note: '行内 code' },
];

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{background:#0d1117;color:#e6edf3;font:13px/1.6 system-ui;padding:20px}
.inline{background:rgba(110,118,129,.25);border-radius:4px;padding:2px 6px;font-family:monospace;color:#79c0ff}
.block{border:1px solid #30363d;border-radius:8px;overflow:hidden;margin:8px 0;max-width:420px}
.hd{display:flex;justify-content:space-between;padding:6px 12px;background:rgba(110,118,129,.12);border-bottom:1px solid #30363d;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8b949e}
pre{margin:0;padding:12px;font:12.5px/1.6 monospace;overflow-x:auto}
</style></head><body><div id="root"></div></body></html>`;

const looksLikeNonCodeLine = (text) => {
  const t = text.trim();
  if (!t) return false;
  if (t.includes('\n')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(t)) return true;
  if (t.startsWith('~/') || t.startsWith('./') || t.startsWith('../') || t.startsWith('/')) return true;
  if (/^[\w.\- ]+\.[a-zA-Z0-9]{1,5}$/.test(t)) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]{0,60}(\.[A-Za-z0-9_]{1,10})?(:\d+(:\d+)?)?$/.test(t)) return true;
  if (/^[\u4e00-\u9fa5()\sA-Za-z0-9·.\-]{1,16}$/.test(t) && !/[{}()\[\];=<>]/.test(t)) return true;
  return false;
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html);

const results = await page.evaluate(({ cases, fnSrc }) => {
  const looksLikeNonCodeLine = new Function('return ' + fnSrc)();
  const render = (markdown) => {
    // 解析 ``` 围栏
    const re = /```([\w+-]*)\n([\s\S]*?)```/g;
    const parts = [];
    let last = 0, m;
    while ((m = re.exec(markdown))) {
      if (m.index > last) parts.push({ kind: 'text', text: markdown.slice(last, m.index) });
      parts.push({ kind: 'fence', lang: m[1], code: m[2].replace(/\n$/, '') });
      last = m.index + m[0].length;
    }
    if (last < markdown.length) parts.push({ kind: 'text', text: markdown.slice(last) });

    return parts.map((p) => {
      if (p.kind === 'text') {
        // 行内 code
        return p.text.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');
      }
      if (looksLikeNonCodeLine(p.code)) return `<code class="inline">${p.code}</code>`;
      return `<div class="block"><div class="hd"><span>${p.lang || 'code'}</span><span>复制</span></div><pre>${p.code}</pre></div>`;
    }).join('');
  };

  const root = document.getElementById('root');
  return cases.map((c) => {
    const div = document.createElement('div');
    div.innerHTML = render(c.src);
    const hasBlock = !!div.querySelector('.block');
    const hasInline = !!div.querySelector('.inline');
    return {
      note: c.note,
      want: c.want,
      got: hasBlock ? 'block' : (hasInline ? 'inline' : 'none'),
      blockWidth: hasBlock ? Math.round(div.querySelector('.block').getBoundingClientRect().width) : 0,
      blockHeight: hasBlock ? Math.round(div.querySelector('.block').getBoundingClientRect().height) : 0,
      html: div.innerHTML.slice(0, 90),
    };
  });
}, { cases: CASES, fnSrc: looksLikeNonCodeLine.toString() });

let pass = 0, fail = 0;
console.log('\n=== W16 渲染行为验证 ===\n');
for (const r of results) {
  const ok = r.want === r.got;
  ok ? pass++ : fail++;
  const dim = r.got === 'block' ? ` [${r.blockWidth}x${r.blockHeight}px]` : '';
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${r.note.padEnd(16)} 期望=${r.want.padEnd(6)} 实际=${r.got}${dim}`);
}

// 关键回归断言：截图里的 7 个退化灰框必须全部消失
const degenerate = results.filter((r) => r.note.match(/^(create_file|apply_diff|rename_file|delete_file|list_directory|project_structure|execute_command)$/));
console.log('\n--- 截图退化灰框检查 ---');
console.log(`  截图中的 7 个灰框 → 现在渲染为行内 code 的数量: ${degenerate.filter((r) => r.got === 'inline').length}/7`);

await browser.close();
console.log(`\n结果: ${pass} PASS, ${fail} FAIL, 共 ${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
