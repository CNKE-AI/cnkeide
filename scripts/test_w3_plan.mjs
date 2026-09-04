/**
 * W3 Plan 状态机测试
 * 验证：1) 创建/查询/追加  2) 状态机合法转换  3) 终态不能回退  4) abandon 全跳过
 *        5) 进度统计  6) 摘要输出  7) 事件订阅
 */
import { PlanManager } from '../electron/core-fork/plan/PlanManager.js';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function test1_createAndQuery() {
  console.log('\n[1] 创建与查询');
  const m = new PlanManager();
  const plan = m.create('s1', [
    { content: '读 a.ts' },
    { content: '改 a.ts' },
    { content: '运行测试' },
  ], '重构 a.ts');
  log(plan.items.length === 3, '3 个步骤', `n=${plan.items.length}`);
  log(m.hasPlan('s1') === true, 'hasPlan true', `${m.hasPlan('s1')}`);
  log(m.getPlan('s1')?.id === plan.id, 'getPlan 一致', `id=${m.getPlan('s1')?.id}`);
  log(m.getPlan('s2') === undefined, '其它会话无 plan', `${m.getPlan('s2')}`);
  log(plan.items[0].status === 'pending', '默认 pending', `status=${plan.items[0].status}`);
}

async function test2_stateMachine() {
  console.log('\n[2] 状态机合法转换');
  const m = new PlanManager();
  const plan = m.create('s2', [{ content: 'a' }, { content: 'b' }]);
  const id0 = plan.items[0].id;
  log(m.startItem('s2', id0) === true, 'pending → running', 'ok');
  log(m.completeItem('s2', id0) === true, 'running → completed', 'ok');
  log(m.getPlan('s2').items[0].startedAt > 0, 'startedAt 已设', `${m.getPlan('s2').items[0].startedAt}`);
  log(m.getPlan('s2').items[0].completedAt > 0, 'completedAt 已设', `${m.getPlan('s2').items[0].completedAt}`);
}

async function test3_terminalState() {
  console.log('\n[3] 终态不能回退');
  const m = new PlanManager();
  const plan = m.create('s3', [{ content: 'a' }]);
  const id = plan.items[0].id;
  m.completeItem('s3', id);
  log(m.startItem('s3', id) === false, 'completed → running 应失败', '');
  log(m.completeItem('s3', id) === true, 'completed → completed 幂等', '');
  log(m.skipItem('s3', id) === false, 'completed → skipped 应失败', '');

  // skipped 也不能变
  m.create('s3b', [{ content: 'a' }]);
  const idb = m.getPlan('s3b').items[0].id;
  m.skipItem('s3b', idb);
  log(m.startItem('s3b', idb) === false, 'skipped → running 应失败', '');
}

async function test4_failItem() {
  console.log('\n[4] 标记失败带错误信息');
  const m = new PlanManager();
  const plan = m.create('s4', [{ content: 'a' }]);
  const id = plan.items[0].id;
  m.startItem('s4', id);
  m.failItem('s4', id, '文件不存在');
  const it = m.getPlan('s4').items[0];
  log(it.status === 'failed', '状态 failed', `status=${it.status}`);
  log(it.error === '文件不存在', '错误信息', `err=${it.error}`);
}

async function test5_progress() {
  console.log('\n[5] 进度统计');
  const m = new PlanManager();
  const plan = m.create('s5', [
    { content: 'a' }, { content: 'b' }, { content: 'c' }, { content: 'd' },
  ]);
  m.completeItem('s5', plan.items[0].id);
  m.startItem('s5', plan.items[1].id);
  m.failItem('s5', plan.items[2].id, 'err');
  m.skipItem('s5', plan.items[3].id);
  const s = m.progress('s5');
  log(s.done === 1, 'done=1', `done=${s.done}`);
  log(s.total === 4, 'total=4', `total=${s.total}`);
  log(s.failed === 1, 'failed=1', `failed=${s.failed}`);
  log(s.skipped === 1, 'skipped=1', `skipped=${s.skipped}`);
  log(s.pending === 0, 'pending=0', `pending=${s.pending}`);
  log(s.running === 1, 'running=1', `running=${s.running}`);
}

async function test6_abandon() {
  console.log('\n[6] abandon：pending/running 全部变 skipped');
  const m = new PlanManager();
  const plan = m.create('s6', [
    { content: 'a' }, { content: 'b' }, { content: 'c' },
  ]);
  m.startItem('s6', plan.items[0].id);
  m.completeItem('s6', plan.items[1].id);
  m.abandon('s6');
  const items = m.getPlan('s6').items;
  log(items[0].status === 'skipped', 'item0 running→skipped', `status=${items[0].status}`);
  log(items[1].status === 'completed', 'item1 completed 保留', `status=${items[1].status}`);
  log(items[2].status === 'skipped', 'item2 pending→skipped', `status=${items[2].status}`);
}

async function test7_addItem() {
  console.log('\n[7] 追加步骤');
  const m = new PlanManager();
  m.create('s7', [{ content: 'a' }]);
  const added = m.addItem('s7', '追加的步骤', 'read_file', '/a.ts');
  log(added !== null, '返回 item', '');
  log(added.toolName === 'read_file', '关联工具', `tool=${added.toolName}`);
  log(added.filePath === '/a.ts', '关联路径', `path=${added.filePath}`);
  log(m.getPlan('s7').items.length === 2, '总数=2', `n=${m.getPlan('s7').items.length}`);
}

async function test8_events() {
  console.log('\n[8] 事件订阅');
  const m = new PlanManager();
  const events = [];
  m.on((e) => events.push(e.type));
  m.create('s8', [{ content: 'a' }]);
  const id = m.getPlan('s8').items[0].id;
  m.startItem('s8', id);
  m.completeItem('s8', id);
  log(events.includes('created'), '触发 created', events.join(','));
  log(events.includes('item-status-changed'), '触发 status 变更', events.join(','));
  log(events.includes('completed'), '全部完成事件', events.join(','));
}

async function test9_summary() {
  console.log('\n[9] LLM 摘要');
  const m = new PlanManager();
  const plan = m.create('s9', [
    { content: '读取配置文件' },
    { content: '解析 JSON' },
    { content: '写入数据库' },
  ], '数据迁移');
  m.completeItem('s9', plan.items[0].id);
  m.startItem('s9', plan.items[1].id);
  const summary = m.summaryForLlm('s9');
  log(/数据迁移/.test(summary), '含标题', summary);
  log(/1\./.test(summary) && /2\./.test(summary) && /3\./.test(summary), '含步骤列表', summary);
  log(/✅/.test(summary) && /▶️/.test(summary) && /⬜/.test(summary), '含状态符号', summary);
  log(/进度/.test(summary), '含进度', summary);
}

async function test10_invalidStatus() {
  console.log('\n[10] 非法状态被拒');
  const m = new PlanManager();
  const plan = m.create('s10', [{ content: 'a' }]);
  const id = plan.items[0].id;
  log(m.updateStatus('s10', id, 'invalid') === false, '拒绝非法状态', '');
  log(m.updateStatus('s10', 'not-exist', 'running') === false, '拒绝不存在的 item', '');
  log(m.updateStatus('s99', id, 'running') === false, '拒绝不存在的会话', '');
}

(async () => {
  console.log('=== W3 Plan 状态机测试 ===');
  await test1_createAndQuery();
  await test2_stateMachine();
  await test3_terminalState();
  await test4_failItem();
  await test5_progress();
  await test6_abandon();
  await test7_addItem();
  await test8_events();
  await test9_summary();
  await test10_invalidStatus();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
