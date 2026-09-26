/**
 * 临时脚本：将 build/social-preview.svg 渲染为 1280×640 PNG 导出为 build/social-preview.png。
 * 复刻 make-icon.js 的 Electron 无头渲染方式，保证 SVG 矢量不失真。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const W = 1280;
const H = 640;
const BUILD_DIR = path.join(__dirname, '..', 'build');
const SVG_FILE = path.join(BUILD_DIR, 'social-preview.svg');
const OUT = path.join(BUILD_DIR, 'social-preview.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  });
  const svg = fs.readFileSync(SVG_FILE, 'utf-8');
  // 禁止缩放偏离设计尺寸，避免 capturePage 倍数差异产生模糊
  const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:#1e40af}svg{display:block;width:${W}px;height:${H}px}</style></head><body>${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 400));
  const shot = await win.webContents.capturePage();
  // deviceScaleFactor 可能放大截图，统一按目标尺寸缩放
  const img = shot.resize({ width: W, height: H, quality: 'best' });
  fs.writeFileSync(OUT, img.toPNG());
  console.log(`[social-preview] written ${OUT} (${W}x${H})`);
  app.quit();
});

app.on('window-all-closed', () => app.quit());