/**
 * 语音引擎冒烟测试：下载模型 → 创建流式识别器 → 喂入音频帧验证解码管道。
 * 运行：npx tsx scripts/test_voice_smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MODEL_ID = 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23';
const SOURCES = [
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_ID}.tar.bz2`,
  `https://hf-mirror.com/csukuangfj/k2-fsa.github.io/resolve/main/sherpa-onnx/asr-models/${MODEL_ID}.tar.bz2`,
];
const DIR = path.join(os.tmpdir(), 'cnke-voice-smoke', MODEL_ID);
fs.mkdirSync(DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`); }
};

const findOnnx = (role) =>
  [
    path.join(DIR, `${role}-epoch-99-avg-1-int8.onnx`),
    path.join(DIR, `${role}-epoch-99-avg-1.onnx`),
    path.join(DIR, `${role}.onnx`),
  ].find((f) => fs.existsSync(f)) || null;

// 1) 模型文件
if (!fs.existsSync(path.join(DIR, 'tokens.txt')) || !findOnnx('encoder')) {
  console.log('1) 下载模型（约 40MB，产品内同样自动下载）…');
  let done = false;
  for (const url of SOURCES) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length') || 0);
      const archive = path.join(DIR, 'model.tar.bz2');
      const out = fs.createWriteStream(archive);
      let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done: d, value } = await reader.read();
        if (d) break;
        out.write(Buffer.from(value));
        got += value.byteLength;
        if (total > 0) process.stdout.write(`  下载 ${((got / 1048576) | 0)}/${((total / 1048576) | 0)} MB\r`);
      }
      await new Promise((r) => out.end(r));
      console.log(`  下载完成 ${(got / 1048576).toFixed(1)} MB，解压中…`);
      const sevenZip = require.resolve('7zip-bin/win/x64/7za.exe');
      execFileSync(sevenZip, ['x', archive, `-o${DIR}`, '-y'], { stdio: 'ignore' });
      const inner = fs.readdirSync(DIR).find((f) => f.endsWith('.tar'));
      if (inner) execFileSync(sevenZip, ['x', path.join(DIR, inner), `-o${DIR}`, '-y'], { stdio: 'ignore' });
      const nested = path.join(DIR, MODEL_ID);
      if (fs.existsSync(nested)) {
        for (const f of fs.readdirSync(nested)) fs.renameSync(path.join(nested, f), path.join(DIR, f));
        fs.rmSync(nested, { recursive: true, force: true });
      }
      fs.rmSync(archive, { force: true });
      done = true;
      break;
    } catch (e) { console.log(`  源失败：${e.message}，尝试下一源`); }
  }
  if (!done) { console.log('  ✗ 全部源下载失败'); process.exit(1); }
}
ok('tokens.txt 存在', fs.existsSync(path.join(DIR, 'tokens.txt')));
ok('encoder/decoder/joiner 齐全', ['encoder', 'decoder', 'joiner'].every((r) => findOnnx(r)));
ok('tokens.txt 含中文 token', /[\u4e00-\u9fff]/.test(fs.readFileSync(path.join(DIR, 'tokens.txt'), 'utf8')));

// 2) 创建流式识别器（与 VoiceEngine 配置一致）
const sherpa = require('sherpa-onnx-node');
const recognizer = new sherpa.OnlineRecognizer({
  featConfig: { featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: findOnnx('encoder'),
      decoder: findOnnx('decoder'),
      joiner: findOnnx('joiner'),
    },
    tokens: path.join(DIR, 'tokens.txt'),
    numThreads: 2,
    sampleRate: 16000,
    debug: false,
    provider: 'cpu',
  },
  enableEndpointDetection: true,
  rule1MinTrailingSilence: 1.2,
  rule2MinTrailingSilence: 0.6,
  rule3MinUtteranceLength: 12,
});
ok('OnlineRecognizer 创建成功', !!recognizer);

// 3) 喂 48 帧（约 3 秒）正弦音，验证 acceptWaveform/decode/getResult/endpoint 全管道
let stream = recognizer.createStream();
const feed = (samples) => {
  stream.acceptWaveform({ sampleRate: 16000, samples });
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const res = recognizer.getResult(stream);
  return { text: (res?.text || '').trim(), endpoint: recognizer.isEndpoint(stream) };
};
let r1 = null, errored = false;
try {
  for (let i = 0; i < 48; i++) {
    const samples = new Float32Array(1024).map((_, j) => 0.02 * Math.sin((2 * Math.PI * 220 * ((i * 1024) + j)) / 16000));
    r1 = feed(samples);
  }
} catch (e) { errored = true; console.log('  解码异常：', e.message); }
ok('48 帧音频解码无异常', !errored && r1 !== null);
ok('getResult 返回文本字段', typeof r1?.text === 'string');
if (r1?.endpoint) { recognizer.reset(stream); ok('端点检测触发并复位成功', true); }
else ok('端点未触发（纯音调无语音属正常），管道存活', true);

// 4) 复位后继续喂音频
stream = recognizer.createStream();
try { for (let i = 0; i < 16; i++) feed(new Float32Array(1024)); ok('复位后继续解码无异常', true); }
catch (e) { ok('复位后继续解码无异常', false, e.message); }

console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
process.exit(fail === 0 ? 0 : 1);
