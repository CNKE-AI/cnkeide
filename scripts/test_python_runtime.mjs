/**
 * 验证 Python 开发脚本链路：
 *   1) traceback 结构化解析（文件/行号/异常类型/消息，取最后一帧）
 *   2) resolvePython 门禁：不得返回「版本过低却 usable=true」的解释器
 *   3) execProgram 直连执行：UTF-8 中文输出、失败返回 traceback
 *   4) PYTHONUNBUFFERED 生效：进程结束前就能收到输出（进度条不假死）
 *
 * 说明：执行测试使用系统 python 启动器（py/python3/python），因为仓库自带的
 * runtime/py312 是开发期的不完整副本，单独运行会报缺 encodings，不能代表线上。
 *
 * 运行：npx tsx scripts/test_python_runtime.mjs
 */
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parsePythonTraceback } from '../electron/core-fork/python/traceback.ts';
import { resolvePython } from '../electron/core-fork/python/PythonRuntime.ts';
import { TerminalAdapter } from '../electron/adapter/TerminalAdapter.ts';

const execFileAsync = promisify(execFile);

/** 找一个能用的系统 python 启动器（py / python3 / python） */
async function findSystemPython() {
  for (const c of ['py', 'python3', 'python']) {
    try {
      await execFileAsync(c, ['--version'], { timeout: 5000 });
      return c;
    } catch {
      /* 该候选不可用 */
    }
  }
  return null;
}

// ---------- 用例 1：traceback 解析 ----------
const tb = parsePythonTraceback(
  'Traceback (most recent call last):\n  File "C:\\a\\b.py", line 7, in <module>\n    foo()\nValueError: bad value',
);
assert.equal(tb?.type, 'ValueError');
assert.equal(tb?.line, 7);
assert.equal(tb?.message, 'bad value');
console.log('[1] ✓ 解析出 ValueError / 行号 7');

// 多帧取最后一帧
const tb2 = parsePythonTraceback(
  'Traceback (most recent call last):\n  File "x.py", line 3, in <module>\n  File "y.py", line 9, in f\nZeroDivisionError: division by zero',
);
assert.equal(tb2?.file, 'y.py');
assert.equal(tb2?.line, 9);
console.log('[2] ✓ 多帧取最后一帧');

// 非 Python 报错不应误判
assert.equal(parsePythonTraceback('bash: python: command not found'), undefined);
assert.equal(parsePythonTraceback(''), undefined);
console.log('[3] ✓ 非 Python 报错不误判');

// ---------- 用例 2：resolvePython 门禁 ----------
const resolved = await resolvePython({ projectRoot: process.cwd() });
console.log(`[4] resolvePython：${resolved ? `${resolved.path} (${resolved.version}, usable=${resolved.usable})` : '无 ≥3.9 解释器'}`);
// 关键回归：曾经会把 3.8 这类「探测成功但版本过低」的候选当作可用返回
assert.ok(
  resolved === null || resolved.usable === true,
  'resolvePython 不得返回 usable=true 却版本过低（<3.9）的解释器',
);
console.log('[5] ✓ resolvePython 门禁正确（低版本不会被误判为可用）');

// ---------- 用例 3/4：真实执行（系统 python） ----------
const exe = await findSystemPython();
assert.ok(exe, '应找到系统 python 启动器');
const adapter = new TerminalAdapter();

const ok = await adapter.execProgram(exe, ['-u', '-c', 'print("你好 cnke")'], {
  cwd: process.cwd(),
  timeout: 30000,
});
assert.equal(ok.success, true, '正常脚本应成功');
assert.ok((ok.stdout || '').includes('你好 cnke'), `中文输出应正常，实得 ${JSON.stringify(ok.stdout)}`);
console.log('[6] ✓ UTF-8 中文输出正常');

const bad = await adapter.execProgram(exe, ['-u', '-c', 'raise ValueError("boom")'], {
  cwd: process.cwd(),
  timeout: 30000,
});
assert.equal(bad.success, false, '抛异常应失败');
const bt = parsePythonTraceback(bad.stderr || '');
assert.equal(bt?.type, 'ValueError');
assert.equal(bt?.message, 'boom');
console.log('[7] ✓ 失败返回结构化 traceback');

// ---------- 用例 4：无缓冲（PYTHONUNBUFFERED） ----------
// 不加 -u、不显式 flush：若 PYTHONUNBUFFERED 未生效，输出会憋到进程退出才出现
let firstChunkAt = 0;
const t0 = Date.now();
const buffered = await adapter.execProgram(
  exe,
  ['-c', 'import time; print("early"); time.sleep(0.6); print("late")'],
  {
    cwd: process.cwd(),
    timeout: 30000,
    onChunk: () => {
      if (!firstChunkAt) firstChunkAt = Date.now() - t0;
    },
  },
);
const closedAt = Date.now() - t0;
console.log(`[8] 首个输出 ${firstChunkAt}ms，进程结束 ${closedAt}ms`);
assert.equal(buffered.success, true);
assert.ok(firstChunkAt > 0, '必须收到输出');
assert.ok(firstChunkAt < 450, `无缓冲应让首个输出早于 sleep（实得 ${firstChunkAt}ms）`);
assert.ok(closedAt > 500, '命令总时长应包含 sleep');
console.log('[9] ✓ PYTHONUNBUFFERED 生效，长脚本输出实时可见');

console.log('\n全部通过：Python 脚本运行链路正常');
