/**
 * 八期 §3.4.1：设置页「SonarQube」子页的配置读写、Token 密文与查看审计、环境探测与连接测试。
 *
 * 口径来源（PRD v1.2）：
 *  - 服务器地址：URL 校验（http/https、去尾斜杠）；
 *  - Token：复用 `util/crypto.ts` 的 AES-256-GCM + `maskSecret`，默认脱敏，
 *    「查看原文」需二次确认**并写审计**（PRD 明确这是新增审计点，现有 API Key 查看通道不写审计，不算复用）；
 *  - 扫描器路径：留空按 PATH 与常见安装目录探测；
 *  - Java 环境：只读探测「扫描用得到的 JVM」，取数顺序是
 *    进程环境（JAVA_HOME/bin → PATH，条目里的 `%VAR%` 由我们自己展开）→ 注册表里的 JAVA_HOME
 *    （进程环境块陈旧时的权威值）→ 扫描器发布包自带的 jre（官方 zip 有 `<根>/jre/bin` 与
 *    `<根>/bin/jre/bin` 两种落位，都认）；三者都没有才判缺，且不代装。
 *    与「系统是否装了 Java」区分开：新版 scanner 自带运行时，此时系统没有 Java 也能扫；
 *  - projectKey 映射：项目 ↔ Sonar projectKey，未配置时扫描前必填（由扫描面板拦截）；
 *  - 扫描并发上限：默认 1、范围 1–2（写进 `exportGateLimit.sonar-scan`，与既有导出闸同一取数口径）；
 *  - 连接测试三项：system/status、scanner -v、components/show，失败 kind 分别为
 *    unreachable / auth-failed / no-scanner / no-java / project-not-found
 *    （项目项原用 projects/show，该 Web API 在新版 SonarQube 已整体下线——详见 testProjectPart）。
 *
 * 安全红线：Token 只以密文落 `app_settings`，明文既不回传（除 reveal 且已二次确认）也不入日志；
 * 服务地址里的 user:info 凭据一律拒绝（凭据应走 Token，写在 URL 里会进日志与外链）。
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection';
import { getSetting, setSetting } from './AppSettings';
import { encrypt, decrypt, maskSecret } from '../util/crypto';
import { sonarBasicAuth } from '../util/sonarAuth'; // T05689：Basic 头单源（token 作用户名、密码留空）

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
const PROBE_TTL_MS = 10 * 60_000;
/** 过期后仍可先回旧值的宽限：超过它才同步重探，避免无限期返回陈旧读数 */
const PROBE_STALE_MAX_MS = 24 * 60 * 60_000;

export type SonarTestKind = 'unreachable' | 'auth-failed' | 'no-scanner' | 'no-java' | 'project-not-found';

