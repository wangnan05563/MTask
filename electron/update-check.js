/**
 * T02740 在线更新（内置仓库）的纯判定内核：GitHub latest-release 解析 + 版本比较。
 *
 * 与 update-state.js 同族设计——纯函数、零 electron 依赖，可脱离桌面壳直接单测；
 * 网络请求、对话框、菜单装配留在 main.js（有副作用的部分），本模块只负责「拿到
 * GitHub API 响应体之后怎么判」，保证判定逻辑可被离线夹具证真。
 *
 * 版本比较口径与 server/src/services/UpdateService.ts 完全一致（逐段数值比较、段数
 * 不齐按 0 补齐、tag 提取 v?X.X.X 数字段），两处如要改动必须同步——本模块是主进程侧
 * 唯一判据来源，渲染侧走服务端 /update/check，二者语义对齐才不会出现「菜单说有新版、
 * 设置页说没有」的分裂。
 */

/** 从 tag/名称中提取版本号（v0.1.0 → 0.1.0）；无数字段返回 null */
function extractVersion(tag) {
  const m = /v?(\d+(?:\.\d+)+)/i.exec(String(tag ?? '').trim());
  return m ? m[1] : null;
}

/** 语义化比较：逐段数值比较，段数不齐补 0。返回 >0 / 0 / <0 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 解析 /releases/latest 响应体为更新信息。字段约定与 GitHub API 文档一致；
 *  tag 中取不到版本号即抛中文错误（宁可报错也不拿空版本去比较造成误提示）。 */
function parseLatestRelease(data) {
  const version = extractVersion(data?.tag_name);
  if (!version) {
    throw new Error(`Release 标签「${data?.tag_name ?? ''}」中未找到版本号（约定 vX.X.X），无法比较`);
  }
  // 下载地址优先级：Windows 安装包 asset > Release 页面链接（与服务端同规则）
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

/** HTTP 状态码 → 中文可读错误（与服务端错误映射同口径）；返回 null 表示非已知错误码 */
function mapReleaseHttpError(status) {
  if (status === 404) return '内置仓库不存在，或尚未发布任何 Release（请先在 GitHub 创建 Release）';
  if (status === 401) return 'GitHub 认证失败（401）';
  if (status === 403) return 'GitHub 请求被限流（403）：未认证额度 60 次/小时，请稍后重试';
  if (status !== 200) return `GitHub 返回异常状态 ${status}，请稍后重试`;
  return null;
}

module.exports = { extractVersion, compareVersions, parseLatestRelease, mapReleaseHttpError };
