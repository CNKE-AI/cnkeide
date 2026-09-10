import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'renderer'),
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'renderer/index.html'),
        ppt: resolve(__dirname, 'renderer/ppt.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'renderer/src'),
    },
  },
  plugins: [
    react(),
    electron([
      {
        entry: '../electron/main.ts',
        onstart(args) {
          // 由插件统一启动/重启 Electron（设置 VITE_DEV_SERVER_URL 环境变量）
          args.startup();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron', /^@modelcontextprotocol\/sdk/],
            },
          },
        },
      },
      {
        entry: '../electron/preload.ts',
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
});
