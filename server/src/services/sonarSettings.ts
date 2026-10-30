/**
 * 八期 §3.4.1：设置页「SonarQube」子页的配置读写、Token 密文与查看审计、环境探测与连接测试。
 *
 * 口径来源（PRD v1.2）：
 *  - 服务器地址：URL 校验（http/https、去尾斜杠）；
 *  - Token：复用 `util/crypto.ts` 的 AES-256-GCM + `maskSecret`，默认脱敏，
 *    「查看原文」需二次确认**并写审计**（PRD 明确这是新增审计点，现有 API Key 查看通道不写审计，不算复用）；
 *  - 扫描器路径：留空按 PATH 探测；
 *  - Java 环境：只读展示 `java -version` 探测结果 + 指引，不提供安装；
 *  - projectKey 映射：项目 ↔ Sonar projectKey，未配置时扫描前必填（由扫描面板拦截）；
 *  - 扫描并发上限：默认 1、范围 1–2（写进 `exportGateLimit.sonar-scan`，与既有导出闸同一取数口径）；
 *  - 连接测试三项：system/status、scanner -v、projects/show，失败 kind 分别为
 *    unreachable / auth-failed / no-scanner / no-java / project-not-found。
 *
 * 安全红线：Token 只以密文落 `app_settings`，明文既不回传（除 reveal 且已二次确认）也不入日志；
 * 服务地址里的 user:info 凭据一律拒绝（凭据应走 Token，写在 URL 里会进日志与外链）。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection';
import { getSetting, setSetting } from './AppSettings';
import { encrypt, decrypt, maskSecret } from '../util/crypto';

const SERVER_URL_KEY = 'sonar.serverUrl';
const TOKEN_ENC_KEY = 'sonar.tokenEnc';
const SCANNER_PATH_KEY = 'sonar.scannerPath';
const PROJECT_KEYS_KEY = 'sonar.projectKeys';
const SCAN_LIMIT_KEY = 'sonar.scanLimit';
/** 并发上限的生效口径：与既有导出闸同名（`exportGate('sonar-scan')` 每次请求读它） */
export const SONAR_SCAN_GATE = 'sonar-scan';
export const SCAN_LIMIT_DEFAULT = 1;
export const SCAN_LIMIT_MIN = 1;
export const SCAN_LIMIT_MAX = 2;
const HTTP_TIMEOUT_MS = 8_000;
const EXEC_TIMEOUT_MS = 20_000;
/** 探测结果缓存：`java -version` / `scanner -v` 各要起一个进程，页签每次挂载都探一次没必要 */
const PROBE_TTL_MS = 60_000;

export type SonarTestKind = 'unreachable' | 'auth-failed' | 'no-scanner' | 'no-java' | 'project-not-found';

export class SonarConfigError extends Error {
  constructor(readonly kind: 'bad-url' | 'bad-limit' | 'bad-project-keys' | 'confirm-required' | 'no-token', message: string) {
    super(message);
    this.name = 'SonarConfigError';
  }
}

export interface SonarProbe {
  available: boolean;
  /** 探测到的可执行文件（PATH 命中的全路径或配置值） */
  resolved: string;
  version: string;
  /** 不可用时的可操作指引 */
  hint: string;
}

export interface SonarConfigView {
  serverUrl: string;
  tokenConfigured: boolean;
  tokenMasked: string;
  scannerPath: string;
  projectKeys: Record<string, string>;
  scanLimit: number;
  /** 当前实际生效的闸上限（app_settings 里那份，可能是别的写入者留下的合法值） */
  gateLimitEffective: number;
  scanner: SonarProbe;
  java: SonarProbe;
}

export interface SonarTestResult {
  server?: { ok: boolean; version?: string; edition?: string; status?: string };
  scanner?: { ok: boolean; version?: string };
  java?: { ok: boolean };
  project?: { ok: boolean; projectKey?: string };
  errors: Array<{ kind: SonarTestKind; message: string; hint: string }>;
}

/**
 * 校验并归一服务地址。
 * 拒绝而非静默清洗的情形：缺 scheme、非 http/https、无主机名、URL 内嵌凭据、含空白。
 */
