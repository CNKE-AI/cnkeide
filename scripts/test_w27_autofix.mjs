/**
 * W27 测试自愈循环测试
 * 覆盖：输出解析（vitest / tsc / pytest / go / cargo / 兜底栈）、失败签名与去重、
 *       测试文件识别、修复 prompt 约束、循环 9 种收敛路径、ToolManager 注册 / 并发策略 / 权限分类
 *
 * 循环部分用注入的假 runTests / applyFix，不联网、不跑真实测试。
 * 用法：npx tsx scripts/test_w27_autofix.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { runTests as runProjectTests } from '../electron/core-fork/tools/TestRunner.js';
import {
  parseTestOutput,
  failureSignature,
  isTestFile,
  buildFixPrompt,
  formatAutoFixReport,
  runAutoFixLoop,
  clampRounds,
  stripAnsi,
  describeStopReason,
} from '../electron/core-fork/agent/AutoFixLoop.js';
import { ToolManager, AUTOFIX_TOOL_NAME } from '../electron/core-fork/tools/ToolManager.js';
import { DEFAULT_TOOL_POLICIES } from '../electron/core-fork/tools/ParallelToolScheduler.js';
import { classifyTool } from '../electron/core-fork/checkpoint/PermissionTier.js';

let pass = 0;
let fail = 0;
const log = (ok, name, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

/* ---------------- 样例输出 ---------------- */

const VITEST_FAIL = `
 FAIL  src/foo.test.ts > math > adds
AssertionError: expected 3 to be 4 // Object.is equality

- Expected
+ Received

 ❯ src/math.ts:2:10
 ❯ src/foo.test.ts:5:20

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
`;

const TSC_FAIL = `src/a.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts(7,1): error TS2304: Cannot find name 'foo'.
`;

const PYTEST_FAIL = `============================= test session starts =============================
FAILED tests/test_a.py::test_add - AssertionError: assert 3 == 4
tests/test_a.py:5: AssertionError
1 failed, 2 passed in 0.12s
`;

const GO_FAIL = `--- FAIL: TestAdd (0.00s)
    add_test.go:12: got 3, want 4
FAIL
exit status 1
`;

const CARGO_FAIL = `running 3 tests
---- tests::it_works stdout ----
thread 'tests::it_works' panicked at src/lib.rs:10:5:
assertion \`left == right\` failed
failures:
    tests::it_works
`;

const STACK_ONLY = `Something exploded
    at Object.<anonymous> (C:\\proj\\src\\a.js:12:3)
    at node:internal/main/run_main_module:23:47
`;

const GREEN = {
  success: true,
  exitCode: 0,
  framework: 'vitest',
  command: 'npm test',
  stdout: ' Test Files  1 passed (1)\n      Tests  3 passed (3)\n',
  durationMs: 1200,
};

const failRun = (msg = 'AssertionError: expected 3 to be 4', line = 2) => ({
  success: false,
  exitCode: 1,
  framework: 'vitest',
  command: 'npm test',
  stdout: ` FAIL  src/foo.test.ts > math > adds\n${msg}\n\n ❯ src/math.ts:${line}:10\n`,
  durationMs: 900,
});

/** 依次返回 results，最后一个可以重复返回 */
function sequence(results) {
  let i = 0;
  return async () => {
    const r = results[Math.min(i, results.length - 1)];
    i++;
    return r;
  };
}

