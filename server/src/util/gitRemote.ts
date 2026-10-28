/**
 * 远端仓库 URL 解析（八期 §3.1.3 / §4.4 安全）。
 *
 * 两条纪律：
 *  1. **凭据剥离**——remote 里可能写着 `https://user:token@host/owner/repo.git`，
 *     展示与外链一律先去 userinfo（token 一旦进入前端 DOM 就等于泄露）。
 *  2. **平台识别不出就不给外链**（Q6 裁定四类之外只走站内兜底），避免拼出一个 404 外链。
 */
import { GitCollectError } from '../services/gitCollect';

export type GitPlatform = 'github' | 'gitlab' | 'gitee' | 'unknown';

const CRED_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@]*@)?/;

/** 去掉 scheme 里的 `user:token@` userinfo 段（scp 式 `git@host:path` 的 user 不算凭据，一并规范化） */
export function stripUrlCredentials(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const m = CRED_RE.exec(s);
  if (m) return m[1] + s.slice(m[0].length);
  // scp 式：git@host:owner/repo.git → ssh://git@host/owner/repo.git（host 前的 user 段保留但不含口令）
  const scp = /^[^/@\s]+@([^:\s/]+):(.+)$/.exec(s);
  if (scp) return `ssh://${s}`;
  return s;
}

export interface RemoteRepo {
  host: string;
  owner: string;
  repo: string;
}

/** 从任意形态的 remote URL 提取 host/owner/repo；识别不了返回 null */
export function parseRemoteRepo(rawUrl: string): RemoteRepo | null {
  const raw = (rawUrl || '').trim();
  // scp 式先判：`git@host:grp/repo.git` 的「冒号后不是端口」，走 URL 解析会因端口非法而整体失败
  const scp = /^([^/@\s]+@)?([^:\s/@]+):(.+)$/.exec(raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/@]*@)?/, ''));
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/.+$/ .test(raw);
  let host = '';
  let path = '';
  if (scheme) {
    try {
      const u = new URL(stripUrlCredentials(raw));
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  } else {
    if (!scp || !scp[2] || !scp[3]) return null;
    host = scp[2];
    path = `/${scp[3]}`;
  }
  const clean = path.replace(/\.git$/, '').replace(/^\/+/, '');
  const segs = clean.split('/').filter(Boolean);
  // GitLab 允许子群组（a/b/repo），取最后两段作 owner/repo
  if (segs.length < 2) return null;
  const repo = segs[segs.length - 1];
  const owner = segs[segs.length - 2];
  if (!repo || !owner) return null;
  return { host, owner, repo };
}

/** Q6 裁定四类：GitHub / GitLab（含自建）/ Gitee；其余 unknown（站内兜底） */
export function detectPlatform(host: string): GitPlatform {
  const h = (host || '').toLowerCase();
  if (h === 'github.com' || h.endsWith('.github.com')) return 'github';
  if (h === 'gitee.com') return 'gitee';
  if (h.includes('gitlab')) return 'gitlab';
  return 'unknown';
}

export interface CommitLink {
  url: string;
  platform: GitPlatform;
  /** 展示用「host/owner/repo」（已剥离凭据） */
  display: string;
}

/** 构造提交外链；平台不可识别时返回 null（调用方走「站内查看」） */
export function buildCommitLink(rawUrl: string, sha: string): CommitLink | null {
  const repo = parseRemoteRepo(rawUrl);
  if (!repo) return null;
  const platform = detectPlatform(repo.host);
  if (platform === 'unknown') return null;
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
  const base = `https://${repo.host}/${repo.owner}/${repo.repo}`;
  const url = platform === 'gitlab' ? `${base}/-/commit/${sha}` : `${base}/commit/${sha}`;
  return { url, platform, display: `${repo.host}/${repo.owner}/${repo.repo}` };
}

/** 外链仅允许 http/https（渲染层与主进程二次校验同一口径） */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 展示用短 SHA（列表徽标 7 位） */
export function shortShaOf(sha: string): string {
  return (sha || '').slice(0, 7);
}

/** 无 origin 远端时的降级归因（§3.2.2 kind='no-remote'） */
export function isNoRemoteError(e: unknown): e is GitCollectError {
  return e instanceof GitCollectError && e.kind === 'no-remote';
}