export function normalizeSonarUrl(raw: string): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  if (/\s/.test(value)) throw new SonarConfigError('bad-url', '服务器地址非法：地址中不能包含空格');
  // 先单独认「缺 scheme」：`localhost:9000` 会被 URL 解析成 protocol="localhost:"，
  // 直接走下面的协议白名单只会回一句看不懂的「只允许 http/https，收到 localhost:」。
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    throw new SonarConfigError('bad-url', '服务器地址非法：请填写完整 URL（例：http://127.0.0.1:9000）');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SonarConfigError('bad-url', '服务器地址非法：请填写完整 URL（例：http://127.0.0.1:9000）');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SonarConfigError('bad-url', `服务器地址非法：只允许 http/https，收到 ${url.protocol}`);
  }
  if (!url.hostname) throw new SonarConfigError('bad-url', '服务器地址非法：缺少主机名');
  if (url.username || url.password) {
    throw new SonarConfigError('bad-url', '服务器地址非法：凭据请填在「认证 Token」里，不要写进地址（地址会进日志与外链）');
  }
  return url.toString().replace(/\/+$/, '');
}

function readProjectKeys(): Record<string, string> {
  const raw = getSetting(PROJECT_KEYS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const parsedObj = parsed as Record<string, unknown>;
    const kept: Array<[string, string]> = [];
    for (const [projectId, key] of Object.entries(parsedObj)) {
      if (typeof key === 'string' && key.trim()) kept.push([projectId, key]);
    }
    return Object.fromEntries(kept);
  } catch {
    return {};
  }
}

/** 键是项目 id、值是 projectKey；空值条目当作未配置剔除（面板据此提示去配置，而不是拿空串去扫） */
function writeProjectKeys(input: unknown): Record<string, string> {
  if (input === undefined) return readProjectKeys();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SonarConfigError('bad-project-keys', 'projectKey 映射格式非法：应为 { 项目id: projectKey } 对象');
  }
  const out: Record<string, string> = {};
  for (const [projectId, key] of Object.entries(input as Record<string, unknown>)) {
    if (typeof key !== 'string') throw new SonarConfigError('bad-project-keys', `projectKey 映射非法：项目 ${projectId} 的值不是字符串`);
    const trimmed = key.trim();
    if (trimmed) out[projectId] = trimmed;
  }
  setSetting(PROJECT_KEYS_KEY, JSON.stringify(out));
  return out;
}

function readScanLimit(): number {
  const raw = getSetting(SCAN_LIMIT_KEY);
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= SCAN_LIMIT_MIN && n <= SCAN_LIMIT_MAX ? n : SCAN_LIMIT_DEFAULT;
}

function tokenPlain(): string | null {
  const enc = getSetting(TOKEN_ENC_KEY);
  if (!enc) return null;
  try {
    return decrypt(enc);
  } catch {
    // 主密钥换过（换机 / MTask_MASTER_KEY 变更）时密文解不开——不能让设置页整页 500
    return null;
  }
}

/**
 * 扫描侧要用的连接参数（§3.4.2）。
 *
 * Token 明文只在这个返回值里出现，且只允许用于 HTTP 头与子进程环境变量：
 * 安全条款要求「日志/命令行/properties 全链路脱敏」，所以 `sonar-project.properties`
 * 里绝不出现它（PRD 阶段表把 token 列进 properties 是早期写法，以安全条款为准）。
 */
export function readScanSettings(): { serverUrl: string; token: string; scannerPath: string; scanLimit: number } {
  return {
    serverUrl: getSetting(SERVER_URL_KEY) ?? '',
    token: tokenPlain() ?? '',
    scannerPath: getSetting(SCANNER_PATH_KEY) ?? '',
    scanLimit: readScanLimit(),
  };
}

/** spawn 形态决策（扫描与探测共用一套，否则「探测能跑、扫描跑不起来」） */
export function planScannerSpawn(bin: string, args: string[]): { command: string; args: string[]; shell: boolean; unsafe?: boolean } {
  const useShell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(bin);
  // 走 cmd.exe 时路径里的 shell 元字符等于把命令行控制权交出去，直接判定不可用
  if (useShell && CMD_UNSAFE_CHARS.test(bin)) return { command: bin, args: [], shell: true, unsafe: true };
  // Windows 官方 SonarScanner 发布包只有 `sonar-scanner.bat`，而 Node ≥18.20 禁止无 shell 启动 .bat/.cmd
  // （实测：裸 execFile 同步抛 spawn EINVAL）。唯一实测可用的写法是「整条命令自带引号 + shell:true + args 传空」
  if (useShell) return { command: `"${bin}" ${args.join(' ')}`, args: [], shell: true };
  return { command: bin, args: [...args], shell: false };
}

