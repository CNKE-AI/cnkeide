/**
 * VoiceEngine — 内置离线中文语音识别
 *
 * 技术选型：sherpa-onnx（k2-fsa，Apache-2.0，纯本地 CPU 推理）+ 流式双语 ZipFormer int8 模型。
 * - 完全离线：识别过程不经过任何网络；模型首次使用时从自托管源下载一次，之后永久离线。
 * - 完全免费：无 API Key、无账号、无调用计费。
 * - 调用方式：renderer 采集 16kHz PCM → IPC 喂入 → 主进程流式解码 → 增量文本回推。
 *
 * 模型：sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20（int8，约 40MB 压缩包），
 * 自托管于 ai.cnkes.cn，附 GitHub Release 与 hf-mirror 兜底源。
 */
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import { spawnSafe } from '../core-fork/util/SafeSpawn';

const MODEL_ID = 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23';
/** 自托管优先，后两个为兜底源（仅下载模型文件用，识别全程离线） */
const MODEL_SOURCES = [
  `https://ai.cnkes.cn/cnkeide/models/${MODEL_ID}.tar.bz2`,
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_ID}.tar.bz2`,
  `https://hf-mirror.com/csukuangfj/k2-fsa.github.io/resolve/main/sherpa-onnx/asr-models/${MODEL_ID}.tar.bz2`,
];

/** 模型目录：userData/models/voice/<MODEL_ID>/ */
function modelDir(): string {
  return path.join(app.getPath('userData'), 'models', 'voice', MODEL_ID);
}

export interface VoiceStatus {
  ready: boolean;
  /** 下载/初始化进度信息，ready=false 时给 UI 展示 */
  message: string;
  /** 0~100，下载进度；不需要下载时为 100 */
  progress: number;
}

let recognizer: any = null;
let stream: any = null;
let loading: Promise<boolean> | null = null;
/** 会话内已确认文本（final），partial 为当前口型未落定文本 */
let confirmedText = '';

/** 在模型目录中查找指定角色的 onnx（优先 int8，体积更小；兼容点分/横杠两种命名） */
function findOnnx(dir: string, role: 'encoder' | 'decoder' | 'joiner'): string | null {
  const candidates = [
    path.join(dir, `${role}-epoch-99-avg-1.int8.onnx`),
    path.join(dir, `${role}-epoch-99-avg-1-int8.onnx`),
    path.join(dir, `${role}-epoch-99-avg-1.onnx`),
    path.join(dir, `${role}.onnx`),
  ];
  return candidates.find((f) => fs.existsSync(f)) || null;
}

/** 是否已具备模型文件（tokens.txt + encoder/decoder/joiner） */
function hasModelFiles(): boolean {
  const dir = modelDir();
  if (!fs.existsSync(path.join(dir, 'tokens.txt'))) return false;
  return (['encoder', 'decoder', 'joiner'] as const).every((r) => findOnnx(dir, r) != null);
}

/** 解压后若模型文件嵌在 <MODEL_ID>/ 子目录里，上移一层归位 */
function normalizeModelDir(): void {
  const dir = modelDir();
  if (hasModelFiles()) return;
  const nested = path.join(dir, MODEL_ID);
  if (!fs.existsSync(nested)) return;
  for (const f of fs.readdirSync(nested)) {
    fs.renameSync(path.join(nested, f), path.join(dir, f));
  }
  fs.rmSync(nested, { recursive: true, force: true });
}

/** 借助项目自带 7za 解压（tar.gz / tar.bz2 两段式） */
function extract(archive: string, dest: string): Promise<void> {
  const sevenZip = require.resolve('7zip-bin/win/x64/7za.exe');
  return new Promise((resolve, reject) => {
    // 7za x 解包外层，再对内层 .tar 解包
    const p1 = spawnSafe(sevenZip, ['x', archive, `-o${dest}`, '-y'], { windowsHide: true });
    p1.on('exit', (code: number) => {
      if (code !== 0) return reject(new Error(`解压失败 7za exit=${code}`));
      const inner = fs.readdirSync(dest).find((f) => f.endsWith('.tar') || f.endsWith('.bz2'));
      if (!inner) return resolve();
      const innerPath = path.join(dest, inner);
      const p2 = spawnSafe(sevenZip, ['x', innerPath, `-o${dest}`, '-y'], { windowsHide: true });
      p2.on('exit', (c: number) => {
        if (c !== 0) return reject(new Error(`解压 tar 失败 exit=${c}`));
        // 内层 tar 已解包完成，删掉避免占用磁盘
        fs.rmSync(innerPath, { force: true });
        resolve();
      });
      p2.on('error', reject);
    });
    p1.on('error', reject);
  });
}

