/**
 * W2 并行工具调度测试
 * 验证：
 * 1. 无依赖的读工具并发执行（3 个 read 同时跑）
 * 2. 同路径的写操作串行（write A → write A 不能并发）
 * 3. 读依赖写（write A → read A 必须等写完成）
 * 4. execute_command 与写操作全局串行
 * 5. 不同路径的写操作可并发（write A / write B）
 * 6. 结果按原始调用顺序返回
 *
 * 用法：npx tsx scripts/test_w2_parallel_tools.mjs
 */
import {
  scheduleToolCalls,
  DEFAULT_TOOL_POLICIES,
} from '../electron/core-fork/tools/ParallelToolScheduler.js';

let pass = 0, fail = 0;
function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 模拟工具执行，记录并发峰��
 *  trace: { name, start, end, args }
 */
function makeExecutor(trace) {
  let active = 0;
  let peak = 0;
  return async (call) => {
    active++;
    peak = Math.max(peak, active);
    const t0 = Date.now();
    let result = { name: call.name, args: call.arguments, peak };
    if (call.name === 'read_file') {
      await delay(100);
      result = { ...result, output: `content-of-${call.arguments.path}` };
    } else if (call.name === 'write_to_file') {
      await delay(100);
      result = { ...result, output: `wrote-${call.arguments.path}` };
    } else if (call.name === 'execute_command') {
      await delay(100);
      result = { ...result, output: 'cmd-done' };
    }
    active--;
    trace.push({ id: call.id, name: call.name, args: call.arguments, start: t0, end: Date.now(), active: active + 1 });
    return result;
  };
}

async function test1_concurrentReads() {
  console.log('\n[1] 3 个读工具应并发（峰值 >= 3）');
  const trace = [];
  const exec = makeExecutor(trace);
  const calls = [
    { id: 't1', name: 'read_file', arguments: { path: '/a.ts' } },
    { id: 't2', name: 'read_file', arguments: { path: '/b.ts' } },
    { id: 't3', name: 'read_file', arguments: { path: '/c.ts' } },
  ];
  const results = await scheduleToolCalls(calls, { execute: exec, policyMap: DEFAULT_TOOL_POLICIES, concurrencyLimit: 4 });
  const peak = trace.reduce((m, t) => Math.max(m, t.active), 0);
  log(peak >= 3, '峰值并发 >= 3', `peak=${peak}`);
  log(results.length === 3, '结果数量=3', `len=${results.length}`);
  log(results[0].toolCallId === 't1' && results[2].toolCallId === 't3', '结果按原顺序', `${results.map((r) => r.toolCallId).join(',')}`);
}

async function test2_samePathWritesSerial() {
  console.log('\n[2] 同一文件两次写必须串行');
  const trace = [];
  const exec = makeExecutor(trace);
  const calls = [
    { id: 'w1', name: 'write_to_file', arguments: { path: '/same.txt', content: '1' } },
    { id: 'w2', name: 'write_to_file', arguments: { path: '/same.txt', content: '2' } },
  ];
  await scheduleToolCalls(calls, { execute: exec, policyMap: DEFAULT_TOOL_POLICIES, concurrencyLimit: 4 });
  const w1 = trace.find((t) => t.id === 'w1');
  const w2 = trace.find((t) => t.id === 'w2');
  const ordered = w1.end <= w2.start;
  log(ordered, 'w1 完全结束后 w2 才开始', `w1=${w1.end} w2=${w2.start}`);
}

async function test3_readDependsOnWrite() {
  console.log('\n[3] read A 依赖 write A');
  const trace = [];
  const exec = makeExecutor(trace);
  const calls = [
    { id: 'r1', name: 'read_file', arguments: { path: '/foo.ts' } },
    { id: 'w1', name: 'write_to_file', arguments: { path: '/foo.ts', content: 'x' } },
  ];
  await scheduleToolCalls(calls, { execute: exec, policyMap: DEFAULT_TOOL_POLICIES, concurrencyLimit: 4 });
  const r = trace.find((t) => t.id === 'r1');
  const w = trace.find((t) => t.id === 'w1');
  const ordered = w.end <= r.start;
  log(ordered, 'write 结束后 read 才开始', `w.end=${w.end} r.start=${r.start}`);
}

async function test4_commandSerialWithWrite() {
  console.log('\n[4] execute_command 与 write 全局串行');
  const trace = [];
  const exec = makeExecutor(trace);
  const calls = [
    { id: 'cmd1', name: 'execute_command', arguments: { command: 'npm test' } },
    { id: 'w1', name: 'write_to_file', arguments: { path: '/z.ts', content: 'z' } },
  ];
  await scheduleToolCalls(calls, { execute: exec, policyMap: DEFAULT_TOOL_POLICIES, concurrencyLimit: 4 });
  const cmd = trace.find((t) => t.id === 'cmd1');
  const w = trace.find((t) => t.id === 'w1');
  const noOverlap = cmd.end <= w.start || w.end <= cmd.start;
  log(noOverlap, '命令与写无时间重叠', `cmd=${cmd.start}-${cmd.end} write=${w.start}-${w.end}`);
}

async function test5_differentPathWritesConcurrent() {
  console.log('\n[5] 不同路径的写可并发');
  const trace = [];
  const exec = makeExecutor(trace);
  const calls = [
    { id: 'wa', name: 'write_to_file', arguments: { path: '/a.txt', content: 'a' } },
    { id: 'wb', name: 'write_to_file', arguments: { path: '/b.txt', content: 'b' } },
  ];
  await scheduleToolCalls(calls, { execute: exec, policyMap: DEFAULT_TOOL_POLICIES, concurrencyLimit: 4 });
  const wa = trace.find((t) => t.id === 'wa');
  const wb = trace.find((t) => t.id === 'wb');
  const overlap = wa.start < wb.end && wb.start < wa.end;
  log(overlap, '两个写有重叠', `wa=${wa.start}-${wa.end} wb=${wb.start}-${wb.end}`);
}

async function test6_concurrencyLimit() {
  console.log('\n[6] 并发上限（5 个读，limit=2，峰值应 <=2）');
  const trace = [];
  const exec = makeExecutor(trace);
  const calls = Array.from({ length: 5 }, (_, i) => ({
    id: `r${i}`,
    name: 'read_file',
    arguments: { path: `/${i}.ts` },
  }));
  await scheduleToolCalls(calls, { execute: exec, policyMap: DEFAULT_TOOL_POLICIES, concurrencyLimit: 2 });
  const peak = trace.reduce((m, t) => Math.max(m, t.active), 0);
  log(peak <= 2, '峰值 <= 2', `peak=${peak}`);
}

(async () => {
  console.log('=== W2 并行工具调度测试 ===');
  await test1_concurrentReads();
  await test2_samePathWritesSerial();
  await test3_readDependsOnWrite();
  await test4_commandSerialWithWrite();
  await test5_differentPathWritesConcurrent();
  await test6_concurrencyLimit();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