async function main() {
  console.log('\n[1] 测试输出解析');
  {
    const v = parseTestOutput({ stdout: VITEST_FAIL, exitCode: 1, framework: 'vitest' });
    log(v.failures.length === 1, 'vitest：解析出 1 条失败', `got ${v.failures.length}`);
    log(v.failures[0]?.file === 'src/math.ts', 'vitest：定位到产品文件 src/math.ts', v.failures[0]?.file);
    log(v.failures[0]?.line === 2, 'vitest：行号 2', String(v.failures[0]?.line));
    log(v.failures[0]?.kind === 'assertion', 'vitest：归类 assertion', v.failures[0]?.kind);
    log(v.failures[0]?.test?.includes('math'), 'vitest：带用例名', v.failures[0]?.test);

    const t = parseTestOutput({ stdout: TSC_FAIL, exitCode: 2, framework: 'npm' });
    log(t.failures.length === 2, 'tsc：解析出 2 条编译错误', `got ${t.failures.length}`);
    log(t.failures[0]?.kind === 'compile', 'tsc：归类 compile', t.failures[0]?.kind);
    log(t.failures[0]?.file === 'src/a.ts' && t.failures[0]?.line === 12, 'tsc：文件与行号正确');
    log(t.failures[0]?.message?.startsWith('TS2322'), 'tsc：保留错误码', t.failures[0]?.message);

    const p = parseTestOutput({ stdout: PYTEST_FAIL, exitCode: 1, framework: 'pytest' });
    log(p.failures.length >= 1, 'pytest：解析出失败', `got ${p.failures.length}`);
    log(p.failures[0]?.file === 'tests/test_a.py', 'pytest：文件正确', p.failures[0]?.file);
    log(p.failures[0]?.test === 'test_add', 'pytest：用例名正确', p.failures[0]?.test);

    const g = parseTestOutput({ stdout: GO_FAIL, exitCode: 1, framework: 'go' });
    log(g.failures.length === 1, 'go：解析出 1 条失败', `got ${g.failures.length}`);
    log(g.failures[0]?.file === 'add_test.go' && g.failures[0]?.line === 12, 'go：文件与行号正确');
    log(g.failures[0]?.test === 'TestAdd', 'go：用例名正确', g.failures[0]?.test);

    const c = parseTestOutput({ stdout: CARGO_FAIL, exitCode: 101, framework: 'cargo' });
    log(c.failures.length === 1, 'cargo：解析出 1 条 panic', `got ${c.failures.length}`);
    log(c.failures[0]?.file === 'src/lib.rs' && c.failures[0]?.line === 10, 'cargo：文件与行号正确');
    log(c.failures[0]?.kind === 'runtime', 'cargo：归类 runtime', c.failures[0]?.kind);

    const s = parseTestOutput({ stdout: STACK_ONLY, exitCode: 1, framework: 'make' });
    log(s.failures.length === 1, '兜底：只扒到 1 条业务栈帧（跳过 node 内部）', `got ${s.failures.length}`);
    log(/a\.js$/.test(s.failures[0]?.file || ''), '兜底：文件为 a.js', s.failures[0]?.file);

    const green = parseTestOutput({ ...GREEN });
    log(green.failures.length === 0, '全绿输出：0 条失败');
    log(green.signature === 'green', '全绿输出：签名为 green', green.signature);

    log(stripAnsi('\u001b[31mred\u001b[0m') === 'red', 'stripAnsi 去颜色码');
  }

  console.log('\n[2] 失败签名与去重');
  {
    const a = parseTestOutput({ stdout: VITEST_FAIL, exitCode: 1, framework: 'vitest' });
    const b = parseTestOutput({ stdout: VITEST_FAIL.replace(/\n/g, '\n\n'), exitCode: 1, framework: 'vitest' });
    log(a.signature === b.signature, '同一失败（多空行）签名相同', `${a.signature} vs ${b.signature}`);
    log(failureSignature([]) === 'green', '空失败签名 green');
    const c = parseTestOutput({ stdout: VITEST_FAIL.replace('src/math.ts:2', 'src/math.ts:9'), exitCode: 1 });
    log(c.signature !== a.signature, '行号变化 → 签名变化');
    const d = failureSignature([
      { file: 'x.ts', line: 1, message: 'boom', kind: 'assertion' },
      { file: 'y.ts', line: 2, message: 'bang', kind: 'assertion' },
    ]);
    const e = failureSignature([
      { file: 'y.ts', line: 2, message: 'bang', kind: 'assertion' },
      { file: 'x.ts', line: 1, message: 'boom', kind: 'assertion' },
    ]);
    log(d === e, '失败顺序不影响签名');
    const dup = parseTestOutput({
      stdout: `${VITEST_FAIL}\n${VITEST_FAIL}`,
      exitCode: 1,
      framework: 'vitest',
    });
    log(dup.failures.length === 1, '重复输出被去重', `got ${dup.failures.length}`);
  }

  console.log('\n[3] 测试文件识别与修复 prompt');
  {
    log(isTestFile('src/foo.test.ts'), '识别 .test.ts');
    log(isTestFile('src/foo.spec.tsx'), '识别 .spec.tsx');
    log(isTestFile('tests/test_a.py'), '识别 test_*.py');
    log(isTestFile('pkg/add_test.go'), '识别 *_test.go');
    log(isTestFile('src/math.ts') === false, '产品文件不算测试');
    log(isTestFile(undefined) === false, 'undefined 不报错');

    const prompt = buildFixPrompt({
      failures: [
        { file: 'src/math.ts', line: 2, column: 10, message: 'AssertionError: expected 3 to be 4', kind: 'assertion' },
        { file: 'src/foo.test.ts', line: 5, message: 'AssertionError: x', kind: 'assertion', test: 'math > adds' },
      ],
      round: 1,
      maxRounds: 3,
      framework: 'vitest',
      command: 'npm test',
      rawTail: 'TAIL_MARKER',
    });
    log(prompt.includes('第 1/3 轮'), 'prompt 含轮次');
    log(prompt.includes('src/math.ts:2:10'), 'prompt 含 file:line:col');
    log(prompt.includes('（测试文件）'), 'prompt 标注测试文件');
    log(prompt.includes('不算改测试') === false && prompt.includes('不许改测试'), 'prompt 含禁止改断言约束');
    log(prompt.includes('skip'), 'prompt 明确禁止 skip');
    log(prompt.includes('TAIL_MARKER'), 'prompt 含原始输出尾部');
    log(prompt.includes('npm test'), 'prompt 含测试命令');
  }

  console.log('\n[4] 自愈循环收敛路径');
  {
    // 4.1 一次就绿
    let fixCalls = 0;
    const r1 = await runAutoFixLoop({
      runTests: sequence([GREEN]),
      applyFix: async () => {
        fixCalls++;
        return { success: true };
      },
    });
    log(r1.success && r1.stoppedReason === 'passed', '首次即绿 → passed', r1.stoppedReason);
    log(r1.rounds.length === 1, '首次即绿 → 只跑 1 轮', String(r1.rounds.length));
    log(fixCalls === 0, '首次即绿 → 不调用修复', String(fixCalls));

    // 4.2 失败 → 修 → 绿
    const events = [];
    let promptSeen = '';
    const r2 = await runAutoFixLoop(
      {
        runTests: sequence([failRun(), GREEN]),
        applyFix: async (p) => {
          promptSeen = p;
          return { success: true, output: '修了 src/math.ts 的加法' };
        },
        emit: (e) => events.push(e.type),
      },
      { maxRounds: 3 }
    );
    log(r2.success && r2.stoppedReason === 'passed', '失败→修复→绿 → passed', r2.stoppedReason);
    log(r2.rounds.length === 2, '共 2 轮', String(r2.rounds.length));
    log(r2.rounds[0].passed === false && r2.rounds[1].passed === true, '首轮失败次轮通过');
    log(r2.rounds[0].failures.length === 1, '首轮记录 1 条失败');
    log((r2.rounds[0].fixSummary || '').includes('src/math.ts'), '记录修复摘要', r2.rounds[0].fixSummary);
    log(promptSeen.includes('src/math.ts:2'), '传递给修复者的是结构化失败');
    log(events.includes('round_result') && events.includes('fix_start') && events.includes('finished'), '进度事件齐全', events.join(','));

    // 4.3 一直失败 → 轮数上限
    let calls3 = 0;
    const r3 = await runAutoFixLoop(
      {
        runTests: sequence([failRun('AssertionError: expected 1', 1), failRun('AssertionError: expected 2', 2), failRun('AssertionError: expected 3', 3)]),
        applyFix: async () => {
          calls3++;
          return { success: true };
        },
      },
      { maxRounds: 2 }
    );
    log(r3.success === false && r3.stoppedReason === 'max-rounds', '始终失败 → max-rounds', r3.stoppedReason);
    log(r3.rounds.length === 2, '恰好跑满 2 轮', String(r3.rounds.length));
    log(calls3 === 1, '最后一轮不再调用修复（已无机会验证）', String(calls3));
    log(r3.failures.length === 1, '报告含剩余失败');
    log(formatAutoFixReport(r3).includes('剩余失败'), '报告含剩余失败小节');

    // 4.4 无进展（两轮签名一致）
    let calls4 = 0;
    const r4 = await runAutoFixLoop(
      {
        runTests: sequence([failRun(), failRun()]),
        applyFix: async () => {
          calls4++;
          return { success: true };
        },
      },
      { maxRounds: 3 }
    );
    log(r4.stoppedReason === 'no-progress', '同签名重复 → no-progress', r4.stoppedReason);
    log(r4.rounds.length === 2, '无进展在第 2 轮停下', String(r4.rounds.length));
    log(calls4 === 1, '只修了 1 次', String(calls4));

    // 4.5 关掉 stopOnRepeat 时继续跑
    const r5 = await runAutoFixLoop(
      { runTests: sequence([failRun(), failRun(), failRun()]), applyFix: async () => ({ success: true }) },
      { maxRounds: 3, stopOnRepeat: false }
    );
    log(r5.stoppedReason === 'max-rounds' && r5.rounds.length === 3, 'stopOnRepeat=false → 跑到上限', r5.stoppedReason);

    // 4.6 修复者失败
    const r6 = await runAutoFixLoop(
      { runTests: sequence([failRun()]), applyFix: async () => ({ success: false, error: 'LLM 超时' }) },
      { maxRounds: 3 }
    );
    log(r6.stoppedReason === 'fix-failed', '修复者失败 → fix-failed', r6.stoppedReason);
    log(r6.rounds[0].fixError === 'LLM 超时', '保留修复失败原因', r6.rounds[0].fixError);

    // 4.7 修复者抛异常
    const r7 = await runAutoFixLoop(
      {
        runTests: sequence([failRun()]),
        applyFix: async () => {
          throw new Error('子 Agent 崩溃');
        },
      },
      { maxRounds: 3 }
    );
    log(r7.stoppedReason === 'fix-failed', '修复者抛异常 → fix-failed', r7.stoppedReason);
    log((r7.rounds[0].fixError || '').includes('子 Agent 崩溃'), '捕获异常信息', r7.rounds[0].fixError);

    // 4.8 abort
    const ctrl = new AbortController();
    ctrl.abort();
    const r8 = await runAutoFixLoop(
      { runTests: sequence([failRun()]), applyFix: async () => ({ success: true }), signal: ctrl.signal },
      { maxRounds: 3 }
    );
    log(r8.stoppedReason === 'aborted', 'abort 后立即停止', r8.stoppedReason);
    log(r8.rounds.length === 0, '未开始跑测试', String(r8.rounds.length));

    // 4.9 无框架
    const r9 = await runAutoFixLoop(
      { runTests: async () => ({ success: false, exitCode: 1, framework: 'unknown' }), applyFix: async () => ({ success: true }) },
      { maxRounds: 3 }
    );
    log(r9.stoppedReason === 'no-framework', '无框架 → no-framework', r9.stoppedReason);
    log(describeStopReason('no-progress').includes('无进展'), 'stopReason 有中文说明');

    // 4.10 maxRounds 夹紧
    log(clampRounds(99) === 5, 'clampRounds(99) = 5', String(clampRounds(99)));
    log(clampRounds(0) === 1, 'clampRounds(0) = 1', String(clampRounds(0)));
    log(clampRounds(undefined) === 3, 'clampRounds(undefined) = 3', String(clampRounds(undefined)));
    log(clampRounds('abc') === 3, 'clampRounds("abc") = 3', String(clampRounds('abc')));
    const rClamp = await runAutoFixLoop(
      { runTests: sequence([GREEN]), applyFix: async () => ({ success: true }) },
      { maxRounds: 99 }
    );
    log(rClamp.maxRounds === 5, '循环内 maxRounds 也被夹到 5', String(rClamp.maxRounds));

    // 4.11 durationMs 透传
    log(r2.rounds[0].durationMs === 900, 'durationMs 透传', String(r2.rounds[0].durationMs));
  }

  console.log('\n[5] ToolManager 注册 / 并发策略 / 权限档位');
  {
    const tm = Object.create(ToolManager.prototype);
    tm.fsAdapter = null;
    tm.terminalAdapter = null;
    tm.mcpHub = null;
    tm.checkpointManager = null;
    tm.codebaseIndexer = null;
    tm.sessionId = null;
    tm.workspaceId = null;
    tm.modifiedFiles = new Set();
    const tools = await tm.getAvailableTools('coder');
    const names = new Set(tools.map((t) => t.name));
    log(names.has(AUTOFIX_TOOL_NAME), `已注册: ${AUTOFIX_TOOL_NAME}`);
    const def = tools.find((t) => t.name === AUTOFIX_TOOL_NAME);
    log(!!def?.parameters?.properties?.maxRounds, '工具含 maxRounds 参数');
    log(!!def?.parameters?.properties?.fixTurns, '工具含 fixTurns 参数');
    log((def?.description || '').includes('自愈'), '工具描述说明了自愈语义');

    const askTools = await tm.getAvailableTools('ask');
    log(!new Set(askTools.map((t) => t.name)).has(AUTOFIX_TOOL_NAME), 'ask 模式不提供该工具');

    log(DEFAULT_TOOL_POLICIES[AUTOFIX_TOOL_NAME] === 'global-serial', '并发策略为全局串行');
    log(classifyTool(AUTOFIX_TOOL_NAME) === 'exec', '归类 exec（只读档位会被拦）');
  }

  console.log('\n[6] AgentManager 接线');
  {
    const src = await fs.readFile(
      path.resolve(process.cwd(), 'electron/core-fork/agent/AgentManager.ts'),
      'utf8'
    );
    log(src.includes('AUTOFIX_TOOL_NAME'), 'AgentManager 已引用 AUTOFIX_TOOL_NAME');
    log(src.includes('runAutoFixLoop('), '已调用 runAutoFixLoop');
    log(/call\.name === AUTOFIX_TOOL_NAME/.test(src), '工具调用被拦截处理');
    log(src.includes("agentType: 'general-purpose'"), '修复者用 general-purpose 子 Agent');
    log(code008(src), '拦截点在 toolManager.execute 之前', 'order');
  }

  console.log('\n[7] 真实链路：真跑 npm test（含 TestRunner 失败输出捕获）');
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'w27-real-'));
    try {
      await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'w27-real', version: '1.0.0', scripts: { test: 'node test.js' } })
      );
      const testFile = path.join(root, 'test.js');
      await fs.writeFile(
        testFile,
        `function add(a, b) { return a - b; }\nconst assert = require('node:assert');\nassert.strictEqual(add(1, 2), 3);\n`
      );

      const bad = await runProjectTests(root);
      log(bad.success === false, '真实项目：npm test 失败被识别', String(bad.success));
      log(bad.framework === 'npm', '真实项目：框架识别为 npm', bad.framework);
      // 回归本轮的修复：失败时再也不能是空输出
      log((bad.stdout + bad.stderr).length > 0, '真实项目：失败时仍有输出（TestRunner 修复）', `len=${(bad.stdout + bad.stderr).length}`);

      const parsed = parseTestOutput(bad);
      log(parsed.failures.length === 1, '真实项目：解析出 1 条失败', `got ${parsed.failures.length}`);
      log((parsed.failures[0]?.file || '').endsWith('test.js'), '真实项目：定位到 test.js', parsed.failures[0]?.file);
      log(parsed.failures[0]?.line === 3, '真实项目：行号 3', String(parsed.failures[0]?.line));

      const report = await runAutoFixLoop(
        {
          runTests: () => runProjectTests(root),
          applyFix: async () => {
            const src = await fs.readFile(testFile, 'utf8');
            await fs.writeFile(testFile, src.replace('a - b', 'a + b'), 'utf8');
            return { success: true, output: '把 add 的减号改回加号' };
          },
        },
        { maxRounds: 2 }
      );
      log(report.success && report.stoppedReason === 'passed', '真实项目：自愈到全绿', report.stoppedReason);
      log(report.rounds.length === 2, '真实项目：2 轮完成', String(report.rounds.length));
      log(formatAutoFixReport(report).includes('测试已通过'), '真实项目：报告可读');
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log(`\n结果：${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

/** 校验拦截发生在 toolManager.execute 之前（先拦截再做普通执行会走错分支） */
function code008(src) {
  const intercept = src.indexOf('call.name === AUTOFIX_TOOL_NAME');
  const exec = src.indexOf('this.toolManager.execute(call.name');
  return intercept > 0 && exec > 0 && intercept < exec;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
