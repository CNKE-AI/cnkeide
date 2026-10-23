import { app } from 'electron';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BUILTIN_PROMPT_SKILLS } from './builtins';
import { PackageSkillDefinition, SkillView } from './types';

interface SkillRegistryOptions {
  resourcesPath?: string;
  appPath?: string;
  cwd?: string;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  version?: string;
}

/**
 * 聚合内置提示词技能和本地技能包。P0 只扫描候选 skills 目录的直接子目录，
 * 绝不执行技能脚本、不安装依赖，也不扫描用户工作区。
 */
export class SkillRegistry {
  private readonly resourcesPath: string;
  private readonly appPath: string;
  private readonly cwd: string;
  private packageSkills: PackageSkillDefinition[] = [];

  constructor(options: SkillRegistryOptions = {}) {
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath;
    this.appPath = options.appPath ?? app.getAppPath();
    this.cwd = options.cwd ?? process.cwd();
  }

  async scan(): Promise<PackageSkillDefinition[]> {
    const seenRoots = new Set<string>();
    const skills: PackageSkillDefinition[] = [];

    for (const root of this.getCandidateSkillRoots()) {
      const normalizedRoot = path.resolve(root);
      if (seenRoots.has(normalizedRoot) || !existsSync(normalizedRoot)) continue;
      seenRoots.add(normalizedRoot);

      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(normalizedRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const rootPath = path.join(normalizedRoot, entry.name);
        const entryPath = path.join(rootPath, 'SKILL.md');
        if (!existsSync(entryPath)) continue;
        skills.push(await this.readPackageSkill(rootPath, entryPath, entry.name));
      }
    }

    const byId = new Map<string, PackageSkillDefinition>();
    for (const skill of skills) {
      const existing = byId.get(skill.id);
      // 资源目录优先于开发目录；相同 id 只保留第一个候选。
      if (!existing) byId.set(skill.id, skill);
    }
    this.packageSkills = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return this.packageSkills;
  }

  list(enabledIds: unknown): SkillView[] {
    const enabled = new Set(Array.isArray(enabledIds) ? enabledIds.filter((id): id is string => typeof id === 'string') : []);
    return [...BUILTIN_PROMPT_SKILLS, ...this.packageSkills].map((skill) => {
      const view: Record<string, unknown> = { ...skill };
      delete view.systemPrompt;
      return { ...view, id: skill.id, enabled: enabled.has(skill.id) } as SkillView;
    });
  }

  getEnabledPrompt(enabledIds: unknown): string {
    const enabled = new Set(Array.isArray(enabledIds) ? enabledIds : []);
    const prompts = BUILTIN_PROMPT_SKILLS
      .filter((skill) => enabled.has(skill.id))
      .map((skill) => `### 技能：${skill.name}\n${skill.systemPrompt}`);
    return prompts.length ? `\n\n[已启用提示词技能]\n${prompts.join('\n\n')}` : '';
  }

  getEnabledPackageGuidance(enabledIds: unknown): string {
    const enabled = new Set(Array.isArray(enabledIds) ? enabledIds : []);
    const skills = this.packageSkills.filter((skill) => skill.available && enabled.has(skill.id));
    if (!skills.length) return '';
    return `\n\n[已启用本地技能包]\n${skills.map((skill) =>
      `- ${skill.name}${skill.version ? ` v${skill.version}` : ''}：${skill.description}\n  入口：${skill.entryPath}\n  使用时先按需读取入口文件和相关工作流；不要自动执行包内脚本或安装依赖。`,
    ).join('\n')}`;
  }

  private getCandidateSkillRoots(): string[] {
    return [
      this.resourcesPath && path.join(this.resourcesPath, 'skills'),
      this.appPath && path.join(this.appPath, 'skills'),
      this.appPath && path.join(this.appPath, '..', 'skills'),
      this.appPath && path.join(this.appPath, '..', '..', 'skills'),
      this.cwd && path.join(this.cwd, 'skills'),
    ].filter((candidate): candidate is string => Boolean(candidate));
  }

  private async readPackageSkill(rootPath: string, entryPath: string, fallbackId: string): Promise<PackageSkillDefinition> {
    try {
      const raw = await fs.readFile(entryPath, 'utf8');
      const metadata = this.parseFrontmatter(raw);
      const id = this.normalizeId(metadata.name || fallbackId);
      return {
        id,
        name: metadata.name || fallbackId,
        description: metadata.description || '本地技能包',
        kind: 'package',
        source: this.isBundledPath(rootPath) ? 'bundled' : 'local',
        version: metadata.version,
        rootPath: path.resolve(rootPath),
        entryPath: path.resolve(entryPath),
        available: true,
      };
    } catch (error: unknown) {
      const message = error instanceof Error && error.message ? error.message : '无法读取 SKILL.md';
      return {
        id: this.normalizeId(fallbackId),
        name: fallbackId,
        description: '本地技能包',
        kind: 'package',
        source: this.isBundledPath(rootPath) ? 'bundled' : 'local',
        rootPath: path.resolve(rootPath),
        entryPath: path.resolve(entryPath),
        available: false,
        error: message,
      };
    }
  }

  private parseFrontmatter(raw: string): ParsedFrontmatter {
    const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return {};
    const lines = match[1].split(/\r?\n/);
    const output: ParsedFrontmatter = {};
    let descriptionLines: string[] | null = null;

    for (const line of lines) {
      // 主流 SKILL.md 将版本放在 metadata: 下；只读取白名单字段，不解析任意 YAML。
      const nestedVersion = line.match(/^\s{2,}version:\s*(.*)$/);
      if (nestedVersion) {
        output.version = this.unquote(nestedVersion[1]);
        continue;
      }

      const field = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (field) {
        if (descriptionLines && field[1] !== 'description') {
          output.description = descriptionLines.join(' ').replace(/\s+/g, ' ').trim();
          descriptionLines = null;
        }
        const [, key, value] = field;
        if (key === 'name') output.name = this.unquote(value);
        if (key === 'version') output.version = this.unquote(value);
        if (key === 'description') {
          if (value === '>' || value === '|') descriptionLines = [];
          else output.description = this.unquote(value);
        }
        continue;
      }
      if (descriptionLines && /^\s+/.test(line)) descriptionLines.push(line.trim());
    }
    if (descriptionLines) output.description = descriptionLines.join(' ').replace(/\s+/g, ' ').trim();
    return output;
  }

  private isBundledPath(rootPath: string): boolean {
    return this.resourcesPath ? path.resolve(rootPath).startsWith(path.resolve(this.resourcesPath) + path.sep) : false;
  }

  private normalizeId(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'local-skill';
  }

  private unquote(value: string): string {
    return value.trim().replace(/^(?:"(.*)"|'(.*)')$/, (_all, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted ?? '');
  }
}
