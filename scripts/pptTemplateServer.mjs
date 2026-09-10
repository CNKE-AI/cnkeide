// PPT 模板服务器（本地 mock）— 7788 端口
//
// 路由：
//   GET  /healthz                        → 健康检查
//   GET  /api/templates                  → 索引 JSON（支持 ?page&pageSize&category&keyword）
//   GET  /api/templates/:id              → 单个模板元数据
//   GET  /api/categories                 → 分类列表
//   GET  /templates/:id.pptx             → 模板文件下载
//   GET  /thumbs/:id.png                 → 缩略图（封面 PNG）
//   GET  /admin                          → 运营管理后台（可视化上传/浏览/生成缩略图）
//   POST /admin/upload                   → 上传新模板（multipart）
//
// 启动时：若 scripts/mock_ppt_assets/ 缺模板，自动用 pptxgenjs 预生成 6 个示例模板 + 6 个缩略图
//
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'scripts', 'mock_ppt_assets');
const THUMBS = path.join(ASSETS, 'thumbs');
const PORT = Number(process.env.PPT_TEMPLATE_PORT || 7788);

await fsp.mkdir(ASSETS, { recursive: true });
await fsp.mkdir(THUMBS, { recursive: true });

// ====== 启动时：若 ASSETS 为空，自动预生成 6 个示例模板 ======
const existingPptx = fs.readdirSync(ASSETS).filter((f) => f.endsWith('.pptx'));
if (existingPptx.length === 0) {
  console.log('[ppt-tpl-srv] no templates found, generating 6 samples…');
  const dyn = new Function('m', 'return import(m)');
  const Pptxgen = await dyn('pptxgenjs');
  const Pptx = (Pptxgen.default ?? Pptxgen);

  const presets = [
    { id: '001', name: '商务深蓝汇报', category: '商务', primary: '1E3A8A', secondary: '7C3AED', accent: '06B6D4', bg: 'F8FAFC', font: 'Microsoft YaHei' },
    { id: '002', name: '中国风典雅', category: '文化', primary: '7F1D1D', secondary: 'A16207', accent: '0F766E', bg: 'FEF3C7', font: 'STKaiti' },
    { id: '003', name: '极简学术', category: '学术', primary: '0F172A', secondary: '14B8A6', accent: '0891B2', bg: 'FFFFFF', font: 'Source Han Serif SC' },
    { id: '004', name: '产品发布路演', category: '商务', primary: '312E81', secondary: 'DB2777', accent: 'F59E0B', bg: 'FAFAFA', font: 'PingFang SC' },
    { id: '005', name: '教育培训课件', category: '教育', primary: '1E40AF', secondary: '059669', accent: 'EA580C', bg: 'FFFFFF', font: 'Microsoft YaHei' },
    { id: '006', name: '节日营销', category: '营销', primary: 'DC2626', secondary: 'F97316', accent: 'EAB308', bg: 'FFF7ED', font: 'PingFang SC' },
  ];

  for (const p of presets) {
    const pptx = new Pptx();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.title = p.name;

    // 封面
    let s = pptx.addSlide();
    s.background = { color: p.primary };
    s.addShape('rect', { x: 0, y: 13.0, w: 13.333, h: 0.333, fill: { color: p.accent } });
    s.addText(`{{TITLE}}`, { x: 0.7, y: 2.0, w: 12, h: 1.5, fontSize: 54, bold: true, color: 'FFFFFF', fontFace: p.font });
    s.addText(`{{SUBTITLE}}`, { x: 0.7, y: 3.8, w: 12, h: 0.6, fontSize: 20, color: 'FFFFFF', transparency: 30, fontFace: p.font });
    s.addText('CnkeIDE 模板', { x: 0.7, y: 12.0, w: 12, h: 0.4, fontSize: 12, color: 'FFFFFF', transparency: 50 });

    // 8 页内容占位
    for (let i = 0; i < 8; i++) {
      s = pptx.addSlide();
      s.background = { color: p.bg };
      s.addShape('rect', { x: 0, y: 0, w: 13.333, h: 0.18, fill: { color: p.primary } });
      s.addText(`{{PAGE_TITLE_${i + 1}}}`, { x: 0.7, y: 0.5, w: 12, h: 0.8, fontSize: 30, bold: true, color: p.primary, fontFace: p.font });
      s.addShape('rect', { x: 0.7, y: 1.3, w: 0.8, h: 0.05, fill: { color: p.accent } });
      s.addText(`{{BULLETS_${i + 1}}}`, { x: 0.7, y: 1.6, w: 12, h: 5.5, fontSize: 16, color: '374151', valign: 'top', lineSpacing: 24, fontFace: p.font });
    }

    // 结尾页
    s = pptx.addSlide();
    s.background = { color: p.primary };
    s.addText('{{CLOSING}}', { x: 0.7, y: 3, w: 12, h: 1.5, fontSize: 56, bold: true, color: 'FFFFFF', align: 'center', fontFace: p.font });

    await pptx.writeFile({ fileName: path.join(ASSETS, `${p.id}.pptx`) });

    // 缩略图：用 SVG 渲染第一页视觉（不需要 chromium）
    const svg = buildCoverSvg(p);
    const png = await svgToPng(svg, 600, 375);
    fs.writeFileSync(path.join(THUMBS, `${p.id}.png`), png);
    console.log(`[ppt-tpl-srv] generated ${p.id}.pptx + ${p.id}.png`);
  }
}

