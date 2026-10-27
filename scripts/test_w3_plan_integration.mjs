/**
 * W3 Plan 端到端集成测试
 * 验证：PlanManager + ToolManager 协作，plan 工具可被 LLM 调用
 * 用法：npx tsx scripts/test_w3_plan_integration.mjs
 */
import { PlanManager } from '../electron/core-fork/plan/PlanManager.js';
import { ToolManager } from '../electron/core-fork/tools/ToolManager.js';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

// 构造最小可用的 ToolManager（plan 相关只依赖 PlanManager + sessionId）
function makeToolManager(planManager) {
  const tm = Object.create(ToolManager.prototype);
  tm.fsAdapter = null;
  tm.terminalAdapter = null;
  tm.mcpHub = null;
  tm.checkpointManager = null;
  tm.codebaseIndexer = null;
  tm.planManager = planManager;
  tm.sessionId = 's-test';
  tm.workspaceId = null;
  tm.modifiedFiles = new Set();
  return tm;
}

async function test1_createPlan() {
  console.log('\n[1] create_plan 工具：返回 plan 摘要');
  const pm = new PlanManager();
  const tm = makeToolManager(pm);
  const r = await tm.execute('create_plan', {
    title: '重构 a.ts',
    items: [
      { content: '读 a.ts' },
      { content: '改 a.ts' },
    ],
  });
  log(r.success === true, 'execute 成功', `out=${r.output?.slice(0, 80)}`);
  log(/重构 a\.ts/.test(r.output), '摘要含标题', '');
  log(/1\./.test(r.output) && /2\./.test(r.output), '含步骤', '');
  log(pm.hasPlan('s-test') === true, 'plan 已创建', '');
}

async function test2_updateStatus() {
  console.log('\n[2] update_plan_status：流转 + 状态机');
  const pm = new PlanManager();
  const tm = makeToolManager(pm);
  await tm.execute('create_plan', { items: [{ content: 'a' }] });
  const id = pm.getPlan('s-test').items[0].id;
  const r1 = await tm.execute('update_plan_status', { itemId: id, status: 'running' });
  log(r1.success, 'pending→running 成功', '');
  const r2 = await tm.execute('update_plan_status', { itemId: id, status: 'completed' });
  log(r2.success, 'running→completed 成功', '');
  const r3 = await tm.execute('update_plan_status', { itemId: id, status: 'running' });
  log(r3.success === false, 'completed→running 失败（终态保护）', `out=${r3.error}`);
}

async function test3_failWithError() {
  console.log('\n[3] fail 时附 error 信息');
  const pm = new PlanManager();
  const tm = makeToolManager(pm);
  await tm.execute('create_plan', { items: [{ content: 'a' }] });
  const id = pm.getPlan('s-test').items[0].id;
  await tm.execute('update_plan_status', { itemId: id, status: 'running' });
  const r = await tm.execute('update_plan_status', { itemId: id, status: 'failed', error: '文件不存在' });
  log(r.success, 'failed 设置成功', '');
  const it = pm.getPlan('s-test').items[0];
  log(it.status === 'failed' && it.error === '文件不存在', 'item 状态+错误信息正确', `status=${it.status} err=${it.error}`);
}

async function test4_addItem() {
  console.log('\n[4] add_plan_item 追加步骤');
  const pm = new PlanManager();
  const tm = makeToolManager(pm);
  await tm.execute('create_plan', { items: [{ content: 'a' }] });
  const r = await tm.execute('add_plan_item', { content: '追加的步骤', toolName: 'read_file' });
  log(r.success, '追加成功', '');
  log(pm.getPlan('s-test').items.length === 2, '总数=2', `n=${pm.getPlan('s-test').items.length}`);
}

async function test5_getPlan() {
  console.log('\n[5] get_plan 查询');
  const pm = new PlanManager();
  const tm = makeToolManager(pm);
  // 无 plan 时
  const r0 = await tm.execute('get_plan', {});
  log(r0.success && /没有计划/.test(r0.output), '无 plan 时友好提示', `out=${r0.output}`);
  // 有 plan 时
  await tm.execute('create_plan', { items: [{ content: 'a' }, { content: 'b' }] });
  const r1 = await tm.execute('get_plan', {});
  log(r1.success && /1\./.test(r1.output) && /2\./.test(r1.output), '返回完整摘要', '');
}

async function test6_markPlanComplete() {
  console.log('\n[6] mark_plan_complete 仅收尾计划，不改步骤状态');
  const pm = new PlanManager();
  const tm = makeToolManager(pm);
  await tm.execute('create_plan', { items: [{ content: 'a' }, { content: 'b' }, { content: 'c' }] });
  const ids = pm.getPlan('s-test').items.map((i) => i.id);
  await tm.execute('update_plan_status', { itemId: ids[0], status: 'completed' });
  await tm.execute('update_plan_status', { itemId: ids[1], status: 'running' });
  const r = await tm.execute('mark_plan_complete', {});
  log(r.success, '执行成功', '');
  const items = pm.getPlan('s-test').items;
  log(items[0].status === 'completed', 'item0 completed 保留', `status=${items[0].status}`);
  log(items[1].status === 'running', 'item1 保持 running（不伪造 skipped）', `status=${items[1].status}`);
  log(items[2].status === 'pending', 'item2 保持 pending（不伪造 skipped）', `status=${items[2].status}`);

  // 用户主动中止才把未完成步骤标 skipped
  pm.abandon('s-test');
  const after = pm.getPlan('s-test').items;
  log(after[0].status === 'completed', 'abandon 后 item0 completed 保留', `status=${after[0].status}`);
  log(
    after[1].status === 'skipped' && after[2].status === 'skipped',
    'abandon 后未完成步骤标 skipped',
    `status=${after[1].status},${after[2].status}`,
  );
}

async function test7_noPlanManager() {
  console.log('\n[7] 未注入 PlanManager 时 plan 工具失败');
  const tm = makeToolManager(undefined);
  const r = await tm.execute('create_plan', { items: [{ content: 'a' }] });
  log(r.success === false, 'create_plan 失败', `err=${r.error}`);
  log(/未启用/.test(r.error), '错误信息明确', `err=${r.error}`);
}

async function test8_emptyItems() {
  console.log('\n[8] create_plan items 为空时拒绝');
  const pm = new PlanManager();
  const tm = makeToolManager(pm);
  const r = await tm.execute('create_plan', { items: [] });
  log(r.success === false, '空 items 拒绝', `err=${r.error}`);
}

async function test9_sessionIsolation() {
  console.log('\n[9] 会话隔离：不同 sessionId 互不影响');
  const pm = new PlanManager();
  const tmA = makeToolManager(pm);
  tmA.sessionId = 'sess-A';
  await tmA.execute('create_plan', { items: [{ content: 'A 的任务' }] });
  tmA.sessionId = 'sess-B';
  const tmB = makeToolManager(pm);
  tmB.sessionId = 'sess-B';
  const r = await tmB.execute('get_plan', {});
  log(r.success && /没有计划/.test(r.output), 'B 会话无 plan', `out=${r.output}`);
  log(pm.hasPlan('sess-A') === true, 'A 会话 plan 还在', '');
}

(async () => {
  console.log('=== W3 Plan 端到端集成测试 ===');
  await test1_createPlan();
  await test2_updateStatus();
  await test3_failWithError();
  await test4_addItem();
  await test5_getPlan();
  await test6_markPlanComplete();
  await test7_noPlanManager();
  await test8_emptyItems();
  await test9_sessionIsolation();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
