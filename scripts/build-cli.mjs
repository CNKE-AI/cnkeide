#!/usr/bin/env node
/**
 * 打包 headless CLI 为单文件（CommonJS）。
 *
 * 产物：dist-cli/cnkeide.cjs
 * 注意：不能输出到 dist/——那是 vite 的 renderer 构建目录（emptyOutDir），
 * 每次 npm run build 都会清空它，CLI 产物会被删掉。
 * 特点：
 *   - 不打包 electron / playwright（前者是 GUI 运行时，后者按需动态加载）
 *   - core-fork 内核与 adapter 一并内联，产物可在纯 Node 18+ 运行
 *   - __CLI_VERSION__ 用 package.json 的 version 替换
 */
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

mkdirSync(path.join(root, 'dist-cli'), { recursive: true });

const outFile = path.join(root, 'dist-cli/cnkeide.cjs');

const result = await esbuild.build({
  entryPoints: [path.join(root, 'cli/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: outFile,
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
  external: ['electron', 'playwright', 'playwright-core'],
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  metafile: true,
});

// esbuild 的 banner 在 CJS 下会被插到产物中间（shebang 落到第 2 行导致语法错误），
// 因此构建后手动前置 shebang 并赋可执行权限。
{
  let code = readFileSync(outFile, 'utf8');
  code = code.replace(/^#!.*\r?\n/, '');
  writeFileSync(outFile, `#!/usr/bin/env node\n${code}`, 'utf8');
  try {
    chmodSync(outFile, 0o755);
  } catch {
    /* Windows 下 chmod 语义有限，忽略 */
  }
}

const outputs = Object.entries(result.metafile.outputs);
for (const [file, info] of outputs) {
  console.log(`[build:cli] ${path.relative(root, path.resolve(root, file))}  ${(info.bytes / 1024).toFixed(1)} KB`);
}
console.log(`[build:cli] version ${pkg.version}`);
