import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, 'src/renderer')

export default defineConfig({
  root,
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@': resolve(root),
    },
  },
  /*
   * 目标环境跟随 Electron 内置 Chromium（38 版是 Chromium 140），
   * 而不是 Vite 默认给浏览器兜底的 es2020 —— 那个限制会挡掉 TLA、
   * 顶层 await 等现代语法，而打包产物只跑在 Electron 里。
   */
  build: {
    target: 'chrome140',
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
      },
    },
  },
  server: {
    port: 5199,
    strictPort: true,
    fs: {
      /* 验证台要动态 import 仓库根的 scripts/make-test-glb.js，它在 root 之外 */
      allow: [resolve(import.meta.dirname)],
    },
  },
})
