import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FolderOpen, Loader2, RefreshCw, Wrench } from 'lucide-react';

type Progress = {
  stage: string;
  message: string;
  current?: number;
  total?: number;
  percent?: number;
  log?: string;
};

type Project = { name: string; path: string; pageCount: number; pptxPath: string | null; mtime: number };

interface Props {
  initialTopic?: string;
  initialSlideCount?: number;
  onBack: () => void;
}

export const PptMasterWorkspace: React.FC<Props> = ({ initialTopic = '', initialSlideCount = 8, onBack }) => {
  const [topic, setTopic] = useState(initialTopic);
  const [slideCount, setSlideCount] = useState(initialSlideCount);
  const [env, setEnv] = useState<any>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [result, setResult] = useState<{ pptxPath?: string; projectPath?: string; error?: string } | null>(null);

  const blocked = useMemo(() => !env?.ok, [env]);

  const refresh = async () => {
    setChecking(true);
    try {
      const [envResult, projectResult] = await Promise.all([
        window.cnke.pptMaster.checkEnv(),
        window.cnke.pptMaster.listProjects(),
      ]);
      setEnv(envResult);
      setProjects(projectResult.projects || []);
    } catch (error: any) {
      setEnv({ ok: false, error: error?.message || String(error) });
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void refresh();
    const offProgress = window.cnke.pptMaster.onProgress((item) => setProgress(item));
    const offInstall = window.cnke.pptMaster.onInstallOutput((line) => setInstallLog((current) => [...current.slice(-99), line]));
    return () => {
      offProgress();
      offInstall();
    };
  }, []);

  const installDependencies = async () => {
    setInstalling(true);
    setInstallLog([]);
    try {
      const response = await window.cnke.pptMaster.installDeps();
      if (!response.success) setResult({ error: response.error || '依赖安装失败' });
      await refresh();
    } catch (error: any) {
      setResult({ error: error?.message || String(error) });
    } finally {
      setInstalling(false);
    }
  };

  const generate = async () => {
    if (!topic.trim() || generating || blocked) return;
    setGenerating(true);
    setResult(null);
    setProgress({ stage: 'checking', message: '正在准备原生 PPTX 流程…', percent: 0 });
    try {
      const save = await window.cnke.pptMaster.pickSavePath(`${topic.trim().slice(0, 40)}.pptx`);
      if (!save.success || !save.savePath) {
        setProgress(null);
        return;
      }
      const response = await window.cnke.pptMaster.generate({
        topic: topic.trim(),
        slideCount,
        canvasFormat: '16:9',
        savePath: save.savePath,
      });
      if (response.success) {
        setResult({ pptxPath: response.pptxPath, projectPath: response.projectPath });
        await refresh();
      } else {
        setResult({ error: response.error || 'PPT Master 生成失败' });
      }
    } catch (error: any) {
      setResult({ error: error?.message || String(error) });
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-[hsl(var(--background))]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">PPT Master 原生 PPTX</h2>
          <p className="mt-1 text-xs text-muted-foreground">使用母版和版式生成 PowerPoint 原生可编辑文件。</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void refresh()} disabled={checking} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-secondary disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} /> 检查环境
          </button>
          <button onClick={onBack} className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-secondary">返回标准生成</button>
        </div>
      </div>

      <section className={`rounded-lg border p-3 ${env?.ok ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5'}`}>
        <div className="flex items-center gap-2 text-sm font-medium">
          {env?.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <AlertTriangle className="h-4 w-4 text-amber-400" />}
          {checking ? '正在检查 Python 和技能依赖…' : env?.ok ? '运行环境已就绪' : '运行环境尚未就绪'}
        </div>
        {!checking && env?.python && <p className="mt-1 text-xs text-muted-foreground">Python：{env.python.path} {env.python.version || ''}</p>}
        {!checking && !env?.ok && <p className="mt-1 text-xs text-amber-200">{env?.blockers?.join('；') || env?.error || '请安装缺失依赖后重试。'}</p>}
        {Array.isArray(env?.dependencies) && env.dependencies.some((item: any) => !item.installed && item.required) && (
          <button onClick={() => void installDependencies()} disabled={installing} className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50">
            {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />} {installing ? '安装依赖中…' : '安装缺失依赖'}
          </button>
        )}
        {installLog.length > 0 && <pre className="mt-3 max-h-28 overflow-auto rounded bg-black/20 p-2 text-[10px] text-muted-foreground">{installLog.join('\n')}</pre>}
      </section>

      <section className="rounded-lg border border-border bg-secondary/15 p-4 space-y-3">
        <h3 className="text-sm font-medium">生成原生 PPTX</h3>
        <input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="输入演示主题" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary" />
        <div className="flex items-center gap-3">
          <label className="text-xs text-muted-foreground">页数</label>
          <input type="number" min="3" max="30" value={slideCount} onChange={(event) => setSlideCount(Math.min(30, Math.max(3, Number(event.target.value) || 8)))} className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary" />
          <button onClick={() => void generate()} disabled={blocked || generating || !topic.trim()} className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} {generating ? '生成中…' : '生成并保存'}
          </button>
        </div>
        {progress && <div className="rounded-md bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">{progress.message}{typeof progress.percent === 'number' ? `（${progress.percent}%）` : ''}</div>}
        {result?.error && <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{result.error}</div>}
        {result?.pptxPath && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">已生成：{result.pptxPath}</div>}
      </section>

      <section className="rounded-lg border border-border bg-secondary/15 p-4">
        <h3 className="mb-2 text-sm font-medium">最近项目</h3>
        {projects.length === 0 ? <p className="text-xs text-muted-foreground">暂无 PPT Master 项目。</p> : <div className="space-y-2">{projects.map((project) => (
          <div key={project.path} className="flex items-center gap-3 rounded-md bg-background/60 px-3 py-2 text-xs">
            <div className="min-w-0 flex-1"><p className="truncate font-medium">{project.name}</p><p className="truncate text-muted-foreground">{project.pageCount} 页 · {project.pptxPath || '尚未导出'}</p></div>
            <button onClick={() => void window.cnke.pptMaster.openProjectDir(project.path)} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 hover:bg-secondary"><FolderOpen className="h-3 w-3" /> 打开</button>
          </div>
        ))}</div>}
      </section>
    </div>
  );
};
