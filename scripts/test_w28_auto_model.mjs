/**
 * W28 模型 AUTO 路由测试
 * 覆盖 PRD 第 9 节可单测的验收用例：
 *  1) 短问答 → fast           2) 代码 → standard，长 prompt → flagship
 *  3) 带图 → 仅 vision 模型    4) 无 vision 模型 → 告警而非静默发送
 *  5) heavyToolUse → flagship 6) @mention 强制命中
 *  7) routing.<task> 覆盖     8) 弱词 "why is my button blue" 不升档
 *  9) 强推理信号 → reasoning  10) @ 到不支持 vision 的模型时被硬约束拦截
 * 11) disabled 配置永不入选  12) 无可用配置显式报错
 * 13) AUTO 候选池仅含 official_ 内置配置，自定义中转永不参与路由
 *
 * 用法：npx tsx scripts/test_w28_auto_model.mjs
 */
import { detectCapabilities } from '../electron/core-fork/llm/ProviderCapabilities.js';
import {
  routeModel,
  detectTaskType,
  hasReasoningEvidence,
  decideModelFromPromptWithImages,
  selectRoutingCandidates,
  isBuiltinConfig,
} from '../electron/core-fork/llm/ModelRouter.js';

let pass = 0;
let fail = 0;
function log(ok, name, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} :: ${detail}`);
  }
}

const cfg = (id, model, extra = {}) => ({
  id,
  name: id,
  baseUrl: 'https://example.com',
  apiKey: 'k',
  model,
  ...extra,
});

const MIXED = [
  cfg('cfg-turbo', 'qwen-turbo'),
  cfg('cfg-plus', 'qwen-plus'),
  cfg('cfg-max', 'qwen-max'),
  cfg('cfg-r1', 'deepseek-reasoner'),
  cfg('cfg-off', 'qwen-max', { disabled: true }),
];

console.log('\n[1] 短问答 → fast 档');
{
  const d = routeModel(MIXED, null, { prompt: '你好', taskType: detectTaskType({ prompt: '你好' }), promptLength: 2 });
  log(d.caps.tier === 'fast', 'plain greeting picks fast tier', `got=${d.caps.tier} ${d.reason}`);
}

console.log('\n[2] 代码任务 → standard；长 prompt → flagship');
{
  const shortPrompt = '帮我写一个排序函数';
  const d1 = routeModel(MIXED, null, {
    taskType: detectTaskType({ prompt: shortPrompt }),
    promptLength: shortPrompt.length,
  });
  log(d1.taskType === 'code' && d1.caps.tier === 'standard', 'short code → standard', `got=${d1.taskType}/${d1.caps.tier}`);

  const longPrompt = `帮我写一个排序函数${'x'.repeat(8200)}`;
  const d2 = routeModel(MIXED, null, {
    taskType: detectTaskType({ prompt: longPrompt }),
    promptLength: longPrompt.length,
  });
  log(d2.caps.tier === 'flagship', 'long code → flagship', `got=${d2.caps.tier} ${d2.reason}`);
}

console.log('\n[3] 带图 → 只可能选中 vision 模型');
{
  const withImage = decideModelFromPromptWithImages('看看这张截图', MIXED, null, true);
  log(withImage.taskType === 'vision', 'image → vision task', `got=${withImage.taskType}`);
  log(withImage.caps.vision === true, 'chosen model supports vision', `model=${withImage.apiConfig.model} vision=${withImage.caps.vision}`);
  log(!withImage.warnings?.length, 'no warning when vision pool exists', JSON.stringify(withImage.warnings));

  // 池内无 vision 模型：不抛错、不静默，给出明确告警
  const noVision = [cfg('cfg-turbo', 'qwen-turbo'), cfg('cfg-r1', 'deepseek-reasoner')];
  const degraded = decideModelFromPromptWithImages('看图', noVision, null, true);
  log(!!degraded.warnings?.length, 'warns when no vision model', JSON.stringify(degraded.warnings));
  log(!!degraded.apiConfig, 'still returns a config (session not broken)');
}

console.log('\n[4] 重工具链任务 → flagship');
{
  const heavy = routeModel(MIXED, null, { taskType: 'chat', prompt: '继续', heavyToolUse: true, promptLength: 2 });
  log(heavy.caps.tier === 'flagship', 'heavyToolUse upgrades to flagship', `got=${heavy.caps.tier} ${heavy.reason}`);
}

console.log('\n[5] @mention 优先级最高');
{
  const d = decideModelFromPromptWithImages('@qwen-turbo 解释一下这段代码', MIXED, null, false);
  log(d.apiConfig.model === 'qwen-turbo', '@mention wins', `got=${d.apiConfig.model}`);
  log(d.mention === 'qwen-turbo', 'mention recorded in decision', `got=${d.mention}`);
  log(d.reason.includes('@mention'), 'reason explains mention', d.reason);
}

console.log('\n[6] 用户 routing 覆盖自动档位');
{
  const d = routeModel(MIXED, null, {
    taskType: 'summarize',
    promptLength: 10,
    userRouting: { summarize: 'cfg-max' },
  });
  log(d.apiConfig.id === 'cfg-max', 'routing.summarize wins', `got=${d.apiConfig.id}`);
  log(d.reason.includes('routing.summarize'), 'reason explains user routing', d.reason);
}

console.log('\n[7] 弱推理词不升档');
{
  const weak = 'why is my button blue';
  log(hasReasoningEvidence(weak) === false, 'weak "why" alone is not reasoning evidence');
  log(detectTaskType({ prompt: weak }) !== 'reasoning', 'weak prompt not classified as reasoning', detectTaskType({ prompt: weak }));

  const strong = '为什么这个函数在并发场景下会死锁？请分析调用链并证明你的结论是正确的';
  log(hasReasoningEvidence(strong) === true, 'multi-signal prompt is reasoning evidence');
  log(detectTaskType({ prompt: strong }) === 'reasoning', 'strong prompt → reasoning', detectTaskType({ prompt: strong }));
  const d = routeModel(MIXED, null, { taskType: 'reasoning', promptLength: strong.length });
  log(d.caps.tier === 'reasoning', 'reasoning task → reasoning tier', `got=${d.caps.tier}`);
}

console.log('\n[8] 带图时 @ 到非 vision 模型被硬约束拦截');
{
  const d = decideModelFromPromptWithImages('@qwen-turbo 这张图里是什么', MIXED, null, true);
  log(d.apiConfig.model !== 'qwen-turbo', 'non-vision @mention blocked', `got=${d.apiConfig.model}`);
  log(d.caps.vision === true, 'blocked mention falls back to vision model', `vision=${d.caps.vision}`);
  log(!!d.warnings?.some((w) => w.includes('能力')), 'warns about blocked mention', JSON.stringify(d.warnings));
}

console.log('\n[9] disabled 配置不进候选池');
{
  const onlyDisabled = [cfg('cfg-off', 'qwen-max', { disabled: true })];
  let threw = false;
  try {
    routeModel(onlyDisabled, null, { taskType: 'chat' });
  } catch {
    threw = true;
  }
  log(threw, 'all-disabled pool throws explicit error');

  const d = routeModel(MIXED, 'cfg-off', { taskType: 'chat', promptLength: 2 });
  log(d.apiConfig.id !== 'cfg-off', 'disabled active id never selected', `got=${d.apiConfig.id}`);
}

console.log('\n[10] 固定模型模式（非 AUTO）行为不变');
{
  // AgentManager 在 mode!=auto 时完全不调用路由器；这里只验证兜底路径本身可用
  const d = routeModel(MIXED, 'cfg-plus', { taskType: 'chat', mention: null });
  log(!!d.apiConfig, 'router still returns a config for fallback path');
  const caps = detectCapabilities(d.apiConfig.model);
  log(caps.tier === d.caps.tier, 'decision caps match selected model');
}

console.log('\n[11] AUTO 仅在 official_ 内置模型中选（自定义配置不参与路由）');
{
  const FULL = [
    cfg('official_qwen-turbo', 'qwen-turbo', { builtin: true }),
    cfg('official_qwen-max', 'qwen-max', { builtin: true }),
    cfg('my-relay-gpt4', 'gpt-4o'),                 // 自定义中转
    cfg('my-kimi', 'kimi-k2'),                      // 自定义
    cfg('official_disabled', 'qwen-plus', { builtin: true, disabled: true }),
  ];
  const candidates = selectRoutingCandidates(FULL);
  log(candidates.length === 2, 'pool keeps only enabled builtin configs', `got=${candidates.map((c) => c.id).join(',')}`);
  log(candidates.every((c) => c.id.startsWith('official_')), 'pool excludes custom relays');

  log(isBuiltinConfig({ id: 'official_qwen-max' }) === true, 'official_ prefix recognized as builtin');
  log(isBuiltinConfig({ id: 'x', builtin: true }) === true, 'builtin flag recognized');
  log(isBuiltinConfig({ id: 'my-relay-gpt4' }) === false, 'custom config is not builtin');
  log(isBuiltinConfig(null) === false, 'null config is not builtin');

  // 自定义池里的强模型不会被 AUTO 选中，即使任务"应该"用 flagship
  const routed = decideModelFromPromptWithImages('帮我做架构规划', candidates, null, false);
  log(routed.apiConfig.id.startsWith('official_'), 'router never picks a custom config', `got=${routed.apiConfig.id}`);

  // 只有自定义配置时 → 候选池为空，调用方（AgentManager）回退当前模型并告警
  const customOnly = [cfg('my-relay-gpt4', 'gpt-4o'), cfg('my-kimi', 'kimi-k2')];
  log(selectRoutingCandidates(customOnly).length === 0, 'custom-only pool is empty → fallback path');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
