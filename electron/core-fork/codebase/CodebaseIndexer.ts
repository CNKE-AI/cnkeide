import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * CodebaseIndexer - 代码库语义索引器
 * 为"全自动 AI IDE"提供代码库级理解能力：
 * 1. 符号索引：提取函数/类/方法/接口/类型/常量等定义
 * 2. 符号搜索：按名称查找定义位置
 * 3. 引用查找：定位某个符号被引用的位置
 * 4. 文件大纲：提取单个文件的符号结构
 * 5. 项目结构：生成目录树概览（跳过 node_modules/.git/dist 等）
 *
 * 实现采用轻量词法分析（正则），不依赖重量级 LSP，避免打包体积爆炸。
 */

export interface SymbolDef {
  /** 符号名 */
  name: string;
  /** 符号类型：function/class/method/interface/type/enum/const/let/var/export */
  kind: string;
  /** 文件绝对路径 */
  file: string;
  /** 相对项目根的路径 */
  relativeFile: string;
  /** 定义所在行号（1-based） */
  line: number;
  /** 定义所在列（1-based） */
  column: number;
  /** 所在类/命名空间（方法才有，如 MyClass） */
  parent?: string;
  /** 定义行原文（截断） */
  snippet: string;
  /** 是否 export */
  exported: boolean;
}

export interface Reference {
  file: string;
  relativeFile: string;
  line: number;
  column: number;
  /** 引用行原文（截断） */
  snippet: string;
}

export interface OutlineItem {
  name: string;
  kind: string;
  line: number;
  column: number;
  parent?: string;
  snippet: string;
}

/** 需要跳过的目录/文件 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'dist-electron',
  'out', 'build', 'coverage', '.next', '.nuxt', '.cache', 'vendor',
  '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'target', '.gradle',
  'release_v3', 'release_v4', 'release_v101_updater',
]);

const SKIP_FILES = new Set([
  '.DS_Store', 'Thumbs.db', 'package-lock.json', 'yarn.lock',
  'pnpm-lock.yaml', '*.min.js', '*.map',
]);

/** 参与索引的文件扩展名（代码文件） */
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp',
  '.php', '.rb', '.swift', '.sh', '.bash', '.zsh', '.ps1',
  '.vue', '.svelte', '.html', '.css', '.scss', '.less',
  '.json', '.yml', '.yaml', '.toml', '.md',
]);

export interface IndexOptions {
  /** 项目根目录 */
  rootPath: string;
  /** 最大扫描文件数（防止超大项目卡死） */
  maxFiles?: number;
  /** 最大文件大小（字节），超过跳过 */
  maxFileSize?: number;
}

export interface SymbolSearchResult {
  symbol: SymbolDef;
}

/** 目录树节点：子目录递归 + _files 存放当前目录下的文件名 */
interface TreeNode {
  _files?: string[];
  dirs: Record<string, TreeNode>;
}

/**
 * 符号定义的正则（按语言粗分，覆盖主流语言常见写法）
 */
const SYMBOL_PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  // TypeScript / JavaScript
  { kind: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
  { kind: 'class', regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/ },
  { kind: 'enum', regex: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'const', regex: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]/ },
  { kind: 'let', regex: /^\s*(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*[:=]/ },
  { kind: 'method', regex: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|abstract\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^=]*)?\s*\{/ },
  { kind: 'method', regex: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|abstract\s+)*(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\(/ },
  // Python
  { kind: 'function', regex: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: 'class', regex: /^\s*class\s+([A-Za-z_]\w*)\s*[:(]/ },
  // Go
  { kind: 'function', regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/ },
  { kind: 'type', regex: /^\s*type\s+([A-Za-z_]\w*)\s+/ },
  // Rust
  { kind: 'function', regex: /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/ },
  { kind: 'struct', regex: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/ },
  { kind: 'trait', regex: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/ },
  { kind: 'enum', regex: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/ },
  // Java / Kotlin
  { kind: 'class', regex: /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+)*class\s+([A-Za-z_]\w*)/ },
  { kind: 'interface', regex: /^\s*(?:public\s+|private\s+|protected\s+)*interface\s+([A-Za-z_]\w*)/ },
  { kind: 'method', regex: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|synchronized\s+)*[\w<>[,\s?]+\s+([a-z_]\w*)\s*\([^)]*\)\s*\{/ },
  // C / C++
  { kind: 'function', regex: /^\s*(?:static\s+|inline\s+|extern\s+)*[\w:*<>,\s&]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/ },
  // C#
  { kind: 'class', regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+|abstract\s+|sealed\s+|static\s+)*class\s+([A-Za-z_]\w*)/ },
  { kind: 'method', regex: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+|static\s+|async\s+|override\s+|virtual\s+)*[\w<>[,\s?]+\s+([A-Za-z_]\w*)\s*\([^)]*\)/ },
  // PHP
  { kind: 'function', regex: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: 'class', regex: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/ },
  // Shell
  { kind: 'function', regex: /^\s*([A-Za-z_]\w*)\s*\(\)\s*\{/ },
];

