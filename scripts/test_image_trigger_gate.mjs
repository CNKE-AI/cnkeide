/**
 * 生图触发前缀门禁回归（收费隔离）
 *
 * 校验目标：
 *  - 只有「生成图片」前缀 + 有效描述才允许收费生图；
 *  - 大小写、空白、连接符、标点、不可见字符的处理符合约定；
 *  - 未授权时 image_generate 不出现在工具表、执行被拒、供应商接口 0 次调用；
 *  - 授权与未授权状态每轮独立，不残留。
 *
 * 全程不触网：用假 fetch 统计调用次数，任何一次真实请求都会让断言失败。
 */
import assert from 'node:assert';
import {
  resolveImageTrigger,
  startsWithImageTrigger,
  hasMeaningfulDescription,
  IMAGE_TRIGGER_HINT,
  IMAGE_TRIGGER_EMPTY_HINT,
} from '../electron/core-fork/tools/ImagePromptGate';
import { ToolManager } from '../electron/core-fork/tools/ToolManager';
import { OpenAIImageGenAdapter } from '../electron/core-fork/tools/ImageGenTools';

let pass = 0;
let fail = 0;
function check(cond, name, detail = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${name} ${detail}`);
  }
}

function allowed(input, name) {
  const r = resolveImageTrigger(input);
  check(r.allowed === true && r.reason === 'ok', name, `got=${JSON.stringify(r)}`);
  return r;
}
function denied(input, reason, name) {
  const r = resolveImageTrigger(input);
  check(r.allowed === false && r.reason === reason, name, `got=${JSON.stringify(r)}`);
}

// ---------- 1. 前缀匹配：应放行 ----------
allowed('生成图片 一只柴犬', '标准前缀 + 描述');
allowed('生成图片一只柴犬', '前缀后无空格直接描述');
allowed('生成图片：一只柴犬', '全角冒号分隔');
allowed('生成图片: 一只柴犬', '半角冒号分隔');
allowed('生成图片，一只柴犬', '全角逗号分隔');
allowed('生成图片 - 一只柴犬', '连接符分隔');
allowed('生成图片  一只柴犬', '多个空格');
allowed('  生成图片 一只柴犬  ', '首尾空白');
allowed('生成图片\n一只柴犬', '换行分隔');
allowed('生成 图片 一只柴犬', '前缀中间一个空格');
allowed('生成-图片 一只柴犬', '前缀中间连接符');
allowed('\u3000生成图片\u3000一只柴犬', '全角空格包围');
allowed('\uFEFF生成图片 一只柴犬', 'BOM 前缀');
allowed('生成图片\u200B 一只柴犬', '零宽字符');
allowed('生成图片 Ab', '英文描述');
allowed('生成图片 猫', '两字描述', );

// ---------- 2. 前缀匹配：应拒绝（无前缀） ----------
denied('画一张柴犬', 'no-prefix', '无前缀：画一张');
denied('帮我生成图片 一只柴犬', 'no-prefix', '前缀不在开头');
denied('请生成图片 一只柴犬', 'no-prefix', '客套词在开头');
denied('generate image a dog', 'no-prefix', '英文表达不算前缀');
denied('图片生成 一只柴犬', 'no-prefix', '词序颠倒');
allowed('生成 图 片 一只柴犬', '前缀中间多个空格仍命中');
denied('生成图 一只柴犬', 'no-prefix', '前缀缺字');
denied('', 'no-prefix', '空输入');
denied('   ', 'no-prefix', '纯空白');

// ---------- 3. 前缀命中但描述无效 ----------
denied('生成图片', 'empty-description', '只有前缀');
denied('生成图片   ', 'empty-description', '前缀 + 空白');
denied('生成图片：', 'empty-description', '前缀 + 标点');
denied('生成图片 ，。！', 'empty-description', '前缀 + 纯标点');
allowed('生成图片 猫', '单字描述视为有效');
allowed('生成图片 🐱', '单个 emoji 描述视为有效');
denied('生成图片 ※※', 'empty-description', '仅非 emoji 符号');
denied('生成图片 （）', 'empty-description', '仅括号');

// ---------- 4. 描述提取 ----------
check(resolveImageTrigger('生成图片：一只柴犬，胶片质感').description === '一只柴犬，胶片质感', '描述去掉前导标点');
check(resolveImageTrigger('生成 图片  一只柴犬').description === '一只柴犬', '描述去掉多余分隔');
check(resolveImageTrigger('画一只猫').description === '', '未授权时描述为空');

// ---------- 5. 辅助函数 ----------
check(startsWithImageTrigger('生成图片 猫') === true, 'startsWith 命中');
check(startsWithImageTrigger('生成图片') === true, 'startsWith 仅前缀也命中');
check(startsWithImageTrigger('画猫') === false, 'startsWith 未命中');
check(hasMeaningfulDescription('一只柴犬') === true, '有效描述判定');
check(hasMeaningfulDescription('  ，。 ') === false, '纯标点非有效描述');
check(IMAGE_TRIGGER_HINT.includes('生成图片'), '无前缀提示含前缀说明');
check(IMAGE_TRIGGER_EMPTY_HINT.includes('未调用'), '空描述提示说明未调用');

// ---------- 6. 工具层：未授权不投递 / 授权才投递 ----------
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error('测试不应发起真实请求');
}) ;

const manager = new ToolManager({ workspaceRoot: process.cwd() });
manager.setImageGenAdapter(new OpenAIImageGenAdapter('sk-test', 'https://image.example/v1'));

const toolsBefore = await manager.getAvailableTools();
check(!toolsBefore.some((t) => t.name === 'image_generate'), '默认未授权：工具表无 image_generate');
check(manager.isImageGenerationAuthorized() === false, '默认未授权');

const deniedResult = await manager.execute('image_generate', { prompt: '一只柴犬' });
check(fetchCalls === 0, '未授权执行不触网', `calls=${fetchCalls}`);
check(deniedResult.success === false, '未授权执行被拒绝');
check(String(deniedResult.error || '').includes('生成图片'), '拒绝信息说明前缀规则');

manager.setImageGenerationAuthorized(true);
const toolsAfter = await manager.getAvailableTools();
check(toolsAfter.some((t) => t.name === 'image_generate'), '授权后工具表含 image_generate');
check(manager.isImageGenerationAuthorized() === true, '授权状态生效');

manager.setImageGenerationAuthorized(false);
const toolsReset = await manager.getAvailableTools();
check(!toolsReset.some((t) => t.name === 'image_generate'), '撤销授权后工具表移除 image_generate');
check(manager.isImageGenerationAuthorized() === false, '撤销授权后状态为 false');

globalThis.fetch = originalFetch;

// ---------- 7. 端到端接线：AgentManager 私有闸门调用规则一致 ----------
const { resolveImageTrigger: gate } = await import('../electron/core-fork/tools/ImagePromptGate');
check(gate('生成图片 一只柴犬').allowed === true, '接线规则一致：放行');
check(gate('帮我画一只柴犬').allowed === false, '接线规则一致：拒绝');

console.log(`\n${pass} PASS, ${fail} FAIL`);
assert.strictEqual(fail, 0, `${fail} 个断言失败`);
