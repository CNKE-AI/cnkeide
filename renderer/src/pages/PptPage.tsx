import React, { useEffect, useMemo, useState } from 'react';
import {
  Briefcase, GraduationCap, Mountain, Smile, Sparkles, RefreshCw, Eye, Save,
  Wand2, FolderOpen, FileDown, Rocket, Building2, Layers, ShieldCheck,
  ChevronRight, ChevronLeft, Pencil, Download, FileText, Check,
} from 'lucide-react';
import { useApp } from '../store/AppProvider';
import { PptMasterWorkspace } from '../components/ppt/PptMasterWorkspace';

interface SlideDraft {
  title: string;
  subtitle?: string;
  bullets: string[];
  /** 页面角色（LLM 标注，决定版式）。缺省时由 assignRoles 推断 */
  role?: 'cover' | 'toc' | 'section' | 'content' | 'data' | 'closing';
  /** 目录页条目（role=toc） */
  tocItems?: string[];
  /** 数据页核心数字（role=data），如 "23%" */
  metric?: string;
  /** 核心数字的标签，如 "营收同比增长" */
  metricLabel?: string;
  /** 底部图注/补充说明 */
  note?: string;
  /** 数据页图表（场景化大纲生成时，数据页可带 chart） */
  chart?: { type: 'bar' | 'line' | 'pie'; labels: string[]; series: { name: string; values: number[] }[] };
}

interface Outline {
  title: string;
  slides: SlideDraft[];
}

interface AiDesign {
  themeId: string;
  artDirection?: 'education' | 'culture' | 'technology' | 'healthcare' | 'business';
  palette: { primary: string; secondary: string; accent: string; background: string };
  fontFamily: string;
  visualStyle: string;
  rationale: string;
}

/** 已确定版式角色的页（assignRoles 的输出） */
type SlideWithRole = SlideDraft & { role: NonNullable<SlideDraft['role']>; tocItems?: string[] };

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

const cnke = window.cnke;

/**
 * 大纲后处理：补全空要点页（对标 WPS AI PPT 每页必须有实质内容）
 *
 * 问题：LLM 生成大纲时经常只给标题不给要点（bullets 为空），导致整页空白。
 * 方案：对 bullets < 2 条的页，并行调用 expandSlide（LLM 扩写）补全。
 * 返回补全后的 slides（新数组），失败的页保留原样（不阻断主流程）。
 */
async function backfillBullets(slides: SlideDraft[], presentationTopic: string): Promise<SlideDraft[]> {
  // 找出需要补全的页（bullets 为空或只有 1 条，且不是封面/结尾页的特征）
  const needFill = slides.map((s, i) => ({ s, i })).filter(({ s, i }) => {
    const isCoverOrEnd = i === 0 || i === slides.length - 1;
    return !isCoverOrEnd && s.bullets.filter((b) => b.trim()).length < 2;
  });
  if (needFill.length === 0) return slides;

  const results = [...slides];
  // 并行补全（每页一次 LLM 调用），单页失败不中断
  await Promise.all(needFill.map(async ({ s, i }) => {
    try {
      const res = await cnke.ppt.expandSlide({
        slide: { title: s.title, bullets: s.bullets },
        presentationTopic,
        intensity: 'standard',
      });
      if (res.success && res.slide) {
        const filled = Array.isArray(res.slide.bullets) ? res.slide.bullets.filter((b: string) => b && b.trim()) : [];
        if (filled.length >= 2) results[i] = { ...s, bullets: filled };
      }
    } catch { /* 单页失败保留原样 */ }
  }));
  return results;
}

/**
 * 自动给大纲页分配角色：
 * - 第 1 页 = cover，最后 1 页 = closing
 * - 第 2 页 = toc（如果总页数 >= 4）
 * - 有 chart 的页 = data
 * - 其余 = content
 * 这样 PPTX 导出和 HTML 预览都能按角色用对应版式，不靠 LLM。
 */
function assignRoles(slides: SlideDraft[]): SlideWithRole[] {
  const total = slides.length;
  const tocItems = slides.slice(1, total >= 4 ? total - 1 : total).map((s) => s.title);
  return slides.map((s, i) => {
    // 优先尊重 LLM 标注的 role（新大纲 prompt 会显式输出 role），仅在缺失时推断。
    // 但首尾页有硬约束：第 1 页必须是 cover、最后 1 页必须是 closing，防止 LLM 标错。
    let role: SlideDraft['role'];
    if (i === 0) role = 'cover';
    else if (i === total - 1) role = 'closing';
    else if (s.role && s.role !== 'cover' && s.role !== 'closing') role = s.role;
    else if (total >= 4 && i === 1) role = 'toc';
    else if (s.chart) role = 'data';
    else role = 'content';
    return {
      ...s,
      role,
      // 目录页补 tocItems（LLM 若已给则保留）
      ...(role === 'toc' ? { tocItems: s.tocItems && s.tocItems.length ? s.tocItems : tocItems } : {}),
    };
  });
}

