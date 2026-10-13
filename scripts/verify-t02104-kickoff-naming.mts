/**
 * T02104 门：交付命名与令牌换文件（PRD §3.5 FR-5 / 技术方案 §2.4）。
 *
 * 断言：
 *   S 组 源码守卫：白名单与清洗口径单源（分叉的真实后果是下载静默回退成 xlsx 兜名）、
 *                  kickoffFileName 走清洗、A-2 裁决的「复用 ai-download、不新增端点」仍在位。
 *   U 组 downloadSafeName 纯函数：脏名字段级处置 + 属性测试（30+ 脏名洗后必然过白名单）+
 *                  反例钉（未洗的名字确实过不了白名单，证明清洗不是臆想出来的需求）。
 *   N 组 kickoffFileName：§2.4 形态 `项目启动会-<项目名>-<YYYYMMDD>.pptx` 逐字钉 + 脏名项目可下载。
 *   E 组 隔离实例真端点：清洗后的中文名换回文件（Content-Type/Content-Disposition/RFC5987 还原）、
 *                  未清洗脏名被白名单挡下并回退兜名、下载即删。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/verify-t02104-kickoff-naming.mts
 * 环境变量：`T02104_PORT`（默认随机 39800+rand300）。
 * 隔离纪律（skill 红线 8）：库副本/端口/临时目录全临时；本门不调模型（零配额）。
 * 结果落 .workbuddy/t02104-gate-results.txt。
 */
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02104_PORT ?? 39_800 + Math.floor(Math.random() * 300));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02104-naming-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const TMP_DIR = join(DATA_DIR, 'tmp');
const OUT = join(ROOT, '.workbuddy', 't02104-gate-results.txt');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const U = await import('../server/src/util/export-name.ts');
const S = await import('../server/src/services/kickoffService.ts');

const UTIL = readFileSync(join(ROOT, 'server', 'src', 'util', 'export-name.ts'), 'utf8');
const PLANS = readFileSync(join(ROOT, 'server', 'src', 'routes', 'plans.ts'), 'utf8');
const INDEX = readFileSync(join(ROOT, 'server', 'src', 'routes', 'index.ts'), 'utf8');
const EST = readFileSync(join(ROOT, 'server', 'src', 'routes', 'estimates.ts'), 'utf8');
const SVC = readFileSync(join(ROOT, 'server', 'src', 'services', 'kickoffService.ts'), 'utf8');

// =====================================================================
// S 组：源码/契约守卫
// =====================================================================
const OLD_INLINE_RE_TEXT = '[\\w\\-.()·\\u4e00-\\u9fa5 ]+\\.(xlsx|docx|pdf|pptx)';
ok('S-01 下载白名单在 util 单源定义（正则只此一份，index.ts 不再留内联副本）',
  /export const DOWNLOAD_NAME_RE = /.test(UTIL) && UTIL.includes(OLD_INLINE_RE_TEXT) && !INDEX.includes(OLD_INLINE_RE_TEXT),
  { inUtil: UTIL.includes(OLD_INLINE_RE_TEXT), inIndex: INDEX.includes(OLD_INLINE_RE_TEXT) });
ok('S-02 下载端点改用 DOWNLOAD_NAME_RE（不再内联第二份正则）',
  /DOWNLOAD_NAME_RE\.test\(filename\)/.test(INDEX) && /from '\.\.\/util\/export-name'/.test(INDEX));