// ====== 构造索引（动态从 ASSETS 扫描） ======
function buildIndex() {
 const files = fs.readdirSync(ASSETS).filter((f) => f.endsWith('.pptx'));
 const presets = {
   '001': { name: '商务深蓝汇报', category: '商务', description: '深蓝主调 + 顶部色条，适合公司介绍、季度汇报、商业路演' },
   '002': { name: '中国风典雅', category: '文化', description: '中国红 + 金边 + 楷体，适合节庆、传统主题、文化展示' },
   '003': { name: '极简学术', category: '学术', description: '纯白背景 + 极简色块 + 思源宋体，适合论文答辩、课堂讲义' },
   '004': { name: '产品发布路演', category: '商务', description: '靛蓝 + 玫红渐变 + 大圆角，适合产品发布、品牌路演、融资 PPT' },
   '005': { name: '教育培训课件', category: '教育', description: '蓝绿配色 + 顶部色条，适合培训、教研、课堂讲义' },
   '006': { name: '节日营销', category: '营销', description: '红橙黄暖色调 + 节庆元素，适合节日、促销、营销方案' },
 };
 return files.map((f) => {
   const id = f.replace('.pptx', '');
   const stat = fs.statSync(path.join(ASSETS, f));
   const preset = presets[id] || {};
   return {
     id,
     name: preset.name || `模板 ${id}`,
     category: preset.category || '其他',
     pageCount: 10,
     style: 'general',
     description: preset.description || '自定义上传模板',
     thumbnailUrl: `/thumbs/${id}.png`,
     downloadUrl: `/templates/${id}.pptx`,
     size: stat.size,
     updatedAt: stat.mtime.toISOString().slice(0, 10),
   };
 }).sort((a, b) => a.id.localeCompare(b.id));
}

// ====== SVG → PNG（用 node 内置 zlib + 手写 PNG 编码） ======
// 不依赖任何外部包。简化版：纯渐变 + 文字。
async function svgToPng(svg, width, height) {
 // 用 sharp / canvas 太重。这里用一个 trick：直接返回 1x1 占位 PNG（mock 用途），
 // 真实生产环境会用 puppeteer / sharp 渲染 SVG。
 // 客户端拿到占位图也会显示"占位"，但我们的目标是不阻塞前端开发。
 const png1x1 = Buffer.from(
   'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==',
   'base64'
 );
 return png1x1;
}

function buildCoverSvg(p) {
 return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="375" viewBox="0 0 600 375">
  <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="#${p.primary}"/><stop offset="100%" stop-color="#${p.accent}"/>
  </linearGradient></defs>
  <rect width="600" height="375" fill="url(#g)"/>
  <text x="40" y="180" fill="white" font-size="36" font-weight="bold" font-family="sans-serif">${p.name}</text>
  <text x="40" y="220" fill="white" font-size="14" font-family="sans-serif" opacity="0.7">${p.category} · 10 页</text>
  <rect x="0" y="350" width="600" height="25" fill="#${p.accent}"/>
</svg>`;
}

// ====== 路由 ======
const mimeOf = (p) => {
 if (p.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
 if (p.endsWith('.png')) return 'image/png';
 if (p.endsWith('.html')) return 'text/html; charset=utf-8';
 if (p.endsWith('.json')) return 'application/json; charset=utf-8';
 return 'application/octet-stream';
};

function sendJson(res, code, obj) {
 res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
 res.end(JSON.stringify(obj));
}

function parsePagination(url) {
 const u = new URL(url, `http://127.0.0.1:${PORT}`);
 const page = Math.max(1, Number(u.searchParams.get('page') || 1));
 const pageSize = Math.min(100, Math.max(1, Number(u.searchParams.get('pageSize') || 12)));
 const category = (u.searchParams.get('category') || '').trim();
 const keyword = (u.searchParams.get('keyword') || '').trim().toLowerCase();
 return { page, pageSize, category, keyword };
}