export class SonarConfigError extends Error {
  constructor(readonly kind: 'bad-url' | 'bad-limit' | 'bad-project-keys' | 'confirm-required' | 'no-token'
    | 'sonar-unreachable' | 'sonar-auth' | 'sonar-projects-response', message: string) {
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

/** SonarQube 项目下拉项：key 是保存进映射的值，name 只用于展示 */
export interface SonarProjectOption {
  key: string;
  name: string;
}

export interface SonarProjectsResult {
  serverUrl: string;
  projects: SonarProjectOption[];
  /** SonarQube 报告的项目总数；超出单页时前端要能看到还有截断 */
  total: number;
}

interface SonarProjectsResponse {
  paging?: { total?: number };
  components?: unknown;
  projects?: unknown;
}

function projectOptionsFrom(json: SonarProjectsResponse): { projects: SonarProjectOption[]; total: number } {
  const rows = Array.isArray(json.components) ? json.components : Array.isArray(json.projects) ? json.projects : [];
  const projects: SonarProjectOption[] = [];
  const seen = new Set<string>();
  for (const row of rows as Array<Record<string, unknown>>) {
    const key = typeof row?.key === 'string' ? row.key.trim() : '';
    if (!key || seen.has(key)) continue;
    // `/api/projects/search` 天然是项目；若换成 components 搜索，TRK 过滤也返回到这层
    if (typeof row?.qualifier === 'string' && row.qualifier !== 'TRK') continue;
    seen.add(key);
    projects.push({ key, name: typeof row?.name === 'string' && row.name.trim() ? row.name.trim() : key });
  }
  const totalRaw = Number(json.paging?.total);
  const total = Number.isInteger(totalRaw) && totalRaw >= projects.length ? totalRaw : projects.length;
  projects.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.key.localeCompare(b.key));
  return { projects, total };
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

/**
 * SonarQube 25.x 起所有 Token 都带 `sqX_` 前缀（squ_ 用户 / sqp_ 项目分析 / sqa_ 全局分析）+ 长 hex 载荷。
 * 设置页「认证 Token」与「Sonar project key」两个框紧邻，真机出现过 Token 被贴进 projectKey 框：
 * 那串会既作为 URL query 发给服务器（进对方访问日志），又被原样回显在连接测试的报错文案里，
 * 等于把凭据扩散到两处非密文位置。只认「前缀 + 足够长的 hex」，`MTask` 这类正常 key 不会误判。
 */
const SONAR_TOKEN_SHAPE = /^sq[a-z]_[0-9a-f]{24,}$/i;
/**
 * T04477：从 sonarSettings 导出，供扫描链路复用同一判据——
 * 保存层拦住了新写入，但**已落库的脏值**仍会被扫描当项目键用；扫描侧必须独立再拦一次，
 * 否则一次扫描就把凭据拼进 `-Dsonar.projectKey` 送给外部服务器。
 */
export function looksLikeSonarToken(value: string): boolean {
  return SONAR_TOKEN_SHAPE.test(value.trim());
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
    if (trimmed && looksLikeSonarToken(trimmed)) {
      throw new SonarConfigError('bad-project-keys', `projectKey 映射非法：项目 ${projectId} 的值是 Token 形态（sqX_ 前缀），不是 project key——Token 请填在「认证 Token」框`);
    }
    if (trimmed) out[projectId] = trimmed;
  }
  setSetting(PROJECT_KEYS_KEY, JSON.stringify(out));
  return out;
}

function readScanLimit(): number {
  const raw = getSetting(SCAN_LIMIT_KEY);
  const n = raw === null ? Number.NaN : Number(raw);
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
/** 同键并发探测合并：过期瞬间多个请求不应各起一个进程 */
const probeInflight = new Map<string, Promise<SonarProbe>>();

export function clearSonarProbeCache(): void {
  probeCache.clear();
  probeInflight.clear();
  // 注册表那条回落也要跟着重读：用户装完 JDK 点「重新探测」时，不该再吃十分钟前的「没配 JAVA_HOME」
  registryJavaHomeMemo = null;
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
const JAVA_MISSING_HINT = '未探测到 Java：系统 PATH、JAVA_HOME/bin、注册表里的 JAVA_HOME 与扫描器自带 jre 都没有 java。'
  + '新版 SonarScanner Windows 发布包自带运行时，只有你用的那份不带 jre 时才需要 JDK 11+；安装后点「重新探测」，本工具不提供安装。';

const firstLine = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';

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
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
    .map((raw) => expandEnvTokens(raw, env))
    .filter(Boolean);
  const names = process.platform === 'win32' ? SCANNER_NAMES : ['sonar-scanner'];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/** Windows 文件系统里扫描器的候选拼写（官方发布包只有 `sonar-scanner.bat`） */
const SCANNER_NAMES = ['sonar-scanner.bat', 'sonar-scanner.exe', 'sonar-scanner.cmd', 'sonar-scanner'];

/** 在某个目录里找扫描器：先看 `<目录>/bin`，再看目录自身（少数安装器把脚本直接铺在根下） */
function scannerInDir(dir: string): string {
  for (const sub of [path.join(dir, 'bin'), dir]) {
    for (const name of SCANNER_NAMES) {
      const candidate = path.join(sub, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/**
 * 常见安装目录探测（PATH 未命中时的兜底，T04501）。
 * 官方 zip 常被直接解压到 `%USERPROFILE%` / `C:\`，choco、scoop 装的也可能没进系统 PATH；
 * 只认 PATH 会把「装了但没配 PATH」误判成「没装」，用户最终只看到运行期一句 spawn ENOENT。
 */
export function findScannerInCommonDirs(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'win32') return '';
  const home = (env.USERPROFILE ?? '').trim();
  const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]
    .map((v) => (v ?? '').trim()).filter(Boolean);
  const direct: string[] = [];
  for (const base of programFiles) direct.push(path.join(base, 'SonarScanner'), path.join(base, 'sonar-scanner'));
  if (home) direct.push(path.join(home, 'sonar-scanner'));
  if (env.LOCALAPPDATA) direct.push(path.join(env.LOCALAPPDATA, 'Programs', 'sonar-scanner'), path.join(env.LOCALAPPDATA, 'Programs', 'SonarScanner'));
  // 包管理器把包装脚本铺在这两个固定目录：装了但没进 PATH 时最常见的两处
  if (env.ProgramData) direct.push(path.join(env.ProgramData, 'chocolatey', 'bin'));
  if (home) direct.push(path.join(home, 'scoop', 'shims'));
  for (const dir of direct) {
    const hit = scannerInDir(dir);
    if (hit) return hit;
  }
  // 版本化目录（`sonar-scanner-6.x-windows`）按前缀枚举常见父目录，只认这一种命名，避免扫出一堆无关目录
  const parents = [...programFiles, home, env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : '', path.parse(env.SystemRoot ?? 'C:\\Windows').root]
    .filter(Boolean);
  for (const parent of parents) {
    let names: string[];
    try { names = readdirSync(parent); } catch { continue; }
    for (const name of names) {
      if (!/^sonar-scanner/i.test(name)) continue;
      const hit = scannerInDir(path.join(parent, name));
      if (hit) return hit;
    }
  }
  return '';
}

export type ScannerBinSource = 'configured' | 'path' | 'common' | 'none';

/** 扫描器可执行文件的解析结果；source 用来解释「这条路径是从哪来的」，避免用户不知道它靠的兜底 */
export interface ScannerBinResolution {
  bin: string;
  source: ScannerBinSource;
}

/**
 * 扫描器路径解析（T04501）：设置页配置 → PATH → 常见安装目录。
 * 扫描执行与设置页探测必须共用这一套取数口径，否则会出现「探测说没有、扫描偶尔又能跑」的分裂。
 */
export function resolveScannerBin(configured?: string, env: NodeJS.ProcessEnv = process.env): ScannerBinResolution {
  // 从资源管理器复制路径时常带首尾引号；陈旧环境块里的 `%VAR%` 也不会被展开，这里一并归一
  const wanted = expandEnvTokens(String(configured ?? '').trim().replace(/^"(.*)"$/, '$1'), env);
  if (wanted && existsSync(wanted)) return { bin: wanted, source: 'configured' };
  const onPath = findScannerOnPath(env);
  if (onPath) return { bin: onPath, source: 'path' };
  const common = findScannerInCommonDirs(env);
  if (common) return { bin: common, source: 'common' };
  return { bin: '', source: 'none' };
}

/**
 * PATH / JAVA_HOME 里的 `%VAR%` 字面量要自己展开：Windows 只在「该变量已定义」时替它展开，
 * 进程环境陈旧或被裁剪时原文会原样落进 PATH（本机实测：`%JAVA_HOME%\bin`、`%JAVA_HOME%\jre\bin`
 * 两条原样躺在 PATH 里，而 JAVA_HOME 是空的），于是 `existsSync` 恒假——装了 JDK 也探不到。
 * 只做同名变量的文本替换（变量名大小写不敏感，与 Windows 一致），不做任何 shell 求值；
 * 引用不到的变量保留原文而不是塌成空串——塌空的 `\bin` 会相对当前工作目录去 stat，反而可能凭空命中。
 */
export function expandEnvTokens(value: string, env: NodeJS.ProcessEnv): string {
  if (!value || !value.includes('%')) return value ?? '';
  const upper = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') upper.set(k.toUpperCase(), v);
  return value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name: string) => upper.get(name.toUpperCase()) ?? match);
}

/** java 可执行文件的候选拼写：Windows 上只认裸名 `java` 会漏掉 `.exe` 之外的包装脚本 */
const JAVA_NAMES = process.platform === 'win32' ? ['java.exe', 'java.bat', 'java.cmd', 'java'] : ['java'];

/**
 * 探测 java 可执行文件：先看 `JAVA_HOME/bin`，再按 PATH 目录逐项 stat。
 * 只认 `java` 裸名会让「装了 JDK 但没把 bin 加进 PATH」这一常见 Windows 形态被误判成「没有 Java」——
 * 而扫描引擎把 Java 当作硬前提，误判等于整条功能链在用户侧凭空消失。
 */
export function findJavaExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const dirs: string[] = [];
  const home = expandEnvTokens((env.JAVA_HOME ?? '').trim(), env);
  if (home) dirs.push(path.join(home, 'bin'));
  for (const raw of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    const dir = expandEnvTokens(raw, env);
    if (dir) dirs.push(dir);
  }
  for (const dir of dirs) {
    for (const name of JAVA_NAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/** 注册表里存放环境变量的两个键：Machine 是权威值，User 在其后（同名时 Machine 优先） */
const REG_ENV_HIVES = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
];
const REG_ENV_TTL_MS = 10 * 60 * 1000;
let registryJavaHomeMemo: { at: number; value: string } | null = null;

/**
 * 解析 `reg query <键> /v <名>` 的文本输出，取 `NAME  REG_SZ|REG_EXPAND_SZ  值` 那一行。
 * REG_EXPAND_SZ 保留原样（`%VAR%` 由 expandEnvTokens 负责），读不到一律回空串。
 */
export function parseRegEnvValue(raw: string, name: string): string {
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/.exec(line);
    if (m && m[1].toUpperCase() === name.toUpperCase()) return m[2].trim();
  }
  return '';
}

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const cb = (err: unknown, stdout: string) => resolve(err ? '' : String(stdout ?? ''));
    try {
      execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, cb);
    } catch {
      resolve('');
    }
  });
}

