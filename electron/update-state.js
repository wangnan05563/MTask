/**
 * T02071：一键更新的「取消/续传」与「安装回执/重试」纯逻辑（不依赖 electron，可单测）。
 *
 * 拆出本模块的原因：这两项要求的验收面在真机（真实更高版本安装包 + NSIS 静默安装），
 * 隔离实例覆盖不到；但它们的**决策内核**（什么时候续传、什么时候从 0 重下、下次启动怎么
 * 判定上次装成功还是失败）是纯函数，先在这里钉住并被 scripts/verify-t02071-update-flow.mjs
 * 断言，主进程只保留 IO 与 IPC 接线。
 */
const path = require('node:path');
const fs = require('node:fs');

/** 4 段版本号（0.1.1011.194）→ 数值数组；非法段按 0 计，缺位补 0 */
function parseVersion(v) {
  return String(v ?? '').split('.').map((s) => Number.parseInt(s, 10) || 0);
}

/** a>b → 1，a<b → -1，相等 → 0（长度不等时短的一侧缺位补 0） */
function cmpVersion(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] ?? 0) - (B[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 续传判定：只有远端**确实按 Range 响应**（206 且 Content-Range 起点 == 本地已有字节数）才追加，
 * 其余一律从 0 重下（含 200 忽略 Range、416 越界、以及 content-range 缺失的怪异响应）。
 * 返回的 startBytes/totalBytes 直接用于进度口径，append 决定写流 flag。
 */
function resumePlan({ partBytes = 0, statusCode, headers = {} }) {
  if (partBytes > 0 && statusCode === 206) {
    // Content-Range: bytes <start>-<end>/<total>
    const m = /bytes\s+(\d+)-\d+\/(\d+|\*)/i.exec(String(headers['content-range'] ?? ''));
    if (m && Number(m[1]) === partBytes) {
      const rest = m[2] === '*' ? Number(headers['content-length'] ?? 0) : Number(m[2]) - partBytes;
      return { append: true, startBytes: partBytes, totalBytes: partBytes + Math.max(0, rest) };
    }
  }
  return { append: false, startBytes: 0, totalBytes: Math.max(0, Number(headers['content-length'] ?? 0)) };
}

const pendingFile = (userDataDir) => path.join(userDataDir, 'update-pending.json');

function writePending(userDataDir, obj) {
  try { fs.writeFileSync(pendingFile(userDataDir), JSON.stringify(obj)); return true; } catch { return false; }
}

function readPending(userDataDir) {
  try { return JSON.parse(fs.readFileSync(pendingFile(userDataDir), 'utf8')); } catch { return null; }
}

function clearPending(userDataDir) {
  try { fs.rmSync(pendingFile(userDataDir), { force: true }); } catch { /* 忽略 */ }
}

/**
 * 下次启动对账：安装器成功时通常会 taskkill 掉本应用，收不到退出码，故成功与否以
 * 「当前运行版本是否已达到目标版本」为准（本模块唯一的判定依据，不看安装器日志）。
 *  - 无标记 → null（没有待回执的更新）
 *  - 当前版本 >= 目标版本 → installed
 *  - 当前版本仍是旧的 → failed（携带安装包路径与目标版本供「重试」复用，不必重新下载）
 */
function reconcilePending(marker, currentVersion) {
  if (!marker) return null;
  const target = marker.targetVersion;
  if (target && currentVersion && cmpVersion(currentVersion, target) >= 0) {
    return { status: 'installed', from: marker.filePath ?? '', targetVersion: target };
  }
  return {
    status: 'failed',
    reason: marker.message || `安装未生效（当前版本 ${currentVersion || '未知'}，目标 ${target || '未知'}）`,
    filePath: marker.filePath ?? '',
    targetVersion: target ?? '',
    code: marker.code ?? null,
  };
}

/**
 * 安装进程退出码 → 回执。NSIS 静默安装成功返回 0；用户取消返回 0x6465…（实际常见非 0）；
 * 这里只按 0 / 非 0 二分，非 0 一律附原始码供界面点明原因。timeout 单独成态：
 * 安装器可能正弹 UAC，不能据此判定失败，交由下次启动对账收敛。
 */
function installOutcome({ code, timedOut }) {
  if (timedOut) return { status: 'pending', message: '安装进程超过约定等待时间仍未回执（可能有授权确认弹窗），本次启动不做成败判定' };
  if (code === 0) return { status: 'installed', message: '安装完成，应用即将重启到新版本' };
  return { status: 'failed', message: `安装器返回失败（退出码 ${code}）：安装包可能损坏、目标目录被占用或权限不足`, code };
}

module.exports = { parseVersion, cmpVersion, resumePlan, pendingFile, writePending, readPending, clearPending, reconcilePending, installOutcome };