export class CodebaseIndexer {
  private rootPath: string;
  private maxFiles: number;
  private maxFileSize: number;
  /** 符号索引：name -> SymbolDef[] */
  private symbolsByName = new Map<string, SymbolDef[]>();
  /** 已索引文件列表 */
  private indexedFiles: string[] = [];
  /** 索引是否已建立 */
  private indexed = false;

  constructor(options: IndexOptions) {
    this.rootPath = path.resolve(options.rootPath);
    this.maxFiles = options.maxFiles ?? 5000;
    this.maxFileSize = options.maxFileSize ?? 512 * 1024; // 512KB
  }

  get root(): string {
    return this.rootPath;
  }

  /** 更新项目根目录（工作区切换时调用），并重建索引 */
  setRootPath(newRoot: string): void {
    const resolved = path.resolve(newRoot);
    if (resolved === this.rootPath) return;
    this.rootPath = resolved;
    this.symbolsByName.clear();
    this.indexedFiles = [];
    this.indexed = false;
  }

  isIndexed(): boolean {
    return this.indexed;
  }

  getIndexedFileCount(): number {
    return this.indexedFiles.length;
  }

  /**
   * 建立索引：递归扫描项目，提取所有符号。
   * 惰性 + 缓存：只在首次查询时建立，之后复用。
   */
  async ensureIndex(): Promise<void> {
    if (this.indexed) return;
    await this.buildIndex();
  }

  async rebuildIndex(): Promise<void> {
    this.symbolsByName.clear();
    this.indexedFiles = [];
    this.indexed = false;
    await this.buildIndex();
  }

  private async buildIndex(): Promise<void> {
    const files = await this.collectFiles(this.rootPath);
    this.indexedFiles = files;

    for (const file of files) {
      try {
        await this.indexFile(file);
      } catch {
        /* skip unreadable file */
      }
    }
    this.indexed = true;
  }

  private async collectFiles(dir: string): Promise<string[]> {
    const result: string[] = [];
    if (result.length >= this.maxFiles) return result;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return result;
    }