/**
 * 进程环境拿不到 JAVA_HOME 时的权威回落。
 * JDK 装好后 MTask 仍看不到它，有两种真实成因：安装程序只写了注册表、没广播 WM_SETTINGCHANGE
 * （Explorer 及其派生进程的环境块还是旧的），或应用由一个早于安装的祖先进程拉起。
 * 负结果同样记账（真没装时不反复起 reg.exe）；非 Windows、reg 缺失或被拒绝都回空串，不改原判据。
 */
export async function registryJavaHome(): Promise<string> {
  if (process.platform !== 'win32') return '';
  if (registryJavaHomeMemo && Date.now() - registryJavaHomeMemo.at < REG_ENV_TTL_MS) return registryJavaHomeMemo.value;
  let found = '';
  for (const hive of REG_ENV_HIVES) {
    const value = parseRegEnvValue(await execText('reg.exe', ['query', hive, '/v', 'JAVA_HOME']), 'JAVA_HOME');
    if (value) { found = value; break; }
  }
  registryJavaHomeMemo = { at: Date.now(), value: found };
  return found;
}

/**
 * 官方 Windows 发布包（sonar-scanner 6.x 起）在 `<扫描器根>/jre/bin/java.exe` 自带运行时，
 * 系统里没有 Java 也照样能扫。把「扫描是否需要 Java」等同于「系统是否装了 Java」，
 * 会让这种形态既被设置页判成缺环境，又被扫描预检用 `no-java` 400 拦下真正能跑的扫描。
 */
