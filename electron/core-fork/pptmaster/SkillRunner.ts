/**
 * SkillRunner — PPT Master 技能执行引擎
 *
 * 职责：
 *   1. 定位 skill 包根目录（packaged / dev 两态）
 *   2. 按 SKILL.md 的工作流契约，以正确的参数调用 Python 脚本
 *   3. 提供项目管理、源转换、SVG 校验、PPTX 导出等类型化封装
 *   4. 统一 stdout/stderr 流式回传、超时、错误归一化
 *
 * 设计原则：脚本调用集中在此，上层（IPC / Agent 工具）只调类型化方法，
 * 不自己拼命令行。对齐 SKILL.md 的「Strict serial commands」硬规则。
 */

import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { resolvePython, PythonInfo, clearPythonCache } from './PythonRuntime';

export interface SkillRunResult {
  success: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** 超时被终止 */
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** 注入环境变量（PPT_MASTER_* 等） */
  env?: Record<string, string>;
}

/**
 * PPT Master skill 执行器。
 * 一个实例绑定一个 skill 根目录与一个 Python 解释器。
 */
export class SkillRunner {
  private skillRoot: string;
  private python: PythonInfo | null = null;
  private resourcesPath: string | null;
  private configuredPythonPath: string | null;
  /** 每次 python 调用前自动注入的 env */
  private baseEnv: Record<string, string>;

  constructor(opts: {
    /** skill 根目录，即包含 SKILL.md 与 scripts/ 的目录 */
    skillRoot: string;
    /** Electron resources 目录（用于发现内置 python） */
    resourcesPath?: string | null;
    /** 用户配置的 python 路径 */
    configuredPythonPath?: string | null;
    baseEnv?: Record<string, string>;
  }) {
    this.skillRoot = opts.skillRoot;
    this.resourcesPath = opts.resourcesPath ?? null;
    this.configuredPythonPath = opts.configuredPythonPath ?? null;
    this.baseEnv = opts.baseEnv ?? {};
  }

  /** skill 包根目录 */
  getSkillRoot(): string {
    return this.skillRoot;
  }

  /** scripts 目录 */
  getScriptsDir(): string {
    return path.join(this.skillRoot, 'scripts');
  }

  /** 校验 skill 包完整性 */
  validate(): { ok: boolean; missing: string[] } {
    const required = [
      'SKILL.md',
      'scripts/project_manager.py',
      'scripts/svg_to_pptx.py',
      'scripts/finalize_svg.py',
      'scripts/source_to_md.py',
      'references',
    ];
    const missing = required.filter((r) => !existsSync(path.join(this.skillRoot, r)));
    return { ok: missing.length === 0, missing };
  }

  /** 解析/刷新 Python 解释器 */
  async ensurePython(force = false): Promise<PythonInfo | null> {
    if (force) clearPythonCache();
    this.python = await resolvePython({
      configuredPath: this.configuredPythonPath,
      resourcesPath: this.resourcesPath,
      skillRoot: this.skillRoot,
      force,
    });
    return this.python;
  }

  getPython(): PythonInfo | null {
    return this.python;
  }

  /** 更新用户配置的 python 路径（设置页保存后调用） */
  setConfiguredPythonPath(p: string | null): void {
    this.configuredPythonPath = p;
    this.python = null;
    clearPythonCache();
  }

