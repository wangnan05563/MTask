import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // 相对路径引用资源：Electron 打包版以 file:// 加载 web/dist，
  // 绝对路径 /assets/... 会解析到磁盘根目录导致白板
  base: './',
  plugins: [react()],
  build: {
    // 默认清空输出目录；沙箱 safe-delete 回收站不可用时清空会超时，
    // 设 MTASK_NO_EMPTY=1 跳过清空（仅写新文件），便于受限环境出包
    emptyOutDir: process.env.MTASK_NO_EMPTY ? false : true,
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    // 端口被占用时直接报错，避免静默切换端口导致启动脚本打开错误页面
    strictPort: true,
    proxy: {
      // 开发期将 API 代理到本地后端（生产由 Electron 内嵌服务承载）
      '/api': 'http://127.0.0.1:39876',
    },
  },
});
