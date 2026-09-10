import React, { useEffect, useMemo, useState } from 'react';
import {
  Briefcase, GraduationCap, Mountain, Smile, Sparkles, RefreshCw, Eye, Save,
  Wand2, FolderOpen, Check, FileDown,
} from 'lucide-react';
import { useApp } from '../store/AppProvider';

interface SlideDraft {
  title: string;
  bullets: string[];
}

interface Outline {
  title: string;
  slides: SlideDraft[];
}

interface ThemeMeta {
  id: string;
  name: string;
  description: string;
  colors: { primary: string; secondary: string; accent: string; background: string };
  icon: string;
}

const ICONS: Record<string, React.ComponentType<any>> = {
  Briefcase, GraduationCap, Mountain, Smile,
};

/** 字节数 → 人类可读（下载进度显示用） */
const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

const cnke = window.cnke;

const PptPage: React.FC = () => {
  // 开发期兜底：F5 或 Ctrl+R 强制刷新本窗口（解决 vite-plugin-electron 对
  // 独立 entry ppt.html 热更新不及时导致窗口变黑的问题）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
        e.preventDefault();
        window.location.reload();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const { workspacePath } = useApp();
  const [topic, setTopic] = useState('');
  const [slideCount, setSlideCount] = useState(8);
  const [outline, setOutline] = useState<Outline | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 主题相关
  const [themes, setThemes] = useState<ThemeMeta[]>([]);
  const [selectedThemeId, setSelectedThemeId] = useState<string>('business');
  const [rendering, setRendering] = useState(false);
  const [renderedHtml, setRenderedHtml] = useState<string | null>(null);
  const [extraInstruction, setExtraInstruction] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  // 渲染进度（progress bar 用）
  const [progress, setProgress] = useState<{ stage: string; current: number; total: number; message: string } | null>(null);
  // 当前预览页索引（缩略图点击切换）
  const [previewIdx, setPreviewIdx] = useState(0);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);

  // 监听进度
  useEffect(() => {
    const off = cnke.ppt.onRenderProgress((payload) => setProgress(payload));
    return off;
  }, []);

  // 大纲变化 / 渲染完成 → 跳到第 1 页
  useEffect(() => {
    setPreviewIdx(0);
  }, [renderedHtml]);

  // 点击缩略图：通过 iframe contentWindow 调用 __pptGoto
  const gotoPage = (idx: number) => {
    setPreviewIdx(idx);
    const win = iframeRef.current?.contentWindow as any;
    if (win?.__pptGoto) win.__pptGoto(idx);
  };

  // 工作区生成
  const [wsLoading, setWsLoading] = useState(false);
  const [wsSummary, setWsSummary] = useState<any>(null);
  const [wsFocus, setWsFocus] = useState('');

  // Tab 切换：'generate' AI主题生成 / 'templates' 服务器模板库
  const [activeTab, setActiveTab] = useState<'generate' | 'templates'>('generate');

  // 模板库状态
  const [remoteIndex, setRemoteIndex] = useState<{ version: string; updatedAt: string; templates: any[] } | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [downloadedTemplateIds, setDownloadedTemplateIds] = useState<Set<string>>(new Set());
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  // 套用完成后的结果提示（成功态，非错误）
  const [applyNotice, setApplyNotice] = useState<string | null>(null);
  // 模板下载进度：id → { downloaded, total, ratio }
  const [templateProgress, setTemplateProgress] = useState<Record<string, { downloaded: number; total: number; ratio: number }>>({});

  // 扩写进度
  const [expandProgress, setExpandProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const [expandingSlideIdx, setExpandingSlideIdx] = useState<number | null>(null);

  // 监听模板下载 / 扩写进度
  useEffect(() => {
    const off1 = cnke.ppt.onTemplateProgress?.((p) => {
      // 实时进度写入 state，供卡片上的进度条渲染
      setTemplateProgress((prev) => ({
        ...prev,
        [p.id]: { downloaded: p.downloaded, total: p.total, ratio: p.ratio },
      }));
      if (p.ratio >= 1) {
        setDownloadedTemplateIds((s) => new Set([...s, p.id]));
        // 完成后延迟清掉进度条，避免闪烁
        setTimeout(() => {
          setTemplateProgress((prev) => {
            const next = { ...prev };
            delete next[p.id];
            return next;
          });
        }, 800);
      }
    });
    const off2 = cnke.ppt.onExpandProgress?.(setExpandProgress);
    return () => { off1?.(); off2?.(); };
  }, []);

  // 加载主题清单
  useEffect(() => {
    (async () => {
      const res = await cnke.ppt.listThemes();
      if (res.success && res.themes) setThemes(res.themes);
    })();
  }, []);

  const handleScanWorkspace = async () => {
    setWsLoading(true);
    setError(null);
    try {
      const res = await cnke.ppt.scanWorkspace();
      if (res.success) setWsSummary(res);
      else { setError(res.error || '扫描工作区失败'); setWsSummary(null); }
    } catch (e: any) { setError(e?.message || String(e)); setWsSummary(null); }
    finally { setWsLoading(false); }
  };

  const handleGenerateFromWorkspace = async () => {
    setLoading(true);
    setError(null);
    setSavedPath(null);
    setRenderedHtml(null);
    try {
      const res = await cnke.ppt.generateFromWorkspace({
        slideCount,
        focus: wsFocus.trim() || undefined,
      });
      if (res.success && res.outline) {
        setOutline({
          title: res.outline.title || (res.workspace?.projectName || '工作区演示文稿'),
          slides: (res.outline.slides || []).map((s: any) => ({
            title: s.title || '',
            bullets: Array.isArray(s.bullets) ? s.bullets : [],
          })),
        });
        if (res.workspace) setWsSummary(res.workspace);
      } else setError(res.error || '从工作区生成大纲失败');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  };

  const handleGenerateOutline = async () => {
    if (!topic.trim()) { setError('请输入 PPT 主题'); return; }
    setLoading(true);
    setError(null);
    setSavedPath(null);
    setRenderedHtml(null);
    try {
      const res = await cnke.ppt.generateOutline(topic.trim(), slideCount);
      if (res.success && res.outline) {
        setOutline({
          title: res.outline.title || topic.trim(),
          slides: (res.outline.slides || []).map((s: any) => ({
            title: s.title || '',
            bullets: Array.isArray(s.bullets) ? s.bullets : [],
          })),
        });
      } else setError(res.error || '生成大纲失败');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  };

  const updateSlideTitle = (idx: number, val: string) => {
    if (!outline) return;
    setOutline({
      ...outline,
      slides: outline.slides.map((s, i) => (i === idx ? { ...s, title: val } : s)),
    });
  };

  const updateBullet = (idx: number, bidx: number, val: string) => {
    if (!outline) return;
    setOutline({
      ...outline,
      slides: outline.slides.map((s, i) => {
        if (i !== idx) return s;
        return { ...s, bullets: s.bullets.map((b, j) => (j === bidx ? val : b)) };
      }),
    });
  };

  const addBullet = (idx: number) => {
    if (!outline) return;
    setOutline({
      ...outline,
      slides: outline.slides.map((s, i) => (i === idx ? { ...s, bullets: [...s.bullets, ''] } : s)),
    });
  };

  const removeBullet = (idx: number, bidx: number) => {
    if (!outline) return;
    setOutline({
      ...outline,
      slides: outline.slides.map((s, i) =>
        i === idx ? { ...s, bullets: s.bullets.filter((_, j) => j !== bidx) } : s
      ),
    });
  };

  const addSlide = () => {
    if (!outline) return;
    setOutline({ ...outline, slides: [...outline.slides, { title: '', bullets: [''] }] });
  };

  const removeSlide = (idx: number) => {
    if (!outline) return;
    setOutline({ ...outline, slides: outline.slides.filter((_, i) => i !== idx) });
  };

  /** 第 2 轮：把大纲 + 主题 → HTML 预览 */
  const handleRenderTheme = async () => {
    if (!outline) { setError('请先生成大纲'); return; }
    setRendering(true);
    setError(null);
    setSavedPath(null);
    try {
      const res = await cnke.ppt.renderTheme({
        themeId: selectedThemeId,
        outline: {
          title: outline.title,
          slides: outline.slides.map((s) => ({
            title: s.title,
            bullets: s.bullets.filter((b) => b.trim()),
          })),
        },
        extraInstruction: extraInstruction.trim() || undefined,
      });
      if (res.success && res.html) setRenderedHtml(res.html);
      else setError(res.error || '渲染失败');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setRendering(false); }
  };

  /** 保存 HTML 到工作区 */
  const handleSaveToWorkspace = async () => {
    if (!renderedHtml) return;
    if (!workspacePath) {
      setError('未打开工作区，无法保存。请先在主界面打开文件夹。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeTitle = (outline?.title || '演示文稿').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      const filename = `${selectedThemeId}-${safeTitle}-${ts}.html`;
      const savePath = `${workspacePath.replace(/[\\/]+$/, '')}\\${filename}`;
      const res = await cnke.ppt.saveHtml({ html: renderedHtml, savePath });
      if (res.success && res.path) setSavedPath(res.path);
      else setError(res.error || '保存失败');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setSaving(false); }
  };

  /** 导出 PDF：渲染好的 HTML → 16:9 PDF */
  const handleExportPdf = async () => {
    if (!renderedHtml) { setError('请先完成 AI 渲染美化'); return; }
    setSaving(true);
    setError(null);
    setSavedPath(null);
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeTitle = (outline?.title || '演示文稿').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      const filename = `${safeTitle}-${ts}.pdf`;
      const savePath = workspacePath
        ? `${workspacePath.replace(/[\\/]+$/, '')}\\${filename}`
        : undefined;
      const res = await cnke.ppt.exportPdf({ html: renderedHtml, savePath, title: outline?.title || '演示文稿' });
      if (res.success && res.path) setSavedPath(res.path);
      else setError(res.error || 'PDF 导出失败');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setSaving(false); }
  };

  /** 导出 PPTX：大纲 + 主题配色 → pptxgenjs 原生文件 */
  const handleExportPptx = async () => {
    if (!outline) { setError('请先生成大纲'); return; }
    setSaving(true);
    setError(null);
    setSavedPath(null);
    try {
      const theme = themes.find((t) => t.id === selectedThemeId);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeTitle = (outline.title || '演示文稿').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      const filename = `${safeTitle}-${ts}.pptx`;
      const savePath = workspacePath
        ? `${workspacePath.replace(/[\\/]+$/, '')}\\${filename}`
        : undefined;
      const res = await cnke.ppt.generate(
        {
          title: outline.title,
          author: 'CnkeIDE',
          subject: topic.trim() || outline.title,
          size: '16x9' as const,
          theme: theme ? {
            primary: theme.colors.primary,
            secondary: theme.colors.secondary,
            accent: theme.colors.accent,
            background: theme.colors.background,
          } : undefined,
          slides: outline.slides.map((s) => ({
            title: s.title,
            bullets: s.bullets.filter((b) => b.trim()).map((text) => ({ text })),
          })),
        },
        savePath,
      );
      if (res.success && res.path) setSavedPath(res.path);
      else setError(res.error || 'PPTX 导出失败');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setSaving(false); }
  };

  const slideCountPreview = useMemo(() => outline?.slides.length ?? 0, [outline]);

  // ===== 模板库相关 =====
  const PAGE_SIZE = 12;
  const [tplPage, setTplPage] = useState(1);
  const [tplTotal, setTplTotal] = useState(0);
  const [tplCategory, setTplCategory] = useState<string>('');
  const [tplKeyword, setTplKeyword] = useState<string>('');
  const [tplCategories, setTplCategories] = useState<string[]>([]);
  const [tplVisibleIds, setTplVisibleIds] = useState<Set<string>>(new Set()); // 懒加载：当前已渲染缩略图的 id

  const loadRemoteIndex = async (page = 1, category = '', keyword = '') => {
    setTemplateLoading(true);
    setTemplateError(null);
    try {
      const res = await cnke.ppt.listRemoteTemplates({ page, pageSize: PAGE_SIZE, category, keyword });
      if (res.success && res.index) {
        setRemoteIndex(res.index);
        setTplPage(res.index.page || page);
        setTplTotal(res.index.total || res.index.templates.length);
        if (res.index.categories) setTplCategories(res.index.categories);
      } else setTemplateError(res.error || '拉取模板索引失败');
    } catch (e: any) { setTemplateError(e?.message || String(e)); }
    finally { setTemplateLoading(false); }
  };

  // 首次切到模板库：拉分类 + 第 1 页
  useEffect(() => {
    if (activeTab === 'templates' && !remoteIndex && !templateLoading) {
      cnke.ppt.listRemoteCategories().then((r) => {
        if (r.success && r.categories) setTplCategories(r.categories);
      });
      loadRemoteIndex(1, tplCategory, tplKeyword);
    }
  }, [activeTab]);

  // IntersectionObserver 懒加载缩略图
  const tplGridRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeTab !== 'templates') return;
    const root = tplGridRef.current;
    if (!root) return;
    const io = new IntersectionObserver((entries) => {
      const next = new Set(tplVisibleIds);
      let changed = false;
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = (entry.target as HTMLElement).dataset.tplId;
          if (id && !next.has(id)) { next.add(id); changed = true; }
        }
      }
      if (changed) setTplVisibleIds(next);
    }, { rootMargin: '200px' });
    root.querySelectorAll('[data-tpl-id]').forEach((el) => io.observe(el));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteIndex, activeTab]);

  // 切分类 / 搜索时回到第 1 页
  const handleCategoryChange = (c: string) => {
    setTplCategory(c);
    setTplVisibleIds(new Set());
    loadRemoteIndex(1, c, tplKeyword);
  };
  const handleSearch = (k: string) => {
    setTplKeyword(k);
    setTplVisibleIds(new Set());
    // 防抖
    const t = setTimeout(() => loadRemoteIndex(1, tplCategory, k), 350);
    return () => clearTimeout(t);
  };
  const handlePageChange = (p: number) => {
    setTplVisibleIds(new Set());
    loadRemoteIndex(p, tplCategory, tplKeyword);
    // 滚到顶部
    requestAnimationFrame(() => {
      const grid = tplGridRef.current;
      if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const handleDownloadTemplate = async (id: string) => {
    setError(null);
    // 预置一个 0 进度，按钮立刻切到进度态（IPC 首包回来前也有反馈）
    setTemplateProgress((prev) => ({ ...prev, [id]: { downloaded: 0, total: 0, ratio: 0 } }));
    try {
      const res = await cnke.ppt.downloadTemplate({ id });
      if (res.success) {
        setDownloadedTemplateIds((s) => new Set([...s, id]));
      } else {
        setError(res.error || '下载失败');
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      // 无论成功失败都清掉进度条，避免卡死
      setTemplateProgress((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  /** 单页细化扩写 */
  const handleExpandSlide = async (idx: number, intensity: 'light' | 'standard' | 'deep' = 'standard') => {
    if (!outline) return;
    setExpandingSlideIdx(idx);
    setError(null);
    try {
      const res = await cnke.ppt.expandSlide({
        slide: outline.slides[idx],
        presentationTopic: outline.title,
        intensity,
      });
      if (res.success && res.slide) {
        const newSlides = outline.slides.map((s, i) => (i === idx ? res.slide! : s));
        setOutline({ ...outline, slides: newSlides });
      } else setError(res.error || '扩写失败');
    } finally { setExpandingSlideIdx(null); }
  };

  /** 全文细化扩写 */
  const handleExpandAll = async (intensity: 'light' | 'standard' | 'deep' = 'standard') => {
    if (!outline) return;
    setError(null);
    try {
      const res = await cnke.ppt.expandAll({ outline, intensity });
      if (res.success && res.outline) setOutline(res.outline);
      else setError(res.error || '全文扩写失败');
    } finally { setExpandProgress(null); }
  };

  /** 套用服务器模板 + 大纲 → 保存到工作区 */
  const handleApplyTemplate = async () => {
    if (!outline || !selectedTemplateId) { setError('请先选择模板并生成大纲'); return; }
    setApplyingTemplate(true);
    setError(null);
    setApplyNotice(null);
    setSavedPath(null);
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeTitle = outline.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      const filename = `${safeTitle}-模板${selectedTemplateId}-${ts}.pptx`;
      const savePath = workspacePath ? `${workspacePath.replace(/[\\/]+$/, '')}\\${filename}` : undefined;
      const res = await cnke.ppt.applyTemplate({ templateId: selectedTemplateId, outline, savePath });
      if (res.success && res.path) {
        setSavedPath(res.path);
        // 明确告知改写结果，避免用户「看不出变化」而误以为没生效
        const n = res.filledCount ?? 0;
        const total = outline.slides.length;
        const via = res.strategy === 'placeholder' ? '占位符' : '文字注入';
        const cap = typeof res.capacity === 'number' ? res.capacity : null;
        setApplyNotice(
          cap !== null && total > cap
            ? `已套用（${via}）：模板为 ${res.pageCount ?? '?'} 页，可容纳 ${cap} 页正文，改写了 ${n} 页。大纲有 ${total} 页，超出 ${total - cap} 页未写入，请换页数更多的模板。`
            : `已套用（${via}）：改写了 ${n} 页，共 ${res.pageCount ?? '?'} 页。`,
        );
      } else setError(res.error || '套用失败');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setApplyingTemplate(false); }
  };

  return (
    <div className="flex flex-col h-full bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      {/* 标题栏 */}
      <div className="flex items-center justify-between h-11 px-4 border-b border-border bg-secondary/20" style={{ WebkitAppRegion: 'drag' } as any}>
        <div className="flex items-center gap-2.5" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <div className="w-2.5 h-2.5 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500" />
          <span className="text-sm font-semibold tracking-wide">生成 PPT</span>
          <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-secondary/60">
            AI 主题渲染
          </span>
        </div>
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button onClick={() => cnke.ppt.minimize()} className="w-9 h-8 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors" title="最小化">
            <svg className="w-4 h-4 mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
          <button onClick={() => cnke.ppt.close()} className="w-9 h-8 rounded-md hover:bg-red-500/80 text-muted-foreground hover:text-white transition-colors" title="关闭">
            <svg className="w-4 h-4 mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* 顶部 Tab 切换 */}
        <div className="absolute top-11 left-0 right-0 z-10 flex border-b border-border bg-background/95 backdrop-blur" style={{ pointerEvents: 'auto' }}>
          <button
            onClick={() => setActiveTab('generate')}
            className={`px-4 py-2 text-xs font-medium transition-colors ${activeTab === 'generate' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            AI 主题生成
          </button>
          <button
            onClick={() => { setActiveTab('templates'); if (!remoteIndex && !templateLoading) loadRemoteIndex(); }}
            className={`px-4 py-2 text-xs font-medium transition-colors ${activeTab === 'templates' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            服务器模板库
          </button>
        </div>
        <div className="flex-1 pt-9 overflow-hidden flex">
        {/* 左侧：输入 + 主题选择 */}
        <div className="w-[340px] shrink-0 border-r border-border flex flex-col">
          <div className="p-4 space-y-4 overflow-y-auto flex-1">
            <div>
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">PPT 主题</label>
              <textarea
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="例如：2026 年 AI 编程助手行业趋势分析"
                rows={3}
                className="mt-1.5 w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm resize-none outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
              />
            </div>

            <div>
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">页数</label>
              <input
                type="range" min={3} max={20} value={slideCount}
                onChange={(e) => setSlideCount(Number(e.target.value))}
                className="w-full mt-2 accent-[hsl(var(--primary))]"
              />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>3</span>
                <span className="text-foreground font-semibold">{slideCount} 页</span>
                <span>20</span>
              </div>
            </div>

            <button
              onClick={handleGenerateOutline}
              disabled={loading}
              className="w-full btn-gradient rounded-lg py-2.5 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>
                  AI 生成大纲中…
                </span>
              ) : 'AI 生成大纲'}
            </button>

            {/* 从工作区生成 */}
            <div className="pt-3 border-t border-border">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">从当前工作区生成</span>
              <button
                onClick={handleScanWorkspace}
                disabled={wsLoading}
                className="w-full mt-2 mb-2 rounded-lg border border-border bg-secondary/40 py-2 text-xs font-medium hover:bg-secondary transition-colors disabled:opacity-50"
              >
                {wsLoading ? '扫描中…' : '扫描工作区结构'}
              </button>
              {wsSummary && (
                <div className="mb-2 rounded-lg border border-border bg-secondary/30 p-2.5 space-y-1.5 text-[11px] max-h-40 overflow-y-auto">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-foreground">{wsSummary.projectName}</span>
                    {wsSummary.readmePath && <span className="text-emerald-400">README ✓</span>}
                  </div>
                  {wsSummary.fileStats && (
                    <div className="text-muted-foreground">
                      根目录 {wsSummary.fileStats.totalFiles} 项 · 文档 {wsSummary.docFiles?.length ?? 0} 个
                    </div>
                  )}
                  {wsSummary.structure && (
                    <pre className="text-muted-foreground/80 whitespace-pre text-[10px] leading-tight overflow-x-auto">{wsSummary.structure}</pre>
                  )}
                </div>
              )}
              <input
                value={wsFocus} onChange={(e) => setWsFocus(e.target.value)}
                placeholder="关注方向（可选），如：核心功能、架构设计"
                className="w-full mb-2 rounded-lg border border-border bg-secondary/40 px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary/50 placeholder:text-muted-foreground/60"
              />
              <button
                onClick={handleGenerateFromWorkspace}
                disabled={loading}
                className="w-full rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 py-2.5 text-sm font-semibold text-fuchsia-300 hover:bg-fuchsia-500/20 transition-all disabled:opacity-50"
              >
                {loading ? 'AI 分析项目中…' : '从工作区自动生成大纲'}
              </button>
            </div>

            {/* 主题选择器（大纲生成后才可见） */}
            {outline && (
              <div className="pt-3 border-t border-border">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">选择主题</span>
                  {renderedHtml && (
                    <span className="text-[10px] text-emerald-400 inline-flex items-center gap-1">
                      <Check className="w-3 h-3" /> 已渲染
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {themes.map((t) => {
                    const Icon = ICONS[t.icon] || Sparkles;
                    const selected = selectedThemeId === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() => setSelectedThemeId(t.id)}
                        className={`relative rounded-lg border p-2 text-left transition-all ${
                          selected
                            ? 'border-primary bg-primary/10 ring-1 ring-primary/40'
                            : 'border-border bg-secondary/30 hover:bg-secondary/60'
                        }`}
                        title={t.description}
                      >
                        <div className="flex items-center gap-1.5 mb-1">
                          <Icon className="w-3.5 h-3.5 text-foreground/80" />
                          <span className="text-xs font-semibold">{t.name}</span>
                            {selected && (
                              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-primary" />
                            )}
                          </div>
                          {/* 配色小预览条 */}
                          <div className="flex h-1.5 rounded-full overflow-hidden">
                            <div className="flex-1" style={{ background: t.colors.primary }} />
                            <div className="flex-1" style={{ background: t.colors.secondary }} />
                            <div className="flex-1" style={{ background: t.colors.accent }} />
                          </div>
                        </button>
                    );
                  })}
                </div>

                <textarea
                  value={extraInstruction}
                  onChange={(e) => setExtraInstruction(e.target.value)}
                  placeholder="附加要求（可选），如：用更口语化的表达、强调数据、加入图表"
                  rows={2}
                  className="mt-3 w-full rounded-lg border border-border bg-secondary/40 px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary/50 placeholder:text-muted-foreground/60 resize-none"
                />

                <button
                  onClick={handleRenderTheme}
                  disabled={rendering}
                  className="w-full mt-2 inline-flex items-center justify-center gap-1.5 rounded-lg btn-gradient py-2.5 text-sm font-semibold disabled:opacity-50 transition-all"
                >
                  <Wand2 className="w-4 h-4" />
                  {rendering ? 'AI 渲染美化中…' : renderedHtml ? '重新渲染' : 'AI 渲染美化'}
                </button>
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
            )}
            {applyNotice && !error && (
              <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs text-sky-300">
                {applyNotice}
              </div>
            )}
            {savedPath && (
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
                已保存到工作区：<span className="break-all font-mono">{savedPath}</span>
              </div>
            )}

            <div className="text-xs text-muted-foreground leading-relaxed pt-2 border-t border-border">
              流程：AI 生成大纲 → 选主题 → AI 渲染美化 → 导出文件。「导出 PDF」保存 AI 渲染的高保真版式；「导出 PPTX」生成可在 PowerPoint/WPS 编辑的原生文件（按所选主题配色）。
            </div>
          </div>
        </div>

        {/* 右侧：编辑 / 预览 */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-secondary/10">
            <div className="flex items-center gap-3 text-muted-foreground text-xs">
              <span>共 <span className="text-foreground font-semibold">{slideCountPreview}</span> 页</span>
              {renderedHtml && (
                <span className="inline-flex items-center gap-1 text-violet-400">
                  <Eye className="w-3.5 h-3.5" /> HTML 预览
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {outline && !renderedHtml && (
                <button onClick={addSlide} className="px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-secondary transition-colors">
                  + 添加页
                </button>
              )}
              {renderedHtml && (
                <button
                  onClick={() => setRenderedHtml(null)}
                  className="px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-secondary transition-colors inline-flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" /> 返回大纲
                </button>
              )}
              {/* 全文 AI 扩写 */}
              {outline && (
                <button
                  onClick={() => handleExpandAll('standard')}
                  disabled={expandProgress !== null}
                  className="px-3 py-1.5 rounded-lg border border-violet-500/40 bg-violet-500/10 text-violet-300 text-xs font-semibold hover:bg-violet-500/20 transition-all disabled:opacity-50 inline-flex items-center gap-1.5"
                  title="AI 全文细化扩写（每页 bullet 加上数据/案例/细节）"
                >
                  <Wand2 className="w-3.5 h-3.5" />
                  {expandProgress ? `${expandProgress.current}/${expandProgress.total}` : 'AI 全文扩写'}
                </button>
              )}
              {/* 导出 PPTX：大纲 + 主题配色（可编辑原生文件） */}
              {outline && (
                <button
                  onClick={handleExportPptx}
                  disabled={saving}
                  className="px-3 py-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 text-orange-300 text-xs font-semibold hover:bg-orange-500/20 transition-all disabled:opacity-50 inline-flex items-center gap-1.5"
                  title="导出原生 PPTX（可在 PowerPoint / WPS 中编辑，按所选主题配色）"
                >
                  <Save className="w-3.5 h-3.5" />
                  {saving ? '导出中…' : '导出 PPTX'}
                </button>
              )}
              {/* 导出 PDF：AI 渲染的 HTML → 16:9 PDF（视觉最佳） */}
              {renderedHtml && (
                <button
                  onClick={handleExportPdf}
                  disabled={saving}
                  className="px-4 py-1.5 rounded-lg btn-gradient text-xs font-semibold disabled:opacity-50 inline-flex items-center gap-1.5"
                  title="导出 PDF（AI 渲染美化效果，16:9 每页一屏）"
                >
                  <FileDown className="w-3.5 h-3.5" />
                  {saving ? '导出中…' : '导出 PDF'}
                </button>
              )}
            </div>
          </div>

          {activeTab === 'templates' ? (
            /* 模板库视图 */
            <div className="flex-1 overflow-y-auto p-6">
              {/* 工具栏：搜索 + 分类筛选 */}
              <div className="flex items-center gap-2 mb-4 sticky top-0 bg-background/95 backdrop-blur py-2 z-10">
                <input
                  value={tplKeyword}
                  onChange={(e) => handleSearch(e.target.value)}
                  placeholder="搜索名称 / 描述 / 编号…"
                  className="flex-1 px-3 py-1.5 rounded-lg border border-border bg-secondary/40 text-sm outline-none focus:ring-1 focus:ring-primary/50 placeholder:text-muted-foreground/60"
                />
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {tplTotal > 0 ? `共 ${tplTotal} 套` : ''}
                </span>
              </div>
              {tplCategories.length > 0 && (
                <div className="flex items-center gap-1.5 mb-4 flex-wrap">
                  <button
                    onClick={() => handleCategoryChange('')}
                    className={`px-2.5 py-1 rounded-full text-[11px] transition-colors ${!tplCategory ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 text-muted-foreground hover:bg-secondary'}`}
                  >全部</button>
                  {tplCategories.map((c) => (
                    <button
                      key={c}
                      onClick={() => handleCategoryChange(c)}
                      className={`px-2.5 py-1 rounded-full text-[11px] transition-colors ${tplCategory === c ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 text-muted-foreground hover:bg-secondary'}`}
                    >{c}</button>
                  ))}
                </div>
              )}
              {templateLoading && (
                <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                  <svg className="animate-spin w-4 h-4 mr-2" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>
                  正在加载模板…
                </div>
              )}
              {templateError && (
                <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400 mb-4">
                  模板服务器不可达：{templateError}
                  <button onClick={() => loadRemoteIndex(1, tplCategory, tplKeyword)} className="ml-2 underline">重试</button>
                </div>
              )}
              {remoteIndex && (
                <>
                  <div ref={tplGridRef} className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {remoteIndex.templates.map((t: any) => {
                      const downloaded = downloadedTemplateIds.has(t.id);
                      const selected = selectedTemplateId === t.id;
                      const missing = !t.downloadUrl;
                      const visible = tplVisibleIds.has(t.id);
                      const dlState = templateProgress[t.id];
                      const dlPct = dlState && dlState.total > 0
                        ? Math.min(100, Math.round(dlState.ratio * 100))
                        : null;
                      return (
                        <div
                          key={t.id}
                          data-tpl-id={t.id}
                          className={`relative rounded-xl border p-3 transition-all ${
                            selected ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-primary/40'
                          } ${missing ? 'opacity-50' : ''}`}
                        >
                          <div className="aspect-[16/10] rounded-lg mb-2 overflow-hidden bg-secondary/50 flex items-center justify-center relative">
                            {missing ? (
                              <span className="text-xs text-muted-foreground">未上传</span>
                            ) : visible ? (
                              <img
                                src={t.thumbnailUrl}
                                alt={t.name}
                                loading="lazy"
                                className="w-full h-full object-cover"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                              />
                            ) : (
                              <div className="w-full h-full bg-secondary/30 animate-pulse flex items-center justify-center">
                                <span className="text-[10px] text-muted-foreground/50">加载中…</span>
                              </div>
                            )}
                            {/* 下载中：缩略图上覆盖一层进度遮罩 */}
                            {dlState && !downloaded && (
                              <div className="absolute inset-0 bg-black/60 backdrop-blur-[1px] flex flex-col items-center justify-center gap-2 px-4">
                                <span className="text-[10px] text-white/90">
                                  {dlPct !== null ? `下载中 ${dlPct}%` : '下载中…'}
                                </span>
                                <div className="w-full h-1 rounded-full bg-white/25 overflow-hidden">
                                  <div
                                    className="h-full bg-sky-400 transition-all duration-150"
                                    style={{ width: dlPct !== null ? `${dlPct}%` : '15%' }}
                                  />
                                </div>
                                {dlState.total > 0 && (
                                  <span className="text-[9px] text-white/60">
                                    {formatBytes(dlState.downloaded)} / {formatBytes(dlState.total)}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <div className="font-semibold text-sm truncate" title={t.name}>{t.name}</div>
                            <div className="text-[10px] text-muted-foreground shrink-0 font-mono">#{t.id}</div>
                          </div>
                          <div className="text-[10px] text-muted-foreground mb-2 line-clamp-2 min-h-[28px]">{t.description}</div>
                          <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-2">
                            <span className="px-1.5 py-0.5 rounded bg-secondary/80">{t.category}</span>
                            <span>·</span>
                            <span>{t.pageCount} 页</span>
                            <span>·</span>
                            <span>{(t.size / 1024).toFixed(1)} KB</span>
                          </div>
                          <div className="flex items-center gap-1">
                            {downloaded ? (
                              <span className="text-[10px] text-emerald-400 inline-flex items-center gap-1">
                                <Check className="w-3 h-3" /> 已缓存
                              </span>
                            ) : dlState ? (
                              <span className="text-[10px] text-sky-400 inline-flex items-center gap-1">
                                <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>
                                {dlState.total > 0
                                  ? `${Math.min(100, Math.round(dlState.ratio * 100))}%`
                                  : dlState.downloaded > 0
                                    ? formatBytes(dlState.downloaded)
                                    : '开始…'}
                              </span>
                            ) : (
                              <button
                                onClick={() => handleDownloadTemplate(t.id)}
                                disabled={missing}
                                className="text-[10px] px-2 py-1 rounded bg-secondary hover:bg-accent transition-colors disabled:opacity-50"
                              >下载模板</button>
                            )}
                            <button
                              onClick={() => { setSelectedTemplateId(t.id); setActiveTab('generate'); }}
                              disabled={!downloaded || !outline}
                              className="text-[10px] px-2 py-1 ml-auto rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                              title={!outline ? '请先生成大纲' : !downloaded ? '请先下载模板' : '套用此模板'}
                            >
                              {selected ? '✓ 已选' : '套用'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* 分页 */}
                  {tplTotal > PAGE_SIZE && (
                    <div className="flex items-center justify-center gap-2 mt-6 pb-2">
                      <button
                        onClick={() => handlePageChange(Math.max(1, tplPage - 1))}
                        disabled={tplPage <= 1}
                        className="px-3 py-1 rounded border border-border text-xs hover:bg-secondary disabled:opacity-50"
                      >上一页</button>
                      <span className="text-xs text-muted-foreground">
                        第 <span className="text-foreground font-semibold">{tplPage}</span> / {Math.ceil(tplTotal / PAGE_SIZE)} 页
                      </span>
                      <button
                        onClick={() => handlePageChange(tplPage + 1)}
                        disabled={tplPage >= Math.ceil(tplTotal / PAGE_SIZE)}
                        className="px-3 py-1 rounded border border-border text-xs hover:bg-secondary disabled:opacity-50"
                      >下一页</button>
                    </div>
                  )}
                </>
              )}
              {/* 套用按钮：仅当已选模板且已下载时显示 */}
              {selectedTemplateId && downloadedTemplateIds.has(selectedTemplateId) && outline && (
                <div className="sticky bottom-0 mt-4 -mx-6 -mb-6 px-6 py-3 bg-background/95 backdrop-blur border-t border-border flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    已选模板 <span className="text-primary font-semibold">#{selectedTemplateId}</span>，套用后会用大纲内容填充模板并保存到工作区。
                  </span>
                  <button
                    onClick={handleApplyTemplate}
                    disabled={applyingTemplate}
                    className="px-4 py-2 rounded-lg btn-gradient text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <Save className="w-4 h-4" />
                    {applyingTemplate ? '套用中…' : '套用模板并保存到工作区'}
                  </button>
                </div>
              )}
            </div>
          ) : !outline ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 flex items-center justify-center mb-4">
                <Sparkles className="w-8 h-8 text-violet-400" />
              </div>
              <p className="text-sm font-medium text-foreground">尚未生成大纲</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-xs leading-relaxed">
                在左侧输入主题并点击「AI 生成大纲」，即可选择主题并由 AI 渲染美化。
              </p>
            </div>
          ) : renderedHtml ? (
            <div className="flex-1 flex bg-secondary/30 overflow-hidden">
              {/* 左侧：缩略图网格 */}
              <div className="w-[200px] shrink-0 border-r border-border bg-background/40 overflow-y-auto p-2 space-y-2">
                {outline!.slides.map((s, i) => {
                  const active = i === previewIdx;
                  return (
                    <button
                      key={i}
                      onClick={() => gotoPage(i)}
                      className={`group block w-full rounded-md overflow-hidden border transition-all text-left ${
                        active ? 'border-primary ring-2 ring-primary/40 shadow-md' : 'border-border hover:border-primary/40'
                      }`}
                      title={`跳转到第 ${i + 1} 页`}
                    >
                      <div
                        className="h-[80px] relative"
                        style={{
                          background: i === 0 || i === outline!.slides.length - 1
                            ? `linear-gradient(135deg, ${themes.find((t) => t.id === selectedThemeId)?.colors.primary || '#1e3a8a'} 0%, ${themes.find((t) => t.id === selectedThemeId)?.colors.secondary || '#7c3aed'} 100%)`
                            : themes.find((t) => t.id === selectedThemeId)?.colors.background || '#f8fafc',
                        }}
                      >
                        <div
                          className="absolute top-1 left-1 text-[9px] font-semibold px-1.5 py-0.5 rounded"
                          style={{
                            color: i === 0 || i === outline!.slides.length - 1 ? 'rgba(255,255,255,0.95)' : themes.find((t) => t.id === selectedThemeId)?.colors.primary || '#1e3a8a',
                            background: i === 0 || i === outline!.slides.length - 1 ? 'rgba(255,255,255,0.18)' : `${themes.find((t) => t.id === selectedThemeId)?.colors.accent || '#06b6d4'}22`,
                          }}
                        >
                          {i + 1}
                        </div>
                        <div
                          className="absolute left-1.5 right-1.5 bottom-1.5 text-[10px] font-semibold truncate"
                          style={{
                            color: i === 0 || i === outline!.slides.length - 1 ? '#fff' : themes.find((t) => t.id === selectedThemeId)?.colors.primary || '#1e3a8a',
                          }}
                        >
                          {s.title}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* 右侧：主预览区 */}
              <div className="flex-1 relative p-4">
                <iframe
                  ref={iframeRef}
                  srcDoc={renderedHtml}
                  title="PPT Preview"
                  className="w-full h-full rounded-lg border border-border bg-white shadow-lg"
                  sandbox="allow-same-origin allow-scripts"
                />
                {/* 进度浮窗（渲染中显示） */}
                {rendering && progress && (
                  <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-full bg-secondary/90 backdrop-blur px-4 py-2 text-xs shadow-lg border border-border">
                    <svg className="animate-spin w-3.5 h-3.5 text-primary" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                    <span className="text-foreground/90">
                      AI 正在{progress.stage === 'render' ? '生成 PPT' : progress.stage === 'audit' ? '排版自检' : progress.stage === 'reflow' ? '重新调整布局' : '完成渲染'}
                      {progress.stage === 'render' && ` (${progress.current}/${progress.total})`}
                    </span>
                    <span className="text-muted-foreground/70 ml-1">{progress.message}</span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="rounded-xl border border-border bg-secondary/20 p-3">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">演示文稿标题</label>
                <input
                  value={outline.title}
                  onChange={(e) => setOutline({ ...outline, title: e.target.value })}
                  className="mt-1 w-full bg-transparent text-lg font-semibold outline-none border-none"
                />
              </div>
              {outline.slides.map((slide, idx) => (
                <div key={idx} className="rounded-xl border border-border bg-secondary/20 p-3 group">
                  <div className="flex items-start gap-2">
                    <span className="w-7 h-7 shrink-0 rounded-lg bg-gradient-to-br from-violet-500/30 to-fuchsia-500/30 flex items-center justify-center text-xs font-bold text-violet-300 mt-0.5">
                      {idx + 1}
                    </span>
                    <div className="flex-1 space-y-2">
                      <input
                        value={slide.title}
                        onChange={(e) => updateSlideTitle(idx, e.target.value)}
                        placeholder={`第 ${idx + 1} 页标题`}
                        className="w-full bg-transparent text-sm font-semibold outline-none border-none placeholder:text-muted-foreground/50"
                      />
                      {slide.bullets.map((b, bidx) => (
                        <div key={bidx} className="flex items-center gap-2">
                          <span className="text-violet-400 text-xs">•</span>
                          <input
                            value={b}
                            onChange={(e) => updateBullet(idx, bidx, e.target.value)}
                            placeholder="要点内容"
                            className="flex-1 bg-transparent text-xs outline-none border-b border-transparent focus:border-border placeholder:text-muted-foreground/40 py-0.5"
                          />
                          <button
                            onClick={() => removeBullet(idx, bidx)}
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-all text-xs"
                            title="删除要点"
                          >✕</button>
                        </div>
                      ))}
                      <button onClick={() => addBullet(idx)} className="text-xs text-muted-foreground hover:text-violet-400 transition-colors">+ 添加要点</button>
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        onClick={() => handleExpandSlide(idx, 'standard')}
                        disabled={expandingSlideIdx !== null}
                        className="opacity-0 group-hover:opacity-100 text-[10px] text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 px-1.5 py-0.5 rounded transition-all disabled:opacity-50"
                        title="AI 细化扩写本页"
                      >
                        {expandingSlideIdx === idx ? '扩写中…' : 'AI 扩写'}
                      </button>
                      <button
                        onClick={() => removeSlide(idx)}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-all text-sm"
                        title="删除此页"
                      >✕</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
};

export default PptPage;