  /**
   * 底层执行：spawn python，流式回传输出。
   * 脚本路径相对于 scripts/ 解析；也可传绝对路径的 .py。
   */
  async runScript(script: string, args: string[], opts: RunOptions = {}): Promise<SkillRunResult> {
    if (!this.python) await this.ensurePython();
    if (!this.python) {
      return {
        success: false,
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 0,
        error: '未找到可用的 Python 3.9+ 解释器。请在设置中指定 Python 路径，或安装内置运行时。',
      };
    }

    const scriptPath = path.isAbsolute(script) ? script : path.join(this.getScriptsDir(), script);
    if (!existsSync(scriptPath)) {
      return {
        success: false,
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 0,
        error: `脚本不存在: ${scriptPath}`,
      };
    }

    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    const started = Date.now();

    // PPT Master 的脚本以裸模块名互相导入（如 `from console_encoding import ...`），
    // 因此必须把 scripts/ 放进 PYTHONPATH。内置的 embeddable Python 会忽略
    // PYTHONPATH（除非 ._pth 含 import site），故同时把脚本目录自身作为 cwd 传给
    // sys.path[0] 兜底，双保险保证任何解释器下都能解析同级模块。
    const scriptsDir = this.getScriptsDir();
    const existingPyPath = process.env.PYTHONPATH;
    const pyPath = existingPyPath ? `${scriptsDir}${path.delimiter}${existingPyPath}` : scriptsDir;

    return new Promise<SkillRunResult>((resolve) => {
      const child = spawn(this.python!.path, [scriptPath, ...args], {
        cwd: opts.cwd ?? this.skillRoot,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          PYTHONPATH: pyPath,
          ...this.baseEnv,
          ...(opts.env ?? {}),
        } as NodeJS.ProcessEnv,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, timeoutMs);

      const finish = (code: number | null, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          success: code === 0 && !timedOut,
          code,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - started,
          error: timedOut ? `执行超时（${Math.round(timeoutMs / 1000)}s）` : error,
        });
      };

      child.stdout?.on('data', (b: Buffer) => {
        const s = b.toString('utf8');
        stdout += s;
        opts.onOutput?.(s, 'stdout');
      });
      child.stderr?.on('data', (b: Buffer) => {
        const s = b.toString('utf8');
        stderr += s;
        opts.onOutput?.(s, 'stderr');
      });
      child.on('error', (e: Error) => finish(null, e.message));
      child.on('close', (code: number | null) => finish(code));
    });
  }

  // ───────────────────────────── 类型化封装 ─────────────────────────────

  /**
   * 解析 SKILL.md 与工作流文档，供注入 LLM 上下文。
   * 只读必要文档，避免塞满上下文。
   */
  async readSkillDoc(relative: string): Promise<string> {
    const p = path.join(this.skillRoot, relative);
    if (!existsSync(p)) return '';
    return fs.readFile(p, 'utf-8');
  }

  /** 读取 SKILL.md 主入口 */
  async readSkillMd(): Promise<string> {
    return this.readSkillDoc('SKILL.md');
  }

  /** 读取指定工作流文档 */
  async readWorkflow(name: string): Promise<string> {
    return this.readSkillDoc(path.join('workflows', name.endsWith('.md') ? name : `${name}.md`));
  }

  /** 读取 references 下的参考文档 */
  async readReference(name: string): Promise<string> {
    return this.readSkillDoc(path.join('references', name.endsWith('.md') ? name : `${name}.md`));
  }

  /** 列出 workflows 目录（供 LLM/UI 选择路由） */
  async listWorkflows(): Promise<string[]> {
    return this.listMarkdown(path.join(this.skillRoot, 'workflows'));
  }

  /** 列出 references 目录 */
  async listReferences(): Promise<string[]> {
    return this.listMarkdown(path.join(this.skillRoot, 'references'));
  }

  private async listMarkdown(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.md')) out.push(e.name);
        else if (e.isDirectory() && !e.name.startsWith('.')) {
          const sub = await this.listMarkdown(path.join(dir, e.name));
          out.push(...sub.map((s) => `${e.name}/${s}`));
        }
      }
      return out.sort();
    } catch {
      return [];
    }
  }

  // ── 项目生命周期（对齐 generate-pptx.md Step 1–2） ──

  /** 初始化项目：project_manager.py init <project_name> */
  async initProject(
    projectsRoot: string,
    projectName: string,
    format?: string,
    onOutput?: RunOptions['onOutput'],
  ): Promise<SkillRunResult> {
    const args = ['init', projectName];
    if (format) args.push('--format', format);
    return this.runScript('project_manager.py', args, {
      cwd: projectsRoot,
      onOutput,
      timeoutMs: 2 * 60 * 1000,
    });
  }

  /** 导入源文件：project_manager.py import-sources <project_path> <files...> */
  async importSources(
    projectPath: string,
    sources: string[],
    onOutput?: RunOptions['onOutput'],
  ): Promise<SkillRunResult> {
    return this.runScript('project_manager.py', ['import-sources', projectPath, ...sources], {
      onOutput,
      timeoutMs: 10 * 60 * 1000,
    });
  }

  /** 校验项目：project_manager.py validate <project_path> */
  async validateProject(projectPath: string): Promise<SkillRunResult> {
    return this.runScript('project_manager.py', ['validate', projectPath], { timeoutMs: 3 * 60 * 1000 });
  }

  /**
   * 创建 design_spec.md 脚手架：project_manager.py scaffold-spec <project_path>
   * 返回原始模板；调用方需填入各字段占位符。
   */
  async scaffoldSpec(projectPath: string): Promise<SkillRunResult> {
    return this.runScript('project_manager.py', ['scaffold-spec', projectPath], {
      timeoutMs: 2 * 60 * 1000,
    });
  }

  /**
   * 创建 spec_lock.md 脚手架：project_manager.py scaffold-lock <project_path>
   * 该文件是质量检查器强制要求的执行锁，缺字段会直接判定为阻塞错误。
   */
  async scaffoldLock(projectPath: string): Promise<SkillRunResult> {
    return this.runScript('project_manager.py', ['scaffold-lock', projectPath], {
      timeoutMs: 2 * 60 * 1000,
    });
  }

  /**
   * 读取单页确定性执行视图：project_manager.py page-context <project> <page_no>
   * 用于把当页所需的规范切片喂给 Executor，避免整篇规范超上下文。
   */
  async pageContext(
    projectPath: string,
    pageNo: string,
    opts: { recordUsage?: boolean } = {},
  ): Promise<SkillRunResult> {
    const args = ['page-context', projectPath, pageNo];
    if (opts.recordUsage !== false) args.push('--record-usage');
    return this.runScript('project_manager.py', args, { timeoutMs: 2 * 60 * 1000 });
  }

  // ── 源文档转换（Step 1） ──

  /** source_to_md.py <file_or_url_or_dir> ... [-o outdir] */
  async convertSource(
    inputs: string[],
    opts: { outDir?: string; type?: string; onOutput?: RunOptions['onOutput'] } = {},
  ): Promise<SkillRunResult> {
    const args = [...inputs];
    if (opts.type) args.push('-t', opts.type);
    if (opts.outDir) args.push('-o', opts.outDir);
    return this.runScript('source_to_md.py', args, { onOutput: opts.onOutput, timeoutMs: 10 * 60 * 1000 });
  }

  // ── 质量门禁与导出（Step 6–7） ──

  /** 早期门禁：svg_quality_checker.py <project> --canonical-authoring --stage early --json */
  async checkQualityEarly(projectPath: string): Promise<SkillRunResult> {
    return this.runScript(
      'svg_quality_checker.py',
      [projectPath, '--canonical-authoring', '--stage', 'early', '--json'],
      { timeoutMs: 5 * 60 * 1000 },
    );
  }

  /** 终检门禁：svg_quality_checker.py <project> --canonical-authoring --stage final --json */
  async checkQualityFinal(projectPath: string): Promise<SkillRunResult> {
    return this.runScript(
      'svg_quality_checker.py',
      [projectPath, '--canonical-authoring', '--stage', 'final', '--json'],
      { timeoutMs: 5 * 60 * 1000 },
    );
  }

  /** 校验模板工作区：--template-mode --canonical-authoring */
  async checkTemplate(workspace: string, canvasFormat?: string): Promise<SkillRunResult> {
    const args = [path.join(workspace, 'templates'), '--template-mode', '--canonical-authoring'];
    if (canvasFormat) args.push('--format', canvasFormat);
    return this.runScript('svg_quality_checker.py', args, { timeoutMs: 5 * 60 * 1000 });
  }

  /** 拆分讲者备注：total_md_split.py <project> */
  async splitNotes(projectPath: string): Promise<SkillRunResult> {
    return this.runScript('total_md_split.py', [projectPath], { timeoutMs: 5 * 60 * 1000 });
  }

  /** 生成自包含 SVG 预览：finalize_svg.py <project> */
  async finalizeSvg(projectPath: string, onOutput?: RunOptions['onOutput']): Promise<SkillRunResult> {
    return this.runScript('finalize_svg.py', [projectPath], {
      onOutput,
      timeoutMs: 15 * 60 * 1000,
    });
  }

  /**
   * 导出原生 PPTX：svg_to_pptx.py <project> [flags]
   * 对应 Step 7.3 的决策表。
   */
  async exportPptx(
    projectPath: string,
    opts: {
      speakerNotes?: boolean;
      nativeChartsAndTables?: boolean;
      noAnimations?: boolean;
      animationMode?: string;
      imageSizing?: string;
      imageScale?: number;
      imageQuality?: number;
      conversionTrace?: string;
      onOutput?: RunOptions['onOutput'];
    } = {},
  ): Promise<SkillRunResult> {
    const args = [projectPath];
    // 讲者备注关闭时必须传 --no-notes，防止陈旧 notes/ 被嵌入
    if (opts.speakerNotes === false) args.push('--no-notes');
    if (opts.nativeChartsAndTables) args.push('--native-charts-and-tables');
    if (opts.noAnimations) args.push('--no-animations');
    if (opts.animationMode) args.push('-a', opts.animationMode);
    if (opts.imageSizing) args.push('--image-sizing', opts.imageSizing);
    if (typeof opts.imageScale === 'number') args.push('--image-scale', String(opts.imageScale));
    if (typeof opts.imageQuality === 'number') args.push('--image-quality', String(opts.imageQuality));
    if (opts.conversionTrace) args.push('--conversion-trace', opts.conversionTrace);

    return this.runScript('svg_to_pptx.py', args, {
      onOutput: opts.onOutput,
      timeoutMs: 20 * 60 * 1000,
    });
  }

  // ── 模板导入（Create Template 路线） ──

  /** pptx_template_import.py <template.pptx> [flags] */
  async importTemplate(
    pptxPath: string,
    opts: { manifestOnly?: boolean; inheritanceMode?: string; onOutput?: RunOptions['onOutput'] } = {},
  ): Promise<SkillRunResult> {
    const args = [pptxPath];
    if (opts.manifestOnly) args.push('--manifest-only');
    if (opts.inheritanceMode) args.push('--inheritance-mode', opts.inheritanceMode);
    return this.runScript('pptx_template_import.py', args, {
      onOutput: opts.onOutput,
      timeoutMs: 15 * 60 * 1000,
    });
  }

  /** 模板注册：register_template.py <id> --kind <kind> [--dry-run] */
  async registerTemplate(
    templateId: string,
    kind: 'brand' | 'style' | 'layout' | 'deck',
    dryRun = false,
    libraryRoot?: string,
  ): Promise<SkillRunResult> {
    const args = [templateId, '--kind', kind];
    if (dryRun) args.push('--dry-run');
    return this.runScript('register_template.py', args, {
      cwd: libraryRoot,
      timeoutMs: 2 * 60 * 1000,
    });
  }

  /** 列出内置预设形状：preset_shape_svg.py list --search <q> */
  async listPresetShapes(search?: string): Promise<SkillRunResult> {
    const args = ['list'];
    if (search) args.push('--search', search);
    return this.runScript('preset_shape_svg.py', args, { timeoutMs: 60 * 1000 });
  }

  /** 从参考 PPTX 重建 SVG（pptx_to_svg.py <deck.pptx> -o <dir>） */
  async pptxToSvg(
    pptxPath: string,
    outDir: string,
    onOutput?: RunOptions['onOutput'],
  ): Promise<SkillRunResult> {
    return this.runScript('pptx_to_svg.py', [pptxPath, '-o', outDir], {
      onOutput,
      timeoutMs: 15 * 60 * 1000,
    });
  }

  /** 模板预览 PPTX：template_preview_pptx.py <template_workspace> */
  async templatePreview(workspace: string, force = false): Promise<SkillRunResult> {
    const args = [workspace];
    if (force) args.push('--force');
    return this.runScript('template_preview_pptx.py', args, { timeoutMs: 10 * 60 * 1000 });
  }

  /** 文字度量校准：text_measure.py calibrate <project> --outline */
  async calibrateText(projectPath: string): Promise<SkillRunResult> {
    return this.runScript('text_measure.py', ['calibrate', projectPath, '--outline'], {
      timeoutMs: 3 * 60 * 1000,
    });
  }
}

