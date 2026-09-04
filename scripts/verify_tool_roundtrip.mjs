/**
 * 无头端到端验证：Agent 工具调用两轮往返
 * 复现 AgentManager.run 的消息流：
 *   R1: system + user("现在几点了?") -> 期望模型返回 tool_calls (execute_command)
 *   模拟执行 -> 拼接 OpenAI 标准格式 assistant(tool_calls) + tool(tool_call_id)
 *   R2: 同序列再发一轮 -> 期望模型基于工具结果给出最终文本回答
 * 目的：验证 AgentManager.ts 里修复后的 tool_calls 回传格式能被真实 API 接受并推进。
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfgPath = path.join(os.homedir(), 'AppData/Roaming/cnke-claw/config/app-config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
const api = cfg.apiConfigs.find((c) => c.id === cfg.activeApiConfigId) || cfg.apiConfigs[0];
if (!api) { console.error('没有找到 API 配置'); process.exit(1); }

const baseUrl = (api.baseUrl || '').replace(/\/+$/, '');
const url = /\/v\d+(beta\d*)?$/.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: '在终端执行 Shell 命令。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '工作目录' },
        },
        required: ['command'],
      },
    },
  },
];

async function chat(messages) {
  const body = {
    model: api.model,
    messages,
    tools,
    temperature: 0.7,
    top_p: 1.0,
    stream: true,
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(api.apiKey ? { Authorization: `Bearer ${api.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('text/html')) throw new Error('端点返回 HTML 而非 JSON 流');

  const reader = resp.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data: ')) continue;
      const jsonStr = t.slice(6);
      if (jsonStr === '[DONE]') continue;
      try {
        const chunk = JSON.parse(jsonStr);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) content += delta.content;
        if (delta.reasoning_content || delta.thinking) reasoning += delta.reasoning_content || delta.thinking;
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index || 0;
            if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, name: '', arguments: '' };
            if (tc.function?.name) toolCalls[idx].name = tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
          }
        }
      } catch { /* skip */ }
    }
  }
  return {
    content,
    reasoning,
    toolCalls: toolCalls
      .filter((tc) => tc && tc.name)
      .map((tc) => ({
        id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
        name: tc.name,
        argsStr: tc.arguments || '{}',
      })),
  };
}

function execSim(command) {
  // 只做白名单模拟执行，避免无头脚本真的跑任意命令
  if (/Get-Date/i.test(command)) {
    return '2026-09-02 14:35:12 +08:00';
  }
  return `[模拟执行结果] 命令已执行完成 (${command.slice(0, 60)})`;
}

console.log(`[verify] model=${api.model} url=${url}\n`);
console.log('=== R1: 首次提问 ===');
const r1 = await chat([
  { role: 'system', content: '你是一个助手。当前运行在 Windows + PowerShell 环境。要获取当前时间请调用 execute_command，命令用 Get-Date -Format \'yyyy-MM-dd HH:mm:ss zzz\'' },
  { role: 'user', content: '现在几点了？请查询一下当前时间。' },
]);
console.log(`R1 content=${JSON.stringify(r1.content)} reasoningLen=${r1.reasoning.length}`);
if (r1.toolCalls.length === 0) {
  console.log('!! R1 模型未触发工具调用（直接回答或未走工具路径），无法验证工具往返。');
  process.exit(2);
}
console.log(`R1 toolCalls=${JSON.stringify(r1.toolCalls)}`);

// 模拟工具执行
const results = r1.toolCalls.map((tc) => ({ tc, out: execSim(tc.argsStr) }));

// 按 AgentManager.ts 修复后的格式拼接
const assistantMsg = {
  role: 'assistant',
  content: r1.content || null,
  tool_calls: r1.toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function',
    function: { name: tc.name, arguments: tc.argsStr },
  })),
};
const toolMsgs = results.map(({ tc, out }) => ({
  role: 'tool',
  tool_call_id: tc.id,
  content: out,
}));

console.log('\n=== R2: 回传标准格式后再次请求 ===');
const msgs2 = [
  { role: 'system', content: '你是一个助手。当前运行在 Windows + PowerShell 环境。' },
  { role: 'user', content: '现在几点了？请查询一下当前时间。' },
  assistantMsg,
  ...toolMsgs,
];
try {
  const r2 = await chat(msgs2);
  console.log(`R2 content=${JSON.stringify(r2.content)}`);
  if (r2.toolCalls.length) console.log(`R2 又触发工具: ${r2.toolCalls.map((t) => t.name).join(',')}`);
  const ok = r2.content && r2.content.length > 0;
  console.log(ok ? '\n✅ 通过：第二轮正常返回文本，工具往返链路 OK（消息格式被 API 接受）' : '\n⚠️ 第二轮返回空文本，需进一步排查');
  process.exit(ok ? 0 : 3);
} catch (err) {
  console.error(`\n❌ R2 失败: ${err.message}`);
  console.error('（说明回传格式仍被 API 拒绝 → 检查 tool_calls / tool_call_id / content 类型）');
  process.exit(4);
}
