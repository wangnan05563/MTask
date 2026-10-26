/**
 * 版本更新服务：通过 GitHub Releases 自动检测最新版本。
 *
 * 职责：
 *  1. 配置存取：GitHub 仓库地址（owner/repo）+ 可选认证凭据（私有仓库 Token）。
 *     Token 经 util/crypto 的 AES-256-GCM 加密后落库（app_settings），任何接口不回传明文。
 *  2. 版本检查：HTTPS 调用 GitHub API /releases/latest，提取 tag 中的版本号与当前版本比较。
 *  3. 结果缓存：5 分钟 TTL，避免频繁请求触发 GitHub 限流（未认证 60 次/小时）。
 *  4. 错误映射：网络/认证/限流/无 Release 等失败统一转成中文可读提示。
 *
 * 版本号约定：Release tag 形如 v0.1.0（允许缺 v 前缀），提取其中的数字段逐段比较，
 * 段数不齐按 0 补齐（0.1 > 0.1.0 视为相等语义下取"不相较于新"处理，保守不提示更新）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting } from './AppSettings';
import { encrypt, decrypt, maskSecret } from '../util/crypto';
import { cacheGet, cacheSet, cacheClear } from '../util/ttl-cache';

const REPO_KEY = 'update.repo';
const TOKEN_KEY = 'update.token';
/** 检查结果缓存时长：GitHub 未认证限流 60 次/小时，5 分钟缓存足够克制 */
const CHECK_TTL_MS = 5 * 60 * 1000;
const GITHUB_API = 'https://api.github.com';
/** T02977：内置下载地址（更新源）——未配置手动地址、或手动地址非法时的兜底。
 *  菜单「帮助 → 检查在线更新」与设置页共用这一份解析，不再各自硬编码。 */
export const BUILTIN_UPDATE_REPO = 'wangnan05563/MTask';

/** 当前应用版本：读应用根 package.json（与 Electron `app.getVersion()` 同源）。
 *  T03298：原来先从 `__dirname/../..` 取——打包后 __dirname 是 `<app.asar>/server/dist/services`，
 *  回溯两级落到 `<app.asar>/server`，而 server/package.json 并不随包（build.files 只收 server/dist），
 *  候选二 `process.cwd()/package.json` 在安装版里也不是包根，于是恒回 '0.0.0'：
 *  任何 Release 都「比当前新」，已是最新照样提示更新，也会把旧版本当新版本发给用户。
 *  三级回溯在三种形态下都正好命中根 package.json：dev(tsx)=<repo>/server/src/services、
 *  后端构建直跑=<repo>/server/dist/services、打包态=<app.asar>/server/dist/services。
 *  同时供 /api/update/version 端点回显关于页真实版本。 */
export function currentVersion(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'package.json'),
    path.resolve(__dirname, '..', '..', 'package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch { /* 尝试下一个候选路径 */ }
  }
  return '0.0.0';
}

/** 规范化仓库地址：接受完整 URL（https://github.com/owner/repo(.git)）或 owner/repo，统一为 owner/repo。
 *  非法输入返回 null，由调用方转成中文提示。 */
