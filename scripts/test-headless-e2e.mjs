/**
 * headless CLI 端到端验收（不依赖真实 LLM）。
 *
 * 起一个本地 mock OpenAI 兼容服务（SSE 流），用 CLI 产物跑完整 Agent 循环：
 *   - 只读工具自动放行
 *   - 写工具默认被拒（不落盘）
 *   - --allow-tool / --approve-policy never 放行后真正写盘
 *   - --json / --final-only 输出形态
 *   - 用法错误退出码
 *
 * 运行：node scripts/build-cli.mjs && node scripts/test-headless-e2e.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'dist-cli/cnkeide.cjs');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

// ---------- mock LLM ----------
function sse(res, chunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 依据 messages 是否已有 tool 结果决定「发起工具调用」还是「给出最终答复」 */
function buildChunks(body) {
  const hasToolResult = Array.isArray(body.messages) && body.messages.some((m) => m && m.role === 'tool');
  if (!hasToolResult) {
    const target = currentTool;
    return [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_mock_1',
                  type: 'function',
                  function: { name: target.name, arguments: JSON.stringify(target.arguments) },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
  }
  return [
    { choices: [{ delta: { content: 'MOCK-FINAL- ANSWER' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 } },
  ];
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      /* ignore */
    }
    sse(res, buildChunks(body));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// ---------- 环境 ----------
const base = path.join(os.tmpdir(), `cnkeide-e2e-${process.pid}`);
const dataDir = path.join(base, 'data');
const workDir = path.join(base, 'work');
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
fs.mkdirSync(workDir, { recursive: true });
fs.writeFileSync(path.join(workDir, 'hello.txt'), 'HELLO-HEADLESS', 'utf8');

fs.writeFileSync(
  path.join(dataDir, 'config', 'app-config.json'),
  JSON.stringify(
    {
      apiConfigs: [
        {
          id: 'cfg-mock',
          name: 'mock',
          provider: 'openai',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'sk-mock',
          model: 'mock-model',
        },
      ],
      activeApiConfigId: 'cfg-mock',
      agentConfig: { mode: 'coder', enableRouting: false, maxTurns: 6 },
    },
    null,
    2
  ),
  'utf8'
);

/** 当前场景要 mock 的工具调用（mock 服务跑在本进程，不能用子进程 env 传递） */
let currentTool = { name: 'read_file', arguments: { path: 'hello.txt' } };

/** 必须异步 spawn：mock 服务与测试跑在同一进程，spawnSync 会阻塞事件循环导致请求无人应答 */
function run(args, tool) {
  return new Promise((resolve) => {
    currentTool = tool || { name: 'read_file', arguments: { path: 'hello.txt' } };
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: workDir,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 90000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** 构造 mock 工具调用 */
const T = (name, args) => ({ name, arguments: args });

const COMMON = ['--data-dir', dataDir, '--cwd', workDir, '--mode', 'craft', '--timeout', '60'];

try {
  console.log('\n[1] 只读工具（read_file）自动放行');
  {
    const r = await run([...COMMON, '-p', '读一下 hello.txt', '--json', '--no-memory'], T('read_file', { path: 'hello.txt' }));
    check('退出码 0', r.code === 0, `code=${r.code} stderr=${r.stderr.slice(0, 300)}`);
    const lines = r.stdout.split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
    const events = lines.filter(Boolean);
    check('NDJSON 全部可解析', events.length === lines.length);
    check('含 run_start', events.some((e) => e.type === 'run_start'));
    check('含 tool_call(read_file)', events.some((e) => e.type === 'tool_call' && e.name === 'read_file'));
    const toolResult = events.find((e) => e.type === 'tool_result');
    check('工具结果是文件内容', !!toolResult && String(toolResult.output).includes('HELLO-HEADLESS'), JSON.stringify(toolResult || {}).slice(0, 200));
    const end = events.find((e) => e.type === 'run_end');
    check('run_end success + exitCode 0', !!end && end.status === 'success' && end.exitCode === 0, JSON.stringify(end || {}));
    check('最终内容非空', !!end && String(end.content).includes('MOCK-FINAL'));
    check('含 usage', events.some((e) => e.type === 'usage'));
  }

  console.log('\n[2] 写工具默认被拒（untrusted）');
  {
    const target = path.join(workDir, 'denied.txt');
    fs.rmSync(target, { force: true });
    const r = await run([...COMMON, '-p', '写一个文件', '--json', '--no-memory'], T('write_to_file', { path: 'denied.txt', content: 'x' }));
    const events = r.stdout.split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    const toolResult = events.find((e) => e.type === 'tool_result');
    check('工具结果标记拒绝', !!toolResult && /拒绝/.test(String(toolResult.output)), JSON.stringify(toolResult || {}));
    check('文件未落盘', !fs.existsSync(target));
  }

  console.log('\n[3] --allow-tool 放行后真正写盘');
  {
    const r = await run([...COMMON, '-p', '写一个文件', '--json', '--no-memory', '--allow-tool', 'write_to_file'], T('write_to_file', { path: 'allowed.txt', content: 'WRITTEN-BY-CLI' }));
    const target = path.join(workDir, 'allowed.txt');
    check('退出码 0', r.code === 0, `code=${r.code}`);
    check('文件已创建', fs.existsSync(target));
    check('内容正确', fs.existsSync(target) && fs.readFileSync(target, 'utf8').includes('WRITTEN-BY-CLI'));
  }

  console.log('\n[4] --approve-policy never 全放行');
  {
    const r = await run([...COMMON, '-p', '写一个文件', '--json', '--no-memory', '--approve-policy', 'never'], T('write_to_file', { path: 'never.txt', content: 'N' }));
    check('文件已创建', fs.existsSync(path.join(workDir, 'never.txt')), `code=${r.code} ${r.stderr.slice(0, 200)}`);
  }

  console.log('\n[5] --final-only 纯文本输出');
  {
    const r = await run([...COMMON, '-p', '读一下 hello.txt', '--final-only', '--no-memory'], T('read_file', { path: 'hello.txt' }));
    check('退出码 0', r.code === 0, `code=${r.code}`);
    check('stdout 只有最终内容', r.stdout.trim() === 'MOCK-FINAL- ANSWER', JSON.stringify(r.stdout));
  }

  console.log('\n[6] 默认输出（流式文本 + 日志走 stderr）');
  {
    const r = await run([...COMMON, '-p', '读一下 hello.txt', '--no-memory'], T('read_file', { path: 'hello.txt' }));
    check('退出码 0', r.code === 0, `code=${r.code}`);
    check('stdout 含回复文本', r.stdout.includes('MOCK-FINAL'));
    check('工具调用提示在 stderr', /调用工具/.test(r.stderr), r.stderr.slice(0, 200));
  }

  console.log('\n[7] 用法错误 / 帮助 / 版本');
  {
    check('--version 退出码 0', (await run(['--version'])).code === 0);
    check('--help 退出码 0', (await run(['--help'])).code === 0);
    const noArgs = await run([]);
    check('无参数退出码 2', noArgs.code === 2, `code=${noArgs.code}`);
    const bogus = await run(['--bogus']);
    check('未知参数退出码 2', bogus.code === 2, `code=${bogus.code}`);
  }

  console.log('\n[8] --model 锁定与不存在模型报错');
  {
    const ok = await run([...COMMON, '-p', '读一下 hello.txt', '--model', 'cfg-mock', '--no-memory'], T('read_file', { path: 'hello.txt' }));
    check('--model 指定配置 ID 可运行', ok.code === 0, `code=${ok.code} ${ok.stderr.slice(0, 200)}`);
    const bad = await run([...COMMON, '-p', 'x', '--model', 'not-exist-model', '--no-memory']);
    check('不存在的模型退出码 1', bad.code === 1, `code=${bad.code}`);
    check('错误信息可读', /找不到模型配置/.test(bad.stderr), bad.stderr.slice(0, 200));
  }

  console.log('\n[9] 无 API 配置时给出明确错误');
  {
    const emptyDir = path.join(base, 'empty');
    fs.mkdirSync(path.join(emptyDir, 'config'), { recursive: true });
    const r = await run(['--data-dir', emptyDir, '--cwd', workDir, '-p', 'x', '--json', '--no-memory']);
    check('退出码 1', r.code === 1, `code=${r.code}`);
    check('提示未配置 API', /未配置 API/.test(r.stdout + r.stderr));
  }
} finally {
  server.close();
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
