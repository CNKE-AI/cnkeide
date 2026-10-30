/**
 * AutoFixLoop - 测试失败自愈循环（W27）
 *
 * run_tests → 解析失败（结构化 file:line + 原因）→ 修复者（LLM 子循环）
 * → 再跑 → 直到全绿 / 到轮数上限 / 无进展 / 用户取消。
 *
 * 与执行环境解耦：runTests / applyFix 都是注入依赖，本文件不 import LLM 与 ToolManager，
 * 单测可用假实现跑完整循环。
 *
 * 护栏：maxRounds 上限 5；两轮失败签名相同时立即停（无进展）；失败最多留 20 条；
 * prompt 里硬性禁止「改断言 / skip 测试」来伪造通过。
 */

export type FailureKind = 'assertion' | 'compile' | 'runtime' | 'timeout' | 'unknown';

export interface FailureInfo {
  file?: string;
  line?: number;
  column?: number;
  test?: string;
  message: string;
  kind: FailureKind;
}

export interface ParsedTestOutput {
  framework: string;
  failures: FailureInfo[];
  /** 失败签名短哈希，用于"无进展"判定 */
  signature: string;
  countsHint?: string;
}

/** 与 TestRunner.TestRunResult 结构兼容的最小契约 */
export interface AutoFixTestRun {
  success?: boolean;
  framework?: string;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  error?: string;
  truncated?: boolean;
}

export interface FixOutcome {
  success: boolean;
  output?: string;
  error?: string;
}

export type AutoFixStopReason =
  | 'passed'
  | 'max-rounds'
  | 'no-progress'
  | 'aborted'
  | 'no-framework'
  | 'fix-failed';

export interface AutoFixRound {
  round: number;
  passed: boolean;
  exitCode: number;
  failures: FailureInfo[];
  signature: string;
  durationMs?: number;
  fixSummary?: string;
  fixError?: string;
}

export interface AutoFixReport {
  success: boolean;
  rounds: AutoFixRound[];
  failures: FailureInfo[];
  stoppedReason: AutoFixStopReason;
  maxRounds: number;
}

export interface AutoFixOptions {
  maxRounds?: number;
  /** 失败签名重复即判定无进展，默认 true */
  stopOnRepeat?: boolean;
}

export interface AutoFixEvent {
  type: 'round_result' | 'fix_start' | 'fix_done' | 'finished';
  round: number;
  data?: any;
}

export interface AutoFixDeps {
  runTests: () => Promise<AutoFixTestRun>;
  applyFix: (prompt: string, ctx: { round: number; failures: FailureInfo[] }) => Promise<FixOutcome>;
  signal?: AbortSignal;
  emit?: (event: AutoFixEvent) => void;
}

const MAX_ROUNDS_LIMIT = 5;
const DEFAULT_MAX_ROUNDS = 3;
const MAX_FAILURES = 20;
const RAW_TAIL_CHARS = 2000;

/* ---------------- 文本工具 ---------------- */

