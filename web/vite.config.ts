import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// node_modules 实体集中在 %NODE_MODULES_HOME%（项目内只留 junction），不再依赖 E:\mtask-build-cache：
// Vite 默认以 process.cwd() 为 root，但 HTML 入口会被解析成真实路径；
// 若目录本身仍链到别的盘符，两者不同盘时 vite:build-html 会把入口 fileName 算成绝对路径并报错。
// 统一 root 到 realpath，正常目录下与 process.cwd() 等价，junction 下则对齐到目标盘。
const projectRoot = realpathSync(process.cwd());

// T06321 L-4：帮助页版本号不再硬编码，构建时从仓库根 package.json 注入；
// MTASK_APP_VERSION 可覆盖（打包脚本/CI 可在不改文件的前提下注入实际安装包版本）。
function resolveAppVersion(): string {
  const fromEnv = (process.env.MTASK_APP_VERSION ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, '..', 'package.json'), 'utf8')) as { version?: string };
    return String(pkg.version ?? '').trim();
  } catch {
    return '';
  }
}
const appVersion = resolveAppVersion();

export default defineConfig({
  root: projectRoot,
  // 相对路径引用资源：Electron 打包版以 file:// 加载 web/dist，
  // 绝对路径 /assets/... 会解析到磁盘根目录导致白板
  base: './',
  plugins: [react()],
  define: {
    __MTASK_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    // 默认清空输出目录；沙箱 safe-delete 回收站不可用时清空会超时，
    // 设 MTASK_NO_EMPTY=1 跳过清空（仅写新文件），便于受限环境出包
    emptyOutDir: process.env.MTASK_NO_EMPTY ? false : true,
    // T06317：把首屏必用的 React 与按需才用到的大依赖拆成独立 chunk。
    // 主包不再把 graph/markdown/icons 全塞进同一个 2.8MB 文件；浏览器可并行下载，
    // 二次启动直接命中缓存，React 基座变更频率也低于业务包。
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'vendor-react';
          if (id.includes('/graphology') || id.includes('/sigma/')) return 'vendor-graph';
          if (id.includes('/markdown-it/') || id.includes('/linkify-it/') || id.includes('/mdurl/') || id.includes('/uc.micro/')) return 'vendor-markdown';
          if (id.includes('/lucide-react/')) return 'vendor-icons';
          return undefined;
        },
      },
    },
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
