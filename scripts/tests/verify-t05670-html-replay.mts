/**
 * T05670 门：「启动会 PPT 生成」HTML 版反复预览/下载。
 *
 * 缺陷（真实 HTTP 复现）：`/report/ai-download` 是「读即删」的一次性令牌端点，
 * 而 HTML 版预览（只读）与下载（一次性）共用同一个 htmlToken；下载一次后令牌文件被删，
 * 再次点「预览 HTML」或「下载 .html」都返回 404「文件已过期，请重新生成」。
 * 附带同源缺陷：`DOWNLOAD_NAME_RE` 漏了 html，下载名被静默兜回 `MTask-ai-report.xlsx`。
 *
 * 判据：
 *   A 组 纯函数/源码锚点——白名单收 html 且仍拒穿越与 exe、URL 单源形状、
 *        服务端 ai-preview 走只读且带 download=1 分支、ai-download 一次性语义不动、
 *        三处前端 HTML 下载全部切到只读通道。
 *   B 组 隔离实例真 HTTP——预览×2 → 附件下载 → 再预览 → 再附件下载 全 200 且令牌文件仍在；
 *        附件名必须是 .html；负对照：普通 ai-download 仍一次即删、随后预览回 404。
 *
 * 隔离纪律：空数据目录 + 随机端口，不读不写生产库；服务由本仓源码起（resolveServerLauncher
 * 自动挑匹配 better-sqlite3 ABI 的启动器）。用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05670-html-replay.mts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitIsolatedServer, bootEvidence } from '../lib/gate-boot.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 39_700 + Math.floor(Math.random() * 300);
const DATA_DIR = mkdtempSync(join(tmpdir(), 't05670-'));
const TMP_DIR = join(DATA_DIR, 'tmp');
mkdirSync(TMP_DIR, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}/api`;

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 300)}`}`);
};

// ---------------- A 组：纯函数 / 源码锚点 ----------------
const EN = await import('../../server/src/util/export-name.ts');
const DL = await import('../../web/src/utils/download.ts');
const srvIndex = readFileSync(join(ROOT, 'server/src/routes/index.ts'), 'utf8');
const previewUi = readFileSync(join(ROOT, 'web/src/ui/DeckHtmlPreview.tsx'), 'utf8');
const kickoffPanel = readFileSync(join(ROOT, 'web/src/pages/KickoffPptPanel.tsx'), 'utf8');
const summaryPanel = readFileSync(join(ROOT, 'web/src/pages/SummaryPptPanel.tsx'), 'utf8');

ok('A-01 下载名白名单收 .html，仍拒 .exe 与路径穿越',
  EN.DOWNLOAD_NAME_RE.test('项目启动会-20261112.html') === true
  && EN.DOWNLOAD_NAME_RE.test('x.exe') === false
  && EN.DOWNLOAD_NAME_RE.test('../evil.html') === false
  && EN.DOWNLOAD_NAME_RE.test('阶段性总结.pptx') === true);

const previewUrl = DL.htmlArtifactUrl('tok-1');
const downloadUrl = DL.htmlArtifactUrl('tok-1', { download: true, filename: '项目启动会 2026.html' });
const parsed = new URLSearchParams(downloadUrl.split('?')[1] ?? '');
ok('A-02 预览 URL 只读端点、不带 download 参数',
  previewUrl === '/report/ai-preview?token=tok-1' && !previewUrl.includes('download'));
ok('A-03 下载 URL 复用同一只读端点（download=1 + 编码文件名，非 ai-download）',
  downloadUrl.startsWith('/report/ai-preview?')
  && parsed.get('download') === '1'
  && parsed.get('token') === 'tok-1'
  && parsed.get('filename') === '项目启动会 2026.html'
  && !downloadUrl.includes('ai-download'));

ok('A-04 服务端 ai-preview 走 readReportBuffer（只读），且有 download=1 附件分支',
  /const buf = readReportBuffer\(token\)/.test(srvIndex)
  && /req\.query\.download === '1'/.test(srvIndex)
  && /Content-Disposition/.test(srvIndex)
  && /DOWNLOAD_NAME_RE\.test\(raw\)/.test(srvIndex));
ok('A-05 ai-download 仍用 readAndDeleteReport（一次性语义零回归）',
  /const buf = readAndDeleteReport\(token\)/.test(srvIndex));
ok('A-06 三处前端 HTML 下载全部切到只读通道，不再消费 htmlToken',
  [previewUi, kickoffPanel, summaryPanel].every((s) =>
    s.includes('htmlArtifactUrl') && s.includes('getDownload') && !/htmlToken[\s\S]{0,160}ai-download/.test(s))
  && !/api\.download\('\/report\/ai-download',\s*\{\s*token:\s*result\.htmlToken/.test(kickoffPanel)
  && !/api\.download\('\/report\/ai-download',\s*\{\s*token:\s*result\.htmlToken/.test(summaryPanel));

// ---------------- B 组：隔离实例真实 HTTP ----------------
const { resolveServerLauncher } = await import('../isolated-server-launcher.mts');
const L = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const child: ChildProcess = spawn(L.exec, L.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...L.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

let up = false;
try {
  const b = await waitIsolatedServer({ base: BASE.replace(/\/api$/, ''), budgetMs: 180_000, envName: 'T05670_BOOT_BUDGET' });
  up = b.up;
  ok('B-00 隔离实例就绪（空数据目录 + 随机端口）', up, up ? { upMs: b.upMs, attempts: b.attempts } : bootEvidence(b));
} catch (e) {
  ok('B-00 隔离实例就绪', false, String(e));
}

if (up) {
  const token = randomUUID();
  const tokenPath = join(TMP_DIR, token);
  const html = '<html><body><section class="slide s-cover">T05670</section></body></html>';
  writeFileSync(tokenPath, html, 'utf8');

  const get = async (path: string) => {
    const r = await fetch(BASE + path);
    return { status: r.status, text: await r.text(), cd: r.headers.get('content-disposition') ?? '',
      csp: r.headers.get('content-security-policy') ?? '' };
  };
  const post = async (path: string, data: unknown) => {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, text: await r.text(), cd: r.headers.get('content-disposition') ?? '' };
  };

  const pv1 = await get(`/report/ai-preview?token=${token}`);
  ok('B-01 首次预览 200 且返回 HTML 正文', pv1.status === 200 && pv1.text === html);
  const pv2 = await get(`/report/ai-preview?token=${token}`);
  ok('B-02 再次预览仍 200（预览不吃令牌）', pv2.status === 200 && pv2.text === html
    && /sandbox allow-scripts/.test(pv2.csp));

  const dl1 = await get(`/report/ai-preview?token=${token}&download=1&filename=${encodeURIComponent('项目启动会.html')}`);
  ok('B-03 附件下载 200，Content-Disposition 为 .html（不再被兜成 xlsx）',
    dl1.status === 200 && dl1.text === html && /attachment/.test(dl1.cd) && /\.html/.test(decodeURIComponent(dl1.cd)),
    { status: dl1.status, cd: dl1.cd });
  ok('B-04 下载后令牌文件仍在（只读通道不删）', existsSync(tokenPath));

  const pv3 = await get(`/report/ai-preview?token=${token}`);
  ok('B-05 下载后再次预览 200 —— bug 不再复现', pv3.status === 200 && pv3.text === html);
  const dl2 = await get(`/report/ai-preview?token=${token}&download=1&filename=${encodeURIComponent('项目启动会.html')}`);
  ok('B-06 第二次附件下载仍 200（可反复下载）', dl2.status === 200 && dl2.text === html);

  // 负对照：普通 ai-download 的一次性语义必须保持（T02144 / T02103 E-03e 口径零回归）
  const destructive = await post('/report/ai-download', { token, filename: '项目启动会.html' });
  ok('B-07 负对照：ai-download 仍一次即删', destructive.status === 200 && !existsSync(tokenPath));
  const pv4 = await get(`/report/ai-preview?token=${token}`);
  ok('B-08 负对照：被 ai-download 消费后预览回 404「文件已过期，请重新生成」',
    pv4.status === 404 && pv4.text.includes('文件已过期，请重新生成'), { status: pv4.status, text: pv4.text });

  const bad = await get('/report/ai-preview?token=not-a-uuid');
  ok('B-09 非法 token 400、不存在 token 404（校验闸未放宽）',
    bad.status === 400 && (await get(`/report/ai-preview?token=${randomUUID()}`)).status === 404);
}

child.kill();
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 清理失败不掩盖判据 */ }

const summary = `PASS=${pass} FAIL=${fail}`;
lines.push('', summary);
const out = join(ROOT, '.workbuddy', 't05670-gate-results.txt');
writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
console.log(`结果文件：${out}`);
console.log(`启动器：${L.label}`);
if (!up) console.log('服务日志尾部：\n' + serverLog.join('').slice(-1200));
process.exit(fail > 0 ? 1 : 0);