    for (const entry of entries) {
      if (result.length >= this.maxFiles) break;
      const fullPath = path.join(dir, entry.name);
      const name = entry.name;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (name.startsWith('.')) continue;
        const sub = await this.collectFiles(fullPath);
        result.push(...sub);
      } else if (entry.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) continue;
        if (SKIP_FILES.has(name)) continue;
        if (name.endsWith('.min.js') || name.endsWith('.map')) continue;
        // 跳过超大小文件（用 stat 检查）
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > this.maxFileSize) continue;
        } catch {
          continue;
        }
        result.push(fullPath);
      }
    }
    return result;
  }

  private async indexFile(file: string): Promise<void> {
    const content = await fs.readFile(file, 'utf-8');
    const lines = content.split('\n');
    const relativeFile = path.relative(this.rootPath, file).replace(/\\/g, '/');

    // 追踪当前类上下文（用于标记 method 的 parent）
    let braceDepth = 0;
    const classStack: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const line = rawLine.trimEnd();

      // 更新花括号深度与类栈（粗略，忽略字符串/注释中的花括号）
      const openCount = (rawLine.match(/\{/g) || []).length;
      const closeCount = (rawLine.match(/\}/g) || []).length;
      braceDepth += openCount - closeCount;
      if (braceDepth < 0) braceDepth = 0;

      for (const pattern of SYMBOL_PATTERNS) {
        const m = line.match(pattern.regex);
        if (m && m[1]) {
          const name = m[1];
          // 跳过关键字误匹配
          if (RESERVED_WORDS.has(name)) continue;

          let kind = pattern.kind;
          let parent: string | undefined;

          if (kind === 'method') {
            parent = classStack[classStack.length - 1];
            if (!parent) {
              // 顶层函数（不在类内）归为 function
              kind = 'function';
            }
          }

          const sym: SymbolDef = {
            name,
            kind,
            file,
            relativeFile,
            line: i + 1,
            column: (line.indexOf(name) + 1),
            parent,
            snippet: line.trim().slice(0, 160),
            exported: /\bexport\b|^pub\s|^public\s/.test(line),
          };
          this.addSymbol(name, sym);

          // 如果是 class/interface/type/enum/struct 定义，记录类上下文
          if (kind === 'class' || kind === 'interface' || kind === 'struct' || kind === 'trait') {
            classStack.push(name);
          }
          break;
        }
      }

      // 类出栈检测（粗粒度：花括号归零时清空类栈）
      if (braceDepth === 0 && classStack.length > 0) {
        // 不立即清空，保守处理：仅当遇到闭合大括号行才可能出栈
      }
    }
  }

  private addSymbol(name: string, sym: SymbolDef): void {
    const list = this.symbolsByName.get(name);
    if (list) {
      // 避免同一位置重复（同一行可能被多个 pattern 命中，已用 break 防止）
      if (list.length < 50) list.push(sym);
    } else {
      this.symbolsByName.set(name, [sym]);
    }
  }

  /** 按名称搜索符号定义 */
  async searchSymbol(name: string, limit = 30): Promise<SymbolDef[]> {
    await this.ensureIndex();
    const exact = this.symbolsByName.get(name);
    if (exact && exact.length > 0) return exact.slice(0, limit);

    // 模糊匹配：名称包含查询串（忽略大小写）
    const lower = name.toLowerCase();
    const results: SymbolDef[] = [];
    for (const [key, syms] of this.symbolsByName) {
      if (key.toLowerCase().includes(lower)) {
        results.push(...syms);
        if (results.length >= limit) break;
      }
    }
    return results.slice(0, limit);
  }

  /** 查找符号的引用位置（在已索引文件中 grep 该符号名） */
  async findReferences(name: string, limit = 50): Promise<Reference[]> {
    await this.ensureIndex();
    const results: Reference[] = [];
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'g');

    for (const file of this.indexedFiles) {
      if (results.length >= limit) break;
      try {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < limit; i++) {
          const line = lines[i];
          regex.lastIndex = 0;
          const m = regex.exec(line);
          if (m) {
            results.push({
              file,
              relativeFile: path.relative(this.rootPath, file).replace(/\\/g, '/'),
              line: i + 1,
              column: m.index + 1,
              snippet: line.trim().slice(0, 160),
            });
          }
        }
      } catch {
        /* skip */
      }
    }
    return results;
  }

  /** 提取单个文件的符号大纲 */
  async getFileOutline(file: string): Promise<OutlineItem[]> {
    const content = await fs.readFile(file, 'utf-8');
    const lines = content.split('\n');
    const items: OutlineItem[] = [];
    let currentClass = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      for (const pattern of SYMBOL_PATTERNS) {
        const m = line.match(pattern.regex);
        if (m && m[1] && !RESERVED_WORDS.has(m[1])) {
          let kind = pattern.kind;
          let parent: string | undefined;
          if (kind === 'method') {
            parent = currentClass || undefined;
            if (!parent) kind = 'function';
          }
          items.push({
            name: m[1],
            kind,
            line: i + 1,
            column: line.indexOf(m[1]) + 1,
            parent,
            snippet: line.slice(0, 160),
          });
          if (kind === 'class' || kind === 'interface' || kind === 'struct' || kind === 'trait') {
            currentClass = m[1];
          }
          break;
        }
      }
    }
    return items;
  }

  /** 生成项目目录树概览（限定深度，跳过忽略目录） */
  async getProjectStructure(maxDepth = 3): Promise<string> {
    await this.ensureIndex();
    // 基于已索引文件重建目录树
    const tree: TreeNode = { dirs: {} };

    for (const file of this.indexedFiles) {
      const rel = path.relative(this.rootPath, file).replace(/\\/g, '/');
      const parts = rel.split('/');
      let node = tree;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isFile = i === parts.length - 1;
        if (isFile) {
          if (!node._files) node._files = [];
          node._files.push(part);
        } else {
          if (!node.dirs[part]) node.dirs[part] = { dirs: {} };
          node = node.dirs[part];
        }
      }
    }

    const lines: string[] = [];
    const render = (node: TreeNode, prefix: string, depth: number, name: string) => {
      if (depth > maxDepth) return;
      lines.push(prefix + name + (node._files ? '/' : ''));
      const childDirs = Object.keys(node.dirs).sort();
      const files = (node._files || []).sort();
      // 目录在前，文件在后
      for (const dir of childDirs) {
        render(node.dirs[dir], prefix + '  ', depth + 1, dir);
      }
      if (depth < maxDepth) {
        const shown = files.slice(0, 20);
        for (const f of shown) {
          lines.push(prefix + '  ' + f);
        }
        if (files.length > 20) lines.push(prefix + '  ...（另有 ' + (files.length - 20) + ' 个文件）');
      }
    };

    render(tree, '', 0, path.basename(this.rootPath));
    return lines.join('\n');
  }
}

/** 关键字/保留字，避免误识别为符号名 */
const RESERVED_WORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break',
  'continue', 'return', 'throw', 'try', 'catch', 'finally', 'new', 'delete',
  'typeof', 'instanceof', 'in', 'of', 'this', 'super', 'class', 'function',
  'const', 'let', 'var', 'async', 'await', 'yield', 'import', 'export',
  'from', 'extends', 'implements', 'interface', 'type', 'enum', 'public',
  'private', 'protected', 'static', 'readonly', 'abstract', 'void', 'null',
  'undefined', 'true', 'false', 'nan', 'nil', 'none', 'get', 'set', 'def',
  'fn', 'struct', 'trait', 'impl', 'mod', 'use', 'mut', 'pub', 'where',
]);
