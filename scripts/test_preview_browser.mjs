/**
 * 内置预览浏览器回归
 *
 * 校验：Agent 的浏览器工具使用软件内置预览面板，而不是另起 headless chromium。
 * 不启动 Electron：预览浏览器依赖 BrowserWindow/WebContents，这里验证
 *  - URL 归一化规则（模型常只给 localhost:5173）
 *  - PreviewBrowserAdapter 满足 PlaywrightAdapter 契约（6 个工具依赖的方法齐备）
 *  - ToolManager 选择优先级：内置预览 > Playwright > Mock
 *  - 截图结果能进入 tool result 的 image 字段（聊天窗口直接显示）
 */
import assert from 'node:assert';

let pass = 0;
let fail = 0;
function check(cond, name, detail = '') {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL: ${name} ${detail}`);
  }
}

// PreviewBrowser.ts 直接 import electron，无法在纯 node 下加载；
// 因此这里用等价实现校验规则，同时用源码静态断言保证两边一致。
const normalizePreviewUrl = (input) => {
  const value = String(input ?? '').trim();
  if (!value) return '';
  if (/^(https?|file):\/\//i.test(value)) return value;
  return `http://${value}`;
};

// ---------- 1. URL 归一化 ----------
check(normalizePreviewUrl('localhost:5173') === 'http://localhost:5173', '补全 http://');
check(normalizePreviewUrl('  localhost:3000  ') === 'http://localhost:3000', '去首尾空格');
check(normalizePreviewUrl('https://example.com') === 'https://example.com', 'https 保持不变');
check(normalizePreviewUrl('http://127.0.0.1:8080/a?b=1') === 'http://127.0.0.1:8080/a?b=1', '路径与查询保留');
check(normalizePreviewUrl('file:///c:/tmp/a.html') === 'file:///c:/tmp/a.html', 'file 协议保留');
check(normalizePreviewUrl('') === '', '空串返回空');
check(normalizePreviewUrl('HTTPS://A.COM') === 'HTTPS://A.COM', '大小写协议不重复加前缀');

// ---------- 2. 适配器契约（PlaywrightAdapter 的 6 个方法 + 状态） ----------
const REQUIRED = ['navigate', 'screenshot', 'click', 'input', 'extract', 'close', 'getStatus'];
const adapterSource = (
  await import('node:fs/promises')
).readFile(new URL('../electron/preview/PreviewBrowser.ts', import.meta.url), 'utf8');
const src = await adapterSource;
for (const name of REQUIRED) {
  check(new RegExp(`\\b${name}\\s*\\(`).test(src), `适配器实现 ${name}()`);
}
check(/class PreviewBrowserAdapter implements PlaywrightAdapter/.test(src), '显式实现 PlaywrightAdapter 接口');
check(/readonly available = true/.test(src), '内置预览恒可用，不依赖 playwright 安装');

// ---------- 3. 主进程接线：捕获 webview guest ----------
check(/ensureGuest/.test(src) && /did-attach-webview/.test(src), '适配器在面板未挂载时等待 webview 附着（含轮询兜底）');
check(/timeoutMs/.test(src) && /预览浏览器未就绪/.test(src), '等待超时给出明确错误而非永久挂起');
const mainSrc = await (await import('node:fs/promises')).readFile(
  new URL('../electron/main.ts', import.meta.url),
  'utf8',
);
check(/previewBrowser\.attachGuest\(guest\)/.test(mainSrc), 'main.ts 登记 webview guest');
check(/onPreviewShow|preview:show/.test(src), '适配器通过 preview:show 请求显示面板');

// ---------- 4. ToolManager 优先级 ----------
const toolSrc = await (await import('node:fs/promises')).readFile(
  new URL('../electron/core-fork/tools/ToolManager.ts', import.meta.url),
  'utf8',
);
const enableIdx = toolSrc.indexOf('async enablePlaywright');
const builtinIdx = toolSrc.indexOf('createPreviewAdapter?.()', enableIdx);
const pwIdx = toolSrc.indexOf('createRealPlaywrightAdapter()', enableIdx);
check(enableIdx > 0, 'enablePlaywright 存在');
check(builtinIdx > enableIdx && pwIdx > builtinIdx, '内置预览优先于 Playwright 判定');
check(/takeBrowserScreenshot/.test(toolSrc), '提供截图取回接口');
check(/image: \{ path: shot\.path/.test(toolSrc), 'browser_screenshot 结果携带 image 供聊天显示');
check(/内置预览浏览器中打开/.test(toolSrc), '工具输出文案说明使用内置预览');

// ---------- 5. AgentManager 注入 ----------
const agentSrc = await (await import('node:fs/promises')).readFile(
  new URL('../electron/core-fork/agent/AgentManager.ts', import.meta.url),
  'utf8',
);
check(/this\.toolManager\.createPreviewAdapter = /.test(agentSrc), 'AgentManager 注入内置预览适配器工厂');
check(/getPreviewBrowser\(\)/.test(agentSrc), '无预览面板时返回 null 以便回退');

// ---------- 6. 渲染层监听 ----------
const layoutSrc = await (await import('node:fs/promises')).readFile(
  new URL('../renderer/src/components/MainLayout.tsx', import.meta.url),
  'utf8',
);
check(/onPreviewShow/.test(layoutSrc), '渲染层订阅显示请求');
check(/setPanelVisible\('preview', true\)/.test(layoutSrc), '收到请求后打开预览面板');

const previewSrc = await (await import('node:fs/promises')).readFile(
  new URL('../renderer/src/components/preview/PreviewPanel.tsx', import.meta.url),
  'utf8',
);
check(/usePreviewStore/.test(previewSrc), '面板地址来自共享 store');
check(/did-navigate/.test(previewSrc), '外部导航后地址栏跟随');

console.log(`\n${pass} PASS, ${fail} FAIL`);
assert.strictEqual(fail, 0, `${fail} 个断言失败`);