/**
 * 从任意入口定位 skill 根目录。
 * packaged: <resources>/skills/ppt-master
 * dev:      <repoRoot>/skills/ppt-master
 */
export function locateSkillRoot(opts: {
  /** app.isPackaged */
  isPackaged: boolean;
  /** app.getAppPath() */
  appPath: string;
  /** process.resourcesPath */
  resourcesPath: string;
  /** __dirname 等，用于向上回溯 */
  searchFrom?: string[];
}): string | null {
  const candidates: string[] = [];

  if (opts.resourcesPath) {
    candidates.push(path.join(opts.resourcesPath, 'skills', 'ppt-master'));
  }
  // appPath 可能是 out/main 或项目根
  candidates.push(path.join(opts.appPath, 'skills', 'ppt-master'));
  candidates.push(path.join(opts.appPath, '..', 'skills', 'ppt-master'));
  candidates.push(path.join(opts.appPath, '..', '..', 'skills', 'ppt-master'));
  candidates.push(path.join(process.cwd(), 'skills', 'ppt-master'));

  for (const from of opts.searchFrom ?? []) {
    let dir = from;
    for (let i = 0; i < 6; i++) {
      candidates.push(path.join(dir, 'skills', 'ppt-master'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  for (const c of candidates) {
    if (existsSync(path.join(c, 'SKILL.md'))) return path.resolve(c);
  }
  return null;
}
