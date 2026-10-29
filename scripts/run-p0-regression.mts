/**
 * T03279 2.1 P0 回归控制入口。
 *
 * 用途：把 PRD §7.2 的 P0 顺序（① 阻断与数据安全 → ② 基础入口与主题 → ③ 高感知能力）
 * 固化成一条可随时复跑的回归命令，并让「哪几项 P0 根本没有门」成为显式输出，而不是靠记忆。
 *
 * 判定口径（与 `docs/验收门判据规约.md` 一致）：
 * - 单门绿 = 子进程 exit 0 且输出无 `[FAIL]`/`FAIL ` 行、无 `[SKIP]`/`SKIP ` 行；
 *   SKIP 不算绿，前置件缺失导致的 `exit≠0 + FAIL=0` 也不算绿；
 * - exit 0 但输出含 FAIL 行 = 门自身没把红传成退出码，一并记为红并在结论里点名（口径缺陷，不放过）；
 * - 汇总首行固定 `PASS=<绿门数> FAIL=<非绿门数>`，可被 `grep '^PASS='` 取数；
 * - 无门的 P0 项一律打 `GAP` 行，**永不计入 PASS**；
 * - `--strict` 额外要求「零 GAP 且第①批全绿」，否则 exit 1——这是「数据安全修复先合入并回归」
 *   的机器可判形式；默认模式只跑已登记的门，便于日常回归。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/run-p0-regression.mts
 *   node node_modules/tsx/dist/cli.mjs scripts/run-p0-regression.mts --strict
 *   node node_modules/tsx/dist/cli.mjs scripts/run-p0-regression.mts --batch=1
 *   环境变量 P0_GATE_TIMEOUT：单门超时秒数（默认 240）
 *
 * 纪律：只读调用既有门；子进程临时目录强制落 D:（C: 常年 0 可用会假性失败）；
 * 本入口不改任何门判据，也不替代单门自身的负对照。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGateResults } from './lib/gate-results.mts';

type P0Item = { req: string; batch: 1 | 2 | 3; title: string; gates: string[] };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = Number(process.env.P0_GATE_TIMEOUT ?? 240) * 1000;

if (!existsSync(join(ROOT, '.git')) || !existsSync(join(ROOT, 'package.json'))) {
  console.log('FAIL ROOT 深度自证 — 期望仓库根（含 .git 与 package.json），实际 ' + ROOT);
  process.exit(1);
}

/** §7.2 P0 全集与顺序；`gates` 为空即「该 P0 项尚无门」。 */
const P0: P0Item[] = [
  { req: 'UX-01', batch: 1, title: '任务列表失败态交互修复', gates: ['scripts/tests/verify-t03213-ux01-resource-hint.mts'] },
  { req: 'UX-03', batch: 1, title: '模型页与悬浮操作层可用性', gates: ['scripts/tests/verify-t03217-ux03-model-page.mts'] },
  { req: 'UX-05', batch: 1, title: '需求转计划与占位操作治理', gates: [] },
  { req: 'UX-06', batch: 1, title: '需求矩阵行定位与关联操作', gates: [] },
  { req: 'UX-07', batch: 1, title: 'PRD 与 AI 计划导入的数据安全', gates: [] },
  { req: 'UX-10', batch: 1, title: '统一加载、失败与空状态', gates: [] },
  { req: 'PM-102', batch: 2, title: '命令面板、结构化搜索与键盘导航', gates: ['scripts/tests/verify-t03184-palette-search.mjs'] },
  { req: 'PM-103', batch: 2, title: '新项目空态与单一首访向导', gates: [] },
  {
    req: 'PM-301',
    batch: 2,
    title: '暗色覆盖、首帧一致性与字号止血',
    gates: [
      'scripts/tests/verify-t03178-dark-coverage.mts',
      'scripts/tests/verify-t03179-first-frame-theme.mts',
      'scripts/tests/verify-t03180-font-tokens.mts',
      'scripts/tests/verify-t03219-pm301-dark-contrast.mts',
      'scripts/tests/verify-t03220-ux11-font-token-coverage.mts',
    ],
  },
  { req: 'PM-101', batch: 3, title: '看板列设置与 WIP 软上限', gates: [] },
  { req: 'PM-105', batch: 3, title: '跨项目批量操作、导出所选与逐条回执', gates: [] },
  {
    req: 'AI-101',
    batch: 3,
    title: 'AI 溯源与反馈',
    gates: ['scripts/tests/verify-t03240-ai101-provenance.mts', 'scripts/tests/verify-t03241-feedback.mts'],
  },
  {
    req: 'AI-102',
    batch: 3,
    title: '生成前用量预估与偏差提示',
    gates: [
      'scripts/tests/verify-t03242-ai102-preflight.mts',
      'scripts/tests/verify-t03243-ai102-deviation.mts',
      'scripts/tests/verify-t03244-ai102-model-version.mts',
      'scripts/tests/verify-t03174-preflight-estimate.mts',
    ],
  },
  {
    req: 'AI-104',
    batch: 3,
    title: '提示词模板变量与使用统计',
    gates: ['scripts/tests/verify-t03247-ai104-template-vars.mts', 'scripts/tests/verify-t03248-ai104-usage-count.mts'],
  },
  { req: 'AI-301', batch: 3, title: '卡片分组、检索、前置条件与精确统计', gates: ['scripts/tests/verify-t03172-card-stats.mts'] },
];

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const batchArg = argv.find((a) => a.startsWith('--batch='));
const onlyBatch = batchArg ? Number(batchArg.slice('--batch='.length)) : 0;
const onlyReq = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);

