import React from 'react';
import { Mic, Loader2 } from 'lucide-react';
import { toast } from '../../utils/toast';

/**
 * VoiceInputButton — 内置离线语音听写按钮
 *
 * 用法：<VoiceInputButton onText={(text) => appendToInput(text)} />
 *
 * 工作流程：
 * 1. 点击开始：getUserMedia 采集麦克风 → AudioContext(16kHz) → 每 ~256ms 取一帧
 *    float32 PCM 经 preload.voice.feed 送主进程 sherpa-onnx 流式解码；
 * 2. 主进程实时回推 partial（口型未定）/ final（停顿落定）文本，final 增量填入输入框；
 * 3. 再次点击结束：voice.finalize 冲刷剩余音频，落定文本全部填入。
 *
 * 完全离线：识别在本地 CPU 推理，不经任何网络；模型首次使用自动下载一次（约 40MB），
 * 之后永久离线；无 API Key、无账号、无费用。
 */

interface Props {
  /** 每次落定一段文字时回调（增量追加到输入框） */
  onText: (text: string) => void;
  className?: string;
}

/** 采集帧长：4096 样本 @16kHz ≈ 256ms，兼顾延迟与 IPC 开销 */
const FRAME = 4096;

const VoiceInputButton: React.FC<Props> = ({ onText, className = '' }) => {
  const [listening, setListening] = React.useState(false);
  const [status, setStatus] = React.useState<{ ready: boolean; message: string; progress: number } | null>(null);
  /** 识别结果订阅的取消函数 */
  const offTextRef = React.useRef<(() => void) | null>(null);
  /** final 与 partial 的分界：partial 灰色显示在按钮 tooltip，不进输入框 */
  const partialRef = React.useRef('');
  const ctxRef = React.useRef<AudioContext | null>(null);
  const procRef = React.useRef<ScriptProcessorNode | null>(null);
  const srcRef = React.useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  /** 累积不足一帧的样本 */
  const bufRef = React.useRef<number[]>([]);

  const stop = React.useCallback(async () => {
    // finalize 拿到剩余落定文本后清理音频链路
    try {
      const text = await window.cnke.voice.finalize();
      if (text) onText(text);
    } catch { /* 引擎未就绪时静默 */ }
    procRef.current?.disconnect();
    srcRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close().catch(() => {});
    procRef.current = null;
    srcRef.current = null;
    streamRef.current = null;
    ctxRef.current = null;
    bufRef.current = [];
    partialRef.current = '';
    setListening(false);
  }, [onText]);

  const start = React.useCallback(async () => {
    try {
      // 先确保引擎/模型就绪（首次会下载，进度经 onStatus 展示）
      const st = await window.cnke.voice.status();
      if (!st?.ready) {
        setStatus(st || { ready: false, message: '引擎不可用', progress: 0 });
        toast.error(st?.message || '语音引擎不可用');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const ctx = new AudioContext({ sampleRate: 16000 });
      ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      srcRef.current = src;
      const proc = ctx.createScriptProcessor(FRAME, 1, 1);
      procRef.current = proc;
      proc.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        bufRef.current.push(...data);
        while (bufRef.current.length >= FRAME) {
          const frame = bufRef.current.splice(0, FRAME);
          window.cnke.voice.feed(frame);
        }
      };
      src.connect(proc);
      // ScriptProcessor 必须连到目的地才会被驱动；音量置零避免回声
      const mute = ctx.createGain();
      mute.gain.value = 0;
      proc.connect(mute);
      mute.connect(ctx.destination);
      // 订阅识别结果：final 增量填输入框
      offTextRef.current = window.cnke.voice.onText(({ text, final }) => {
        if (final) {
          partialRef.current = '';
          onText(text);
        } else {
          partialRef.current = text;
        }
      });
      setListening(true);
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (/NotAllowedError|Permission/i.test(msg)) toast.error('麦克风权限被拒绝：请在系统设置中允许本应用使用麦克风');
      else if (/NotFoundError/i.test(msg)) toast.error('未检测到麦克风设备');
      else toast.error(`语音启动失败：${msg}`);
      await stop();
    }
  }, [onText, stop]);

  // 组件卸载时清理音频与订阅
  React.useEffect(() => {
    const off = window.cnke.voice.onStatus((s) => setStatus(s));
    return () => {
      off();
      offTextRef.current?.();
      if (listening) void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const title = listening
    ? `停止听写（正在说：${partialRef.current || '…'}）`
    : '语音输入（离线中文识别，点击开始）';

  /** 下载/解压进行中才显示进度浮层；失败（progress=0）已有 toast 提示，不常驻 */
  const preparing = !!status && !status.ready && status.progress > 0;
  const pct = status?.progress ?? 0;
  const msg = status?.message || '';

  return (
    <>
      <button
        type="button"
        title={title}
        onClick={() => void (listening ? stop() : start())}
        className={`flex shrink-0 items-center justify-center rounded-md transition-colors ${
          listening
            ? 'bg-rose-500/15 text-rose-400 hover:bg-rose-500/25'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        } ${className}`}
      >
        {listening ? (
          <Mic className="w-4 h-4 animate-pulse" />
        ) : (
          <Mic className="w-4 h-4" />
        )}
      </button>
      {/* 首次下载模型 / 初始化引擎：在工具条内联展示进度，用户无需盲等 */}
      {preparing && (
        <div
          className="ml-auto mr-1 flex min-w-0 items-center gap-2"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-rose-400" />
          <span className="truncate text-[10px] text-muted-foreground">{msg}</span>
          <div className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-foreground/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-rose-400 to-pink-400 transition-[width] duration-300"
              style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
            />
          </div>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
        </div>
      )}
    </>
  );
};

export default VoiceInputButton;
