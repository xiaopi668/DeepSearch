import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** 当前目录即 web/，构建产物输出到仓库根目录的 dist/web。 */
const webRoot = import.meta.dirname;

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 浏览器只访问同源 /api/*，开发时由 Vite 代理到后端。
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: false,
  },
});
