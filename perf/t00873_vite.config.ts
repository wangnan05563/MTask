import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// T00873 隔离实测用的临时 vite 配置：把 /api 代理到隔离后端(39576)，避免污染生产库
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:39576' },
  },
});