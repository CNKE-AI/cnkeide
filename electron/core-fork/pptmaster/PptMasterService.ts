/**
 * PptMasterService — PPT Master 全流程编排服务
 *
 * 把 PPT Master 的 markdown 工作流 + Python 工具链变成 CnkeIDE 可一键调用的编排流程。
 *
 * 关键设计（对齐 SKILL.md 硬规则）：
 *   1. 页面作者化交给 LLM（Executor 角色）——每页输出完整 SVG 到 svg_output/
 *   2. SVG→原生 PPTX 交给 Python 工具链——产出可编辑的原生对象
 *   3. 质量门禁强制：early（P05 后）+ final（全页后）
 *   4. Step 7 严格串行：total_md_split → finalize_svg → svg_to_pptx
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { SkillRunner } from './SkillRunner';
import { checkDependencies, DependencyStatus } from './PythonRuntime';
import { LLMProvider } from '../llm/LLMProvider';

export type PptMasterStage =
  | 'idle' | 'checking' | 'converting' | 'init' | 'planning' | 'authoring'
  | 'early-gate' | 'final-gate' | 'postprocess' | 'exporting' | 'done' | 'error';

export interface PptMasterProgress {
  stage: PptMasterStage;
  message: string;
  current?: number;
  total?: number;
  percent?: number;
  log?: string;
}

export interface PptMasterOptions {
  projectName: string;
  topic: string;
  sources?: string[];
  slideCount?: number;
  canvasFormat?: string;
  deliveryContext?: string;
  styleHint?: string;
  speakerNotes?: boolean;
  animations?: boolean;
  savePath?: string;
}

export interface PptMasterResult {
  success: boolean;
  projectPath?: string;
  pptxPath?: string;
  reportPath?: string;
  pageCount?: number;
  qualityGate?: string;
  warnings?: string[];
  error?: string;
  timings?: Record<string, number>;
}

export type PptMasterEventHandler = (p: PptMasterProgress) => void;

/** 页面作者化并发上限 */
const AUTHORING_CONCURRENCY = 2;
/** 单页 LLM 超时 */
const PAGE_LLM_TIMEOUT_MS = 5 * 60 * 1000;

interface PlanPage {
  no: number;
  role: string;
  title: string;
  points: string[];
}

/** 规划阶段产出的配色板（HEX） */
interface PlanColors {
  bg?: string;
  primary?: string;
  secondary?: string;
  accent?: string;
  text?: string;
  textMuted?: string;
  surface?: string;
}

/** 规划阶段产出的字体与字号 */
interface PlanTypography {
  fontFamily?: string;
  titleFamily?: string;
  bodyFamily?: string;
  titleSize?: number;
  bodySize?: number;
}

interface PlanResult {
  success: boolean;
  error?: string;
  pages?: PlanPage[];
  designSpec?: string;
  specLock?: string;
  colors?: PlanColors;
  typography?: PlanTypography;
  canvas?: { w: number; h: number; viewBox: string };
  outlineText?: string;
}

/**
 * Executor 系统提示词：把 executor-base.md 契约压缩成可执行指令，
 * 保证每页 SVG 满足 svg_to_pptx.py 的转换要求。
 */
export const EXECUTOR_SYSTEM_PROMPT = `你是 PPT Master 的 Executor（页面绘制角色）。你的唯一输出是**一个完整合法的 SVG 文档**，直接用于 PowerPoint 原生导出。

## 输出硬规则
1. 只输出 SVG 源码，从 \`<svg\` 开始，到 \`</svg>\` 结束。不要 markdown 代码块围栏，不要任何解释文字。
2. 根元素必须带正确的 viewBox，尺寸与给定画布严格一致。
3. 所有文字用 <text> 元素，必须显式指定 font-family、font-size、fill。禁止用 tspan 做自动换行——每行文字是独立 <text>。
4. 颜色只能用调色板给定的 HEX 值，不要引入新颜色。
5. 每个可见元素都必须是真实几何（rect/circle/path/text/image）。禁止 CSS 类、<style> 块、外部 CSS、<foreignObject>。
6. 不要画超出 viewBox 的内容，文字尤其注意宽度不能溢出画布。
7. 装饰性图形用简单几何，<g> 嵌套不超过 3 层。`;

class PptMasterService {
  private runner: SkillRunner;
  private llm: LLMProvider;
  private projectsRoot: string;
  private emit: PptMasterEventHandler;
  /** 注入的 ConfigAdapter（读 activeApiConfigId 等持久化配置） */
  private config: any = null;

  constructor(opts: {
    runner: SkillRunner;
    projectsRoot: string;
    onEvent?: PptMasterEventHandler;
    /** 可选：ConfigAdapter 实例，用于解析当前模型 API */
    config?: any;
  }) {
    this.runner = opts.runner;
    this.projectsRoot = opts.projectsRoot;
    this.llm = new LLMProvider();
    this.emit = opts.onEvent ?? (() => {});
    this.config = opts.config ?? null;
  }

  /** 环境自检 */
  async checkEnvironment(): Promise<{
    ok: boolean;
    python: { path: string; version: string | null; source: string } | null;
    skillOk: boolean;
    missingSkill: string[];
    dependencies: DependencyStatus[];
    blockers: string[];
  }> {
    this.emit({ stage: 'checking', message: '检查 Python 环境与技能包完整性…' });
    const skillCheck = this.runner.validate();
    const py = await this.runner.ensurePython();

    if (!py) {
      return {
        ok: false, python: null, skillOk: skillCheck.ok,
        missingSkill: skillCheck.missing, dependencies: [],
        blockers: ['未找到 Python 3.9+ 解释器'],
      };
    }

    const deps = await checkDependencies(py.path);
    const blockers: string[] = [];
    if (!skillCheck.ok) blockers.push(`技能包缺失文件: ${skillCheck.missing.join(', ')}`);
    const missingRequired = deps.filter((d) => d.required && !d.installed);
    if (missingRequired.length) {
      blockers.push(`缺少必需依赖: ${missingRequired.map((d) => d.name).join(', ')}`);
    }

    this.emit({
      stage: 'checking',
      message: blockers.length ? `环境未通过：${blockers[0]}` : '环境就绪',
    });

    return {
      ok: blockers.length === 0,
      python: { path: py.path, version: py.version, source: py.source },
      skillOk: skillCheck.ok, missingSkill: skillCheck.missing,
      dependencies: deps, blockers,
    };
  }

