/**
 * T02071 验证：一键更新的「下载中途取消」与「安装失败回执/重试」。
 *
 * 覆盖策略（与工单口径一致）：真机安装/真实更高版本发布属真机验收项，本仓跑不了；
 * 但两块的**决策内核**（Range 续传判定、待回执标记与下次启动对账、安装退出码→回执）是纯函数，
 * 这里逐条断言，并额外用本地 HTTP 服务器跑一次**真实 Range 协议**，证明「取消后继续」拼出来的
 * 字节与原包逐字节一致；主进程/预加载/界面的接线以静态断言钉住（改错即 FAIL）。
 *
 * 用法：node scripts/verify-t02071-update-flow.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const U = require(path.join(ROOT, 'electron', 'update-state.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? ` :: ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`); }
};

// ---------- 版本号比较（对账判定用） ----------
ok('U-01 cmpVersion 4 段逐段比大小', U.cmpVersion('0.1.1011.194', '0.1.1011.94') === 1
  && U.cmpVersion('0.1.1011.94', '0.1.1011.194') === -1
  && U.cmpVersion('0.1.1011.194', '0.1.1011.194') === 0);
ok('U-02 缺位补 0 / 非法段按 0，不因段数不同误判', U.cmpVersion('0.1.1011', '0.1.1011.0') === 0
  && U.cmpVersion('0.1.1011.194', '0.1.1011') === 1
  && U.cmpVersion('garbage', '') === 0);

// ---------- 续传判定 ----------
const CR = (start, end, total) => ({ 'content-range': `bytes ${start}-${end}/${total}` });
ok('U-03 206 且 Content-Range 起点==本地已有字节 → 追加续传', (() => {
  const p = U.resumePlan({ partBytes: 1024, statusCode: 206, headers: { ...CR(1024, 4095, 4096), 'content-length': String(4096 - 1024) } });
  return p.append === true && p.startBytes === 1024 && p.totalBytes === 4096;
})());
ok('U-04 200 忽略 Range → 从 0 重下（半截文件不可拼）', (() => {
  const p = U.resumePlan({ partBytes: 1024, statusCode: 200, headers: { 'content-length': '4096' } });
  return p.append === false && p.startBytes === 0 && p.totalBytes === 4096;
})());
ok('U-05 206 但起点错位（服务端/本地不一致）→ 从 0 重下', (() => {
  const p = U.resumePlan({ partBytes: 1024, statusCode: 206, headers: CR(0, 4095, 4096) });
  return p.append === false;
})());
ok('U-06 416 越界 → 从 0 重下', U.resumePlan({ partBytes: 9999, statusCode: 416, headers: {} }).append === false);
ok('U-07 无本地残留时即使 206 也从 0 开始', (() => {
  const p = U.resumePlan({ partBytes: 0, statusCode: 206, headers: CR(0, 4095, 4096) });
  return p.append === false && p.startBytes === 0;
})());
ok('U-08 Content-Range 长度为 * 时用 content-length 补总量', (() => {
  const p = U.resumePlan({ partBytes: 1000, statusCode: 206, headers: { ...CR(1000, 1999, '*'), 'content-length': '1000' } });
  return p.append === true && p.totalBytes === 2000;
})());

// ---------- 待回执标记 + 下次启动对账 ----------
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 't02071-pending-'));
ok('U-09 无标记时对账为 null（平时启动不打扰）', U.reconcilePending(U.readPending(userData), '0.1.1011.194') === null);
U.writePending(userData, { filePath: 'D:/dl/MTask Setup 0.1.1012.001.exe', targetVersion: '0.1.1012.001', currentVersion: '0.1.1011.194' });
ok('U-10 标记落盘并可读回（安装前写入，退出后仍在）', U.readPending(userData)?.targetVersion === '0.1.1012.001'
  && fs.existsSync(U.pendingFile(userData)));
ok('U-11 当前版本已达目标版本 → installed（安装器 taskkill 后唯一可判据）', (() => {
  const r = U.reconcilePending(U.readPending(userData), '0.1.1012.001');
  return r.status === 'installed' && r.targetVersion === '0.1.1012.001';
})());
ok('U-12 当前版本仍是旧的 → failed，携带安装包路径与目标版本供重试', (() => {
  const r = U.reconcilePending(U.readPending(userData), '0.1.1011.194');
  return r.status === 'failed' && r.filePath.includes('MTask Setup') && r.targetVersion === '0.1.1012.001'
    && typeof r.reason === 'string' && r.reason.length > 0;
})());
U.clearPending(userData);
ok('U-13 回执消费即清（不会每次启动重复提示）', U.readPending(userData) === null);
ok('U-14 对账不看安装器日志，只认版本：当前更高也算 installed', (() => {
  return U.reconcilePending({ targetVersion: '0.1.1012.001', filePath: 'x' }, '0.1.1013.002').status === 'installed';
})());

// ---------- 安装进程退出码 → 回执 ----------
ok('U-15 退出码 0 → installed', U.installOutcome({ code: 0, timedOut: false }).status === 'installed');
ok('U-16 非 0 退出码 → failed 且原始码随行带出（界面点明原因）', (() => {
  const o = U.installOutcome({ code: 5, timedOut: false });
  return o.status === 'failed' && o.code === 5 && o.message.includes('退出码 5');
})());
ok('U-17 等待超时不判失败（可能正弹授权确认）→ pending 留待下次对账', U.installOutcome({ code: null, timedOut: true }).status === 'pending');

// ---------- 真实 Range 协议：证明「取消后继续」拼出的字节与原包逐字节一致 ----------
const blob = crypto.randomBytes(300_000);
const blobSha = crypto.createHash('sha256').update(blob).digest('hex');
const srv = http.createServer((req, res) => {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : blob.length - 1;
    res.writeHead(206, {
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${blob.length}`,
    });
    res.end(blob.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { 'content-length': String(blob.length) });
  res.end(blob);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${srv.address().port}/pkg.exe`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't02071-dl-'));
const partPath = path.join(tmpDir, 'pkg.exe.part');

/** 模拟一次「下载/续传」：按主进程同一套判定（Range 请求头 → resumePlan → append/w flag）落盘 */
async function oneRound(partBytes, cutAfter) {
  const res = await fetch(baseUrl, { headers: partBytes > 0 ? { Range: `bytes=${partBytes}-` } : {} });
  const plan = U.resumePlan({ partBytes, statusCode: res.status, headers: { 'content-range': res.headers.get('content-range'), 'content-length': res.headers.get('content-length') } });
  const out = fs.createWriteStream(partPath, { flags: plan.append ? 'a' : 'w' });
  let written = 0, aborted = false;
  for await (const chunk of res.body) {
    out.write(chunk);
    written += chunk.length;
    if (cutAfter > 0 && partBytes + written >= cutAfter) { aborted = true; break; } // 用户取消：断连，保留 .part
  }
  // 中途取消时显式取消响应流，否则 undici 句柄半挂在退出阶段触发 libuv 断言
  if (aborted) await res.body.cancel();
  await new Promise((r) => out.end(r));
  return { plan, aborted, bytesOnDisk: fs.statSync(partPath).size };
}