/** 下载模型（带进度回调），按顺序尝试多个源 */
async function downloadModel(onProgress: (p: number, msg: string) => void): Promise<void> {
  fs.mkdirSync(modelDir(), { recursive: true });
  let lastErr: Error | null = null;
  for (const url of MODEL_SOURCES) {
    try {
      onProgress(2, '开始下载语音模型（约 40MB，仅首次）…');
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length') || 0);
      // 固定标准扩展名：7za 依赖扩展名识别格式链（bz2 → tar）
      const archive = path.join(modelDir(), 'model.tar.bz2');
      const out = fs.createWriteStream(archive);
      let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.write(Buffer.from(value));
        got += value.byteLength;
        if (total > 0) onProgress(Math.min(98, Math.round((got / total) * 96)), '正在下载语音模型…');
      }
      await new Promise<void>((resolve, reject) => out.end((err: Error | null) => (err ? reject(err) : resolve())));
      onProgress(98, '正在解压模型…');
      await extract(archive, modelDir());
      fs.rmSync(archive, { force: true });
      normalizeModelDir();
      if (!hasModelFiles()) throw new Error('解压后缺少模型文件');
      onProgress(100, '模型就绪');
      return;
    } catch (e: any) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('模型下载失败');
}

/** 加载 sherpa-onnx 流式识别器 */
async function ensureRecognizer(onProgress: (s: VoiceStatus) => void): Promise<boolean> {
  if (recognizer) return true;
  if (loading) return loading;
  loading = (async () => {
    try {
      if (!hasModelFiles()) {
        await downloadModel((p, msg) => onProgress({ ready: false, message: msg, progress: p }));
      }
      onProgress({ ready: false, message: '正在初始化识别引擎…', progress: 100 });
      // 延迟加载：未配置模型时绝不拖累主进程启动
      const sherpa = require('sherpa-onnx-node');
      const dir = modelDir();
      recognizer = new sherpa.OnlineRecognizer({
        featConfig: { featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: findOnnx(dir, 'encoder')!,
            decoder: findOnnx(dir, 'decoder')!,
            joiner: findOnnx(dir, 'joiner')!,
          },
          tokens: path.join(dir, 'tokens.txt'),
          numThreads: 2,
          sampleRate: 16000,
          debug: false,
          provider: 'cpu',
        },
        // 端点检测：停顿即落定一句，保证"实时填入"体验
        enableEndpointDetection: true,
        rule1MinTrailingSilence: 1.2,
        rule2MinTrailingSilence: 0.6,
        rule3MinUtteranceLength: 12,
      });
      stream = recognizer.createStream();
      confirmedText = '';
      onProgress({ ready: true, message: '语音识别就绪', progress: 100 });
      return true;
    } catch (e: any) {
      onProgress({ ready: false, message: `初始化失败：${e?.message || e}`, progress: 0 });
      return false;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * 喂入一段 16kHz float32 PCM，返回增量识别文本。
 * 返回 { partial, final }：final 是本次停顿落定的句子（含此前累积）。
 */
export function feedAudio(samples: Float32Array): { partial: string; final: string } {
  if (!recognizer || !stream) return { partial: '', final: '' };
  stream.acceptWaveform({ sampleRate: 16000, samples });
  let partial = '';
  // 推进解码直到端点：sherpa 要求循环 decode 以消费全部波形
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const res = recognizer.getResult(stream);
  partial = (res?.text || '').replace(/\s+/g, ' ').trim();
  let final = '';
  if (recognizer.isEndpoint(stream)) {
    if (partial) {
      confirmedText = (confirmedText + ' ' + partial).trim();
      final = confirmedText;
    }
    recognizer.reset(stream);
    partial = '';
  }
  return { partial, final };
}

/** 结束本次听写：冲刷剩余波形，返回全部确认文本 */
export function finalizeAudio(): string {
  if (!recognizer || !stream) return confirmedText;
  stream.inputFinished();
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const res = recognizer.getResult(stream);
  const tail = (res?.text || '').trim();
  if (tail) confirmedText = (confirmedText + ' ' + tail).trim();
  const out = confirmedText;
  // 复位会话，下次听写从空开始
  stream = recognizer.createStream();
  confirmedText = '';
  return out;
}

/** 丢弃当前会话（用户取消） */
export function resetSession(): void {
  if (recognizer) stream = recognizer.createStream();
  confirmedText = '';
}

export async function getStatus(onProgress: (s: VoiceStatus) => void): Promise<VoiceStatus> {
  if (recognizer) return { ready: true, message: '语音识别就绪', progress: 100 };
  const ok = await ensureRecognizer(onProgress);
  return ok ? { ready: true, message: '语音识别就绪', progress: 100 } : { ready: false, message: '未就绪', progress: 0 };
}