ok('S-03 kickoffFileName 走 downloadSafeName（不再裸拼项目名进文件名）',
  /downloadSafeName\(/.test(SVC.slice(SVC.indexOf('export function kickoffFileName'))) &&
  /from '\.\.\/util\/export-name'/.test(SVC));
ok('S-04 safeExportName 单源：plans.ts 不再定义、estimates.ts 从 util 取（口径不双份）',
  !/export function safeExportName/.test(PLANS) && /safeExportName/.test(PLANS) &&
  /from '\.\.\//.test(EST) && !/safeExportName.*from '\.\/plans'/.test(EST));
ok('S-05 A-2 裁决未走偏：没有新增 kickoff-ppt-download 端点（复用 /report/ai-download）',
  !/kickoff-ppt-download/.test(PLANS) && !/kickoff-ppt-download/.test(INDEX));
ok('S-06 清洗与白名单同源的机理在注释里写明（分叉后果是静默回退兜名，不是名字难看）',
  /MTask-ai-report\.xlsx/.test(UTIL) && /回退/.test(UTIL));

// =====================================================================
// U 组：downloadSafeName 纯函数（字段级处置 + 属性测试）
// =====================================================================
ok('U-01 常规名逐字不动（清洗不该动合法字符）',
  U.downloadSafeName('项目启动会-mtask五期-20261013', '项目启动会') === '项目启动会-mtask五期-20261013');
ok('U-02 路径分隔与控制字符逐个换成 -（防 ../ 与换行注入）',
  U.downloadSafeName('a/b\\c:d*e?f"g<h>i|j\nk', 'x') === 'a-b-c-d-e-f-g-h-i-j-k');
ok('U-03 白名单外字符被处置（& # + 全角括号 中文标点 全角空格 emoji）',
  (() => {
    const dirty = '五期&A&B<C>#1 项目（kickoff） 测试 +emoji😀';
    return U.downloadSafeName(dirty, 'x').split('').every((ch) => /[A-Za-z0-9_\-().·\u4e00-\u9fa5 ]/.test(ch));
  })());
ok('U-04 前导点/尾随分隔剥掉（防 "..pptx" 与以 - 收尾的怪名）',
  U.downloadSafeName('..甲..', 'x') === '甲' && U.downloadSafeName('乙--', 'x') === '乙');
ok('U-05 洗空了才用兜名（兜名本身必须过白名单）',
  U.downloadSafeName('///***???', '项目启动会') === '项目启动会' &&
  U.downloadSafeName('', '项目启动会') === '项目启动会' &&
  U.DOWNLOAD_NAME_RE.test(`${U.downloadSafeName('', '项目启动会')}.pptx`));
ok('U-06 长度上限 80 且截断后仍过白名单',
  (() => {
    const long = U.downloadSafeName('项'.repeat(200), 'x');
    return long.length === 80 && U.DOWNLOAD_NAME_RE.test(`${long}.pptx`);
  })());
ok('U-07 连续分隔折叠（a//b → a-b，不是 a--b）', U.downloadSafeName('a//b', 'x') === 'a-b');
ok('U-08 属性测试：30+ 脏名洗后 + .pptx 必然通过下载白名单',
  (() => {
    const nasty = ['a/b', 'c:d', 'e*f', 'g?h', 'i"j', 'k<l>m', 'n|o', 'p\nq', '  空格  项目  ',
      '&amp&', '#1 期', 'kickoff+v1', '（全角括号）', '【中括号】', '《书名号》', '，、；：！？',
      '😀emoji', '混CLEAN中文', '..lead', 'trail..', 'a'.repeat(300), '项目启动会'.repeat(40),
      '\\\\双反斜杠', '%percent%', "'quote'", 'tab\tsep', 'null\0char', '中文-下划_线.点', '·间隔号·',
      '(半角括号)', '五期 2026-10-13'];
    return nasty.every((n) => U.DOWNLOAD_NAME_RE.test(`${U.downloadSafeName(n, '项目启动会')}.pptx`));
  })());
ok('U-09 反例钉：未清洗的脏名 + .pptx 确实过不了白名单（证明清洗是必需而非臆想）',
  ['五期&kickoff.pptx', '项目（五期）.pptx', 'a/b.pptx', '五期【2026】.pptx', 'a%b.pptx']
    .every((n) => !U.DOWNLOAD_NAME_RE.test(n)));
ok('U-10 下载端点的兜名分支真实存在（不清洗就会命中它：内容 pptx、名字 xlsx）',
  /MTask-ai-report\.xlsx/.test(INDEX) && !U.DOWNLOAD_NAME_RE.test('五期&kickoff.pptx'));

// =====================================================================
// N 组：kickoffFileName（§2.4 形态）
// =====================================================================
ok('N-01 正常项目名逐字钉：项目启动会-<项目名>-<YYYYMMDD>.pptx（与 T02103 O-12 同钉防回归）',
  S.kickoffFileName('mtask五期', '2026-10-13') === '项目启动会-mtask五期-20261013.pptx');
ok('N-02 脏名项目出稿名仍可下载（含 / : & （） 仍过白名单）',
  (() => {
    const f = S.kickoffFileName('五期/启动：A&B（草稿）', '2026-10-13');
    return U.DOWNLOAD_NAME_RE.test(f) && f.endsWith('.pptx') && f.includes('20261013');
  })(), S.kickoffFileName('五期/启动：A&B（草稿）', '2026-10-13'));
ok('N-03 名字永远以 项目启动会- 起手或就是兜名（前缀不被清洗吃掉）',
  S.kickoffFileName('mtask五期', '2026-10-13').startsWith('项目启动会-') &&
  U.DOWNLOAD_NAME_RE.test(S.kickoffFileName('', '2026-10-13')));
ok('N-04 日期串保头去横杠（YYYYMMDD），空日期不产生尾随 - 悬空',
  S.kickoffFileName('p', '2026-10-13').includes('20261013') &&
  U.DOWNLOAD_NAME_RE.test(S.kickoffFileName('p', '')));

// =====================================================================
// E 组：隔离实例真下载端点（库副本 + 临时目录，不调模型）
// =====================================================================
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const prodDb = join(process.env.APPDATA ?? '', 'MTask', 'data', 'mtask.db');
const copyPath = join(DATA_DIR, 'mtask.db');
{
  const Database = (await import('better-sqlite3')).default;
  const src = new Database(prodDb, { readonly: true });
  await src.backup(copyPath);
  src.close();
}
ok('E-00a 生产库副本已生成', existsSync(copyPath));

const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

async function waitUp(ms = 90_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok && (await res.json().catch(() => null))?.service === 'mtask-server') return true;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  return false;
}

/** 放一份产物字节进 tmp 换令牌：本门只验「名字与下载头」，产物真实性由 T02103 E-03 把守 */
function putTmp(bytes: Buffer): string {
  const token = randomUUID();
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(join(TMP_DIR, token), bytes);
  return token;
}
async function download(token: string, filename: string) {
  const res = await fetch(`${BASE}/report/ai-download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, filename }),
  });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}
const dispositionName = (h: Headers): string => {
  const raw = h.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(raw);
  return m ? decodeURIComponent(m[1]) : raw;
};

if (!(await waitUp())) {
  ok('E-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('E-00 隔离实例启动', true);
  const mkPptx = (mark: string) => Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from(mark.repeat(64))]);

  // E-01 清洗后的中文名（含脏名项目）换回文件：头正确、名不跑偏
  const cleanName = S.kickoffFileName('五期/启动：A&B（草稿）', '2026-10-13');
  const t1 = putTmp(mkPptx('A'));
  const r1 = await download(t1, cleanName);
  ok('E-01 清洗后的下载名被接受（200 + pptx MIME + 名字逐字回来）',
    r1.status === 200 && /presentationml/.test(r1.headers.get('content-type') ?? '') &&
    dispositionName(r1.headers) === cleanName,
    { status: r1.status, ct: r1.headers.get('content-type'), name: dispositionName(r1.headers), sent: cleanName });

  // E-02 RFC5987 还原：中文/间隔号不乱码（前端 saveBinary 用同一个解码口径）
  const zh = S.kickoffFileName('五期·启动会 验收', '2026-10-13');
  const t2 = putTmp(mkPptx('B'));
  const r2 = await download(t2, zh);
  ok('E-02 中文名经 RFC5987 编码可无损还原（无乱码、空格保留）',
    r2.status === 200 && dispositionName(r2.headers) === zh && zh.includes('·'),
    dispositionName(r2.headers));

  // E-03 反例：未清洗的原始脏名命中白名单兜底（证明闸在位，清洗不是摆设）
  const t3 = putTmp(mkPptx('C'));
  const r3 = await download(t3, '五期&kickoff.pptx');
  ok('E-03 未清洗脏名被挡下并回退兜名（内容仍是我们的字节，名却变了——正是要修的坑）',
    r3.status === 200 && dispositionName(r3.headers) === 'MTask-ai-report.xlsx',
    dispositionName(r3.headers));

  // E-04 下载即删（令牌一次性，孤儿文件不留）
  const t4 = putTmp(mkPptx('D'));
  const first = await download(t4, S.kickoffFileName('mtask五期', '2026-10-13'));
  const second = await download(t4, '项目启动会.pptx');
  ok('E-04 下载即删：二次请求 404 且 tmp 不残留',
    first.status === 200 && second.status === 404 && !existsSync(join(TMP_DIR, t4)),
    { first: first.status, second: second.status });

  // E-05 字节原样返回（清洗只动名字，不动内容）
  ok('E-05 字节原样返回（下载端点不因名字改写内容）',
    r1.buf.subarray(0, 4).toString('hex') === '504b0304' && r1.buf.equals(mkPptx('A')),
    { head: r1.buf.subarray(0, 4).toString('hex'), len: r1.buf.length });
}

child.kill();
// 隔离目录必须回收（红线 8）：Windows 上刚 kill 的子进程还压着 sqlite 句柄，直接 rm 会 EPERM
for (let i = 0; i < 25; i++) {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
    break;
  } catch {
    if (i === 24) lines.push('[WARN] 临时目录未回收（子进程句柄未释放）：' + DATA_DIR);
    await sleep(200);
  }
}
lines.unshift(`T02104 命名与下载门：PASS=${pass} FAIL=${fail}`);
writeFileSync(OUT, lines.join('\n'), 'utf8');
process.exit(fail === 0 ? 0 : 1);
