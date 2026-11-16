/**
 * T05738：server 构建的 skills 同步。
 * dist/skills 在 Windows 上可能因杀毒/文件句柄出现 ENOTEMPTY，原内联 rmSync 会直接中断构建。
 * 这里把清理降级为 best-effort，失败后仍用 cpSync(force) 覆盖写入，保证 build 可完成。
 */
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src', 'skills');
const dst = path.join(__dirname, '..', 'dist', 'skills');

try {
  fs.rmSync(dst, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
} catch (e) {
  console.warn(`[WARN] dist/skills cleanup failed (${e.code || e.message}); continuing with overwrite`);
}

fs.cpSync(src, dst, { recursive: true, force: true });
console.log('[OK] skills synced');