function normalizeRepo(input: string): string | null {
  const raw = input.trim().replace(/\.git$/i, '');
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:[/?#].*)?$/i.exec(raw)
    ?? /^([\w.-]+)\/([\w.-]+)$/.exec(raw);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

export interface UpdateSource {
  /** 实际生效的 owner/repo */
  repo: string;
  /** manual=设置页手填且合法；builtin=未填/非法时的内置兜底 */
  source: 'manual' | 'builtin';
}

/** T02977：地址优先级——手动地址合法则覆盖内置地址，否则（空/非法）回退内置地址。
 *  保存入口已做规范化，这里再规范一次是给历史脏数据兜底，保证「非法即回退」始终成立。 */
export function resolveRepoSource(configured: string | null | undefined): UpdateSource {
  const manual = configured ? normalizeRepo(configured) : null;
  return manual
    ? { repo: manual, source: 'manual' }
    : { repo: BUILTIN_UPDATE_REPO, source: 'builtin' };
}

/** 从 tag/名称中提取版本号（v0.1.0 → 0.1.0）；无数字段返回 null */
function extractVersion(tag: string): string | null {
  const m = /v?(\d+(?:\.\d+)+)/i.exec(tag.trim());
  return m ? m[1] : null;
}

/** 语义化比较：逐段数值比较，段数不齐补 0。返回 >0 / 0 / <0 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export interface UpdateConfigView {
  /** 用户保存的手动地址（空串＝未配置，回退内置地址） */
  repo: string;
  /** T02977：内置兜底地址，供界面提示「留空时使用」 */
  builtinRepo: string;
  /** T02977：当前实际生效的地址来源 */
  source: 'manual' | 'builtin';
  tokenConfigured: boolean;
  tokenMasked: string;
}

export interface UpdateCheckResult {
  ok: true;
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseName: string;
  releaseUrl: string;
  publishedAt: string;
  /** Windows 安装包下载地址：优先 assets 中的 setup/exe，缺省回退 Release 页面 */
  downloadUrl: string;
  /** Release 正文（更新日志），Markdown 原文，由前端按需渲染 */
  changelog: string;
  /** T02977：本次检查实际使用的地址与来源 */
  repo: string;
  source: 'manual' | 'builtin';
}

/** 读取当前配置（token 只回掩码，绝不回明文） */
export function getConfig(): UpdateConfigView {
  const repo = getSetting(REPO_KEY) ?? '';
  const tokenEnc = getSetting(TOKEN_KEY);
  let tokenMasked = '';
  if (tokenEnc) {
    try { tokenMasked = maskSecret(decrypt(tokenEnc)); } catch { tokenMasked = '****'; }
  }
  const resolved = resolveRepoSource(repo);
  return { repo, builtinRepo: BUILTIN_UPDATE_REPO, source: resolved.source, tokenConfigured: Boolean(tokenEnc), tokenMasked };
}

/** 保存配置。token 传 undefined=不改动；传空串=清除；传非空=加密写入。
 *  T02977：repo 传空串=清除手动地址（回退内置地址），非空仍须是合法 owner/repo 或 GitHub URL。 */
export function saveConfig(input: { repo?: string; token?: string }): UpdateConfigView {
  if (input.repo !== undefined) {
    const repo = normalizeRepo(input.repo);
    if (!repo && input.repo.trim()) throw new Error('仓库地址非法：请填「owner/repo」或 GitHub 仓库完整 URL');
    setSetting(REPO_KEY, repo ?? '');
    cacheClear('update-check');
  }
  if (input.token !== undefined) {
    // 非空=加密写入；空串=清除（写空覆盖，读取端以真值判断视为未配置）
    setSetting(TOKEN_KEY, input.token.trim() ? encrypt(input.token.trim()) : '');
    cacheClear('update-check');
  }
  return getConfig();
}

/** 调 GitHub API 拉取最新 Release。token 为本函数内一次性使用，不落日志不返回。 */
async function fetchLatestRelease(repo: string, token: string | null): Promise<{
  name: string; url: string; publishedAt: string; body: string;
  downloadUrl: string; version: string;
}> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    // GitHub API 强制要求 User-Agent，缺失直接 403
    'User-Agent': 'MTask-Updater',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let resp: Response;
  try {
    resp = await fetch(`${GITHUB_API}/repos/${repo}/releases/latest`, {
      headers,
      // 约束 1：仅 HTTPS——GitHub API 域名硬编码，不接受自填 API 地址
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/timeout|abort/i.test(msg)) throw new Error('连接 GitHub 超时，请检查网络或代理设置');
    throw new Error(`无法连接 GitHub（HTTPS）：${msg}`);
  }

  if (resp.status === 404) throw new Error('仓库不存在，或该仓库尚未发布任何 Release（请先在 GitHub 创建 Release）');
  if (resp.status === 401) throw new Error('认证凭据无效（401）：请检查 Token 是否正确、是否已过期');
  if (resp.status === 403) throw new Error('GitHub 请求被限流（403）：未认证额度 60 次/小时，请稍后重试，或配置 Token 提升额度');
  if (!resp.ok) throw new Error(`GitHub 返回异常状态 ${resp.status}，请稍后重试`);

  const data = (await resp.json()) as {
    tag_name?: string; name?: string; html_url?: string; published_at?: string; body?: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  };
  const version = extractVersion(data.tag_name ?? '');
  if (!version) throw new Error(`Release 标签「${data.tag_name ?? ''}」中未找到版本号（约定 vX.X.X），无法比较`);
  // 下载地址优先级：Windows 安装包 asset > Release 页面链接
  const winAsset = data.assets?.find((a) => /(?:setup|installer|\.exe$)/i.test(a.name));
  return {
    version,
    name: data.name ?? data.tag_name ?? '',
    url: data.html_url ?? `https://github.com/${repo}/releases`,
    publishedAt: data.published_at ?? '',
    body: data.body ?? '',
    downloadUrl: winAsset?.browser_download_url ?? data.html_url ?? `https://github.com/${repo}/releases`,
  };
}

/** 用草稿配置测试连通性（不落库），供保存前验证 */
export async function testConfig(input: { repo: string; token?: string }): Promise<{ ok: boolean; latestVersion?: string; error?: string }> {
  const repo = normalizeRepo(input.repo ?? '');
  if (!repo) return { ok: false, error: '仓库地址非法：请填「owner/repo」或 GitHub 仓库完整 URL' };
  try {
    const r = await fetchLatestRelease(repo, input.token?.trim() || null);
    return { ok: true, latestVersion: r.version };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 检查更新：带 5 分钟缓存；force=true 跳过缓存强制拉取。
 *  T02977：手动地址合法则覆盖内置地址，留空/非法回退内置地址——不再因未配置而直接报错。 */
export async function checkUpdate(force = false): Promise<UpdateCheckResult> {
  const { repo, source } = resolveRepoSource(getSetting(REPO_KEY));

  const cached = force ? undefined : cacheGet<UpdateCheckResult>('update-check');
  if (cached) return cached;

  const tokenEnc = getSetting(TOKEN_KEY);
  let token: string | null = null;
  if (tokenEnc) {
    try { token = decrypt(tokenEnc); } catch { token = null; }
  }

  const cur = currentVersion();
  const rel = await fetchLatestRelease(repo, token);
  const result: UpdateCheckResult = {
    ok: true,
    currentVersion: cur,
    latestVersion: rel.version,
    hasUpdate: compareVersions(rel.version, cur) > 0,
    releaseName: rel.name,
    releaseUrl: rel.url,
    publishedAt: rel.publishedAt,
    downloadUrl: rel.downloadUrl,
    changelog: rel.body,
    repo,
    source,
  };
  cacheSet('update-check', result, CHECK_TTL_MS);
  return result;
}
