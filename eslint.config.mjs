import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

// 参与类型感知检查的源码范围（分别由 electron/tsconfig.json 与 renderer/tsconfig.json 覆盖）
const TYPED_FILES = ['electron/**/*.ts', 'renderer/src/**/*.{ts,tsx}'];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '**/dist/**',
      '**/dist-electron/**',
      'release/**',
      'runtime/**',
      'skills/**',
      '_archive/**',
      '.tmp_*/**',
      'coverage/**',
      '**/*.min.js'
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // 严格模式：主进程与渲染层源码启用类型感知规则
  {
    files: TYPED_FILES,
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir },
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      // 本仓库大量 any 为外部动态数据（JSON/MCP/LLM 载荷），其 unsafe 传播暂列为告警，
      // 不阻塞 CI，后续渐进收敛为具体类型。
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Promise reject(err) 在 catch 块中原封传递是常见模式，不阻塞 CI
      '@typescript-eslint/prefer-promise-reject-errors': 'warn',
      // 本仓库仍存在大量 JSON.parse / 外部 API 返回值导致的 any，暂时不阻塞 CI
      '@typescript-eslint/no-explicit-any': 'warn',
      // 事件回调接 async 函数 / 顶层 Promise 未加 void，属于代码风格问题，暂不阻塞 CI
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      // 未使用变量（catch e / 解构 / import）加 _ 前缀即可，暂不阻塞 CI
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }]
    }
  },

  // 渲染层追加 React Hooks 规则
  {
    files: ['renderer/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error'
    }
  },

  // 构建脚本 / 配置文件不做类型感知检查
  {
    files: [
      'scripts/**/*.{mjs,cjs,js}',
      '**/*.config.{mjs,cjs,js}',
      '*.mjs', '*.cjs', '*.js', '*.ts',
      'electron/**/*.{mjs,cjs,js}'
    ],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      // CommonJS 文件天然用 require，合理豁免
      '@typescript-eslint/no-require-imports': 'off',
      // 测试脚本里未使用的变量多为脚手架/调试残留，豁免
      '@typescript-eslint/no-unused-vars': 'off'
    }
  },

  // TS 源文件里的函数内 require（SafeSpawn/WorkspaceWatcher 条件动态加载）
  {
    files: [
      'electron/core-fork/util/SafeSpawn.ts',
      'electron/adapter/WorkspaceWatcher.ts'
    ],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off'
    }
  },

  // 浏览器模拟测试脚本（Playwright evaluate 回调里用 document/window）
  {
    files: ['scripts/test_w16_render_check.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    }
  }
);