export function findScannerBundledJre(scannerBin: string): string {
  const bin = (scannerBin ?? '').trim();
  if (!bin) return '';
  const home = path.dirname(path.dirname(bin)); // `<根>/bin/sonar-scanner(.bat)` → `<根>`
  for (const sub of [path.join(home, 'jre', 'bin'), path.join(home, 'bin', 'jre', 'bin')]) {
    for (const name of JAVA_NAMES) {
      const candidate = path.join(sub, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/** 当前会被用于扫描的扫描器可执行文件（配置 → PATH → 常见目录），供「自带 JRE」判定复用同一取数口径 */
function currentScannerBin(): string {
  return resolveScannerBin(getSetting(SCANNER_PATH_KEY) ?? '').bin;
}

type JavaSource = 'system' | 'registry' | 'scanner-jre';

/** 按「进程环境 → 注册表 → 扫描器自带 jre」逐级找 java，返回命中的可执行文件与其来源 */
async function resolveJavaCandidate(javaHomeFromRegistry: () => Promise<string>): Promise<{ bin: string; source: JavaSource }> {
  const direct = findJavaExecutable();
  if (direct) return { bin: direct, source: 'system' };
  const home = await javaHomeFromRegistry();
  if (home) {
    const hit = findJavaExecutable({ ...process.env, JAVA_HOME: home });
    if (hit) return { bin: hit, source: 'registry' };
  }
  const bundled = findScannerBundledJre(currentScannerBin());
  if (bundled) return { bin: bundled, source: 'scanner-jre' };
  return { bin: '', source: 'system' };
}

export async function probeJava(
  javaBin?: string,
  deps?: { javaHomeFromRegistry?: () => Promise<string> },
): Promise<SonarProbe> {
  const configured = (javaBin ?? '').trim();
  // 显式传入=按这条命令探测（老用法，供「换一台 java」的排障场景），不走注册表/自带 JRE 回落
  if (configured) return probeJavaBin(configured, 'system');
  const { bin, source } = await resolveJavaCandidate(deps?.javaHomeFromRegistry ?? registryJavaHome);
  if (!bin) return { available: false, resolved: '', version: '', hint: JAVA_MISSING_HINT };
  return probeJavaBin(bin, source);
}

function probeJavaBin(bin: string, source: JavaSource): Promise<SonarProbe> {
  return probeWithCache(`java:${bin}`, async () => {
    const res = await execVersion(bin, ['-version']);
    return {
      available: res.ok,
      resolved: res.ok ? bin : '',
      version: res.ok ? res.out : '',
      // 可用时的 hint 只用来交代「这条 java 是从哪来的」——系统通道没命中不是可以瞒过去的事，
      // 否则用户看到一行绿字，却不知道它靠的是扫描器自带运行时。
      hint: res.ok ? javaSourceNote(source, bin) : probeHint('Java', res) || JAVA_MISSING_HINT,
    };
  });
}

function javaSourceNote(source: JavaSource, bin: string): string {
  if (source === 'registry') return `进程环境未继承 JAVA_HOME（陈旧环境块或未展开的 %JAVA_HOME%），改用注册表值：${bin}`;
  if (source === 'scanner-jre') return `系统 PATH/JAVA_HOME 未命中，改用扫描器自带 JRE：${bin}（该发布包不依赖系统 Java）`;
  return '';
}

/** 单飞刷新：同键并发只跑一次探测，成功后写回缓存；失败清 inflight 让下次可重试 */
function refreshProbe(key: string, compute: () => Promise<SonarProbe>): Promise<SonarProbe> {
  const running = probeInflight.get(key);
  if (running) return running;
  const p = compute().then(
    (value) => { probeCache.set(key, { at: Date.now(), value }); probeInflight.delete(key); return value; },
    (e) => { probeInflight.delete(key); throw e; },
  );
  probeInflight.set(key, p);
  return p;
}

async function probeWithCache(key: string, compute: () => Promise<SonarProbe>): Promise<SonarProbe> {
  const hit = probeCache.get(key);
  if (hit) {
    const age = Date.now() - hit.at;
    if (age < PROBE_TTL_MS) return hit.value;
    if (age < PROBE_STALE_MAX_MS) {
      // 过期但未超宽限：先回旧值让页签即时可用，后台刷新（失败保留旧值，不打扰用户）
      void refreshProbe(key, compute).catch(() => {});
      return hit.value;
    }
  }
  return refreshProbe(key, compute);
}

/** 扫描器缺失时的统一文案：探测失败与「根本没探测到」共用一句，避免两处指引不同 */
const SCANNER_MISSING_HINT = '未找到 sonar-scanner：请在「扫描器路径」填写可执行文件全路径，'
  + '或把 sonar-scanner/bin 加入系统 PATH（也支持 Program Files、用户目录等常见安装位置，留空会自动探测）。';

export async function probeScanner(scannerPathConfig?: string): Promise<SonarProbe> {
  const configured = (scannerPathConfig ?? getSetting(SCANNER_PATH_KEY) ?? '').trim();
  const resolution = resolveScannerBin(configured);
  const resolved = resolution.bin;
  if (!resolved) {
    // 配置了路径却一个都没探到：必须点名那条路径，否则用户只看到笼统的「未找到」，
    // 分不清是自己填错还是机器上确实没装。
    const deadPath = configured ? `「扫描器路径」配置的 ${configured} 不存在或不可执行；` : '';
    return { available: false, resolved: '', version: '', hint: deadPath + SCANNER_MISSING_HINT };
  }
  return probeWithCache(`scanner:${resolved}`, async () => {
    const res = await execVersion(resolved, ['-v']);
    return {
      available: res.ok,
      resolved: res.ok ? resolved : '',
      version: res.ok ? res.out : '',
      hint: res.ok ? scannerSourceNote(resolution, configured) : probeHint('扫描器', res)
        || `扫描器执行 \`sonar-scanner -v\` 失败（${resolved}）：确认该路径是可运行的 SonarScanner CLI，且 Java 环境可用。`,
    };
  });
}

/** 可用时交代「这条路径从哪来」：配置路径失效或走了常见目录兜底都要写明，不能只给一行绿字 */
function scannerSourceNote(resolution: ScannerBinResolution, configured: string): string {
  if (resolution.source === 'path' && configured) {
    return `「扫描器路径」配置的 ${configured} 不存在或不可执行，已改用 PATH 探测到的：${resolution.bin}`;
  }
  if (resolution.source === 'common') {
    return `PATH 未命中，已改用常见安装目录探测到的：${resolution.bin}（建议把该目录加入系统 PATH，或填进「扫描器路径」）`;
  }
  return '';
}

export async function getSonarConfigView(): Promise<SonarConfigView> {
  const plain = tokenPlain();
  const scanLimit = readScanLimit();
  const gateRaw = getSetting(`exportGateLimit.${SONAR_SCAN_GATE}`);
  const gateParsed = gateRaw === null ? Number.NaN : Number(gateRaw);
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
  // T05689：必须经 sonarBasicAuth 补 `token:` 的冒号——裸 token 的 base64 会被 Sonar 判成 401
  if (token) headers.Authorization = sonarBasicAuth(token);
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

/** 服务器项：未填地址直接记错；否则匿名优先探测，失败按 kind 回填。 */
async function testServerPart(
  serverUrl: string,
  token: string | null,
  errors: SonarTestResult['errors'],
): Promise<SonarTestResult['server']> {
  if (!serverUrl) {
    errors.push({ kind: 'unreachable', message: '未填写服务器地址', hint: '填写 http/https 地址后重试。' });
    return { ok: false };
  }
  const server = await checkServerStatus(serverUrl, token);
  if (!server.ok) errors.push({ kind: server.kind ?? 'unreachable', message: server.message ?? '', hint: server.hint ?? '' });
  return server.ok ? { ok: true, version: server.version, edition: server.edition, status: server.status } : { ok: false };
}

/** 扫描器项（连带 Java 项）：scanner 起不来时 Java 才是首要原因，只在失败分支补探一次。 */
async function testScannerPart(errors: SonarTestResult['errors']): Promise<Pick<SonarTestResult, 'scanner' | 'java'>> {
  const scanner = await probeScanner();
  if (scanner.available) return { scanner: { ok: true, version: scanner.version } };
  errors.push({ kind: 'no-scanner', message: scanner.resolved && scanner.version ? '扫描器执行失败' : '未找到可用的 sonar-scanner', hint: scanner.hint });
  // 正常环境不多起一个进程：只有 scanner 探不到时才需要追查 Java
  const java = await probeJava();
  if (!java.available) errors.push({ kind: 'no-java', message: '未探测到 Java 环境', hint: java.hint });
  return { scanner: { ok: false }, java: { ok: java.available } };
}

/** components/show 取数：匿名优先，被拒（401/403）且带 Token 时才重试一次。 */
async function fetchComponentShow(showUrl: string, token: string | null): Promise<{ res: Response; json: unknown }> {
  const first = await getJson(showUrl, null);
  if (token && (first.res.status === 401 || first.res.status === 403)) return getJson(showUrl, token);
  return first;
}

/** SonarQube 错误体的第一条 msg：带上它，「端点不存在」这类版本问题才不会被说成「你的键填错了」。 */
function sonarErrorSuffix(json: unknown): string {
  const msg = (json as { errors?: Array<{ msg?: string }> } | null)?.errors?.[0]?.msg ?? '';
  return msg ? `（SonarQube：${msg}）` : '';
}

/**
 * 读取 SonarQube 项目键列表（T04545）。
 *
 * 草稿地址/Token 优先，用于「还没保存就能选」；已存 Token 在服务端内部解密，不经前端。
 * 拼接走 `/api/projects/search?ps=500&qualifiers=TRK`，仍用连接测试同源的归一地址规则，
 * 避免 context path / 尾斜杠造成第二套 URL 口径。
 */
export async function listSonarProjects(input?: {
  serverUrl?: string;
  token?: string;
  search?: string;
}): Promise<SonarProjectsResult> {
  const serverUrl = normalizeSonarUrl(input?.serverUrl ?? getSetting(SERVER_URL_KEY) ?? '');
  if (!serverUrl) throw new SonarConfigError('bad-url', '未填写 SonarQube 服务器地址，无法读取项目列表');
  const query = new URLSearchParams({ ps: '500', qualifiers: 'TRK' });
  const search = (input?.search ?? '').trim();
  if (search) query.set('q', search);
  const url = `${serverUrl}/api/projects/search?${query.toString()}`;
  const draftToken = (input?.token ?? '').trim();
  const retryToken = draftToken || tokenPlain();

  let response: Awaited<ReturnType<typeof getJson>>;
  try {
    response = await getJson(url, null);
    if (response.res.status === 401 || response.res.status === 403) {
      if (!retryToken) throw new SonarConfigError('no-token', `SonarQube 要求认证（HTTP ${response.res.status}）`);
      response = await getJson(url, retryToken);
      if (response.res.status === 401 || response.res.status === 403) {
        // T05689 二轮：401 修好后出现 403 —— 多为「项目分析令牌」无权浏览 api/projects/search。
        // 降级到 components/search（部分部署对该端点放行，TRK 结果同义）；仍被拒就给可操作指引，
        // 而不是把裸 403 丢给用户——projectKey 输入框本就允许手输，读取列表只提供候选。
        if (response.res.status === 403) {
          const altQuery = new URLSearchParams({ ps: '500', qualifiers: 'TRK' });
          if (search) altQuery.set('q', search);
          const altUrl = `${serverUrl}/api/components/search?${altQuery.toString()}`;
          let alt = await getJson(altUrl, null);
          if ((alt.res.status === 401 || alt.res.status === 403) && retryToken) alt = await getJson(altUrl, retryToken);
          if (alt.res.ok) {
            const json = alt.json as { components?: Array<{ key?: string; name?: string }>; paging?: { total?: number } } | null;
            const list = (json?.components ?? [])
              .filter((c): c is { key: string; name?: string } => typeof c.key === 'string' && c.key.length > 0)
              .map((c) => ({ key: c.key, name: c.name ?? c.key }));
            return { serverUrl, projects: list, total: json?.paging?.total ?? list.length };
          }
        }
        throw new SonarConfigError('sonar-auth', `读取项目列表被拒绝（HTTP ${response.res.status}）`
          + (response.res.status === 403
            ? '：当前 Token 多半是「项目分析令牌」，无浏览项目列表的权限。请在 SonarQube「我的账号 → 安全」改用 User Token，或在下方 projectKey 输入框手动填写（读取列表只提供候选，不影响扫描）'
            : '：请检查 Token 是否有效'));
      }
    }
    if (!response.res.ok) {
      throw new SonarConfigError('sonar-unreachable', `读取项目列表失败（HTTP ${response.res.status}）${sonarErrorSuffix(response.json)}`);
    }
  } catch (e) {
    if (e instanceof SonarConfigError) throw e;
    const name = (e as Error)?.name;
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    throw new SonarConfigError(
      'sonar-unreachable',
      timedOut ? `读取项目列表超时（${Math.round(HTTP_TIMEOUT_MS / 1000)}s）` : `无法连接 SonarQube：${(e as Error)?.message ?? String(e)}`,
    );
  }

  const body = (response.json ?? {}) as SonarProjectsResponse;
  if (!body.components && !body.projects) {
    throw new SonarConfigError('sonar-projects-response', 'SonarQube 项目列表响应格式不符合预期');
  }
  const { projects, total } = projectOptionsFrom(body);
  return { serverUrl, projects, total };
}

/** 项目项：服务器不通或未配 projectKey 时直接给结论；否则按 HTTP 状态分别归因。 */
async function testProjectPart(
  serverUrl: string,
  projectKey: string,
  token: string | null,
  serverOk: boolean,
  errors: SonarTestResult['errors'],
): Promise<SonarTestResult['project']> {
  if (!serverOk) return { ok: false, projectKey };
  if (!projectKey) {
    errors.push({ kind: 'project-not-found', message: '未配置 projectKey，无法验证项目可达性', hint: '在「默认 projectKey 映射」里为任一项目配置 projectKey 后重试。' });
    return { ok: false, projectKey: '' };
  }
  // Token 形态的值不发给服务器、也不回显：映射里那份会被保存拦截，未保存的草稿走这条兜底。
  if (looksLikeSonarToken(projectKey)) {
    errors.push({ kind: 'project-not-found', message: '「Sonar project key」里填的是 Token 形态的值（sqX_ 前缀），已拒绝外发', hint: 'Token 只填在「认证 Token」框；project key 在 SonarQube「项目 → 标记为项目」处，形如 MTask。' });
    return { ok: false, projectKey: '' };
  }
  try {
    // 与状态项同一口径：匿名优先，被拒才带 Token 重试——否则等于对可读实例无谓地送出凭据。
    // 重试用的 Token 也取「草稿优先，退回已存」：只填了草稿就能测通三项，不然服务器行绿、
    // 项目行永远 401（真机驱动 UI-24 抓到的就是这个不对称）。
    // 端点取 `components/show?component=`（单键）：PRD 原文写的 projects/show 在新版
    // SonarQube（实测 26.1.0.118079）已整体下线，匿名请求直接回 404「Unknown url」——
    // 旧拼接会把任何正确的 key 都判成「项目键不存在」，把服务版本问题伪装成用户的填写错误。
    const showUrl = `${serverUrl}/api/components/show?component=${encodeURIComponent(projectKey)}`;
    const { res, json } = await fetchComponentShow(showUrl, token);
    if (res.ok) return { ok: true, projectKey };
    if (res.status === 404) {
      errors.push({ kind: 'project-not-found', message: `项目键不存在：${projectKey}${sonarErrorSuffix(json)}`, hint: '到 SonarQube「项目」页核对 project key（不是项目显示名），或先在页面上创建项目。' });
    } else if (res.status === 401 || res.status === 403) {
      errors.push({ kind: 'auth-failed', message: `项目校验被拒绝（HTTP ${res.status}）`, hint: '该 Token 无权查看此项目：换有权限的 Token，或在 SonarQube 里给项目授权。' });
    } else {
      errors.push({ kind: 'unreachable', message: `项目校验返回 HTTP ${res.status}${sonarErrorSuffix(json)}`, hint: '确认该 Token 有查看此项目的权限。' });
    }
    return { ok: false, projectKey };
  } catch (e) {
    errors.push({ kind: 'unreachable', message: `项目校验失败：${(e as Error)?.message ?? String(e)}`, hint: '确认服务地址可达后重试。' });
    return { ok: false, projectKey };
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
  const retryToken = draftToken || savedToken;

  out.server = await testServerPart(serverUrl, retryToken, errors);
  const scannerPart = await testScannerPart(errors);
  out.scanner = scannerPart.scanner;
  if (scannerPart.java) out.java = scannerPart.java;
  out.project = await testProjectPart(serverUrl, projectKey, retryToken, out.server?.ok === true, errors);
  return out;
}

/** 扫描面板取数：项目对应的 Sonar projectKey，未配置回空串（面板据此行内提示去设置页） */
export function projectKeyFor(projectId: string): string {
  return readProjectKeys()[projectId] ?? '';
}
