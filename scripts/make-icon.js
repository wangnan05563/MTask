/**
 * 图标生成脚本（由 Electron 主进程执行）：
 *   node_modules\electron\dist\electron.exe scripts\make-icon.js
 * 流程：隐藏窗口渲染 build/icon.svg → capturePage 得 512px PNG
 *       → nativeImage 缩放出多尺寸 → 组装 build/icon.ico（PNG 压缩条目）
 *       → 另存 build/icon.png 供桌面壳窗口图标使用。
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const BUILD_DIR = path.join(__dirname, '..', 'build');
const SVG_FILE = path.join(BUILD_DIR, 'icon.svg');
const BASE = 512;
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** 组装 ICO：ICONDIR + N 个 ICONDIRENTRY + 各尺寸 PNG 数据（Vista+ 支持 PNG 条目） */
function buildIco(pngs) {
  const count = pngs.length;
  const headerSize = 6 + count * 16;
  let offset = headerSize;
  const entries = [];
  for (const { size, data } of pngs) {
    entries.push({ size, data, offset });
    offset += data.length;
  }
  const out = Buffer.alloc(offset);
  out.writeUInt16LE(0, 0);      // reserved
  out.writeUInt16LE(1, 2);      // type: 1 = icon
  out.writeUInt16LE(count, 4);
  let p = 6;
  for (const e of entries) {
    out.writeUInt8(e.size >= 256 ? 0 : e.size, p);     // width（0 表示 256）
    out.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1); // height
    out.writeUInt8(0, p + 2);   // colors
    out.writeUInt8(0, p + 3);   // reserved
    out.writeUInt16LE(1, p + 4);  // planes
    out.writeUInt16LE(32, p + 6); // bpp
    out.writeUInt32LE(e.data.length, p + 8);
    out.writeUInt32LE(e.offset, p + 12);
    p += 16;
  }
  for (const e of entries) e.data.copy(out, e.offset);
  return out;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: BASE,
    height: BASE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  // 内联 SVG 到 HTML：去掉默认 body 边距，透明背景，确保图标贴边渲染
  const svg = fs.readFileSync(SVG_FILE, 'utf-8');
  const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // SVG 矢量渲染，等待一帧稳定后截图
  await new Promise((r) => setTimeout(r, 300));
  const shot = await win.webContents.capturePage();
  const baseImage = shot.resize({ width: BASE, height: BASE, quality: 'best' });

  // 高清 PNG：桌面壳窗口/任务栏图标（另存一份到 electron/ 随应用打包）
  const pngBuf = baseImage.toPNG();
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), pngBuf);
  fs.writeFileSync(path.join(__dirname, '..', 'electron', 'icon.png'), pngBuf);

  // 多尺寸 ICO
  const pngs = SIZES.map((size) => ({
    size,
    data: baseImage.resize({ width: size, height: size, quality: 'best' }).toPNG(),
  }));
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), buildIco(pngs));

  console.log(`[make-icon] icon.png (${BASE}px) 与 icon.ico (${SIZES.join('/')}px) 已生成到 build/`);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