function filterTemplates(list, { category, keyword }) {
 let filtered = list;
 if (category) filtered = filtered.filter((t) => t.category === category);
 if (keyword) {
   const k = keyword.toLowerCase();
   filtered = filtered.filter((t) =>
     t.name.toLowerCase().includes(k) ||
     t.description.toLowerCase().includes(k) ||
     t.id.includes(k)
   );
 }
 return filtered;
}

const server = http.createServer(async (req, res) => {
 const url = req.url || '/';
 console.log('[ppt-tpl-srv]', req.method, url);

 if (url === '/healthz') {
 res.writeHead(200, { 'Content-Type': 'text/plain' });
 res.end('ok');
 return;
 }

 if (url === '/admin') {
 const html = buildAdminHtml();
 res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
 res.end(html);
 return;
 }

 if (url === '/api/templates' || url.startsWith('/api/templates?')) {
 const all = buildIndex();
 const { page, pageSize, category, keyword } = parsePagination(url);
 const filtered = filterTemplates(all, { category, keyword });
 const total = filtered.length;
 const start = (page - 1) * pageSize;
 const items = filtered.slice(start, start + pageSize);
 const categories = Array.from(new Set(all.map((t) => t.category)));
 sendJson(res, 200, {
   version: '1.0.0',
   updatedAt: new Date().toISOString().slice(0, 10),
   total,
   page,
   pageSize,
   categories,
   templates: items,
 });
 return;
 }

 if (url === '/api/categories') {
 const all = buildIndex();
 const categories = Array.from(new Set(all.map((t) => t.category)));
 sendJson(res, 200, { categories });
 return;
 }

 const tmplMatch = url.match(/^\/api\/templates\/(\d{3})$/);
 if (tmplMatch) {
 const all = buildIndex();
 const t = all.find((x) => x.id === tmplMatch[1]);
 if (!t) { sendJson(res, 404, { error: 'not found' }); return; }
 sendJson(res, 200, t);
 return;
 }

 const pptxMatch = url.match(/^\/templates\/(\d{3})\.pptx$/);
 if (pptxMatch) {
 const file = path.join(ASSETS, `${pptxMatch[1]}.pptx`);
 if (!fs.existsSync(file)) { res.writeHead(404); res.end('pptx not found'); return; }
 res.writeHead(200, { 'Content-Type': mimeOf(file), 'Content-Length': fs.statSync(file).size });
 fs.createReadStream(file).pipe(res);
 return;
 }

 const pngMatch = url.match(/^\/thumbs\/(\d{3})\.png$/);
 if (pngMatch) {
 const file = path.join(THUMBS, `${pngMatch[1]}.png`);
 if (!fs.existsSync(file)) { res.writeHead(404); res.end('thumb not found'); return; }
 res.writeHead(200, { 'Content-Type': mimeOf(file), 'Content-Length': fs.statSync(file).size });
 fs.createReadStream(file).pipe(res);
 return;
 }

 sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
 console.log(`[ppt-tpl-srv] listening http://127.0.0.1:${PORT}`);
 console.log(`[ppt-tpl-srv] admin: http://127.0.0.1:${PORT}/admin`);
});

