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

/**
 * T02740：在线更新（内置仓库）的 latest-release 判定内核——同为纯函数，随本模块一起入
 * build.files 白名单（新增独立文件会被 W-14「主进程本地 require 必须在白名单」拦红，
 * 而 package.json 是并发会话的 MM 文件，不宜为白名单加行去裹挟他人 WIP）。
 * 版本比较复用上方 cmpVersion；tag 提取与安装包 asset 优先规则与
 * server/src/services/UpdateService.ts 同口径，两处如要改动必须同步。
 */

/** 从 tag/名称中提取版本号（v0.1.0 → 0.1.0）；无数字段返回 null */
function extractVersion(tag) {
  const m = /v?(\d+(?:\.\d+)+)/i.exec(String(tag ?? '').trim());
  return m ? m[1] : null;
}

/** 解析 GitHub /releases/latest 响应体；tag 取不到版本号即抛中文错误（宁报错不误提示）。
 *  下载地址优先级：Windows 安装包 asset > Release 页面链接（与服务端同规则）。 */
function parseLatestRelease(data) {
  const version = extractVersion(data?.tag_name);
  if (!version) {
    throw new Error(`Release 标签「${data?.tag_name ?? ''}」中未找到版本号（约定 vX.X.X），无法比较`);
  }
  const winAsset = (data?.assets ?? []).find((a) => /(?:setup|installer|\.exe$)/i.test(String(a?.name ?? '')));
  const releaseUrl = data?.html_url ?? '';
  return {
    version,
    releaseName: data?.name ?? data?.tag_name ?? '',
    publishedAt: data?.published_at ?? '',
    downloadUrl: winAsset?.browser_download_url ?? releaseUrl,
    downloadIsInstaller: Boolean(winAsset),
  };
}

/** HTTP 状态码 → 中文可读错误（与服务端 fetchLatestRelease 错误映射同口径）；200 返回 null */
function mapReleaseHttpError(status) {
  if (status === 404) return '内置仓库不存在，或尚未发布任何 Release（请先在 GitHub 创建 Release）';
  if (status === 401) return 'GitHub 认证失败（401）';
  if (status === 403) return 'GitHub 请求被限流（403）：未认证额度 60 次/小时，请稍后重试';
  if (status !== 200) return `GitHub 返回异常状态 ${status}，请稍后重试`;
  return null;
}

module.exports = { parseVersion, cmpVersion, resumePlan, pendingFile, writePending, readPending, clearPending, reconcilePending, installOutcome, extractVersion, parseLatestRelease, mapReleaseHttpError };
