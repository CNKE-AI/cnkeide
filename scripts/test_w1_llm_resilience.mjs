/**
 * W1 LLM 容错单元测试
 * 验证：1) 重试退避  2) 超时中断  3) AbortSignal 取消  4) Fallback 切换
 *
 * 用法：node scripts/test_w1_llm_resilience.mjs
 * 不需要真实 API：用本地 http.createServer 模拟各种失败模式
 */
import http from 'node:http';
import { LLMProvider } from '../electron/core-fork/llm/LLMProvider.js';

const TEST_PORT = 18932;
let pass = 0, fail = 0;

function log(ok, name, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} :: ${detail}`); }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 起一个可控的 mock 服务器：按 scenario 返回指定状态码/延迟 */
function startMock(scenario) {
  return new Promise((resolve) => {
    let callCount = 0;
    const server = http.createServer((req, res) => {
      callCount++;
      const body = [];
      req.on('data', (c) => body.push(c));
      req.on('end', () => {
        const n = callCount;
        const step = scenario.steps[Math.min(n - 1, scenario.steps.length - 1)];
        if (step.delay) {
          setTimeout(() => respond(res, step), step.delay);
        } else {
          respond(res, step);
        }
      });
    });
    function respond(res, step) {
      res.writeHead(step.status || 200, { 'Content-Type': 'application/json' });
      if (step.status && step.status >= 400) {
        res.end(step.body || JSON.stringify({ error: { message: 'mock error' } }));
      } else {
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: step.content || `ok-call-${callCount}` } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
      }
    }
    server.listen(TEST_PORT, '127.0.0.1', () => resolve({ server, getCalls: () => callCount }));
  });
}

const baseCfg = () => ({
  baseUrl: `http://127.0.0.1:${TEST_PORT}`,
  apiKey: 'test-key',
  model: 'mock-model',
});

async function test1_retryThenSuccess() {
  console.log('\n[1] 重试：第一次 500，第二次 200');
  const { server, getCalls } = await startMock({
    steps: [
      { status: 500, body: 'server err' }, // 第 1 次失败（可重试）
      { status: 200, content: 'recovered' }, // 第 2 次成功
    ],
  });
  const p = new LLMProvider();
  try {
    const r = await p.chat({
      apiConfig: baseCfg(),
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      retry: { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 100 },
      timeout: { perAttemptTimeoutMs: 5000, totalTimeoutMs: 10000 },
    });
    log(r.content === 'recovered', '第二次成功', `content=${r.content}`);
    log(getCalls() === 2, '调用了 2 次', `calls=${getCalls()}`);
  } catch (e) {
    log(false, '不应抛错', e.message);
  } finally { server.close(); }
}

async function test2_nonRetryable() {
  console.log('\n[2] 不可重试错误（400）直接抛');
  const { server, getCalls } = await startMock({
    steps: [{ status: 400, body: 'bad request' }],
  });
  const p = new LLMProvider();
  try {
    await p.chat({
      apiConfig: baseCfg(),
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      retry: { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 100 },
    });
    log(false, '400 应该抛错', 'no throw');
  } catch (e) {
    log(/400/.test(e.message), '400 错误', `msg=${e.message}`);
    log(getCalls() === 1, '只调用 1 次（不重试）', `calls=${getCalls()}`);
  } finally { server.close(); }
}

async function test3_timeout() {
  console.log('\n[3] 单次超时：服务端 hang 住');
  const { server, getCalls } = await startMock({
    steps: [{ delay: 3000, status: 200, content: 'too-late' }], // 3s 后才返回
  });
  const p = new LLMProvider();
  const t0 = Date.now();
  try {
    await p.chat({
      apiConfig: baseCfg(),
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      retry: { maxRetries: 1, baseDelayMs: 50, maxDelayMs: 100 },
      timeout: { perAttemptTimeoutMs: 500, totalTimeoutMs: 2000 },
    });
    log(false, '应抛超时', 'no throw');
  } catch (e) {
    const dt = Date.now() - t0;
    log(/超时|TIMEOUT/i.test(e.message), '抛超时错误', `msg=${e.message}`);
    log(dt < 1500, '500ms 内中断（< 1.5s）', `dt=${dt}ms`);
  } finally { server.close(); }
}