const probeCache = new Map<string, { at: number; value: SonarProbe }>();

export function clearSonarProbeCache(): void {
  probeCache.clear();
}

interface ExecResult {
  ok: boolean;
  out: string;
  /** 区分「路径不能安全交给 cmd」与「执行失败」——两类的用户处置动作不同 */
  error?: 'unsafe-path' | 'spawn-failed';
}

/**
 * 走 cmd.exe 时，路径里出现 shell 元字符等于把命令行的控制权交出去，直接拒绝而不是尝试转义
 * （cmd 的转义规则连 Node 自己都不保证）；空格是合法的（`Program Files`），不禁。
 */
const CMD_UNSAFE_CHARS = /[&|^%<>"'`;]|\r|\n/;

/** Java 缺失的统一文案：探测失败与「根本没探测到」共用一句，避免两处各写一遍后指引不同 */
const JAVA_MISSING_HINT = '未探测到 Java（PATH 与 JAVA_HOME/bin 里都没有 java）。SonarScanner CLI 依赖 JDK 11+，请安装后点「重新探测」；本工具不提供安装。';

const firstLine = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? '';

function execVersion(bin: string, args: string[]): Promise<ExecResult> {
  const spec = planScannerSpawn(bin, args);
  if (spec.unsafe) return Promise.resolve({ ok: false, out: '', error: 'unsafe-path' });
  return new Promise((resolve) => {
    const opts = { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true } as const;
    const cb = (err: unknown, stdout: string, stderr: string) => {
      // java -version 走 stderr 是既成事实（scanner CLI 走 stdout），两路都要收下
      resolve({ ok: !err, out: firstLine(`${stdout ?? ''}${stderr ?? ''}`) });
    };
    try {
      execFile(spec.command, spec.args, { ...opts, shell: spec.shell }, cb);
    } catch {
      resolve({ ok: false, out: '', error: 'spawn-failed' });
    }
  });
}

function probeHint(base: string, res: ExecResult): string {
  if (res.error === 'unsafe-path') {
    return `${base}路径含 cmd.exe 无法安全执行的字符（& | ^ % < > " ' ; 反引号），请改指向不含这些字符的路径。`;
  }
  return '';
}

/** PATH 里探测 sonar-scanner：不借 shell（Windows 下 `where` 也算外部进程），直接按 PATH 目录逐项 stat */
export function findScannerOnPath(env: NodeJS.ProcessEnv = process.env): string {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32'
    ? ['sonar-scanner.bat', 'sonar-scanner.exe', 'sonar-scanner.cmd', 'sonar-scanner']
    : ['sonar-scanner'];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/**
 * 探测 java 可执行文件：先看 `JAVA_HOME/bin`，再按 PATH 目录逐项 stat。
 * 只认 `java` 裸名会让「装了 JDK 但没把 bin 加进 PATH」这一常见 Windows 形态被误判成「没有 Java」——
 * 而扫描引擎把 Java 当作硬前提，误判等于整条功能链在用户侧凭空消失。
 */
export function findJavaExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const names = process.platform === 'win32' ? ['java.exe', 'java.bat', 'java.cmd', 'java'] : ['java'];
  const dirs: string[] = [];
  const home = (env.JAVA_HOME ?? '').trim();
  if (home) dirs.push(path.join(home, 'bin'));
  for (const d of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) dirs.push(d);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

async function probeWithCache(key: string, compute: () => Promise<SonarProbe>): Promise<SonarProbe> {
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;
  const value = await compute();
  probeCache.set(key, { at: Date.now(), value });
  return value;
}

export async function probeScanner(scannerPathConfig?: string): Promise<SonarProbe> {
  const configured = (scannerPathConfig ?? getSetting(SCANNER_PATH_KEY) ?? '').trim();
  const resolved = configured || findScannerOnPath();
  const cacheKey = `scanner:${resolved}`;
  if (!resolved) {
    return {
      available: false, resolved: '', version: '',
      hint: '未找到 sonar-scanner：请在「扫描器路径」填写可执行文件全路径，或把 sonar-scanner/bin 加入系统 PATH。',
    };
  }
  if (configured && !existsSync(configured)) {
    return {
      available: false, resolved: configured, version: '',
      hint: `配置的扫描器路径不存在：${configured}（留空则自动按 PATH 探测）。`,
    };
  }
  return probeWithCache(cacheKey, async () => {
    const res = await execVersion(resolved, ['-v']);
    return {
      available: res.ok,
      resolved,
      version: res.ok ? res.out : '',
      hint: res.ok ? '' : probeHint('扫描器', res)
        || '扫描器执行 `sonar-scanner -v` 失败：确认该路径是可运行的 SonarScanner CLI，且 Java 环境可用。',
    };
  });
}

export async function probeJava(javaBin?: string): Promise<SonarProbe> {
  const configured = (javaBin ?? '').trim();
  // 不传参数=按环境探测（JAVA_HOME 优先，其次 PATH）；显式传入保留「指定命令名探测」的老用法
  const resolved = configured || findJavaExecutable();
  if (!resolved) {
    return { available: false, resolved: '', version: '', hint: JAVA_MISSING_HINT };
  }
  return probeWithCache(`java:${resolved}`, async () => {
    const res = await execVersion(resolved, ['-version']);
    return {
      available: res.ok,
      resolved: res.ok ? resolved : '',
      version: res.ok ? res.out : '',
      hint: res.ok ? '' : probeHint('Java', res) || JAVA_MISSING_HINT,
    };
  });
}

export async function getSonarConfigView(): Promise<SonarConfigView> {
  const plain = tokenPlain();
  const scanLimit = readScanLimit();
  const gateRaw = getSetting(`exportGateLimit.${SONAR_SCAN_GATE}`);
  const gateParsed = gateRaw === null ? NaN : Number(gateRaw);
  return {
    serverUrl: getSetting(SERVER_URL_KEY) ?? '',
    tokenConfigured: Boolean(plain),
    tokenMasked: plain ? maskSecret(plain) : '',
    scannerPath: getSetting(SCANNER_PATH_KEY) ?? '',
    projectKeys: readProjectKeys(),
    scanLimit,
    gateLimitEffective: Number.isInteger(gateParsed) && gateParsed >= 1 ? gateParsed : scanLimit,
    scanner: await probeScanner(),
    java: await probeJava(),
  };
}

/**
 * 保存配置。各字段语义与 `update/config` 一致：`undefined`=不改动、空串=清除、非空=覆盖。
 * 扫描并发上限直接写闸的 override 键——两处（设置页与闸）只有一个真源，不存在漂移。
 */
export async function saveSonarConfig(input: {
  serverUrl?: string;
  token?: string;
  scannerPath?: string;
  projectKeys?: unknown;
  scanLimit?: number;
}): Promise<SonarConfigView> {
  if (input.serverUrl !== undefined) {
    if (typeof input.serverUrl !== 'string') throw new SonarConfigError('bad-url', '服务器地址非法：类型不是字符串');
    setSetting(SERVER_URL_KEY, normalizeSonarUrl(input.serverUrl));
  }
  if (input.token !== undefined) {
    if (typeof input.token !== 'string') throw new SonarConfigError('no-token', 'Token 非法：类型不是字符串');
    const value = input.token.trim();
    setSetting(TOKEN_ENC_KEY, value ? encrypt(value) : '');
  }
  if (input.scannerPath !== undefined) {
    if (typeof input.scannerPath !== 'string') throw new SonarConfigError('bad-url', '扫描器路径非法：类型不是字符串');
    setSetting(SCANNER_PATH_KEY, input.scannerPath.trim());
    clearSonarProbeCache();
  }
  if (input.projectKeys !== undefined) writeProjectKeys(input.projectKeys);
  if (input.scanLimit !== undefined) {
    const n = Number(input.scanLimit);
    if (!Number.isInteger(n) || n < SCAN_LIMIT_MIN || n > SCAN_LIMIT_MAX) {
      throw new SonarConfigError('bad-limit', `扫描并发上限非法：允许 ${SCAN_LIMIT_MIN}–${SCAN_LIMIT_MAX}，收到 ${input.scanLimit}`);
    }
    setSetting(SCAN_LIMIT_KEY, String(n));
    setSetting(`exportGateLimit.${SONAR_SCAN_GATE}`, String(n));
  }
  return getSonarConfigView();
}

/**
 * 查看 Token 原文：必须带显式二次确认，且**每次查看都落审计行**（含失败尝试）。
 * 审计只记「谁在什么时候看了哪台服务器的 Token」，不记 Token 本身。
 */
export function revealSonarToken(confirm: unknown, serverUrlAtCall = getSetting(SERVER_URL_KEY) ?? ''): { token: string; revealedAt: string } {
  if (confirm !== true) {
    // T03352：被拒的查看尝试同样落审计——表注释承诺「失败尝试也记」，
    // 否则反复试探该端点在审计里一片空白；此行**不含 Token**（此时也取不到）。
    recordRevealAudit({ revealedAt: new Date().toISOString(), serverUrl: serverUrlAtCall, ok: false, note: 'confirm-required' });
    throw new SonarConfigError('confirm-required', '查看原文需要二次确认：请勾选确认后再试（此动作会写入审计记录）');
  }
  const revealedAt = new Date().toISOString();
  const plain = tokenPlain();
  if (!plain) {
    recordRevealAudit({ revealedAt, serverUrl: serverUrlAtCall, ok: false, note: 'no-token' });
    throw new SonarConfigError('no-token', '尚未配置 Token，或既有密文无法解密（主密钥变更后需重新录入）');
  }
  recordRevealAudit({ revealedAt, serverUrl: serverUrlAtCall, ok: true, note: '' });
  return { token: plain, revealedAt };
}

export function recordRevealAudit(input: { revealedAt: string; serverUrl: string; ok: boolean; note: string }): void {
  getDb()
    .prepare('INSERT INTO sonar_reveal_audit (id, revealed_at, actor, target, server_url, ok, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), input.revealedAt, 'local', 'sonar.token', input.serverUrl, input.ok ? 1 : 0, input.note);
}

export function listRevealAudit(limit = 20): Array<{ revealedAt: string; serverUrl: string; ok: boolean; note: string }> {
  const rows = getDb()
    .prepare('SELECT revealed_at, server_url, ok, note FROM sonar_reveal_audit ORDER BY revealed_at DESC LIMIT ?')
    .all(limit) as Array<{ revealed_at: string; server_url: string; ok: number; note: string }>;
  return rows.map((r) => ({ revealedAt: r.revealed_at, serverUrl: r.server_url, ok: r.ok === 1, note: r.note ?? '' }));
}

interface StatusResponse {
  status?: string;
  version?: string;
  edition?: string;
}

async function getJson(url: string, token: string | null): Promise<{ res: Response; json: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Basic ${Buffer.from(token).toString('base64')}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const json = await res.json().catch(() => null);
  return { res, json };
}
interface StatusOutcome {
  ok: boolean;
  kind?: SonarTestKind;
  message?: string;
  hint?: string;
  version?: string;
  edition?: string;
  status?: string;
}

/**
 * `/api/system/status` 读取：先匿名，被拒（401/403）才带 Token 重试一次——
 * 匿名可用时不把凭据发出去，这是「Token 只在需要时用」的口径。
 */
async function checkServerStatus(serverUrl: string, token: string | null): Promise<StatusOutcome> {
  const fail = (kind: SonarTestKind, message: string, hint: string): StatusOutcome => ({ ok: false, kind, message, hint });
  try {
    let { res, json } = await getJson(`${serverUrl}/api/system/status`, null);
    if (res.status === 401 || res.status === 403) {
      if (!token) return fail('auth-failed', `服务器要求认证（HTTP ${res.status}）`, '该实例禁止匿名读取，请在「认证 Token」里填写有权限的 Token。');
      ({ res, json } = await getJson(`${serverUrl}/api/system/status`, token));
      if (res.status === 401 || res.status === 403) {
        return fail('auth-failed', `Token 被拒绝（HTTP ${res.status}）`, '确认 Token 未过期且具有分析权限；匿名可读的实例可把 Token 留空。');
      }
    }
    if (!res.ok) return fail('unreachable', `服务器返回 HTTP ${res.status}`, '确认地址与端口正确，且 SonarQube 已启动。');
    const body = (json ?? {}) as StatusResponse;
    return { ok: true, version: body.version ?? '', edition: body.edition ?? '', status: body.status ?? '' };
  } catch (e) {
    const name = (e as Error)?.name;
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return fail(
      'unreachable',
      timedOut ? `连接超时（${Math.round(HTTP_TIMEOUT_MS / 1000)}s）` : `无法连接：${(e as Error)?.message ?? String(e)}`,
      '确认服务地址可达、端口开放，且本机未被代理/防火墙拦截。',
    );
  }
}

/** 三项连接测试，结果分别回显（PRD §3.4.1）；每类失败各给 kind 与可操作指引。 */
export async function testSonarConnection(input?: { serverUrl?: string; token?: string; projectKey?: string }): Promise<SonarTestResult> {
  const errors: SonarTestResult['errors'] = [];
  const out: SonarTestResult = { errors };
  const serverUrl = normalizeSonarUrl(input?.serverUrl ?? getSetting(SERVER_URL_KEY) ?? '');
  const draftToken = (input?.token ?? '').trim();
  const savedToken = tokenPlain();
  const projectKey = (input?.projectKey ?? '').trim() || Object.values(readProjectKeys())[0] || '';

  if (!serverUrl) {
    out.server = { ok: false };
    errors.push({ kind: 'unreachable', message: '未填写服务器地址', hint: '填写 http/https 地址后重试。' });
  } else {
    const server = await checkServerStatus(serverUrl, draftToken || savedToken);
    out.server = server.ok ? { ok: true, version: server.version, edition: server.edition, status: server.status } : { ok: false };
    if (!server.ok) errors.push({ kind: server.kind ?? 'unreachable', message: server.message ?? '', hint: server.hint ?? '' });
  }

  const scanner = await probeScanner();
  out.scanner = scanner.available ? { ok: true, version: scanner.version } : { ok: false };
  if (!scanner.available) {
    errors.push({ kind: 'no-scanner', message: scanner.resolved && scanner.version ? '扫描器执行失败' : '未找到可用的 sonar-scanner', hint: scanner.hint });
    // scanner 起不来时 Java 才是首要原因——只在 no-scanner 分支补报，正常环境不多起一个进程
    const java = await probeJava();
    out.java = { ok: java.available };
    if (!java.available) errors.push({ kind: 'no-java', message: '未探测到 Java 环境', hint: java.hint });
  }

  if (!out.server?.ok) {
    out.project = { ok: false, projectKey };
  } else if (!projectKey) {
    out.project = { ok: false, projectKey: '' };
    errors.push({ kind: 'project-not-found', message: '未配置 projectKey，无法验证项目可达性', hint: '在「默认 projectKey 映射」里为任一项目配置 projectKey 后重试。' });
  } else {
    try {
      // 与状态项同一口径：匿名优先，被拒才带 Token 重试——否则等于对可读实例无谓地送出凭据。
      // 重试用的 Token 也取「草稿优先，退回已存」：只填了草稿就能测通三项，不然服务器行绿、
      // 项目行永远 401（真机驱动 UI-24 抓到的就是这个不对称）。
      // PRD 原文写 `?keys=`；SonarQube 的 projects/show 实际参数是 `projectKey`（单键），按真实接口取
      const showUrl = `${serverUrl}/api/projects/show?projectKey=${encodeURIComponent(projectKey)}`;
      const retryToken = draftToken || savedToken;
      let { res, json } = await getJson(showUrl, null);
      if (retryToken && (res.status === 401 || res.status === 403)) {
        ({ res, json } = await getJson(showUrl, retryToken));
      }
      if (res.ok) out.project = { ok: true, projectKey };
      else if (res.status === 404) {
        out.project = { ok: false, projectKey };
        errors.push({ kind: 'project-not-found', message: `项目键不存在：${projectKey}`, hint: '到 SonarQube「项目」页核对 project key（不是项目显示名），或先在页面上创建项目。' });
      } else if (res.status === 401 || res.status === 403) {
        out.project = { ok: false, projectKey };
        errors.push({ kind: 'auth-failed', message: `项目校验被拒绝（HTTP ${res.status}）`, hint: '该 Token 无权查看此项目：换有权限的 Token，或在 SonarQube 里给项目授权。' });
      } else {
        out.project = { ok: false, projectKey };
        const msg = (json as { errors?: Array<{ msg: string }> } | null)?.errors?.[0]?.msg ?? '';
        errors.push({ kind: 'unreachable', message: `项目校验返回 HTTP ${res.status}${msg ? `（${msg}）` : ''}`, hint: '确认该 Token 有查看此项目的权限。' });
      }
    } catch (e) {
      out.project = { ok: false, projectKey };
      errors.push({ kind: 'unreachable', message: `项目校验失败：${(e as Error)?.message ?? String(e)}`, hint: '确认服务地址可达后重试。' });
    }
  }
  return out;
}

/** 扫描面板取数：项目对应的 Sonar projectKey，未配置回空串（面板据此行内提示去设置页） */
export function projectKeyFor(projectId: string): string {
  return readProjectKeys()[projectId] ?? '';
}