/** 把大纲页转成 PPTX 导出所需的 slides（bullets 转 {text} 对象 + 透传版式字段） */
function toExportSlides(slidesWithRole: SlideWithRole[]) {
  return slidesWithRole.map((s) => ({
    title: s.title,
    subtitle: s.subtitle,
    bullets: s.bullets.filter((b: string) => b && b.trim()).map((text: string) => ({ text })),
    role: s.role,
    tocItems: s.tocItems,
    metric: s.metric,
    metricLabel: s.metricLabel,
    note: s.note,
    ...(s.chart ? { chart: s.chart } : {}),
  }));
}

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
  const [showPptMaster, setShowPptMaster] = useState(false);

  // 一键生成：自动串起「场景检测 → AI 大纲 → AI 渲染 → 导出 PPTX」四步，
  // step 标记当前进行到的阶段（null = 空闲）
  const [oneClickStep, setOneClickStep] = useState<'scenario' | 'outline' | 'render' | 'export' | null>(null);

  // ===== 企业级：场景体系 =====
  interface ScenarioMeta { id: string; name: string; description: string; recommendedTheme: string; recommendedPages: [number, number] }
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([]);
  /** '' = 自动检测；否则为用户手动锁定的场景 id */
  const [scenarioId, setScenarioId] = useState('');
  const [scenarioInfo, setScenarioInfo] = useState<{ id: string; byLlm: boolean; confidence: number } | null>(null);

  // ===== 企业级：品牌配置 =====
  const [brand, setBrand] = useState<any>(null);
  const [brandSaving, setBrandSaving] = useState(false);

  // ===== 企业级：批量生成 =====
  const [batchMode, setBatchMode] = useState(false);
  const [batchTopics, setBatchTopics] = useState('');
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const [batchResults, setBatchResults] = useState<Array<{ topic: string; success: boolean; path?: string; error?: string }>>([]);

  // ===== 企业级：审校报告 =====
  const [auditReport, setAuditReport] = useState<{ issues: Array<{ level: 'warning' | 'fixed'; slide: number; message: string }>; summary: string; passed: boolean } | null>(null);

  // 主题相关
  const [themes, setThemes] = useState<ThemeMeta[]>([]);
  const [selectedThemeId, setSelectedThemeId] = useState<string>('business');
  const [aiDesign, setAiDesign] = useState<AiDesign | null>(null);
  const [designing, setDesigning] = useState(false);
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

  // 从聊天 /ppt 指令打开时，将主题带入当前窗口。
  useEffect(() => cnke.ppt.onTopic((nextTopic) => {
    const normalizedTopic = nextTopic.trim();
    if (!normalizedTopic) return;
    setTopic(normalizedTopic);
    setError(null);
    setOutline(null);
    setRenderedHtml(null);
    setSavedPath(null);
    setWizardStep('input');
  }), []);

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

  // ===== AiPPT 式分步向导：input → outline → theme → preview，steps 可点击回退 =====
  const [wizardStep, setWizardStep] = useState<'input' | 'outline' | 'theme' | 'preview'>('input');
  /** 高级选项折叠态（页数/场景/批量/工作区等企业能力收进这里） */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** 输入源：主题 / 粘贴文本 / 工作区 */
  const [inputMode, setInputMode] = useState<'topic' | 'text' | 'workspace'>('topic');
  const [pastedText, setPastedText] = useState('');

  // 生成完成后的结果提示（成功态，非错误）
  const [applyNotice, setApplyNotice] = useState<string | null>(null);

  // 扩写进度
  const [expandProgress, setExpandProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const [expandingSlideIdx, setExpandingSlideIdx] = useState<number | null>(null);

  // 监听全文扩写进度
  useEffect(() => cnke.ppt.onExpandProgress?.(setExpandProgress), []);

  // 场景推荐主题自动跟随：用户选场景后切到推荐主题（除非已手动改过主题）
  useEffect(() => {
    if (!scenarioId || scenarios.length === 0 || themes.length === 0) return;
    const s = scenarios.find((x) => x.id === scenarioId);
    if (s && themes.some((t) => t.id === s.recommendedTheme)) {
      setSelectedThemeId(s.recommendedTheme);
    }
  }, [scenarioId, scenarios, themes]);

  // 加载主题清单 + 场景清单 + 品牌配置
  useEffect(() => {
    (async () => {
      const res = await cnke.ppt.listThemes();
      if (res.success && res.themes) setThemes(res.themes);
    })();
    (async () => {
      const res = await cnke.ppt.listScenarios();
      if (res.success && res.scenarios) setScenarios(res.scenarios);
    })();
    (async () => {
      const res = await cnke.ppt.getBrand();
      if (res.success && res.brand) setBrand(res.brand);
    })();
  }, []);

  /**
   * 向导步骤自动跟随数据状态：
   * - 清空大纲（或首次进入）→ input
   * - 刚生成大纲 → outline（停在编辑页，让用户先改）
   * - 渲染结果被清空（点「返回大纲」）→ outline
   * 注意：渲染完成后不自动跳 preview，用户点「查看效果并导出」再进。
   */
  useEffect(() => {
    setWizardStep((cur) => {
      if (!outline) return 'input';
      if (cur === 'input') return 'outline';
      if (!renderedHtml && cur === 'preview') return 'outline';
      return cur;
    });
  }, [outline, renderedHtml]);

  /** 步骤条点击：只能跳到已解锁的步骤 */
  const gotoStep = (step: 'input' | 'outline' | 'theme' | 'preview') => {
    if (step === 'outline' && !outline) return;
    if (step === 'theme' && !outline) return;
    if (step === 'preview' && !renderedHtml) return;
    setWizardStep(step);
  };

  /** 保存品牌配置 */
  const handleSaveBrand = async () => {
    if (!brand) return;
    setBrandSaving(true);
    try {
      const res = await cnke.ppt.setBrand(brand);
      if (res.success) setBrand(res.brand);
    } finally { setBrandSaving(false); }
  };

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

  /**
   * 一键生成 PPT（企业级）：自动串起「场景检测 → AI 大纲（场景结构）→ AI 渲染 → 导出 PPTX（品牌+动画+审校）」。
   *
   * 输入源自动选择：填了主题用主题；没填但打开了工作区则从项目内容生成。
   * 任何一步失败即中断并报错；成功后右侧出 HTML 预览、工作区落盘带品牌元素的 .pptx。
   */
  const handleOneClick = async () => {
    if (oneClickStep) return;
    const t = topic.trim();
    const fromWs = !t && !!workspacePath;
    if (!t && !fromWs) {
      setError('请输入 PPT 主题；或先在主界面打开工作区，即可从项目内容一键生成');
      return;
    }

    setError(null);
    setApplyNotice(null);
    setSavedPath(null);
    setRenderedHtml(null);
    setAuditReport(null);
    try {
      // ⓪ 场景检测：自动匹配最合适的模板类型（商务汇报/产品发布/项目提案/年度总结/培训课件）
      let sid = scenarioId;
      setOneClickStep('scenario');
      if (!sid) {
        const det = await cnke.ppt.detectScenario(t || '工作区项目介绍');
        if (det.success) {
          sid = det.scenarioId;
          setScenarioInfo({ id: det.scenarioId, byLlm: det.byLlm, confidence: det.confidence });
          // 场景推荐主题自动跟随（一键模式下用户未手动选主题时跟随）
          const sc = scenarios.find((x) => x.id === det.scenarioId);
          if (sc && themes.some((tm) => tm.id === sc.recommendedTheme)) {
            setSelectedThemeId(sc.recommendedTheme);
          }
        }
      } else {
        setScenarioInfo({ id: sid, byLlm: false, confidence: 1 });
      }

      // ① AI 生成大纲（按场景结构骨架组织，数据页可带 chart）
      setOneClickStep('outline');
      const outlineRes: any = fromWs
        ? await cnke.ppt.generateFromWorkspace({ slideCount, focus: wsFocus.trim() || undefined })
        : await cnke.ppt.generateOutline(t, slideCount, sid || undefined);
      if (!outlineRes.success || !outlineRes.outline) {
        throw new Error(outlineRes.error || '生成大纲失败');
      }
      let slides = (outlineRes.outline.slides || []).map((s: any) => ({
        title: s.title || '',
        subtitle: s.subtitle || undefined,
        bullets: Array.isArray(s.bullets) ? s.bullets : [],
        // 透传 LLM 标注的版式字段（新版大纲 prompt 会输出）
        role: s.role || undefined,
        tocItems: Array.isArray(s.tocItems) ? s.tocItems : undefined,
        metric: s.metric || undefined,
        metricLabel: s.metricLabel || undefined,
        note: s.note || undefined,
        chart: s.chart && Array.isArray(s.chart.series) && s.chart.series.length > 0 ? s.chart : undefined,
      }));
      // 关键：补全空要点页（LLM 常只给标题不给要点，导致整页空白）
      const emptyCount = slides.filter((s: SlideDraft, i: number) => i !== 0 && i !== slides.length - 1 && s.bullets.filter((b: string) => b.trim()).length < 2).length;
      if (emptyCount > 0) {
        slides = await backfillBullets(slides, outlineRes.outline.title || t || '演示文稿');
      }
      const ol: Outline = {
        title: outlineRes.outline.title || (fromWs ? (outlineRes.workspace?.projectName || '工作区演示文稿') : t),
        slides,
      };
      // 场景图表建议透传到大纲（PPTX 导出时 addChart 渲染）
      const chartSlides: Record<number, any> = {};
      (outlineRes.outline.slides || []).forEach((s: any, i: number) => {
        if (s.chart && Array.isArray(s.chart.series) && s.chart.series.length > 0) chartSlides[i] = s.chart;
      });
      if (outlineRes.workspace) setWsSummary(outlineRes.workspace);
      setOutline(ol);

      // ② AI 先设计原创视觉方案，再由本地代码绘制；不下载、不套用外部模板。
      setOneClickStep('render');
      setDesigning(true);
      const slidesWithRole = assignRoles(ol.slides);
      const designRes = await cnke.ppt.generateAiDesign({
        topic: t || ol.title,
        scenarioName: scenarios.find((s) => s.id === sid)?.name,
        slides: slidesWithRole,
        fallbackThemeId: selectedThemeId,
      });
      const design = designRes.design as AiDesign;
      setAiDesign(design);
      setSelectedThemeId(design.themeId);
      const previewRes = await cnke.ppt.generatePreview({
        themeId: design.themeId,
        outline: { title: ol.title, slides: slidesWithRole },
        design: { palette: design.palette, fontFamily: design.fontFamily, artDirection: design.artDirection },
      });
      if (!previewRes.success || !previewRes.html) {
        throw new Error(previewRes.error || '预览生成失败');
      }
      setRenderedHtml(previewRes.html);

      // ③ 导出原生 PPTX：品牌元素 + 切换动画 + 生成前智能审校（主进程内完成）
      setOneClickStep('export');
      const theme = themes.find((x) => x.id === design.themeId);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeTitle = (ol.title || '演示文稿').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      const filename = `${safeTitle}-${ts}.pptx`;
      const savePath = workspacePath
        ? `${workspacePath.replace(/[\\/]+$/, '')}\\${filename}`
        : undefined;
      const genRes = await cnke.ppt.generate(
        {
          title: ol.title,
          author: 'CnkeIDE',
          subject: t || ol.title,
          size: '16x9' as const,
          // AI 原创配色优先；企业品牌启用时由品牌色覆盖（主进程内处理）
          theme: {
            primary: design.palette.primary,
            secondary: design.palette.secondary,
            accent: design.palette.accent,
            background: design.palette.background,
          },
          fontFamily: design.fontFamily,
          brand: brand || undefined,
          transition: true,
          slides: toExportSlides(slidesWithRole),
        },
        savePath,
      );
      if (!genRes.success) {
        // 预览已成功，导出失败不回滚，仅提示
        setError('预览已生成，但 PPTX 导出失败：' + (genRes.error || '未知错误'));
        return;
      }
      if (genRes.path) setSavedPath(genRes.path);
      if (genRes.audit) setAuditReport(genRes.audit);
      const warnCount = genRes.audit?.issues.filter((i: any) => i.level === 'warning').length ?? 0;
      setApplyNotice(
        `AI 已原创设计「${design.visualStyle}」：${ol.slides.length} 页 PPT 已保存${genRes.audit ? `，${genRes.audit.summary}` : ''}${warnCount > 0 ? '（详见下方审校报告）' : ''}。${design.rationale}`,
      );
      // 全自动完成后直达导出步骤
      setWizardStep('preview');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setOneClickStep(null);
      setDesigning(false);
    }
  };

  /**
   * 批量生成：每行一个主题 → 逐个「场景检测 → 大纲 → PPTX」（跳过 HTML 预览求速度）。
   * 结果逐条汇总展示，单个失败不中断批次。
   */
  const handleBatchGenerate = async () => {
    if (batchRunning) return;
    const topics = batchTopics.split('\n').map((x) => x.trim()).filter(Boolean);
    if (topics.length === 0) { setError('批量模式：请在文本框中输入主题，每行一个'); return; }
    if (!workspacePath) { setError('批量生成需要先在主界面打开工作区（用于保存文件）'); return; }

    setBatchRunning(true);
    setBatchProgress({ current: 0, total: topics.length });
    setBatchResults([]);
    setError(null);
    try {
      const results: Array<{ topic: string; success: boolean; path?: string; error?: string }> = [];
      for (let i = 0; i < topics.length; i++) {
        const tp = topics[i];
        setBatchProgress({ current: i + 1, total: topics.length });
        try {
          // 场景检测（失败静默回退 general）
          let sid = scenarioId;
          if (!sid) {
            const det = await cnke.ppt.detectScenario(tp);
            if (det.success) sid = det.scenarioId;
          }
          // 大纲（场景化）
          const outlineRes = await cnke.ppt.generateOutline(tp, slideCount, sid || undefined);
          if (!outlineRes.success || !outlineRes.outline) throw new Error(outlineRes.error || '生成大纲失败');
          const slidesRaw = (outlineRes.outline.slides || []).map((s: any) => ({
            title: s.title || '',
            subtitle: s.subtitle || undefined,
            bullets: (Array.isArray(s.bullets) ? s.bullets : []).filter((b: string) => b && b.trim()),
            role: s.role || undefined,
            tocItems: Array.isArray(s.tocItems) ? s.tocItems : undefined,
            metric: s.metric || undefined,
            metricLabel: s.metricLabel || undefined,
            note: s.note || undefined,
            chart: s.chart && Array.isArray(s.chart.series) && s.chart.series.length > 0 ? s.chart : undefined,
          }));
          const slidesWithRoleBatch = assignRoles(slidesRaw);
          const slides = toExportSlides(slidesWithRoleBatch);
          // 每份 PPT 独立调用 AI 原创设计，避免批量结果视觉雷同。
          const designRes = await cnke.ppt.generateAiDesign({
            topic: tp,
            scenarioName: scenarios.find((s) => s.id === sid)?.name,
            slides: slidesWithRoleBatch,
            fallbackThemeId: selectedThemeId,
          });
          const design = designRes.design as AiDesign;
          // 导出 PPTX（审校 + 品牌 + 动画在主进程完成）
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const safeTitle = (outlineRes.outline.title || tp).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
          const filename = `${safeTitle}-${ts}.pptx`;
          const savePath = `${workspacePath.replace(/[\\/]+$/, '')}\\${filename}`;
          const genRes = await cnke.ppt.generate(
            {
              title: outlineRes.outline.title || tp,
              author: 'CnkeIDE',
              subject: tp,
              size: '16x9' as const,
              theme: design.palette,
              fontFamily: design.fontFamily,
              brand: brand || undefined,
              transition: true,
              slides,
            },
            savePath,
          );
          if (!genRes.success) throw new Error(genRes.error || 'PPTX 导出失败');
          results.push({ topic: tp, success: true, path: genRes.path });
        } catch (e: any) {
          results.push({ topic: tp, success: false, error: e?.message || String(e) });
        }
        setBatchResults([...results]);
      }
      const ok = results.filter((r) => r.success).length;
      setApplyNotice(`批量生成完成：成功 ${ok} / ${results.length} 份，文件已保存到工作区。`);
    } finally {
      setBatchRunning(false);
      setBatchProgress(null);
    }
  };

  /**
   * 粘贴内容 → 大纲（AiPPT 式「Anything In」）
   * 不新增 IPC：把长文本作为主题 + 结构化指令传给现有 generateOutline，
   * 由 LLM 从材料中提炼要点，避免空白页与编造。
   */
  const handleGenerateFromText = async () => {
    const body = pastedText.trim();
    if (!body) { setError('请先粘贴文本内容'); return; }
    setLoading(true);
    setError(null);
    setSavedPath(null);
    setRenderedHtml(null);
    try {
      const doc = body.slice(0, 6000);
      const instruction = [
        `【原始材料】`,
        doc,
        ``,
        `请基于以上材料，提炼并组织成一份 ${slideCount} 页的 PPT 大纲。`,
        `材料中没有的信息不要编造；如材料本身较短，可合理归纳但不要虚构数据。`,
      ].join('\n');
      const res = await cnke.ppt.generateOutline(instruction, slideCount, scenarioId || undefined);
      if (res.success && res.outline) {
        setOutline({
          title: res.outline.title || doc.slice(0, 30) || '演示文稿',
          slides: (res.outline.slides || []).map((s: any) => ({
            title: s.title || '',
            bullets: Array.isArray(s.bullets) ? s.bullets : [],
          })),
        });
        setTopic(res.outline.title || doc.slice(0, 30));
      } else setError(res.error || '生成大纲失败');
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
      // 分步模式也传场景，保证大纲按场景结构骨架组织
      const res = await cnke.ppt.generateOutline(topic.trim(), slideCount, scenarioId || undefined);
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

  /** 第 2 轮：把大纲交给 AI 现场设计视觉方案 → 生成 HTML 预览 */
  const handleRenderTheme = async () => {
    if (!outline) { setError('请先生成大纲'); return; }
    setRendering(true);
    setDesigning(true);
    setError(null);
    setSavedPath(null);
    try {
      const slidesWithRole = assignRoles(outline.slides);
      const designRes = await cnke.ppt.generateAiDesign({
        topic: outline.title,
        scenarioName: scenarios.find((s) => s.id === scenarioId)?.name,
        slides: slidesWithRole,
        fallbackThemeId: selectedThemeId,
      });
      const design = designRes.design as AiDesign;
      setAiDesign(design);
      setSelectedThemeId(design.themeId);
      const res = await cnke.ppt.generatePreview({
        themeId: design.themeId,
        outline: { title: outline.title, slides: slidesWithRole },
        design: { palette: design.palette, fontFamily: design.fontFamily, artDirection: design.artDirection },
      });
      if (res.success && res.html) setRenderedHtml(res.html);
      else setError(res.error || '预览生成失败');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setRendering(false); setDesigning(false); }
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

  /** 导出 PPTX：优先使用 AI 原创设计；若尚未设计则现场生成。 */
  const handleExportPptx = async () => {
    if (!outline) { setError('请先生成大纲'); return; }
    setSaving(true);
    setError(null);
    setSavedPath(null);
    try {
      const slidesWithRole = assignRoles(outline.slides);
      let design = aiDesign;
      if (!design) {
        setDesigning(true);
        const designRes = await cnke.ppt.generateAiDesign({
          topic: topic.trim() || outline.title,
          scenarioName: scenarios.find((s) => s.id === scenarioId)?.name,
          slides: slidesWithRole,
          fallbackThemeId: selectedThemeId,
        });
        design = designRes.design;
        setAiDesign(design);
        setSelectedThemeId(design.themeId);
      }
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
          theme: design.palette,
          fontFamily: design.fontFamily,
          brand: brand || undefined,
          transition: true,
          slides: toExportSlides(slidesWithRole),
        },
        savePath,
      );
      if (res.success && res.path) setSavedPath(res.path);
      else setError(res.error || 'PPTX 导出失败');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setSaving(false); setDesigning(false); }
  };

  const slideCountPreview = useMemo(() => outline?.slides.length ?? 0, [outline]);


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


  /** 生成当前内置主题的确定性草稿预览。 */
  const handlePreviewTemplate = async () => {
    if (!outline) { setError('请先生成大纲'); return; }
    setRendering(true);
    setError(null);
    setApplyNotice(null);
    try {
      const res = await cnke.ppt.generatePreview({
        themeId: selectedThemeId,
        outline: { title: outline.title, slides: assignRoles(outline.slides) },
      });
      if (res.success && res.html) {
        setRenderedHtml(res.html);
      } else setError(res.error || '草稿预览生成失败');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setRendering(false); }
  };

  if (showPptMaster) {
    return (
      <div className="flex h-full flex-col bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-secondary/20 px-4" style={{ WebkitAppRegion: 'drag' } as any}>
          <span className="text-sm font-semibold" style={{ WebkitAppRegion: 'no-drag' } as any}>AI 智能 PPT / 原生 PPTX</span>
          <div className="flex gap-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <button onClick={() => cnke.ppt.minimize()} className="w-9 h-8 rounded-md hover:bg-secondary text-muted-foreground" title="最小化">−</button>
            <button onClick={() => cnke.ppt.close()} className="w-9 h-8 rounded-md hover:bg-red-500/80 text-muted-foreground hover:text-white" title="关闭">×</button>
          </div>
        </div>
        <PptMasterWorkspace initialTopic={topic} initialSlideCount={slideCount} onBack={() => setShowPptMaster(false)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      {/* 标题栏 */}
      <div className="flex items-center justify-between h-11 px-4 border-b border-border bg-secondary/20" style={{ WebkitAppRegion: 'drag' } as any}>
        <div className="flex items-center gap-2.5" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <span className="text-sm font-semibold tracking-wide">AI 智能 PPT</span>
          <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-secondary/60">
            从想法到可编辑幻灯片
          </span>
        </div>
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button onClick={() => setShowPptMaster(true)} className="mr-2 rounded-md border border-violet-500/40 bg-violet-500/10 px-2.5 py-1.5 text-xs font-medium text-violet-300 hover:bg-violet-500/20" title="使用母版和版式生成原生可编辑 PPTX">PPT Master</button>
          <button onClick={() => cnke.ppt.minimize()} className="w-9 h-8 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors" title="最小化">
            <svg className="w-4 h-4 mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
          <button onClick={() => cnke.ppt.close()} className="w-9 h-8 rounded-md hover:bg-red-500/80 text-muted-foreground hover:text-white transition-colors" title="关闭">
            <svg className="w-4 h-4 mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      </div>

      {/* 步骤条：输入 → 大纲 → 主题 → 导出（可点击回退到已解锁步骤） */}
      <div className="flex items-center gap-1 px-4 h-10 border-b border-border bg-secondary/10 shrink-0">
        {([
          ['input', '输入内容'],
          ['outline', '生成大纲'],
          ['theme', '选主题'],
          ['preview', '导出'],
        ] as const).map(([step, label], i, arr) => {
          const order = { input: 0, outline: 1, theme: 2, preview: 3 } as const;
          const cur = order[wizardStep];
          const own = order[step];
          const done = own < cur;
          const active = own === cur;
          // 未解锁的步骤（无大纲/无预览）不可点击
          const locked = (step === 'outline' || step === 'theme') ? !outline : step === 'preview' ? !renderedHtml : false;
          return (
            <React.Fragment key={step}>
              <button
                onClick={() => gotoStep(step)}
                disabled={locked}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  active ? 'text-primary bg-primary/10'
                    : done ? 'text-emerald-400 hover:bg-secondary/60'
                      : locked ? 'text-muted-foreground/40 cursor-not-allowed'
                        : 'text-muted-foreground hover:bg-secondary/60'
                }`}
              >
                <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold ${
                  active ? 'bg-primary text-primary-foreground'
                    : done ? 'bg-emerald-500/20 text-emerald-400'
                      : 'bg-secondary text-muted-foreground/70'
                }`}>
                  {done ? '✓' : i + 1}
                </span>
                {label}
              </button>
              {i < arr.length - 1 && <ChevronRight className="w-3 h-3 text-muted-foreground/40 shrink-0" />}
            </React.Fragment>
          );
        })}
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden flex">
        {/* 左侧：向导步骤面板 */}
        <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          <>
          {/* ===== 步骤 1：输入内容 ===== */}
          {wizardStep === 'input' && (
            <>
              <div className="flex gap-1 p-0.5 rounded-lg bg-secondary/40">
                {([
                  ['topic', '主题生成', Sparkles],
                  ['text', '粘贴内容', FileText],
                  ['workspace', '工作区', FolderOpen],
                ] as const).map(([mode, label, Icon]) => (
                  <button
                    key={mode}
                    onClick={() => setInputMode(mode)}
                    className={`flex-1 inline-flex items-center justify-center gap-1 rounded-md py-1.5 text-[11px] font-medium transition-colors ${
                      inputMode === mode ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />{label}
                  </button>
                ))}
              </div>

              {/* 输入源内容 */}
              {inputMode === 'topic' && (
                <div className="mt-4">
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">PPT 主题</label>
                  <textarea
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="例如：2026 年 AI 编程助手行业趋势分析"
                    rows={4}
                    className="mt-1.5 w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm resize-none outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
                  />
                  <button
                    onClick={handleGenerateOutline}
                    disabled={loading || !topic.trim() || batchMode}
                    className="w-full mt-2 rounded-lg btn-gradient py-2.5 text-sm font-semibold disabled:opacity-50 transition-all inline-flex items-center justify-center gap-1.5"
                  >
                    <Wand2 className="w-4 h-4" />
                    {loading ? 'AI 生成大纲中…' : '生成大纲'}
                  </button>
                </div>
              )}

              {inputMode === 'text' && (
                <div className="mt-4">
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">粘贴文本 / 材料</label>
                  <textarea
                    value={pastedText}
                    onChange={(e) => setPastedText(e.target.value)}
                    placeholder={'粘贴文章、报告、会议纪要或任意长文本，AI 会从中提炼要点生成大纲。\n\n（最多取前 6000 字）'}
                    rows={10}
                    className="mt-1.5 w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs resize-none outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground mt-1 mb-2">
                    <span>已输入 {pastedText.trim().length} 字</span>
                    {pastedText.trim().length > 6000 && <span className="text-amber-400">超出部分将被截断</span>}
                  </div>
                  <button
                    onClick={handleGenerateFromText}
                    disabled={loading || !pastedText.trim()}
                    className="w-full rounded-lg btn-gradient py-2.5 text-sm font-semibold disabled:opacity-50 transition-all inline-flex items-center justify-center gap-1.5"
                  >
                    <Wand2 className="w-4 h-4" />
                    {loading ? 'AI 提炼要点中…' : '从内容生成大纲'}
                  </button>
                </div>
              )}
            </>
          )}

            {/* 场景自动匹配（企业级）：自动检测 + 手动锁定 */}
            {wizardStep === 'input' && scenarios.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">模板类型（自动匹配）</label>
                  {scenarioInfo && (
                    <span className="text-[9px] text-muted-foreground/70">
                      {scenarioInfo.byLlm ? `AI 识别：${scenarios.find((s) => s.id === scenarioInfo.id)?.name || scenarioInfo.id}` : '手动指定'}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  <button
                    onClick={() => { setScenarioId(''); setScenarioInfo(null); }}
                    className={`px-2 py-1 rounded-full text-[10px] transition-colors ${!scenarioId ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 text-muted-foreground hover:bg-secondary'}`}
                    title="根据主题内容自动匹配最合适的场景"
                  >✨ 自动</button>
                  {scenarios.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => { setScenarioId(s.id); setScenarioInfo({ id: s.id, byLlm: false, confidence: 1 }); }}
                      className={`px-2 py-1 rounded-full text-[10px] transition-colors ${scenarioId === s.id ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 text-muted-foreground hover:bg-secondary'}`}
                      title={s.description}
                    >{s.name}</button>
                  ))}
                </div>
              </div>
            )}

            {/* 批量开关 */}
            {wizardStep === 'input' && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={batchMode}
                onChange={(e) => setBatchMode(e.target.checked)}
                className="accent-[hsl(var(--primary))]"
              />
              <Layers className="w-3.5 h-3.5" />
              批量生成（每行一个主题，仅导出 PPTX）
            </label>
            )}

            {/* 一键生成（主推路径）：场景 → 大纲 → 渲染 → 导出全自动（批量模式下隐藏） */}
            {wizardStep === 'input' && !batchMode && (
              <button
                onClick={handleOneClick}
                disabled={!!oneClickStep || loading || rendering || saving}
                className="w-full rounded-lg py-3 text-sm font-bold btn-gradient disabled:opacity-60 disabled:cursor-not-allowed transition-all inline-flex items-center justify-center gap-2"
                title="自动完成：场景匹配 → AI 生成大纲 → AI 渲染美化 → 导出 PPTX（品牌元素 + 审校 + 动画）"
              >
                <Rocket className="w-4 h-4" />
                {oneClickStep
                  ? oneClickStep === 'scenario' ? '⓪ 匹配场景类型…'
                    : oneClickStep === 'outline' ? '① AI 生成大纲中…'
                      : oneClickStep === 'render' ? '② AI 原创设计中…'
                        : '③ 导出 PPTX 中…'
                  : '一键 AI 生成 PPT（原创设计）'}
              </button>
            )}
            {wizardStep === 'input' && !batchMode && oneClickStep && (
              <div className="flex items-center justify-between text-[10px]">
                {([
                  ['scenario', '⓪ 场景'],
                  ['outline', '① 大纲'],
                  ['render', '② 原创设计'],
                  ['export', '③ 导出'],
                ] as const).map(([step, label]) => {
                  const order = { scenario: 0, outline: 1, render: 2, export: 3 } as const;
                  const cur = order[oneClickStep];
                  const own = order[step];
                  return (
                    <span
                      key={step}
                      className={
                        own < cur ? 'text-emerald-400' : own === cur ? 'text-primary font-semibold' : 'text-muted-foreground/60'
                      }
                    >
                      {own < cur ? `✓ ${label}` : label}
                    </span>
                  );
                })}
              </div>
            )}

            {/* 批量生成模式：多主题输入 + 队列执行 + 结果汇总 */}
            {wizardStep === 'input' && batchMode && (
              <div className="rounded-lg border border-border bg-secondary/20 p-2.5 space-y-2">
                <textarea
                  value={batchTopics}
                  onChange={(e) => setBatchTopics(e.target.value)}
                  placeholder={'每行一个主题，例如：\nQ3 销售团队业绩汇报\n新员工入职培训课件\nAI 助手产品发布会'}
                  rows={4}
                  className="w-full rounded-md border border-border bg-secondary/40 px-2.5 py-2 text-xs resize-none outline-none focus:ring-1 focus:ring-primary/50 placeholder:text-muted-foreground/50"
                />
                <button
                  onClick={handleBatchGenerate}
                  disabled={batchRunning || !!oneClickStep}
                  className="w-full rounded-lg py-2 text-xs font-semibold bg-violet-600/90 text-white hover:bg-violet-600 disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-1.5"
                >
                  <Layers className="w-3.5 h-3.5" />
                  {batchRunning
                    ? `批量生成中 ${batchProgress ? `${batchProgress.current}/${batchProgress.total}` : '…'}`
                    : `批量生成（${batchTopics.split('\n').filter((x) => x.trim()).length} 份）`}
                </button>
                {batchResults.length > 0 && (
                  <div className="max-h-32 overflow-y-auto space-y-1">
                    {batchResults.map((r, i) => (
                      <div key={i} className={`flex items-start gap-1.5 text-[10px] ${r.success ? 'text-emerald-400' : 'text-red-400'}`}>
                        <span className="shrink-0">{r.success ? '✓' : '✕'}</span>
                        <span className="truncate" title={r.error || r.path}>{r.topic}{r.success ? '' : `：${r.error}`}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ===== 步骤 2：编辑大纲 ===== */}
            {wizardStep === 'outline' && outline && (
              <>
                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">演示标题</label>
                  <input
                    value={outline.title}
                    onChange={(e) => setOutline({ ...outline, title: e.target.value })}
                    className="mt-1.5 w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      幻灯片大纲（{outline.slides.length} 页）
                    </span>
                    <button
                      onClick={handleGenerateOutline}
                      disabled={loading || batchMode}
                      className="text-[10px] text-primary hover:underline disabled:opacity-50"
                    >
                      {loading ? '重新生成中…' : '重新生成'}
                    </button>
                  </div>
                  {outline.slides.map((s, si) => (
                    <div key={si} className="rounded-lg border border-border bg-secondary/30 p-2.5 space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="w-5 h-5 shrink-0 rounded bg-primary/15 text-primary text-[10px] font-bold flex items-center justify-center">{si + 1}</span>
                        <input
                          value={s.title}
                          onChange={(e) => {
                            const next = { ...outline, slides: [...outline.slides] };
                            next.slides[si] = { ...s, title: e.target.value };
                            setOutline(next);
                          }}
                          className="flex-1 bg-transparent text-xs font-semibold outline-none border-b border-transparent focus:border-primary/50"
                        />
                        <button
                          onClick={() => setOutline({ ...outline, slides: outline.slides.filter((_, i) => i !== si) })}
                          className="text-muted-foreground/60 hover:text-red-400 text-xs shrink-0"
                          title="删除此页"
                        >✕</button>
                      </div>
                      <textarea
                        value={s.bullets.join('\n')}
                        onChange={(e) => {
                          const next = { ...outline, slides: [...outline.slides] };
                          next.slides[si] = { ...s, bullets: e.target.value.split('\n') };
                          setOutline(next);
                        }}
                        rows={3}
                        placeholder="每行一个要点"
                        className="w-full rounded-md border border-border bg-secondary/40 px-2 py-1.5 text-[11px] resize-none outline-none focus:ring-1 focus:ring-primary/50 placeholder:text-muted-foreground/50"
                      />
                    </div>
                  ))}
                  <button
                    onClick={() => setOutline({ ...outline, slides: [...outline.slides, { title: '新页面', bullets: ['要点一'] }] })}
                    className="w-full rounded-lg border border-dashed border-border py-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
                  >+ 添加一页</button>
                </div>
                <button
                  onClick={() => setWizardStep('theme')}
                  className="w-full rounded-lg btn-gradient py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-1.5"
                >
                  下一步：选主题 <ChevronRight className="w-4 h-4" />
                </button>
              </>
            )}

            {/* ===== 步骤 3：选主题 + 渲染 ===== */}
            {wizardStep === 'theme' && outline && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">AI 原创设计（可选覆盖）</span>
                  {renderedHtml && (
                    <span className="text-[10px] text-emerald-400 inline-flex items-center gap-1">
                      <Check className="w-3 h-3" /> 已渲染
                    </span>
                  )}
                </div>
                {/* AI 现场设计结果：配色、字体、风格说明；用户仍可手动覆盖 */}
                {aiDesign && (
                  <div className="mb-2 rounded-lg border border-violet-500/40 bg-violet-500/10 px-2.5 py-2 text-[10px] text-violet-200 leading-relaxed">
                    <div className="flex items-center gap-1.5 font-semibold mb-1">
                      <Sparkles className="w-3.5 h-3.5" />
                      AI 原创设计：{aiDesign.visualStyle}
                      <span className="ml-auto font-mono text-[9px] text-violet-300/80">{aiDesign.fontFamily}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mb-1">
                      {(['primary', 'secondary', 'accent', 'background'] as const).map((k) => (
                        <span
                          key={k}
                          className="h-3 w-6 rounded border border-white/20"
                          style={{ background: aiDesign.palette[k] }}
                          title={`${k} ${aiDesign.palette[k]}`}
                        />
                      ))}
                    </div>
                    {aiDesign.rationale}
                  </div>
                )}
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

                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => setWizardStep('outline')}
                    className="shrink-0 rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-xs font-medium hover:bg-secondary inline-flex items-center gap-1"
                    title="返回大纲编辑"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" /> 大纲
                  </button>
                  <button
                    onClick={handleRenderTheme}
                    disabled={rendering}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg btn-gradient py-2.5 text-sm font-semibold disabled:opacity-50 transition-all"
                  >
                    <Wand2 className="w-4 h-4" />
                    {rendering ? (designing ? 'AI 原创设计中…' : '渲染中…') : renderedHtml ? '重新生成设计' : 'AI 原创设计并渲染'}
                  </button>
                </div>
                {renderedHtml && (
                  <button
                    onClick={() => setWizardStep('preview')}
                    className="w-full rounded-lg border border-border bg-secondary/40 py-2 text-xs font-medium hover:bg-secondary transition-colors inline-flex items-center justify-center gap-1.5"
                  >
                    查看效果并导出 <ChevronRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            )}

            {/* ===== 步骤 4：导出 ===== */}
            {wizardStep === 'preview' && (
              <>
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-300 flex items-center gap-2">
                  <Check className="w-4 h-4 shrink-0" />
                  <span>渲染完成，可在右侧预览并导出 PPTX。</span>
                </div>
                <button
                  onClick={handleExportPptx}
                  disabled={saving || !renderedHtml}
                  className="w-full rounded-lg btn-gradient py-2.5 text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                >
                  <Download className="w-4 h-4" />
                  {saving ? '导出中…' : '导出 PPTX'}
                </button>
                {savedPath && (
                  <div className="rounded-lg border border-border bg-secondary/30 p-2.5 text-[10px] break-all">
                    <div className="text-emerald-400 mb-0.5">已保存</div>
                    <div className="text-muted-foreground">{savedPath}</div>
                  </div>
                )}
                <button
                  onClick={() => setWizardStep('theme')}
                  className="w-full rounded-lg border border-border bg-secondary/40 py-2 text-xs font-medium hover:bg-secondary inline-flex items-center justify-center gap-1.5"
                >
                  <ChevronLeft className="w-4 h-4" /> 换个主题重新渲染
                </button>
              </>
            )}

            {/* 企业品牌元素：Logo / 企业色 / 字体 / 页脚（折叠编辑，全局持久化） */}
            {brand && (
              <details className="group/side pt-3 border-t border-border">
                <summary className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground">
                  <Building2 className="w-3.5 h-3.5" />
                  企业品牌元素
                  <span className={`ml-1 px-1.5 py-0.5 rounded text-[9px] normal-case ${brand.enabled ? 'bg-emerald-500/15 text-emerald-400' : 'bg-secondary text-muted-foreground/70'}`}>
                    {brand.enabled ? '已启用' : '未启用'}
                  </span>
                </summary>
                <div className="mt-2 space-y-2">
                  <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={!!brand.enabled}
                      onChange={(e) => setBrand({ ...brand, enabled: e.target.checked })}
                      className="accent-[hsl(var(--primary))]"
                    />
                    启用品牌元素（企业色优先、Logo、页脚、页码）
                  </label>
                  <input
                    value={brand.companyName || ''}
                    onChange={(e) => setBrand({ ...brand, companyName: e.target.value })}
                    placeholder="公司名称（封面/页脚显示）"
                    className="w-full rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  <input
                    value={brand.logoPath || ''}
                    onChange={(e) => setBrand({ ...brand, logoPath: e.target.value })}
                    placeholder="Logo 图片绝对路径（png/jpg，透明底最佳）"
                    className="w-full rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary/50 font-mono"
                  />
                  <div className="grid grid-cols-3 gap-1.5">
                    {([
                      ['primary', '主色'],
                      ['secondary', '辅色'],
                      ['accent', '强调色'],
                    ] as const).map(([key, label]) => (
                      <label key={key} className="flex flex-col gap-1">
                        <span className="text-[9px] text-muted-foreground">{label}（可空）</span>
                        <span className="flex items-center gap-1">
                          <input
                            type="color"
                            value={(brand[key] && /^#[0-9a-fA-F]{6}$/.test(brand[key]) ? brand[key] : '#1e3a8a')}
                            onChange={(e) => setBrand({ ...brand, [key]: e.target.value })}
                            className="w-6 h-6 rounded border border-border bg-transparent cursor-pointer p-0.5 shrink-0"
                          />
                          <input
                            value={brand[key] || ''}
                            onChange={(e) => setBrand({ ...brand, [key]: e.target.value })}
                            placeholder="默认"
                            className="w-full min-w-0 rounded border border-border bg-secondary/40 px-1 py-1 text-[9px] font-mono outline-none focus:ring-1 focus:ring-primary/50"
                          />
                        </span>
                      </label>
                    ))}
                  </div>
                  <input
                    value={brand.fontFamily || ''}
                    onChange={(e) => setBrand({ ...brand, fontFamily: e.target.value })}
                    placeholder="企业字体（如 Microsoft YaHei；空 = 默认）"
                    className="w-full rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  <input
                    value={brand.footerText || ''}
                    onChange={(e) => setBrand({ ...brand, footerText: e.target.value })}
                    placeholder="页脚文本（如 slogan / 部门名；空 = 不显示）"
                    className="w-full rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  <button
                    onClick={handleSaveBrand}
                    disabled={brandSaving}
                    className="w-full rounded-md border border-border bg-secondary/40 py-1.5 text-xs font-medium hover:bg-secondary transition-colors disabled:opacity-50"
                  >
                    {brandSaving ? '保存中…' : '保存品牌配置'}
                  </button>
                </div>
              </details>
            )}

            {/* 智能审校报告：导出完成后展示（自动修复项 + 需人工确认项） */}
            {auditReport && (
              <div className={`rounded-lg border px-3 py-2 text-xs space-y-1.5 ${auditReport.passed ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
                <div className={`flex items-center gap-1.5 font-semibold ${auditReport.passed ? 'text-emerald-400' : 'text-amber-300'}`}>
                  <ShieldCheck className="w-3.5 h-3.5" />
                  {auditReport.summary}
                </div>
                {auditReport.issues.length > 0 && (
                  <ul className="space-y-0.5 max-h-28 overflow-y-auto">
                    {auditReport.issues.map((iss, i) => (
                      <li key={i} className={`text-[10px] leading-relaxed ${iss.level === 'fixed' ? 'text-emerald-400/80' : 'text-amber-300/90'}`}>
                        {iss.level === 'fixed' ? '🔧' : '⚠️'} {iss.slide > 0 ? `第${iss.slide}页 ` : ''}{iss.message}
                      </li>
                    ))}
                  </ul>
                )}
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
              流程：输入主题/材料 → AI 生成大纲 → AI 原创设计视觉方案 → 导出 PPTX。「一键 AI 生成」会全自动完成并直接产出原始可编辑文件。
            </div>
          </>
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
          {!outline ? (
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
                {outline.slides.map((s, i) => {
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
                          background: i === 0 || i === outline.slides.length - 1
                            ? `linear-gradient(135deg, ${themes.find((t) => t.id === selectedThemeId)?.colors.primary || '#1e3a8a'} 0%, ${themes.find((t) => t.id === selectedThemeId)?.colors.secondary || '#7c3aed'} 100%)`
                            : themes.find((t) => t.id === selectedThemeId)?.colors.background || '#f8fafc',
                        }}
                      >
                        <div
                          className="absolute top-1 left-1 text-[9px] font-semibold px-1.5 py-0.5 rounded"
                          style={{
                            color: i === 0 || i === outline.slides.length - 1 ? 'rgba(255,255,255,0.95)' : themes.find((t) => t.id === selectedThemeId)?.colors.primary || '#1e3a8a',
                            background: i === 0 || i === outline.slides.length - 1 ? 'rgba(255,255,255,0.18)' : `${themes.find((t) => t.id === selectedThemeId)?.colors.accent || '#06b6d4'}22`,
                          }}
                        >
                          {i + 1}
                        </div>
                        <div
                          className="absolute left-1.5 right-1.5 bottom-1.5 text-[10px] font-semibold truncate"
                          style={{
                            color: i === 0 || i === outline.slides.length - 1 ? '#fff' : themes.find((t) => t.id === selectedThemeId)?.colors.primary || '#1e3a8a',
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
                      <div className="flex items-center gap-1.5">
                        <input
                          value={slide.title}
                          onChange={(e) => updateSlideTitle(idx, e.target.value)}
                          placeholder={`第 ${idx + 1} 页标题`}
                          className="flex-1 min-w-0 bg-transparent text-sm font-semibold outline-none border-none placeholder:text-muted-foreground/50"
                        />
                        {slide.chart && (
                          <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-cyan-500/15 text-cyan-400" title={`${slide.chart.type} 图表：${slide.chart.labels.join(' / ')}`}>
                            📊 {slide.chart.type}
                          </span>
                        )}
                      </div>
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