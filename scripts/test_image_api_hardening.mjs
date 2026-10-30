/**
 * 生图 API 只读加固回归
 *
 * 校验：接口不可编辑、防篡改、零信息泄露。
 * - 输入校验：prompt 长度/控制字符/空值；size 白名单
 * - 错误脱敏：上游响应体、URL、IP、模型名、堆栈绝不出现在对外错误中
 * - 输出最小化：成功结果不含内部临时 URL；LLM 可见文案不含本地路径
 */
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
function check(cond, name, detail = '') {
  if (cond) pass++;
  else { fail++; console.log(`FAIL: ${name} ${detail}`); }
}

const { OpenAIImageGenAdapter, validateImagePrompt } = await import(
  new URL('../electron/core-fork/tools/ImageGenTools.ts', import.meta.url).href
);

// ---------- 1. prompt 输入校验 ----------
check(validateImagePrompt('一只柴犬').ok === true, '常规描述通过');
check(validateImagePrompt('  一只柴犬  ').ok && validateImagePrompt('  一只柴犬  ').value === '一只柴犬', '首尾空白裁剪');
check(validateImagePrompt('').ok === false, '空描述拒绝');
check(validateImagePrompt(null).ok === false, 'null 拒绝');
check(validateImagePrompt(123).ok === false, '非字符串拒绝');
check(validateImagePrompt('a\u0000\u001Fb').value === 'ab', '控制字符被清除');
check(validateImagePrompt('x'.repeat(2001)).ok === false, '超长描述拒绝（2001 字）');
check(validateImagePrompt('x'.repeat(2000)).ok === true, '边界 2000 字通过');

// ---------- 2. 错误脱敏：上游响应体绝不透传 ----------
const LEAKY_BODY = JSON.stringify({
  error: { message: 'account group internal-endpoint https://gw.internal.example/v1 key sk-SECRET leaked quota for gpt-image-2' },
});
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'imgsec-'));
const savePath = path.join(tmp, 'out.png');

// 2a. HTTP 4xx：响应体含敏感信息，对外错误必须只有通用文案
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    text: async () => LEAKY_BODY,
    json: async () => ({}),
  });
  const a = new OpenAIImageGenAdapter('sk-test', 'https://gw.internal.example/v1', 'gpt-image-2');
  const r = await a.generate({ prompt: 'a cat', savePath });
  globalThis.fetch = originalFetch;
  check(r.success === false, '4xx 失败');
  check(!JSON.stringify(r).includes('sk-SECRET'), '密钥不外泄');
  check(!JSON.stringify(r).includes('gw.internal.example'), '内部端点不外泄');
  check(!JSON.stringify(r).includes('gpt-image-2'), '模型名不外泄');
  check(!JSON.stringify(r).includes('account group'), '上游响应体不外泄');
  check(/暂不支持当前模型|稍后重试|鉴权失败|拒绝/.test(r.error), '错误为通用分类文案', r.error);
}

// 2b. 网络异常：err.message 含 URL/IP，对外错误必须脱敏
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('fetch failed: connect ECONNREFUSED 10.0.0.1:443 https://gw.internal.example/v1/images/generations');
  };
  const a = new OpenAIImageGenAdapter('sk-test', 'https://gw.internal.example', 'gpt-image-2');
  const r = await a.generate({ prompt: 'a cat', savePath });
  globalThis.fetch = originalFetch;
  check(r.success === false, '网络失败');
  check(!JSON.stringify(r).includes('10.0.0.1'), 'IP 不外泄');
  check(!JSON.stringify(r).includes('gw.internal.example'), '域名不外泄');
  check(!JSON.stringify(r).includes('ECONNREFUSED'), '系统错误码不外泄');
  check(/网络异常/.test(r.error), '网络错误为通用文案', r.error);
}

// ---------- 3. 成功输出最小化：不含内部临时 URL ----------
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ url: 'https://internal-cdn.example/tmp/abc123.png?sig=SECRET', }],
    }),
  });
  globalThis.fetch = Object.assign(globalThis.fetch, {});
  // 第二次 fetch 是下载图片
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url) => {
    call++;
    if (call === 1) return { ok: true, status: 200, json: async () => ({ data: [{ url: 'https://internal-cdn.example/tmp/abc123.png?sig=SECRET' }] }) };
    return {
      ok: true, status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new TextEncoder().encode('PNGDATA').buffer,
    };
  };
  const a = new OpenAIImageGenAdapter('sk-test', 'https://api.example.com/v1', 'gpt-image-2');
  const r = await a.generate({ prompt: 'a cat', savePath });
  globalThis.fetch = originalFetch;
  check(r.success === true, 'URL 型返回成功');
  check(r.url === undefined, '结果不携带内部临时 URL');
  check(!JSON.stringify(r).includes('sig=SECRET'), '临时 URL 签名不外泄');
  check(r.dataUrl?.startsWith('data:image/png;base64,'), 'dataUrl 供 UI 展示');
}

await fs.rm(tmp, { recursive: true, force: true });

// ---------- 4. 源码级断言：工具层防篡改与输出约束 ----------
const toolSrc = await fs.readFile(new URL('../electron/core-fork/tools/ToolManager.ts', import.meta.url), 'utf8');
check(/validateImagePrompt\(args\.prompt\)/.test(toolSrc), '执行层校验 prompt');
check(/IMAGE_SIZES\.includes/.test(toolSrc), '执行层校验 size 白名单');
check(/尺寸参数无效/.test(toolSrc), '无效尺寸显式拒绝');
check(/已生成图片并保存到本地，已显示在聊天窗口。/.test(toolSrc), 'LLM 可见文案不含路径/供应商');
check(!/已生成并保存本地图片（\$\{r\.provider\}）/m.test(toolSrc), '供应商名不再进入 LLM 文案');
const agentSrc = await fs.readFile(new URL('../electron/core-fork/agent/AgentManager.ts', import.meta.url), 'utf8');
check(/image: _imageOnly/.test(agentSrc), 'image 字段回传模型前被剥离');
const ipcSrc = await fs.readFile(new URL('../electron/ipc/handlers.ts', import.meta.url), 'utf8');
check(/image\\?\/\(png\|jpeg\|webp\)\)?;base64/.test(ipcSrc), '保存接口严格校验 dataUrl 格式');

console.log(`\n${pass} PASS, ${fail} FAIL`);
assert.strictEqual(fail, 0, `${fail} 个断言失败`);
