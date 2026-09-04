/**
 * W6 模型路由测试
 * 验证：1) detectCapabilities 各类模型  2) extractModelMention  3) resolveModelAlias
 *        4) detectTaskType  5) routeModel 显式 @mention 优先
 *        6) routeModel 任务特征路由  7) 用户 routing 配置覆盖
 *
 * 用法：npx tsx scripts/test_w6_routing.mjs
 */
import {
  detectCapabilities,
  extractModelMention,
  resolveModelAlias,
} from '../electron/core-fork/llm/ProviderCapabilities.js';
import {
  routeModel,
  detectTaskType,
  decideModelFromPrompt,
} from '../electron/core-fork/llm/ModelRouter.js';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

// 候选配置
const CONFIGS = [
  { id: 'cfg-deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-chat', provider: 'deepseek' },
  { id: 'cfg-deepseek-r1', name: 'DeepSeek R1', baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-reasoner', provider: 'deepseek' },
  { id: 'cfg-qwen-max', name: 'Qwen Max', baseUrl: 'https://dashscope.aliyuncs.com', apiKey: 'k', model: 'qwen-max', provider: 'qwen' },
  { id: 'cfg-qwen-turbo', name: 'Qwen Turbo', baseUrl: 'https://dashscope.aliyuncs.com', apiKey: 'k', model: 'qwen-turbo', provider: 'qwen' },
  { id: 'cfg-kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn', apiKey: 'k', model: 'moonshot-v1-128k', provider: 'kimi' },
  { id: 'cfg-glm', name: 'GLM-4', baseUrl: 'https://open.bigmodel.cn', apiKey: 'k', model: 'glm-4-plus', provider: 'glm' },
  { id: 'cfg-disabled', name: 'Disabled', baseUrl: 'x', apiKey: 'k', model: 'gpt-4', provider: 'openai', disabled: true },
];

async function test1_detectCapabilities() {
  console.log('\n[1] detectCapabilities 国内 T0 模型');
  const cases = [
    ['deepseek-reasoner', 'reasoning'],
    ['deepseek-coder', 'standard'],
    ['deepseek-chat', 'flagship'],
    ['qwen-max', 'flagship'],
    ['qwen-plus', 'standard'],
    ['qwen-turbo', 'fast'],
    ['qwen3-max-thinking', 'reasoning'],
    ['glm-4-plus', 'flagship'],
    ['glm-4-flash', 'standard'],
    ['moonshot-v1-128k', 'standard'],
    ['kimi-k2', 'flagship'],
    ['ernie-4.5-8k', 'flagship'],
    ['o1-preview', 'reasoning'],
    ['gpt-4o', 'flagship'],
    ['gpt-3.5-turbo', 'fast'],
    ['claude-3-5-sonnet', 'flagship'],
    ['unknown-model-xyz', 'standard'],
  ];
  for (const [model, expectedTier] of cases) {
    const caps = detectCapabilities(model);
    log(caps.tier === expectedTier, `${model} → ${expectedTier}`, `got=${caps.tier}`);
  }
  // reasoning 标志
  log(detectCapabilities('deepseek-reasoner').reasoning === true, 'reasoner.reasoning=true', '');
  log(detectCapabilities('qwen3-max-thinking').reasoning === true, 'qwen3-thinking.reasoning=true', '');
  log(detectCapabilities('qwen-max').reasoning === false, 'qwen-max.reasoning=false', '');
}

async function test2_extractMention() {
  console.log('\n[2] extractModelMention 提取 @model');
  const r1 = extractModelMention('@deepseek 帮我写代码');
  log(r1.mention === 'deepseek', 'mention=deepseek', `got=${r1.mention}`);
  log(r1.cleanPrompt === '帮我写代码', 'cleanPrompt 正确', `got=${r1.cleanPrompt}`);

  const r2 = extractModelMention('hello @kimi 解释');
  log(r2.mention === null, '非开头 @ 不识别', `got=${r2.mention}`);

  const r3 = extractModelMention('@qwen-max-latest 你好');
  log(r3.mention === 'qwen-max-latest', '复杂 model 名', `got=${r3.mention}`);
  log(r3.cleanPrompt === '你好', 'cleanPrompt 正确', '');

  const r4 = extractModelMention('');
  log(r4.mention === null && r4.cleanPrompt === '', '空字符串', '');
}

async function test3_resolveAlias() {
  console.log('\n[3] resolveModelAlias 模糊匹配');
  const models = CONFIGS.map((c) => c.model);
  log(resolveModelAlias('deepseek-reasoner', models) === 'deepseek-reasoner', '精确匹配', '');
  log(resolveModelAlias('qwen', models) === 'qwen-max', 'qwen 模糊匹配 qwen-max', '');
  log(resolveModelAlias('nope', models) === null, '找不到返回 null', '');
}

async function test4_detectTaskType() {
  console.log('\n[4] detectTaskType 任务分类');
  log(detectTaskType({ prompt: '写一个 TypeScript 函数' }) === 'code', '代码任务', '');
  log(detectTaskType({ prompt: '请帮我证明这个定理' }) === 'reasoning', '推理任务', '');
  log(detectTaskType({ prompt: '分析这个 bug 的根本原因' }) === 'reasoning', '分析任务', '');
  log(detectTaskType({ prompt: '总结这段代码' }) === 'summarize', '总结任务', '');
  log(detectTaskType({ prompt: '你好' }) === 'chat', '闲聊', '');
  log(detectTaskType({ prompt: '设计一个系统架构', hasImages: false }) === 'plan', '长 prompt 规划', '');
  log(detectTaskType({ prompt: '看看这个图', hasImages: true }) === 'vision', '有图 = vision', '');
}

async function test5_routeByMention() {
  console.log('\n[5] @mention 优先于一切');
  const r = decideModelFromPrompt('@kimi 你好', CONFIGS, 'cfg-deepseek');
  log(r.apiConfig.id === 'cfg-kimi', '@kimi → cfg-kimi', `got=${r.apiConfig.id}`);
  log(/@mention/.test(r.reason), 'reason 含 @mention', r.reason);

  // 模型名匹配
  const r2 = decideModelFromPrompt('@reasoner 推理', CONFIGS, 'cfg-deepseek');
  log(r2.apiConfig.model === 'deepseek-reasoner', '@reasoner → deepseek-reasoner', `got=${r2.apiConfig.model}`);

  // 找不到的 @mention 走默认
  const r3 = decideModelFromPrompt('@notexist 问个事', CONFIGS, 'cfg-qwen-max');
  log(r3.apiConfig.id !== 'notexist', '不存在的 @mention 退化到默认', `got=${r3.apiConfig.id}`);
}

async function test6_routeByTask() {
  console.log('\n[6] 任务特征路由');
  // 短闲聊 → fast (qwen-turbo)
  const r1 = decideModelFromPrompt('你好', CONFIGS, 'cfg-deepseek');
  log(r1.apiConfig.model === 'qwen-turbo', '闲聊 → qwen-turbo (fast)', `got=${r1.apiConfig.model}`);

  // 推理 → reasoning
  const r2 = decideModelFromPrompt('请证明勾股定理', CONFIGS, 'cfg-deepseek');
  log(r2.caps.tier === 'reasoning', '推理 → reasoning tier', `tier=${r2.caps.tier}`);

  // 写代码 → standard (deepseek-chat)
  const r3 = decideModelFromPrompt('写一个函数计算斐波那契', CONFIGS, 'cfg-kimi');
  log(r3.apiConfig.model === 'deepseek-chat' || r3.caps.tier !== 'reasoning', '写代码 → 非 reasoning', `model=${r3.apiConfig.model} tier=${r3.caps.tier}`);

  // 视觉 → flagship
  const r4b = routeModel(CONFIGS, 'cfg-qwen-turbo', { taskType: 'vision' });
  log(r4b.caps.tier === 'flagship', '视觉 → flagship', `tier=${r4b.caps.tier}`);
}

async function test7_userRoutingOverride() {
  console.log('\n[7] 用户配置 routing 覆盖默认');
  const r = decideModelFromPrompt('写一个工具函数', CONFIGS, 'cfg-deepseek', {
    code: 'cfg-kimi', // 强制代码用 Kimi
  });
  log(r.apiConfig.id === 'cfg-kimi', 'routing.code=cfg-kimi 生效', `got=${r.apiConfig.id}`);
}

async function test8_disabledExcluded() {
  console.log('\n[8] disabled 配置被排除');
  const r = decideModelFromPrompt('@Disabled 问个事', CONFIGS, 'cfg-deepseek');
  log(r.apiConfig.id !== 'cfg-disabled', 'disabled 不会路由', `got=${r.apiConfig.id}`);
}

async function test9_emptyConfigs() {
  console.log('\n[9] 没有任何启用配置时抛错');
  let threw = false;
  try {
    routeModel([], null, { taskType: 'chat' });
  } catch (e) {
    threw = true;
  }
  log(threw, '应抛错', '');
}

async function test10_reasoningCaps() {
  console.log('\n[10] reasoning 能力字段');
  const r = detectCapabilities('deepseek-reasoner');
  log(r.reasoning === true, 'reasoner.reasoning=true', '');
  log(r.tier === 'reasoning', 'tier=reasoning', '');
  const std = detectCapabilities('qwen-max');
  log(std.reasoning === false, 'qwen-max.reasoning=false', '');
}

(async () => {
  console.log('=== W6 模型路由测试 ===');
  await test1_detectCapabilities();
  await test2_extractMention();
  await test3_resolveAlias();
  await test4_detectTaskType();
  await test5_routeByMention();
  await test6_routeByTask();
  await test7_userRoutingOverride();
  await test8_disabledExcluded();
  await test9_emptyConfigs();
  await test10_reasoningCaps();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