async function test4_abort() {
  console.log('\n[4] AbortSignal：用户中途取消');
  const { server, getCalls } = await startMock({
    steps: [{ delay: 2000, status: 200, content: 'should-not-arrive' }],
  });
  const p = new LLMProvider();
  const ctrl = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ctrl.abort(), 200);
  try {
    await p.chat({
      apiConfig: baseCfg(),
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      signal: ctrl.signal,
      retry: { maxRetries: 1 },
      timeout: { perAttemptTimeoutMs: 5000, totalTimeoutMs: 10000 },
    });
    log(false, '应抛取消', 'no throw');
  } catch (e) {
    const dt = Date.now() - t0;
    log(e.name === 'AbortError' || /取消/i.test(e.message), 'AbortError', `name=${e.name} msg=${e.message}`);
    log(dt < 1000, '200ms 内响应 abort', `dt=${dt}ms`);
  } finally { server.close(); }
}

async function test5_fallback() {
  console.log('\n[5] Fallback：主配置 500 切到 fallback 200');
  let portA = TEST_PORT + 1;
  let portB = TEST_PORT + 2;

  // 主服务器：永远 500
  const serverA = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"main down"}');
  });
  await new Promise((r) => serverA.listen(portA, '127.0.0.1', r));
  // 备用：200
  let bCalls = 0;
  const serverB = http.createServer((req, res) => {
    bCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'fallback-ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }));
  });
  await new Promise((r) => serverB.listen(portB, '127.0.0.1', r));

  const p = new LLMProvider();
  try {
    const r = await p.chat({
      apiConfig: { baseUrl: `http://127.0.0.1:${portA}`, apiKey: 'k', model: 'm1' },
      fallbackConfigs: [{ baseUrl: `http://127.0.0.1:${portB}`, apiKey: 'k', model: 'm2' }],
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      retry: { maxRetries: 2, baseDelayMs: 30, maxDelayMs: 50 },
      timeout: { perAttemptTimeoutMs: 2000, totalTimeoutMs: 10000 },
    });
    log(r.content === 'fallback-ok', 'fallback 成功返回', `content=${r.content}`);
    log(r.resolvedConfig?.model === 'm2', 'resolvedConfig 切到 m2', `model=${r.resolvedConfig?.model}`);
    log(bCalls > 0, 'fallback 服务器被调用', `bCalls=${bCalls}`);
  } catch (e) {
    log(false, '不应抛错', e.message);
  } finally {
    serverA.close(); serverB.close();
  }
}

async function test6_totalTimeout() {
  console.log('\n[6] 总超时：重试也救不回来');
  const { server, getCalls } = await startMock({
    steps: [
      { status: 503 }, { status: 503 }, { status: 503 },
    ],
  });
  const p = new LLMProvider();
  const t0 = Date.now();
  try {
    await p.chat({
      apiConfig: baseCfg(),
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      retry: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 200 },
      timeout: { perAttemptTimeoutMs: 1000, totalTimeoutMs: 1500 },
    });
    log(false, '应抛总超时', 'no throw');
  } catch (e) {
    const dt = Date.now() - t0;
    log(/503/i.test(e.message), '最终抛 503 错误（无 fallback 时）', `msg=${e.message}`);
    log(dt < 2500, '1.5s 内退出', `dt=${dt}ms`);
  } finally { server.close(); }
}

(async () => {
  console.log('=== W1 LLM 容错测试 ===');
  await test1_retryThenSuccess();
  await test2_nonRetryable();
  await test3_timeout();
  await test4_abort();
  await test5_fallback();
  await test6_totalTimeout();
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