  /**
   * 主流程：从需求到原生 PPTX。严格对齐 generate-pptx.md 的 Step 1–7。
   */
  async generate(opts: PptMasterOptions): Promise<PptMasterResult> {
    const timings: Record<string, number> = {};
    const mark = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        timings[name] = Date.now() - t0;
      }
    };

    try {
      // ── Step 0: 环境门禁 ──
      const env = await mark('env', () => this.checkEnvironment());
      if (!env.ok) {
        this.emit({ stage: 'error', message: `环境未就绪：${env.blockers.join('；')}` });
        return { success: false, error: env.blockers.join('；'), timings };
      }

      // ── Step 1: 源文档转换 ──
      let sourceMdFiles: string[] = [];
      if (opts.sources?.length) {
        this.emit({ stage: 'converting', message: `转换 ${opts.sources.length} 个源文件…`, percent: 5 });
        const conv = await mark('convert', () =>
          this.runner.convertSource(opts.sources!, {
            onOutput: (chunk) => {
              const line = chunk.trim();
              if (line) this.emit({ stage: 'converting', message: line.slice(0, 200), log: line });
            },
          }),
        );
        if (!conv.success) {
          this.emit({ stage: 'error', message: '源文档转换失败' });
          return { success: false, error: `源文档转换失败: ${conv.stderr.slice(-1500)}`, timings };
        }
        sourceMdFiles = opts.sources
          .map((s) => `${s.replace(/\.[^./\\]+$/, '')}.md`)
          .filter((p) => existsSync(p));
      }

      // ── Step 2: 项目初始化 ──
      this.emit({ stage: 'init', message: '创建项目工作区…', percent: 10 });
      await fs.mkdir(this.projectsRoot, { recursive: true });
      const initRes = await mark('init', () =>
        this.runner.initProject(this.projectsRoot, opts.projectName, opts.canvasFormat),
      );
      if (!initRes.success) {
        return { success: false, error: `项目初始化失败: ${initRes.stderr.slice(-1000)}`, timings };
      }
      const projectPath = await this.resolveProjectPath(
        opts.projectName,
        initRes.stdout,
        initRes.stderr,
      );
      if (!projectPath) {
        return { success: false, error: '无法定位新建项目目录', timings };
      }
      this.emit({ stage: 'init', message: `项目已创建: ${projectPath}`, percent: 15 });

      const importInputs = [...new Set([...(opts.sources ?? []), ...sourceMdFiles])];
      if (importInputs.length) {
        await mark('import', () => this.runner.importSources(projectPath, importInputs));
      }

      // ── Step 4: 规划 ──
      this.emit({ stage: 'planning', message: 'AI 正在规划演示结构与视觉规范…', percent: 20 });
      const plan = await mark('planning', () => this.plan(projectPath, opts, sourceMdFiles));
      if (!plan.success) {
        return { success: false, projectPath, error: plan.error, timings };
      }

      const val = await this.runner.validateProject(projectPath);
      if (!val.success) {
        this.emit({ stage: 'error', message: `项目校验失败\n${val.stderr.slice(-800)}` });
        return {
          success: false, projectPath,
          error: `项目校验失败: ${val.stderr.slice(-800)}`, timings,
        };
      }

      // ── Step 6: 逐页绘制 SVG ──
      this.emit({
        stage: 'authoring', message: `开始绘制 ${plan.pages!.length} 页…`,
        current: 0, total: plan.pages!.length, percent: 30,
      });
      const authored = await mark('authoring', () => this.authorPages(projectPath, plan, opts));
      if (!authored.success) {
        return { success: false, projectPath, error: authored.error, timings };
      }

      // ── 终检门禁 ──
      this.emit({ stage: 'final-gate', message: '执行质量检查…', percent: 70 });
      const gate = await mark('gate', () => this.runner.checkQualityFinal(projectPath));
      const gateReport = await this.readJsonSafe(
        path.join(projectPath, 'validation', 'svg_quality_report.json'),
      );
      const blocking: any[] = gateReport?.categories?.blocking?.issues ?? [];
      if (blocking.length) {
        const detail = this.formatIssues(blocking);
        this.emit({ stage: 'error', message: `质量门禁发现 ${blocking.length} 个阻塞问题:\n${detail}` });
        return {
          success: false, projectPath,
          error: `质量检查未通过（${blocking.length} 个阻塞问题）：\n${detail}`, timings,
        };
      }
      if (!gate.success && !existsSync(path.join(projectPath, 'validation', 'svg_quality_report.json'))) {
        return {
          success: false, projectPath,
          error: `质量检查执行失败: ${gate.stderr.slice(-800)}`, timings,
        };
      }

      // ── Step 7: 严格串行后处理与导出 ──
      if (opts.speakerNotes !== false) {
        this.emit({ stage: 'postprocess', message: '拆分讲者备注…', percent: 75 });
        await mark('notes', () => this.runner.splitNotes(projectPath));
      }

      this.emit({ stage: 'postprocess', message: '生成 SVG 预览…', percent: 80 });
      const fin = await mark('finalize', () =>
        this.runner.finalizeSvg(projectPath, (chunk) => {
          const line = chunk.trim();
          if (line) this.emit({ stage: 'postprocess', message: line.slice(0, 160), log: line, percent: 82 });
        }),
      );
      if (!fin.success) {
        this.emit({ stage: 'error', message: 'SVG 后处理失败' });
        return { success: false, projectPath, error: `finalize_svg 失败: ${fin.stderr.slice(-1000)}`, timings };
      }

      this.emit({ stage: 'exporting', message: '导出原生 PPTX…', percent: 88 });
      const exp = await mark('export', () =>
        this.runner.exportPptx(projectPath, {
          speakerNotes: opts.speakerNotes !== false,
          noAnimations: opts.animations === false,
          onOutput: (chunk) => {
            const line = chunk.trim();
            if (line) this.emit({ stage: 'exporting', message: line.slice(0, 160), log: line, percent: 90 });
          },
        }),
      );
      if (!exp.success) {
        this.emit({ stage: 'error', message: 'PPTX 导出失败' });
        return { success: false, projectPath, error: `PPTX 导出失败: ${exp.stderr.slice(-1500)}`, timings };
      }

      const pptxPath = await this.latestFile(path.join(projectPath, 'exports'), '.pptx');
      const reportPath = await this.latestFile(path.join(projectPath, 'exports'), '.json');
      if (!pptxPath) {
        return { success: false, projectPath, error: '导出命令成功但未找到 .pptx 产物', timings };
      }

      let finalPath = pptxPath;
      if (opts.savePath && path.resolve(opts.savePath) !== path.resolve(pptxPath)) {
        await fs.mkdir(path.dirname(opts.savePath), { recursive: true });
        await fs.copyFile(pptxPath, opts.savePath);
        finalPath = opts.savePath;
      }

      const report = reportPath ? await this.readJsonSafe(reportPath) : null;
      const warnings: string[] = [];
      if (Array.isArray(report?.postflight?.warnings)) warnings.push(...report.postflight.warnings);

      this.emit({
        stage: 'done', message: `完成：${plan.pages!.length} 页原生 PPTX`,
        percent: 100, current: plan.pages!.length, total: plan.pages!.length,
      });

      return {
        success: true, projectPath, pptxPath: finalPath,
        reportPath: reportPath ?? undefined,
        pageCount: plan.pages!.length,
        qualityGate: report?.postflight?.quality_gate ?? report?.postflight?.status ?? 'passed',
        warnings, timings,
      };
    } catch (err: any) {
      const msg = err?.message || String(err);
      this.emit({ stage: 'error', message: `生成失败: ${msg}` });
      return { success: false, error: msg, timings };
    }
  }

  // ── 规划阶段：单次 LLM 调用产出结构化规范 + 页面清单 ──

  private async plan(
    projectPath: string,
    opts: PptMasterOptions,
    sourceMdFiles: string[],
  ): Promise<PlanResult> {
    let sourceText = '';
    for (const f of sourceMdFiles.slice(0, 5)) {
      try {
        const content = await fs.readFile(f, 'utf-8');
        sourceText += `\n\n--- 源文件: ${path.basename(f)} ---\n${content.slice(0, 20000)}`;
      } catch { /* ignore */ }
    }
    try {
      const srcDir = path.join(projectPath, 'sources');
      if (existsSync(srcDir)) {
        const files = await fs.readdir(srcDir);
        for (const f of files.filter((x) => x.endsWith('.md')).slice(0, 5)) {
          const content = await fs.readFile(path.join(srcDir, f), 'utf-8');
          sourceText += `\n\n--- 导入源: ${f} ---\n${content.slice(0, 20000)}`;
        }
      }
    } catch { /* ignore */ }

    const apiConfig = await this.resolveApiConfig();
    if (!apiConfig) {
      return { success: false, error: '未配置模型 API，无法进行规划。请先在设置中配置。' };
    }

    const n = Math.max(3, Math.min(30, Number(opts.slideCount) || 10));
    const canvasKey = opts.canvasFormat || 'ppt169';
    const canvasSize = canvasKey.includes('43') ? { w: 1024, h: 768 } : { w: 1280, h: 720 };

    const prompt = `你是 PPT Master 的 Strategist（策略规划角色）。为下面的需求产出一份可直接执行的演示规划。

## 需求
主题：${opts.topic}
期望页数：${n}
画布：${canvasKey}（${canvasSize.w}×${canvasSize.h}，viewBox="0 0 ${canvasSize.w} ${canvasSize.h}"）
${opts.deliveryContext ? `交付语境：${opts.deliveryContext}` : ''}
${opts.styleHint ? `风格倾向：${opts.styleHint}` : ''}
${sourceText ? `\n## 源材料\n${sourceText}` : ''}

## 输出要求
严格输出一个 JSON 对象，不要 markdown 围栏，不要解释：

{
  "designSpec": "设计规范说明，200-400字中文。涵盖整体叙事策略、视觉风格定位、信息密度节奏、配色与字体使用意图",
  "audience": "目标受众，20字内",
  "objective": "演示目标，30字内",
  "coreMessage": "核心信息，一句话",
  "visualStyle": "视觉风格英文小写标识，如 editorial / clinical / technical",
  "mode": "叙事模式，见下方枚举",
  "colors": {
    "bg": "#FFFFFF",
    "primary": "#1F2937",
    "secondary": "#4B5563",
    "accent": "#2563EB",
    "text": "#111827",
    "textMuted": "#6B7280",
    "surface": "#F3F4F6"
  },
  "typography": {
    "fontFamily": "微软雅黑",
    "titleFamily": "微软雅黑",
    "bodyFamily": "微软雅黑",
    "titleSize": 48,
    "bodySize": 20
  },
  "pages": [
    { "role": "cover", "title": "页面主标题", "points": ["要点1", "要点2", "要点3"] }
  ]
}

硬约束：
- mode 只能是以下之一（原样输出，不要翻译）：pyramid / narrative / instructional / showcase / briefing / custom
- visualStyle 只能是小写英文标识（如 editorial / clinical / technical），不要写中文
- colors 的 7 个颜色必须全是 6 位大写 HEX（如 #1F2937），禁止 rgba / 颜色名 / 简写
- 配色必须有明确对比层次：bg 与 text 对比度足够；accent 用于强调，全局只用一种强调色
- typography 的字体名必须是 PowerPoint 常见字体（微软雅黑 / 黑体 / 思源黑体 / 苹方 / Arial / Calibri / Georgia）
- titleSize / bodySize 必须是纯数字（不带 px），titleSize 在 36-54，bodySize 在 16-24
- pages 必须恰好 ${n} 个元素，第一页 role 是 cover，最后一页 role 是 ending
- 中间页 role 从 content / content-2col / section / quote / data / timeline / comparison 中选择，避免全部雷同
- 每页 points 数量 2-5 条，每条不超过 40 字，内容要具体，禁止"此处填写内容"这类占位`;

    this.emit({
      stage: 'planning',
      message: `调用模型规划 ${n} 页结构…`,
      percent: 22,
    });

    try {
      const resp = await this.llm.chat({
        apiConfig,
        messages: [
          { role: 'system', content: '你是资深的演示文稿结构设计与视觉规范专家。只输出 JSON。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.6,
        timeout: { totalTimeoutMs: 5 * 60 * 1000 },
      });

      let text = (resp.content || '').trim();
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence) text = fence[1].trim();
      const s = text.indexOf('{');
      const e = text.lastIndexOf('}');
      if (s >= 0 && e > s) text = text.slice(s, e + 1);

      const parsed = JSON.parse(text);
      const pages: PlanPage[] = (parsed.pages || []).map((p: any, i: number, arr: any[]) => ({
        no: i + 1,
        role: String(p.role || (i === 0 ? 'cover' : i === arr.length - 1 ? 'ending' : 'content')),
        title: String(p.title || `第 ${i + 1} 页`),
        points: Array.isArray(p.points) ? p.points.map(String) : [],
      }));

      if (!pages.length) {
        return { success: false, error: '规划阶段未返回页面清单' };
      }

      const designSpec = String(parsed.designSpec || '');
      const canvas = { w: canvasSize.w, h: canvasSize.h, viewBox: `0 0 ${canvasSize.w} ${canvasSize.h}` };
      const outlineText = pages
        .map((p) => `P${String(p.no).padStart(2, '0')} [${p.role}] ${p.title}${p.points.length ? ' — ' + p.points.join(' / ') : ''}`)
        .join('\n');

      // 视觉规范落盘：必须写成质量检查器要求的 spec_lock.md 契约，
      // 而不是自由文本——否则终检会以「Master export requires spec_lock.md
      // typography title and body rows」等结构化错误阻塞导出。
      const colors = parsed.colors || {};
      const typography = parsed.typography || {};
      const specLock = this.buildSpecLock({
        canvas,
        canvasKey,
        colors,
        typography,
        audience: parsed.audience || opts.deliveryContext || '',
        objective: parsed.objective || opts.topic,
        coreMessage: parsed.coreMessage || opts.topic,
        visualStyle: parsed.visualStyle || opts.styleHint || 'editorial',
        mode: String(parsed.mode || 'briefing'),
        pageRhythm: pages.map((p) => p.role),
      });

      // 用脚本官方脚手架生成骨架，再整体替换为填好值的版本，
      // 保证 schema 注释头（ppt-master-schema）与章节顺序与官方一致。
      const lockScaffold = await this.runner.scaffoldLock(projectPath);
      if (!lockScaffold.success && !existsSync(path.join(projectPath, 'spec_lock.md'))) {
        this.emit({
          stage: 'planning',
          message: `spec_lock 脚手架生成失败，将直接写入: ${lockScaffold.stderr.slice(-200)}`,
        });
      }
      await fs.writeFile(path.join(projectPath, 'spec_lock.md'), specLock, 'utf-8');

      const specMd = this.buildDesignSpec({
        designSpec,
        colors,
        typography,
        canvas,
        canvasKey,
        pages,
        projectName: opts.projectName,
        audience: String(parsed.audience || opts.deliveryContext || '通用受众'),
        objective: String(parsed.objective || opts.topic),
        coreMessage: String(parsed.coreMessage || opts.topic),
        visualStyle: String(parsed.visualStyle || opts.styleHint || 'editorial'),
        mode: String(parsed.mode || 'briefing'),
        theme: parsed.theme ? String(parsed.theme) : undefined,
        tone: parsed.tone ? String(parsed.tone) : undefined,
        composition: parsed.composition ? String(parsed.composition) : undefined,
        margin: canvasSize.w >= 1280 ? 80 : 64,
        speakerNotes: opts.speakerNotes !== false,
        animations: opts.animations !== false,
      });
      const specScaffold = await this.runner.scaffoldSpec(projectPath);
      if (!specScaffold.success && !existsSync(path.join(projectPath, 'design_spec.md'))) {
        this.emit({
          stage: 'planning',
          message: `design_spec 脚手架生成失败，将直接写入: ${specScaffold.stderr.slice(-200)}`,
        });
      }
      await fs.writeFile(path.join(projectPath, 'design_spec.md'), specMd, 'utf-8');

      const analysisDir = path.join(projectPath, 'analysis');
      await fs.mkdir(analysisDir, { recursive: true });
      await fs.writeFile(
        path.join(analysisDir, 'pptmaster_plan.json'),
        JSON.stringify({ designSpec, specLock, colors, typography, canvas, pages }, null, 2),
        'utf-8',
      );

      this.emit({ stage: 'planning', message: `规划完成：${pages.length} 页`, percent: 28 });
      return { success: true, pages, designSpec, specLock, colors, typography, canvas, outlineText };
    } catch (err: any) {
      return { success: false, error: `规划阶段失败: ${err?.message || String(err)}` };
    }
  }

  // ── 逐页绘制：并发受控，前 5 页串行建立视觉基线 ──

  private async authorPages(
    projectPath: string,
    plan: PlanResult,
    _opts: PptMasterOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const pages = plan.pages!;
    const canvas = plan.canvas!;
    const outDir = path.join(projectPath, 'svg_output');
    await fs.mkdir(outDir, { recursive: true });

    const apiConfig = await this.resolveApiConfig();
    if (!apiConfig) return { success: false, error: '未配置模型 API' };

    const EARLY = Math.min(5, pages.length);
    let completed = 0;
    let lastDigest = '';
    const failures: Array<{ no: number; error: string }> = [];

    // 已落盘的执行锁即为唯一事实来源：作者页看到的规范必须与门禁校验的完全一致，
    // 因此直接从 spec_lock.md 读取，而不是依赖内存里的规划结果。
    let lockedSpec = plan.specLock || '';
    try {
      const onDisk = await fs.readFile(path.join(projectPath, 'spec_lock.md'), 'utf-8');
      if (onDisk.trim()) lockedSpec = onDisk;
    } catch {
      /* 文件缺失时回退到内存中的规划结果 */
    }

    const gen = async (page: PlanPage): Promise<void> => {
      const fileName = `${String(page.no).padStart(2, '0')}_${page.role}.svg`;
      const filePath = path.join(outDir, fileName);

      // 幂等：支持断点续跑
      if (existsSync(filePath)) {
        const st = await fs.stat(filePath);
        if (st.size > 500) {
          completed++;
          this.emit({
            stage: 'authoring', message: `P${String(page.no).padStart(2, '0')} 已存在，跳过`,
            current: completed, total: pages.length,
            percent: 30 + Math.round((completed / pages.length) * 35),
          });
          return;
        }
      }

      const prompt = this.buildPagePrompt({
        designSpec: plan.designSpec || '',
        specLock: lockedSpec,
        pageNo: page.no, total: pages.length,
        pageRole: page.role, pageTitle: page.title, pagePoints: page.points,
        outline: plan.outlineText || '', canvas,
        prevPageDigest: lastDigest || undefined,
      });

      try {
        const resp = await this.llm.chat({
          apiConfig,
          messages: [
            { role: 'system', content: EXECUTOR_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          temperature: 0.4,
          timeout: { totalTimeoutMs: PAGE_LLM_TIMEOUT_MS },
        });

        const svg = this.extractSvg(resp.content || '');
        if (!svg) throw new Error('LLM 未返回有效 SVG');

        const fixed = this.normalizeSvgRoot(svg, canvas);
        await fs.writeFile(filePath, fixed, 'utf-8');

        completed++;
        lastDigest = `P${String(page.no).padStart(2, '0')} ${page.title}：${page.points.slice(0, 3).join('；')}`;
        this.emit({
          stage: 'authoring', message: `P${String(page.no).padStart(2, '0')} ${page.title} 完成`,
          current: completed, total: pages.length,
          percent: 30 + Math.round((completed / pages.length) * 35),
        });
      } catch (err: any) {
        failures.push({ no: page.no, error: err?.message || String(err) });
        completed++;
        this.emit({
          stage: 'authoring',
          message: `P${String(page.no).padStart(2, '0')} 失败: ${err?.message || String(err)}`,
          current: completed, total: pages.length,
          percent: 30 + Math.round((completed / pages.length) * 35),
        });
      }
    };

    // 阶段一：前 5 页串行，稳定视觉基线
    for (const p of pages.slice(0, EARLY)) {
      await gen(p);
    }

    // 阶段二：早期质量门禁（对齐 SKILL.md：>6 页时在第 6 页之前执行）
    if (pages.length > 6) {
      this.emit({ stage: 'early-gate', message: '执行早期质量门禁（P01–P05）…', percent: 66 });
      const early = await this.runner.checkQualityEarly(projectPath);
      const report = await this.readJsonSafe(
        path.join(projectPath, 'validation', 'svg_quality_early_report.json'),
      );
      const blocking: any[] = report?.categories?.blocking?.issues ?? [];
      if (blocking.length) {
        const detail = this.formatIssues(blocking);
        this.emit({ stage: 'error', message: `早期门禁未通过:\n${detail}` });
        return { success: false, error: `早期质量门禁未通过（${blocking.length} 个阻塞问题）：\n${detail}` };
      }
      if (!early.success && !report) {
        this.emit({
          stage: 'early-gate',
          message: `早期门禁脚本异常（继续执行）: ${early.stderr.slice(-300)}`,
        });
      }
    }

    // 阶段三：并发绘制剩余页面
    for (let i = EARLY; i < pages.length; i += AUTHORING_CONCURRENCY) {
      await Promise.all(pages.slice(i, i + AUTHORING_CONCURRENCY).map((p) => gen(p)));
    }

    if (failures.length) {
      return {
        success: false,
        error: `${failures.length} 页生成失败：${failures.map((f) => `P${f.no}(${f.error})`).join('; ')}`,
      };
    }
    return { success: true };
  }

  // ───────────────────────────── 辅助 ─────────────────────────────

  /** 单页绘制提示词 */
  private buildPagePrompt(ctx: {
    designSpec: string;
    specLock: string;
    pageNo: number;
    total: number;
    pageRole: string;
    pageTitle: string;
    pagePoints: string[];
    outline: string;
    canvas: { w: number; h: number; viewBox: string };
    prevPageDigest?: string;
  }): string {
    return `## 本页任务
第 ${ctx.pageNo} / ${ctx.total} 页 | 页面角色：${ctx.pageRole}
画布：${ctx.canvas.w} × ${ctx.canvas.h}，viewBox="${ctx.canvas.viewBox}"

## 设计规范
${ctx.designSpec}

## 视觉锁（颜色/字体/字号必须严格照用，不得自创）
${ctx.specLock}

## 全篇大纲
${ctx.outline}

## 本页内容
主标题：${ctx.pageTitle}
${ctx.pagePoints.length ? `要点：\n${ctx.pagePoints.map((p) => `- ${p}`).join('\n')}` : ''}
${ctx.prevPageDigest ? `\n## 上一页摘要（保持视觉连续性与节奏）\n${ctx.prevPageDigest}\n` : ''}
现在输出这一页的完整 SVG。`;
  }

  /** 从 LLM 回复中抽取 SVG（容忍代码块围栏与前后杂text） */
  private extractSvg(text: string): string | null {
    let t = text.trim();
    const fence = t.match(/```(?:svg|xml)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const start = t.indexOf('<svg');
    const end = t.lastIndexOf('</svg>');
    if (start < 0 || end < 0) return null;
    return t.slice(start, end + 6);
  }

  /**
   * 纠正 SVG 根元素的 width/height，确保与 viewBox 一致。
   * svg_to_pptx.py 依赖 viewBox 做坐标换算；根属性不一致会导致整页错位或缩放异常。
   */
  private normalizeSvgRoot(svg: string, canvas: { w: number; h: number; viewBox: string }): string {
    const openEnd = svg.indexOf('>');
    if (openEnd < 0) return svg;
    let head = svg.slice(0, openEnd);
    const rest = svg.slice(openEnd);

    // 强制 viewBox
    if (/\bviewBox\s*=/.test(head)) {
      head = head.replace(/\bviewBox\s*=\s*(["'])[^"']*\1/, `viewBox="${canvas.viewBox}"`);
    } else {
      head += ` viewBox="${canvas.viewBox}"`;
    }

    // 统一 width/height 为画布像素（PowerPoint 侧会按 viewBox 换算）
    head = /\bwidth\s*=/.test(head)
      ? head.replace(/\bwidth\s*=\s*(["'])[^"']*\1/, `width="${canvas.w}"`)
      : `${head} width="${canvas.w}"`;
    head = /\bheight\s*=/.test(head)
      ? head.replace(/\bheight\s*=\s*(["'])[^"']*\1/, `height="${canvas.h}"`)
      : `${head} height="${canvas.h}"`;

    return head + rest;
  }

  /** 默认配色板（LLM 未返回时的兜底） */
  private defaultColors(): Required<PlanColors> {
    return {
      bg: '#FFFFFF',
      primary: '#1F2937',
      secondary: '#4B5563',
      accent: '#2563EB',
      text: '#111827',
      textMuted: '#6B7280',
      surface: '#F3F4F6',
    };
  }

  /** 默认字体设定（LLM 未返回时的兜底） */
  private defaultTypography(): Required<PlanTypography> {
    return {
      fontFamily: '微软雅黑',
      titleFamily: '微软雅黑',
      bodyFamily: '微软雅黑',
      titleSize: 48,
      bodySize: 20,
    };
  }

  /** 归一化 HEX 颜色；非法值回退到兜底色 */
  private normHex(v: unknown, fallback: string): string {
    if (typeof v !== 'string') return fallback;
    let s = v.trim().toUpperCase();
    if (/^#[0-9A-F]{3}$/.test(s)) {
      // #ABC → #AABBCC
      s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    }
    return /^#[0-9A-F]{6}$/.test(s) ? s : fallback;
  }

  /** 归一化字号到合理区间 */
  private normSize(v: unknown, fallback: number, min: number, max: number): number {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  /**
   * 生成符合 svg_quality_checker.py 契约的 spec_lock.md。
   *
   * 该文件是硬门禁：pptx_structure 检查会要求 typography 的 title/body 行、
   * colors 的 4 个基础色、canvas 的 viewBox/format 全部存在且非占位符，
   * 任一缺失都会以 blocking 级别阻塞导出。
   */
  private buildSpecLock(ctx: {
    canvas: { w: number; h: number; viewBox: string };
    canvasKey: string;
    colors: any;
    typography: any;
    audience: string;
    objective: string;
    coreMessage: string;
    visualStyle: string;
    /** 叙事模式，必须落在 spec_lock.schema.json 的 mode 枚举内 */
    mode: string;
    pageRhythm: string[];
  }): string {
    const dc = this.defaultColors();
    const dt = this.defaultTypography();
    const c = {
      bg: this.normHex(ctx.colors?.bg, dc.bg),
      primary: this.normHex(ctx.colors?.primary, dc.primary),
      secondary: this.normHex(ctx.colors?.secondary, dc.secondary),
      accent: this.normHex(ctx.colors?.accent, dc.accent),
      text: this.normHex(ctx.colors?.text, dc.text),
      textMuted: this.normHex(ctx.colors?.textMuted, dc.textMuted),
      surface: this.normHex(ctx.colors?.surface, dc.surface),
    };
    const family = String(ctx.typography?.fontFamily || dt.fontFamily).trim();
    const titleFamily = String(ctx.typography?.titleFamily || family).trim();
    const bodyFamily = String(ctx.typography?.bodyFamily || family).trim();
    const titleSize = this.normSize(ctx.typography?.titleSize, dt.titleSize, 36, 54);
    const bodySize = this.normSize(ctx.typography?.bodySize, dt.bodySize, 16, 24);

    const canvasLabel =
      ctx.canvasKey === 'ppt43' ? 'PPT 4:3' : ctx.canvasKey === 'ppt169' ? 'PPT 16:9' : ctx.canvasKey;

    // mode / visual_style 必须落在 schema 枚举内，否则项目校验直接失败。
    const MODE_ENUM = ['pyramid', 'narrative', 'instructional', 'showcase', 'briefing', 'custom'];
    const mode = MODE_ENUM.includes(ctx.mode) ? ctx.mode : 'briefing';

    // page_rhythm 的取值被限制为 anchor|dense|breathing，且键必须形如 P01。
    // 封面/章节页用 anchor（留白重、信息少），内容密集页用 dense，过渡页用 breathing。
    const rhythmLines = ctx.pageRhythm.map((role, i) => {
      const key = `P${String(i + 1).padStart(2, '0')}`;
      const value =
        role === 'cover' || role === 'section' || role === 'ending'
          ? 'anchor'
          : role === 'quote' || role === 'transition'
            ? 'breathing'
            : 'dense';
      return `- ${key}: ${value}`;
    });

    const lines = [
      '<!-- ppt-master-schema: spec-lock/v1 -->',
      '# Execution Lock',
      '',
      '## canvas',
      `- viewBox: ${ctx.canvas.viewBox}`,
      `- format: ${canvasLabel}`,
      '',
      '## communication',
      // ⚠️ 必须是 BCP-47 语言标签。svg_to_pptx.py 会校验此字段，
      // 写成 zh-CN / zh 都会被拒绝，简体中文的正确标签是 zh-Hans。
      '- primary_language: zh-Hans',
      `- audience: ${ctx.audience || '通用受众'}`,
      `- objective: ${ctx.objective || '清晰传达核心信息'}`,
      `- core_message: ${ctx.coreMessage || '未指定'}`,
      '- consumption_mode: presentation',
      '',
      '## mode',
      `- mode: ${mode}`,
      '',
      '## visual_style',
      `- visual_style: ${ctx.visualStyle || 'editorial'}`,
      '',
      '## colors',
      `- bg: ${c.bg}`,
      `- primary: ${c.primary}`,
      `- secondary: ${c.secondary}`,
      `- accent: ${c.accent}`,
      `- text: ${c.text}`,
      `- textMuted: ${c.textMuted}`,
      `- surface: ${c.surface}`,
      '',
      '## typography',
      `- font_family: ${family}`,
      `- title_family: ${titleFamily}`,
      `- body_family: ${bodyFamily}`,
      `- body: ${bodySize}`,
      `- title: ${titleSize}`,
      '',
      '## icons',
      '- library: none',
      '- inventory: none',
      '',
      '## page_rhythm',
      ...rhythmLines,
      '',
      '## pptx_structure',
      '- mode: flat',
      '',
      '## forbidden',
      // ⚠️ 这两行必须与 templates/scaffolds/spec_lock.md 的基线逐字一致。
      // 校验器只放行「基线行」或结尾带 (user) 标记的自定义行，
      // 任何其他行都会触发 "is not a baseline rule and lacks the (user) tag" 阻塞。
      '- `mask`, `<style>`, `class`, external CSS, `<foreignObject>`, `textPath`, `@font-face`, `<animate*>`, `<set>`, `<script>` / event attributes, `<iframe>`',
      '- HTML named entities in text; write typography as raw Unicode and escape XML reserved characters',
      '',
    ];
    return lines.join('\n');
  }

  /** 生成 design_spec.md（叙事与视觉意图说明，供作者页与人工审阅） */
  private buildDesignSpec(ctx: {
    designSpec: string;
    colors: any;
    typography: any;
    canvas: { w: number; h: number; viewBox: string };
    canvasKey: string;
    pages: PlanPage[];
    projectName: string;
    audience: string;
    objective: string;
    coreMessage: string;
    visualStyle: string;
    mode: string;
    theme?: string;
    tone?: string;
    composition?: string;
    margin: number;
    speakerNotes: boolean;
    animations: boolean;
  }): string {
    const dc = this.defaultColors();
    const dt = this.defaultTypography();

    const bg = this.normHex(ctx.colors?.bg, dc.bg);
    const primary = this.normHex(ctx.colors?.primary, dc.primary);
    const accent = this.normHex(ctx.colors?.accent, dc.accent);
    const text = this.normHex(ctx.colors?.text, dc.text);

    const family = String(ctx.typography?.fontFamily || dt.fontFamily).trim();
    const titleFamily = String(ctx.typography?.titleFamily || family).trim();
    const bodyFamily = String(ctx.typography?.bodyFamily || family).trim();
    const titleSize = this.normSize(ctx.typography?.titleSize, dt.titleSize, 36, 54);
    const bodySize = this.normSize(ctx.typography?.bodySize, dt.bodySize, 16, 24);

    return [
      '<!-- ppt-master-schema: design-spec/v1 -->',
      `# ${ctx.projectName} - Design Spec`,
      '',
      '## I. Project Information',
      '',
      '| Item | Value |',
      '| --- | --- |',
      `| Project Name | ${ctx.projectName} |`,
      `| Canvas Format | ${ctx.canvasKey} (${ctx.canvas.w} × ${ctx.canvas.h}) |`,
      `| Page Count | ${ctx.pages.length} |`,
      `| Target Audience | ${ctx.audience || '通用受众'} |`,
      `| Communication Intent | ${ctx.objective || '清晰传达核心信息'} |`,
      `| Core Message / Ask / Action | ${ctx.coreMessage || '未指定'} |`,
      `| Reading Mode | 投屏讲解 |`,
      `| Content Strategy | 按大纲逐页递进，重点页以强调色突出核心结论 |`,
      `| Design Style | ${ctx.visualStyle || 'editorial'} |`,
      `| AI Image Acquisition Path | not applicable |`,
      `| Speaker Notes | ${ctx.speakerNotes ? 'enabled' : 'disabled'} |`,
      `| Custom Animations | ${ctx.animations ? 'enabled' : 'disabled'} |`,
      `| Narration Audio | disabled |`,
      '',
      '## II. Canvas Specification',
      '',
      '| Property | Value |',
      '| --- | --- |',
      `| Format | ${ctx.canvasKey} |`,
      `| Dimensions | ${ctx.canvas.w} × ${ctx.canvas.h} |`,
      `| viewBox | \`${ctx.canvas.viewBox}\` |`,
      `| Margins | 左右 ${ctx.margin}，上下 ${ctx.margin} |`,
      `| Content Area | ${ctx.canvas.w - ctx.margin * 2} × ${ctx.canvas.h - ctx.margin * 2} |`,
      '',
      '## III. Visual Theme',
      '',
      '### Theme Style',
      '',
      `- **Mode**: ${ctx.mode || 'briefing'}`,
      `- **Visual style**: ${ctx.visualStyle || 'editorial'}`,
      `- **Theme**: ${ctx.theme || '现代商务'}`,
      `- **Tone**: ${ctx.tone || '专业、克制、可信'}`,
      '',
      '### Color Scheme',
      '',
      '| Role | HEX | Purpose |',
      '| --- | --- | --- |',
      `| Background | ${bg} | 页面底色 |`,
      `| Primary | ${primary} | 主色，用于标题与主要图形 |`,
      `| Accent | ${accent} | 强调色，用于关键数据与交互点 |`,
      `| Body text | ${text} | 正文文字 |`,
      '',
      '## IV. Typography System',
      '',
      '### Font Plan',
      '',
      '| Role | Character (Reference) | Primary | English if non-English | Fallback tail |',
      '| --- | --- | --- | --- | --- |',
      `| Title | 无衬线 | ${titleFamily} | Arial | sans-serif |`,
      `| Body | 无衬线 | ${bodyFamily} | Arial | sans-serif |`,
      '',
      `- **Title stack**: ${titleFamily}, Arial, sans-serif`,
      `- **Body stack**: ${bodyFamily}, Arial, sans-serif`,
      '',
      '### Font Size Hierarchy',
      '',
      '| Purpose | Size |',
      '| --- | --- |',
      `| Body | ${bodySize} |`,
      `| Page title | ${titleSize} |`,
      `| Subtitle | ${Math.round(titleSize * 0.67)} |`,
      `| Annotation | ${Math.max(12, Math.round(bodySize * 0.75))} |`,
      `| Footnote | ${Math.max(11, Math.round(bodySize * 0.65))} |`,
      '',
      '## V. Layout Principles',
      '',
      '### Deck-wide Direction',
      '',
      `- **Hierarchy direction**: 左上起手，自上而下递减`,
      `- **Composition tendency**: ${ctx.composition || '单栏为主，数据页采用左右分栏'}`,
      `- **Cross-page continuity**: 统一页边距与标题位置，页码固定右下`,
      `- **Spacing posture**: 留白充足，正文行距 1.5 倍`,
      '',
      '## VI. Icon Usage Specification',
      '',
      '| Icon Path | Suitable Scenarios |',
      '| --- | --- |',
      '| none | 本演示不使用图标，全部依赖几何图形与排版层级 |',
      '',
      '## VIII. Image Resource List',
      '',
      '| Filename | Dimensions | Ratio | Purpose | Type | Image pattern | Crop Policy | Acquire Via | Status | Reference | text_policy | page_role |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '',
      '## IX. Content Outline',
      '',
      ...ctx.pages.flatMap((p) => [
        `#### Slide ${String(p.no).padStart(2, '0')} - ${p.title}`,
        '',
        '- **Audience move**: 跟随讲者理解本页要点并接受其结论',
        '- **Composition**: 自上而下：标题 → 要点区 → 结论条',
        `- **Title**: ${p.title}`,
        `- **Core message**: ${p.points[0] || p.title}`,
        `- **Content**: ${p.points.length ? p.points.join('；') : p.title}`,
        '',
      ]),
      '## X. Speaker Notes Requirements',
      '',
      `- **Generation**: ${ctx.speakerNotes ? 'enabled' : 'disabled'}`,
      '- **Filename**: match each SVG filename under `notes/`',
      '- **Content**: 每页 3-5 句讲解口径，包含开场衔接、要点展开与收束过渡',
      '',
    ].join('\n');
  }

  /** 把质量报告中的 issue 列表格式化为可读文本 */
  private formatIssues(issues: any[]): string {
    return issues
      .slice(0, 10)
      .map((i: any) => {
        const file = i.file || i.page || i.path || '';
        const rule = i.rule || i.code || i.category || '';
        const msg = i.message || i.description || JSON.stringify(i);
        return `- ${[file, rule].filter(Boolean).join(' ')}${file || rule ? ': ' : ''}${msg}`.slice(0, 240);
      })
      .join('\n');
  }

  /** 安全读取 JSON 文件 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON.parse 动态结构必须用 any 才能让调用方属性访问通过类型检查
  private async readJsonSafe(p: string): Promise<any> {
    try {
      if (!existsSync(p)) return null;
      return JSON.parse(await fs.readFile(p, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * 定位 project_manager.py init 生成的项目目录。
   * 命名规则为 <name>_<YYYYMMDD>，同一天重复执行会追加序号。
   */
  private async resolveProjectPath(
    projectName: string,
    stdout: string,
    stderr: string,
  ): Promise<string | null> {
    // 优先从脚本输出里解析路径
    const combined = `${stdout}\n${stderr}`;
    const pathMatches = combined.match(/[A-Za-z]:[\\/][^\s"']+|(?:^|\s)(\/[^\s"']+)/gm);
    if (pathMatches) {
      for (const m of pathMatches) {
        const candidate = m.trim().replace(/[.,;:]$/, '');
        if (existsSync(candidate) && existsSync(path.join(candidate, 'svg_output'))) {
          return path.resolve(candidate);
        }
      }
    }

    // 回退：在同名目录中选 mtime 最新且包含 svg_output 的
    try {
      const base = projectName.replace(/[^\w\u4e00-\u9fa5-]/g, '_');
      const entries = await fs.readdir(this.projectsRoot, { withFileTypes: true });
      const candidates = entries
        .filter((e) => e.isDirectory() && e.name.startsWith(base))
        .map((e) => path.join(this.projectsRoot, e.name))
        .filter((p) => existsSync(path.join(p, 'svg_output')));

      if (!candidates.length) return null;

      const withTime = await Promise.all(
        candidates.map(async (p) => ({ p, t: (await fs.stat(p)).mtimeMs })),
      );
      withTime.sort((a, b) => b.t - a.t);
      return path.resolve(withTime[0].p);
    } catch {
      return null;
    }
  }

  /** 取目录下最新的匹配扩展名文件 */
  private async latestFile(dir: string, ext: string): Promise<string | null> {
    try {
      if (!existsSync(dir)) return null;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(ext));
      if (!files.length) return null;
      const withTime = await Promise.all(
        files.map(async (e) => ({
          p: path.join(dir, e.name),
          t: (await fs.stat(path.join(dir, e.name))).mtimeMs,
        })),
      );
      withTime.sort((a, b) => b.t - a.t);
      return withTime[0].p;
    } catch {
      return null;
    }
  }

  /**
   * 解析当前生效的模型 API 配置。
   * 与 AgentManager.resolveApiConfig 保持同一优先级：
   * activeApiConfigId 命中 → 否则兜底到第一个可用配置。
   */
  private resolveApiConfig(): Promise<unknown> {
    try {
      const cfg = this.config;
      if (!cfg) return Promise.resolve(null);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config 接口未导出详细类型，内部按 any 处理
      const configs: any[] = cfg.getApiKeyConfigs?.() ?? cfg.get?.('apiConfigs', []) ?? [];
      if (!configs.length) return Promise.resolve(null);

      const activeId = cfg.get?.('activeApiConfigId');
      const usable =
        configs.find((c: any) => c.id === activeId) ||
        configs.find((c: any) => c?.apiKey && c?.baseUrl) ||
        configs[0];

      // 基本可用性校验：必须有 baseUrl + apiKey + model
      if (!usable?.baseUrl || !usable?.apiKey || !usable?.model) return Promise.resolve(null);
      return Promise.resolve(usable);
    } catch {
      return Promise.resolve(null);
    }
  }
}

export { PptMasterService };