const r1 = await oneRound(fs.existsSync(partPath) ? fs.statSync(partPath).size : 0, 120_000);
ok('U-18 首下中途取消：未续传（从 0 起）但 .part 已保留非零字节', r1.plan.append === false && r1.aborted && r1.bytesOnDisk >= 120_000);
const r2 = await oneRound(r1.bytesOnDisk, 260_000);
ok('U-19 取消后再点：服务端按 Range 响应，判定为追加而非重下', r2.plan.append === true && r2.plan.startBytes === r1.bytesOnDisk);
const r3 = await oneRound(r2.bytesOnDisk, 0);
ok('U-20 三段拼接后总长 == 原包长度', r3.plan.append === true && r3.bytesOnDisk === blob.length, `实际 ${r3.bytesOnDisk} / ${blob.length}`);
ok('U-21 拼接产物 sha256 与原包逐字节一致（续传不会拼坏安装包）',
  crypto.createHash('sha256').update(fs.readFileSync(partPath)).digest('hex') === blobSha);
srv.closeAllConnections?.();
await new Promise((r) => srv.close(r));
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });

// ---------- 接线静态断言（改错即 FAIL，弥补本仓跑不了 Electron IPC） ----------
const mainJs = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
const desktopTs = fs.readFileSync(path.join(ROOT, 'web', 'src', 'ui', 'desktop.ts'), 'utf8');
const settingsTsx = fs.readFileSync(path.join(ROOT, 'web', 'src', 'pages', 'SettingsPage.tsx'), 'utf8');