export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return String(input ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

export function normalizeMessage(message: string): string {
  const text = stripAnsi(message).replace(/\r/g, '').replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function normalizeFile(file?: string): string | undefined {
  if (!file) return undefined;
  const f = file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return f || undefined;
}

/** 粗略判断测试文件（用于提示修复者"别改裁判"） */
export function isTestFile(file?: string): boolean {
  const f = normalizeFile(file);
  if (!f) return false;
  if (/(^|\/)(__tests__|__mocks__|tests?|spec)\//i.test(f)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(f)) return true;
  if (/(^|\/)test_[^/]+\.py$/i.test(f)) return true;
  if (/_test\.go$/i.test(f)) return true;
  return false;
}

/** 32 位 FNV-1a → 8 位十六进制（够用、无依赖、跨平台稳定） */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 失败签名：只反映"哪里错、错成什么样"，与顺序无关 */
export function failureSignature(failures: FailureInfo[]): string {
  if (!failures || failures.length === 0) return 'green';
  const parts = failures
    .map((f) => `${normalizeFile(f.file) || '?'}:${f.line ?? 0}|${f.kind}|${normalizeMessage(f.message)}`)
    .sort();
  return fnv1a(parts.join('\n'));
}

/* ---------------- 输出解析 ---------------- */

interface Frame {
  file?: string;
  line?: number;
  column?: number;
}

const RE_TSC = /^(.*?)\((\d+),(\d+)\):\s*error\s+(TS\d+)\s*:\s*(.+)$/;
const RE_TSC_BARE = /^(.+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+)\s*:\s*(.+)$/;
const RE_PYTEST_FAILED = /^FAILED\s+(\S+?)(?:\s+-\s+(.*))?$/;
const RE_PY_LOC = /^(\S+\.py):(\d+):\s*(.+)$/;
const RE_GO_FAIL = /^---\s+FAIL:\s+(\S+)/;
const RE_GO_LOC = /^\s+(\S+?\.go):(\d+):\s*(.+)$/;
const RE_CARGO_PANIC = /panicked at\s+(.+?):(\d+):(\d+)/;
const RE_TEST_FILE_HEAD = /^\s*(?:FAIL|❯)\s+(\S+?\.[cm]?[jt]sx?)(?:\s+>\s*(.+))?$/;
const RE_JEST_BULLET = /^\s*●\s+(.+)$/;
const RE_STACK = /^\s*at\s+(?:.*?\s+\()?([^()\s]+?):(\d+):(\d+)\)?\s*$/;
const RE_BARE_LOC = /^([^()\s]+?\.[cm]?[jt]sx?):(\d+):(\d+)$/;
const RE_ERR_LINE = /^(?:AssertionError|TypeError|ReferenceError|RangeError|SyntaxError|Error|expect\b)/;

function frameFromLine(line: string): Frame | null {
  const stack = line.match(RE_STACK);
  if (stack) return { file: stack[1], line: Number(stack[2]), column: Number(stack[3]) };
  // vitest 的帧长这样：` ❯ src/math.ts:2:10`，要先剥掉 ❯/> 前缀
  const bare = line.trim().replace(/^[❯>›]\s*/, '').match(RE_BARE_LOC);
  if (bare) return { file: bare[1], line: Number(bare[2]), column: Number(bare[3]) };
  // pytest 位置行：`tests/test_a.py:5: AssertionError`
  const py = line.trim().match(/^([^()\s]+?\.py):(\d+):/);
  if (py) return { file: py[1], line: Number(py[2]) };
  return null;
}

/** 向后找最近的业务栈帧（跳过 node 内部与 node_modules） */
function nearestFrameAfter(lines: string[], startIdx: number, maxScan = 12): Frame | null {
  const end = Math.min(lines.length, startIdx + maxScan);
  for (let i = startIdx; i < end; i++) {
    const frame = frameFromLine(lines[i]);
    if (!frame?.file) continue;
    if (/node_modules|node:internal|^node:/.test(frame.file)) continue;
    return frame;
  }
  return null;
}

function pushFailure(list: FailureInfo[], item: FailureInfo, seen: Set<string>): void {
  const message = normalizeMessage(item.message);
  if (!message) return;
  const file = normalizeFile(item.file);
  const key = `${file || '?'}:${item.line ?? 0}:${item.kind}:${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ ...item, file, message });
}

/**
 * 解析测试输出为结构化失败列表。
 * 覆盖 tsc / vitest / jest / mocha / pytest / go test / cargo test / 裸 node 栈；
 * 都解析不到但有非零退出码时，退化为"扒所有业务栈帧"，至少给模型留线索。
 */
export function parseTestOutput(run: {
  stdout?: string;
  stderr?: string;
  framework?: string;
  exitCode?: number;
}): ParsedTestOutput {
  const text = stripAnsi(`${run.stdout ?? ''}\n${run.stderr ?? ''}`).replace(/\r/g, '');
  const lines = text.split('\n');
  const failures: FailureInfo[] = [];
  const seen = new Set<string>();
  let currentFile: string | undefined;
  let currentTest: string | undefined;

  for (let i = 0; i < lines.length && failures.length < MAX_FAILURES; i++) {
    const line = lines[i].trimEnd();
    if (!line.trim()) continue;

    // 1) TS 编译错误
    const tsc = line.match(RE_TSC) || line.match(RE_TSC_BARE);
    if (tsc) {
      currentFile = tsc[1];
      pushFailure(failures, {
        file: tsc[1],
        line: Number(tsc[2]),
        column: Number(tsc[3]),
        message: `${tsc[4]}: ${tsc[5]}`,
        kind: 'compile',
      }, seen);
      continue;
    }

    // 2) vitest / jest 的 FAIL 文件头
    const head = line.match(RE_TEST_FILE_HEAD);
    if (head) {
      currentFile = head[1];
      if (head[2]) currentTest = head[2].trim();
      continue;
    }

    // 3) jest 的 ● 用例标题
    const bullet = line.match(RE_JEST_BULLET);
    if (bullet) {
      currentTest = bullet[1].trim();
      continue;
    }

    // 4) pytest FAILED 行
    const pyFailed = line.match(RE_PYTEST_FAILED);
    if (pyFailed) {
      const target = pyFailed[1];
      const msg = (pyFailed[2] || '').trim();
      const [file, test] = target.includes('::') ? target.split('::', 2) : [undefined, target];
      const frame = nearestFrameAfter(lines, i + 1, 6);
      pushFailure(failures, {
        file: frame?.file || file,
        line: frame?.line,
        test: test || target,
        message: msg || 'pytest 报告失败（详见原始输出）',
        kind: msg ? 'assertion' : 'unknown',
      }, seen);
      continue;
    }

    // 5) pytest 位置行
    const pyLoc = line.match(RE_PY_LOC);
    if (pyLoc && /(assert|AssertionError|Error)/i.test(pyLoc[3])) {
      pushFailure(failures, {
        file: pyLoc[1],
        line: Number(pyLoc[2]),
        message: pyLoc[3],
        kind: /Error/i.test(pyLoc[3]) ? 'runtime' : 'assertion',
      }, seen);
      continue;
    }

    // 6) go test
    const goFail = line.match(RE_GO_FAIL);
    if (goFail) {
      currentTest = goFail[1];
      currentFile = undefined;
      continue;
    }
    const goLoc = line.match(RE_GO_LOC);
    if (goLoc) {
      pushFailure(failures, {
        file: goLoc[1],
        line: Number(goLoc[2]),
        test: currentTest,
        message: goLoc[3],
        kind: 'assertion',
      }, seen);
      continue;
    }

    // 7) cargo
    const panic = line.match(RE_CARGO_PANIC);
    if (panic) {
      pushFailure(failures, {
        file: panic[1],
        line: Number(panic[2]),
        column: Number(panic[3]),
        test: currentTest,
        message: (lines[i + 1] || 'panicked').trim(),
        kind: 'runtime',
      }, seen);
      continue;
    }
    const cargoHeader = line.match(/^----\s+(.+?)\s+stdout\s+----$/);
    if (cargoHeader) {
      currentTest = cargoHeader[1].trim();
      continue;
    }

    // 8) 断言/异常消息行（vitest / jest / mocha 主体）
    if (RE_ERR_LINE.test(line.trim())) {
      const frame = nearestFrameAfter(lines, i + 1);
      pushFailure(failures, {
        file: frame?.file || currentFile,
        line: frame?.line,
        column: frame?.column,
        test: currentTest,
        message: line.trim(),
        // 注意顺序：AssertionError 里也含 "Error"，先判断言再判运行时
        kind: /AssertionError|expected\b|expect\(/i.test(line) ? 'assertion' : 'runtime',
      }, seen);
      continue;
    }

    // 9) 超时
    if (/timed?\s*out|TimeoutError|exceeded \d+\s*ms/i.test(line)) {
      pushFailure(failures, {
        file: currentFile,
        test: currentTest,
        message: line.trim(),
        kind: 'timeout',
      }, seen);
      continue;
    }
  }

  // 10) 兜底：一条都没解析出来但确实失败 → 扒栈帧
  if (failures.length === 0 && (run.exitCode ?? 0) !== 0) {
    for (const line of lines) {
      const frame = frameFromLine(line);
      if (!frame?.file) continue;
      if (/node_modules|node:internal/.test(frame.file)) continue;
      pushFailure(failures, {
        file: frame.file,
        line: frame.line,
        column: frame.column,
        message: '未解析到失败原因，仅定位到栈帧（详见原始输出）',
        kind: 'unknown',
      }, seen);
      if (failures.length >= 5) break;
    }
  }

  const trimmed = failures.slice(0, MAX_FAILURES);
  return {
    framework: run.framework || 'unknown',
    failures: trimmed,
    signature: failureSignature(trimmed),
    countsHint: text.match(/\d+\s+failed[^\n]{0,40}/i)?.[0].trim(),
  };
}

/* ---------------- Prompt ---------------- */

/**
 * 给修复者的指令。约束写得很硬是刻意的：
 * 「把断言期望值改成实际值」是模型最容易走的捷径——测试确实绿了，bug 还在。
 */
export function buildFixPrompt(params: {
  failures: FailureInfo[];
  round: number;
  maxRounds: number;
  framework?: string;
  command?: string;
  rawTail?: string;
}): string {
  const { failures, round, maxRounds, framework, command, rawTail } = params;
  const list = failures.length
    ? failures
        .map((f, i) => {
          const loc = f.file
            ? `${f.file}${f.line ? `:${f.line}` : ''}${f.column ? `:${f.column}` : ''}`
            : '(位置未知)';
          const flag = isTestFile(f.file) ? '（测试文件）' : '';
          const test = f.test ? ` [用例: ${f.test}]` : '';
          return `${i + 1}. ${loc}${flag}${test} — ${f.kind}: ${f.message}`;
        })
        .join('\n')
    : '(未能解析出结构化失败，请直接看原始输出尾部)';

  return `测试未通过，请定位根因并修复。这是第 ${round}/${maxRounds} 轮自动修复。

## 测试信息
- 框架：${framework || '未知'}
- 命令：${command || '(未记录)'}

## 失败清单
${list}

## 硬性约束（违反等于没修）
1. **不许改测试**：不得修改断言期望值、不得删除用例、不得加 skip/only/todo（\`it.skip\`、\`xit\`、\`@pytest.mark.skip\`、\`t.Skip\`）、不得调低覆盖率或超时阈值来让它变绿。
2. **改产品代码，不改裁判**：只有确认失败源于测试本身写错（例如被测函数的约定确实变了）才可改测试，且必须在结论里写明「这是测试写错，理由是……」。
3. **最小改动**：优先 apply_diff 精确改；不要顺手重构、不要整文件格式化、不要动无关代码。
4. **先看再改**：用 read_file / grep / find_references 确认调用链，不要凭猜测改。
5. **修完只回一句话**：说明改了什么（文件 + 改法），不要长篇总结，不要复述失败清单。

## 原始输出尾部
\`\`\`
${(rawTail || '').slice(-RAW_TAIL_CHARS)}
\`\`\``;
}

/* ---------------- 报告 ---------------- */

const STOP_REASON_TEXT: Record<AutoFixStopReason, string> = {
  passed: '测试已通过',
  'max-rounds': '达到最大修复轮数仍未通过',
  'no-progress': '连续两轮失败完全相同，判定无进展已停止（继续只会白烧 token）',
  aborted: '用户取消',
  'no-framework': '未检测到可用的测试框架',
  'fix-failed': '修复者执行失败',
};

export function describeStopReason(reason: AutoFixStopReason): string {
  return STOP_REASON_TEXT[reason] || reason;
}

export function formatAutoFixReport(report: AutoFixReport): string {
  const lines: string[] = [];
  lines.push(`${report.success ? '✅' : '❌'} 自愈循环结束：${describeStopReason(report.stoppedReason)}`);
  lines.push(`轮数：${report.rounds.length}/${report.maxRounds}`);
  lines.push('');
  lines.push('| 轮次 | 结果 | 失败数 | 耗时 |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of report.rounds) {
    const dur = r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '-';
    lines.push(`| ${r.round} | ${r.passed ? '通过' : `失败(${r.exitCode})`} | ${r.failures.length} | ${dur} |`);
  }
  if (report.failures.length) {
    lines.push('');
    lines.push('剩余失败：');
    for (const f of report.failures.slice(0, 10)) {
      const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '(位置未知)';
      lines.push(`- ${loc} — ${f.message}`);
    }
    if (report.failures.length > 10) lines.push(`- …另有 ${report.failures.length - 10} 条`);
  }
  return lines.join('\n');
}

/* ---------------- 循环 ---------------- */

export function clampRounds(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_ROUNDS;
  return Math.max(1, Math.min(MAX_ROUNDS_LIMIT, Math.trunc(n)));
}

function isGreen(run: AutoFixTestRun): boolean {
  if (typeof run.success === 'boolean') return run.success && (run.exitCode ?? 0) === 0;
  return (run.exitCode ?? 1) === 0;
}

/**
 * 跑自愈循环。
 * 注意顺序：先判绿 → 再判无进展 → 再决定要不要修，避免"已经绿了还去修一次"。
 */
export async function runAutoFixLoop(deps: AutoFixDeps, options: AutoFixOptions = {}): Promise<AutoFixReport> {
  const maxRounds = clampRounds(options.maxRounds);
  const stopOnRepeat = options.stopOnRepeat !== false;
  const rounds: AutoFixRound[] = [];
  let previousSignature = '';
  let finalFailures: FailureInfo[] = [];
  let stoppedReason: AutoFixStopReason = 'max-rounds';

  for (let round = 1; round <= maxRounds; round++) {
    if (deps.signal?.aborted) {
      stoppedReason = 'aborted';
      break;
    }
    const run = await deps.runTests();
    const parsed = parseTestOutput(run);
    const passed = isGreen(run);
    finalFailures = parsed.failures;

    const record: AutoFixRound = {
      round,
      passed,
      exitCode: run.exitCode ?? (passed ? 0 : -1),
      failures: parsed.failures,
      signature: parsed.signature,
      durationMs: run.durationMs,
    };
    rounds.push(record);
    deps.emit?.({ type: 'round_result', round, data: { passed, failures: parsed.failures.length } });

    if (passed) {
      stoppedReason = 'passed';
      break;
    }

    // 没有任何测试框架：修也白修
    if (run.framework === 'unknown' && !run.command) {
      stoppedReason = 'no-framework';
      break;
    }

    // 与上一轮失败完全一致 → 修复没触及根因
    if (stopOnRepeat && previousSignature && parsed.signature === previousSignature) {
      stoppedReason = 'no-progress';
      break;
    }

    if (round === maxRounds) {
      stoppedReason = 'max-rounds';
      break;
    }

    previousSignature = parsed.signature;
    const prompt = buildFixPrompt({
      failures: parsed.failures,
      round,
      maxRounds,
      framework: run.framework,
      command: run.command,
      rawTail: `${run.stdout ?? ''}\n${run.stderr ?? ''}`,
    });

    deps.emit?.({ type: 'fix_start', round });
    let fix: FixOutcome;
    try {
      fix = await deps.applyFix(prompt, { round, failures: parsed.failures });
    } catch (err: any) {
      fix = { success: false, error: err?.message || String(err) };
    }
    deps.emit?.({ type: 'fix_done', round, data: fix });

    if (!fix.success) {
      record.fixError = fix.error || '修复者失败';
      stoppedReason = 'fix-failed';
      break;
    }
    record.fixSummary = (fix.output || '').trim().slice(0, 500);

    if (deps.signal?.aborted) {
      stoppedReason = 'aborted';
      break;
    }
  }

  const report: AutoFixReport = {
    success: stoppedReason === 'passed',
    rounds,
    failures: finalFailures,
    stoppedReason,
    maxRounds,
  };
  deps.emit?.({ type: 'finished', round: rounds.length, data: report });
  return report;
}