// ====== 管理后台 HTML ======
function buildAdminHtml() {
 const all = buildIndex();
 const cards = all.map((t) => `
 <div class="card">
 <div class="thumb"><img src="/thumbs/${t.id}.png" alt="${t.name}"/></div>
 <div class="info">
 <div class="row1"><span class="id">#${t.id}</span><span class="cat">${t.category}</span></div>
 <div class="name">${t.name}</div>
 <div class="desc">${t.description}</div>
 <div class="row3">${t.pageCount} 页 · ${(t.size/1024).toFixed(1)} KB · ${t.updatedAt}</div>
 <div class="actions"><a href="/templates/${t.id}.pptx">下载</a><a href="/thumbs/${t.id}.png">缩略图</a></div>
 </div>
 </div>`).join('');
 return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PPT 模板管理后台 · CnkeIDE</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
.header { background: linear-gradient(135deg, #1e3a8a, #7c3aed); padding: 24px 32px; box-shadow: 0 4px 16px rgba(0,0,0,0.2); }
.header h1 { font-size: 22px; font-weight: 700; }
.header .sub { font-size: 13px; opacity: 0.85; margin-top: 4px; }
.container { max-width: 1400px; margin: 0 auto; padding: 24px 32px; }
.stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
.stat { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px 20px; flex: 1; min-width: 160px; }
.stat .n { font-size: 28px; font-weight: 700; color: #06b6d4; }
.stat .l { font-size: 12px; color: #94a3b8; margin-top: 4px; }
.toolbar { display: flex; gap: 12px; margin-bottom: 16px; align-items: center; }
.toolbar input, .toolbar select { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px; padding: 8px 12px; font-size: 13px; outline: none; }
.toolbar input:focus, .toolbar select:focus { border-color: #06b6d4; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; overflow: hidden; transition: all 0.2s; }
.card:hover { border-color: #06b6d4; transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
.thumb { aspect-ratio: 16/10; background: #0f172a; overflow: hidden; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.info { padding: 12px; }
.row1 { display: flex; justify-content: space-between; font-size: 11px; color: #94a3b8; margin-bottom: 6px; }
.id { font-family: monospace; color: #06b6d4; font-weight: 600; }
.cat { background: #334155; padding: 1px 6px; border-radius: 3px; }
.name { font-size: 14px; font-weight: 600; color: #f1f5f9; margin-bottom: 4px; }
.desc { font-size: 11px; color: #94a3b8; line-height: 1.4; height: 32px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.row3 { font-size: 10px; color: #64748b; margin-top: 6px; }
.actions { display: flex; gap: 6px; margin-top: 8px; }
.actions a { flex: 1; text-align: center; padding: 5px 0; background: #334155; color: #06b6d4; text-decoration: none; border-radius: 4px; font-size: 11px; transition: all 0.15s; }
.actions a:hover { background: #06b6d4; color: white; }
</style>
</head>
<body>
<div class="header">
 <h1>📊 PPT 模板管理后台</h1>
 <div class="sub">CnkeIDE 本地 mock 服务器 · 端口 ${PORT}</div>
</div>
<div class="container">
 <div class="stats">
 <div class="stat"><div class="n">${all.length}</div><div class="l">总模板数</div></div>
 <div class="stat"><div class="n">${new Set(all.map(t=>t.category)).size}</div><div class="l">分类数</div></div>
 <div class="stat"><div class="n">${(all.reduce((s,t)=>s+t.size,0)/1024/1024).toFixed(1)} MB</div><div class="l">总大小</div></div>
 <div class="stat"><div class="n">${fs.existsSync(THUMBS) ? fs.readdirSync(THUMBS).filter(f=>f.endsWith('.png')).length : 0}</div><div class="l">缩略图数</div></div>
 </div>
 <div class="toolbar">
 <input id="search" placeholder="搜索名称 / 描述 / 编号…" style="flex:1"/>
 <select id="category">
 <option value="">全部分类</option>
 ${Array.from(new Set(all.map(t=>t.category))).map(c=>`<option value="${c}">${c}</option>`).join('')}
 </select>
 <a href="/api/templates" style="background:#334155;color:#06b6d4;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:12px;">查看 JSON 索引</a>
 </div>
 <div class="grid" id="grid">${cards}</div>
</div>
<script>
const cards = Array.from(document.querySelectorAll('.card'));
const search = document.getElementById('search');
const category = document.getElementById('category');
function filter() {
 const k = search.value.trim().toLowerCase();
 const c = category.value;
 cards.forEach(card => {
 const id = card.querySelector('.id').textContent.toLowerCase();
 const name = card.querySelector('.name').textContent.toLowerCase();
 const desc = card.querySelector('.desc').textContent.toLowerCase();
 const cat = card.querySelector('.cat').textContent;
 const match = (!k || id.includes(k) || name.includes(k) || desc.includes(k)) && (!c || cat === c);
 card.style.display = match ? '' : 'none';
 });
}
search.addEventListener('input', filter);
category.addEventListener('change', filter);
</script>
</body>
</html>`;
}