ok('W-01 主进程引用决策内核（不在 main.js 里另写一套判定）',
  /require\('\.\/update-state'\)/.test(mainJs) && /resumePlan/.test(mainJs) && /installOutcome/.test(mainJs));
ok('W-02 缺口 1 有落点：update:cancel IPC 存在且保留 .part（取消路径不删半成品）',
  /ipcMain\.handle\('update:cancel'/.test(mainJs) && mainJs.includes('if (!ctx.cancelled) { try { fs.rmSync(tmpPath'));
ok('W-03 下载句柄被登记（取消才有东西可断）', /let activeDownload = null;/.test(mainJs) && /activeDownload = ctx;/.test(mainJs));
ok('W-04 续传请求头按 .part 实际大小生成', /headers\.Range = `bytes=\$\{partBytes\}-`/.test(mainJs) && /partBytes: fileSizeOf\(tmpPath\)/.test(mainJs));
ok('W-05 206 被当合法响应（原实现只认 200，Range 续传会被误判失败）',
  /res\.statusCode !== 200 && res\.statusCode !== 206/.test(mainJs));
ok('W-06 缺口 2 有落点：安装器不再 detached 即退，改为等退出码',
  !/spawn\(filePath, \['\/S'\], \{ detached: true/.test(mainJs) && /child\.on\('exit', \(code\)/.test(mainJs));
ok('W-07 安装前落待回执标记，成功后才 app.quit', /writePending\(app\.getPath\('userData'\)/.test(mainJs)
  && /setTimeout\(\(\) => app\.quit\(\), 800\)/.test(mainJs));
ok('W-08 失败/超时不退出应用（回执与重试的前提）', !/setTimeout\(\(\) => app\.quit\(\), 1500\)/.test(mainJs));
ok('W-09 下次启动对账已挂进 whenReady，并经 IPC 回给界面',
  /reconcilePendingUpdateOnLaunch\(\);/.test(mainJs) && /ipcMain\.handle\('update:pending-result'/.test(mainJs));
ok('W-10 preload 白名单补齐取消与回执两个能力',
  /cancelUpdateDownload: \(\) => ipcRenderer\.invoke\('update:cancel'\)/.test(preloadJs)
  && /getUpdatePendingResult: \(\) => ipcRenderer\.invoke\('update:pending-result'\)/.test(preloadJs));
ok('W-11 渲染侧类型与主进程返回契约同步（不再是 string/裸 ok）',
  /downloadUpdate\?: \(url: string\) => Promise<UpdateDownloadResult>/.test(desktopTs)
  && /installUpdate\?: \(filePath: string, targetVersion\?: string\) => Promise<UpdateInstallResult>/.test(desktopTs));
ok('W-12 界面：下载中有「取消下载」，取消后主按钮变「继续下载」',
  /doCancelDownload/.test(settingsTsx) && /取消下载/.test(settingsTsx) && /'继续下载'/.test(settingsTsx));
ok('W-13 界面：安装失败回执条 + 重试复用安装包（不重新下载）',
  /安装失败：\{installError\.message\}/.test(settingsTsx) && /runInstall\(installError\.filePath, installError\.targetVersion\)/.test(settingsTsx));

console.log(`verify-t02071-update-flow: PASS=${pass} FAIL=${fail}`);
process.exitCode = fail > 0 ? 1 : 0; // 自然退出（硬 exit 会与未释放的 undici 句柄撞 libuv 断言）