const selected = P0.filter((it) => (!onlyBatch || it.batch === onlyBatch) && (!onlyReq || onlyReq.includes(it.req)));

const lines: string[] = [];
let green = 0;
let notGreen = 0;
let gapGates = 0;
const batch1Red: string[] = [];
const gaps: string[] = [];
const exitDefects: string[] = [];
const blockedGates: string[] = [];

const emit = (s: string): void => {
  lines.push(s);
  console.log(s);
};

for (const item of selected) {
  if (item.gates.length === 0) {
    gapGates += 1;
    gaps.push(`${item.req} ${item.title}`);
    emit(`GAP  B${item.batch} ${item.req.padEnd(7)} ${item.title} — 无门（不计绿）`);
    continue;
  }
  for (const rel of item.gates) {
    if (!existsSync(join(ROOT, rel))) {
      notGreen += 1;
      if (item.batch === 1) batch1Red.push(item.req);
      emit(`FAIL B${item.batch} ${item.req.padEnd(7)} ${rel} — 门文件不在盘上`);
      continue;
    }
    const started = Date.now();
    const r = spawnSync(process.execPath, [...(rel.endsWith('.mts') ? ['node_modules/tsx/dist/cli.mjs'] : []), rel], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TMPDIR: 'D:/tmp', TMP: 'D:/tmp', TEMP: 'D:/tmp' },
    });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const summary = (out.match(/^PASS=\d+.*$/m) ?? [''])[0].trim();
    const failHits = (out.match(/\[FAIL\]|^FAIL\s/gm) ?? []).length;
    const skipHits = (out.match(/\[SKIP\]|^SKIP\s/gm) ?? []).length;
    const crashed = r.error?.code === 'ETIMEDOUT' || r.signal !== null || r.status === null;
    const blocked = !crashed && r.status !== 0 && failHits === 0;
    const isGreen = !crashed && !blocked && r.status === 0 && failHits === 0 && skipHits === 0;
    const exitCodeDefect = r.status === 0 && failHits > 0;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (isGreen) green += 1;
    else {
      notGreen += 1;
      if (item.batch === 1) batch1Red.push(item.req);
    }
    if (exitCodeDefect) exitDefects.push(`${item.req}:${rel.split('/').pop()}`);
    if (blocked) blockedGates.push(`${item.req}:${rel.split('/').pop()}`);
    const why = isGreen
      ? ''
      : crashed
        ? ` — 崩溃/超时 ${TIMEOUT_MS / 1000}s`
        : blocked
          ? ` — 阻断：exit=${r.status} 无 FAIL 行（前置件/实例未就绪）`
          : ` — 红：${summary || `${failHits} 条 FAIL`}${skipHits ? ` / SKIP ${skipHits}` : ''}${exitCodeDefect ? ' / 且 exit=0（退出码未传递）' : ''}`;
    emit(`${isGreen ? 'GREEN' : blocked ? 'BLOCK' : 'FAIL '} B${item.batch} ${item.req.padEnd(7)} ${rel} ${secs}s${why}`);
  }
}

const head = `PASS=${green} FAIL=${notGreen}`;
emit('');
emit(head);
emit(`门数=${green + notGreen} 绿=${green} 非绿=${notGreen} 无门 P0 项=${gapGates}`);
if (gaps.length) emit(`GAP 明细：${gaps.join('；')}`);
if (blockedGates.length) emit(`阻断（前置件/实例未就绪，不计绿）：${blockedGates.join('；')}`);
if (exitDefects.length) emit(`口径缺陷（红但 exit=0）：${exitDefects.join('；')}`);
if (batch1Red.length) emit(`第①批（阻断与数据安全）非绿：${[...new Set(batch1Red)].join(',')}`);

const strictRed = strict && (gapGates > 0 || batch1Red.length > 0 || notGreen > 0);
const exitCode = strictRed || notGreen > 0 ? 1 : 0;
const verdict =
  exitCode === 0
    ? '回归放行：已登记 P0 门全绿'
    : strictRed
      ? '严格模式不放行：存在无门 P0 项或第①批非绿'
      : '回归拦截：存在非绿门';
emit(`结论：${verdict}（strict=${strict}${onlyBatch ? ` batch=${onlyBatch}` : ''}）`);

writeGateResults(join(ROOT, '.workbuddy'), 'p0-regression-results.txt', lines.join('\n'), {
  note: `strict=${strict} gates=${green + notGreen} green=${green} gaps=${gapGates}`,
});
process.exit(exitCode);
