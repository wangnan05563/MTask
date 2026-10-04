#!/usr/bin/env node
/**
 * T01494：M2 验收回归——编排器（A7-A12 隔离自举 + 构建前置 + 三段断言汇聚 + 报告落盘）。
 *
 * 用法：
 *   node server/scripts/m2-regression.mjs                     # 全自动：构建 → 起隔离实例 → A8 API + A9-A12 流水线 → 报告
 *   node server/scripts/m2-regression.mjs --skip-build        # 复跑不改代码时，沿用上次构建
 *   node server/scripts/m2-regression.mjs --skip-api          # 只跑流水线段（迭代 A9-A12 用）
 *   node server/scripts/m2-regression.mjs --skip-pipeline     # 只跑 A8 HTTP 契约（迭代守卫文案用）
 *   node server/scripts/m2-regression.mjs --base=http://127.0.0.1:39924   # A8 打已在跑实例（流水线仍自建临时库）
 *
 * 分工（与 m1-regression.mjs 同构，勿另造轮子）：
 *  - A8「双输入通道」是服务端契约：通道选择 + 前置校验全在 SSE 头 flush 前 return → HTTP 层确定性打；
 *  - A9-A12 是生成流水线语义（阶段日志/中断/覆盖率/幂等）：in-process 桩 adapter 驱动真实 pipeline，
 *    无需真实模型即可断言，由子进程 `m2-checks-pipeline.cjs` 产出单行 `M2PIPE:<json>` 供本脚本解析；
 *  - A7「卡片一致性」是渲染/DOM 契约，本环境无 CDP 探针 → 如实标 SKIP，绝不因为没跑就当它过了。
 *
 * 隔离纪律（硬规则#8）：A8 段自举隔离实例（MTask_PORT + 临时 MTask_DATA_DIR），流水线段自己再开一个临时库，
 *  两段都跑完即清；A8 只造带前缀的自建项目并删，绝不污染共享库。
 *
 * 退出码三态，**故意不给假绿**：0=全通过；1=有 FAIL；2=无 FAIL 但有 SKIP（A7 无 UI 探针必致 exit=2）。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkHttp } from './m1-checks-api.mjs';
import { runM2ApiChecks } from './m2-checks-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name, dft) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(hit.indexOf('=') + 1) : dft;
};
const has = (name) => argv.includes(`--${name}`);

const OUT = flag('out', path.join(ROOT, 'docs', 'M2-验收回归报告.md'));
const EXTERNAL_BASE = flag('base', '');
const PIPELINE = path.join(ROOT, 'server', 'scripts', 'm2-checks-pipeline.cjs');

/** ---------- 构建前置（与 M1 A14 同口径：dist 必须是本次被测代码）---------- */
function runCmd(cmd, args, tag) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Windows 下 npm 是 npm.cmd，须 shell:true；全为写死字面量，无外部输入流入命令行
    const child = spawn([cmd, ...args].join(' '), { cwd: ROOT, shell: true, windowsHide: true });
    let tail = '';
    child.stdout.on('data', (b) => { tail = (tail + b.toString()).slice(-4000); });
    child.stderr.on('data', (b) => { tail = (tail + b.toString()).slice(-4000); });
    child.on('close', (code) => {
      const okRun = code === 0;
      console.log(`  ${okRun ? 'PASS' : 'FAIL'} ${tag}  exit=${code} ${(Date.now() - t0) / 1000}s`);
      resolve({ k: tag, pass: okRun, skip: false, msg: `exit=${code} 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s${okRun ? '' : ' 尾部输出: ' + tail.slice(-500)}` });
    });
    child.on('error', (e) => resolve({ k: tag, pass: false, skip: false, msg: 'spawn 失败: ' + e.message }));
  });
}

async function phaseBuild() {
  console.log('\n== 构建 / 类型校验（前置）==');
  const list = [];
  list.push(await runCmd('npm', ['run', 'typecheck'], 'BUILD_server_tsc_noEmit'));
  list.push(await runCmd('npm', ['run', 'build:server'], 'BUILD_server_emit_dist'));
  list.push(await runCmd('npm', ['run', 'build:web'], 'BUILD_web_tsc_and_vite'));
  list.push({
    k: 'BUILD_electron_packaging', pass: false, skip: true,
    msg: '完整打包（electron-builder 出安装包）不在本单范围：T01496「全量验收与打包」承接。此处如实标 SKIP，不冒充已验。',
  });
  return { title: '构建前置（被测 dist 必须是本单最新代码）', ids: ['BUILD'], list };
}

/** ---------- A8：隔离实例自举（供 HTTP 断言打）---------- */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

/** better-sqlite3 原生模块 dev(electron) ABI 与打包 ABI 互不兼容 → 先试 node，ERR_DLOPEN 回落 electron */
function spawnInstance({ port, dataDir, runner }) {
  const env = { ...process.env, MTask_PORT: String(port), MTask_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: '1' };
  if (runner === 'electron') {
    const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    return spawn(exe, ['server/dist/index.js'], { cwd: ROOT, env, windowsHide: true });
  }
  return spawn(process.execPath, [path.join(ROOT, 'server', 'dist', 'index.js')], { cwd: ROOT, env, windowsHide: true });
}

async function waitForHealth(base, child, timeoutMs = 45000) {
  const t0 = Date.now();
  let exited = false; let stderr = '';
  child.on('exit', () => { exited = true; });
  child.stderr?.on('data', (b) => { stderr = (stderr + b.toString()).slice(-3000); });
  while (Date.now() - t0 < timeoutMs) {
    if (exited) return { ok: false, stderr };
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return { ok: true, stderr }; } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, stderr: stderr || 'health 等待超时' };
}

async function bootIsolated() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-m2-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let runner = 'node';
  let child = spawnInstance({ port, dataDir, runner });
  let res = await waitForHealth(base, child);
  if (!res.ok && /ERR_DLOPEN_FAILED/.test(res.stderr)) {
    console.log('  node ABI 不匹配（ERR_DLOPEN_FAILED），回落 electron.exe 运行 server/dist');
    child.kill();
    runner = 'electron';
    child = spawnInstance({ port, dataDir, runner });
    res = await waitForHealth(base, child);
  }
  if (!res.ok) throw new Error(`隔离实例起不来 @ ${base}\n${res.stderr}`);
  console.log(`  隔离实例就绪 ${base} runner=${runner} dataDir=${dataDir}`);
  return { base, child, dataDir, runner, port };
}

/** 只删本次自举、带 mtask-m2- 前缀的临时目录 */
function sweepTemp(dir) {
  if (!dir || !path.basename(dir).startsWith('mtask-m2-')) { console.log(`  跳过清理（非本脚本前缀）：${dir}`); return 'skipped'; }
  try { fs.rmSync(dir, { recursive: true, force: true }); return 'removed'; } catch (e) { return 'locked:' + e.message; }
}

/** ---------- A9-A12：子进程跑 in-process 桩 adapter 流水线，解析 M2PIPE JSON ---------- */
function spawnPipeline(runner) {
  return new Promise((resolve) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const child = runner === 'electron'
      ? spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [PIPELINE], { cwd: ROOT, env, windowsHide: true })
      : spawn(process.execPath, [PIPELINE], { cwd: ROOT, env, windowsHide: true });
    let out = ''; let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err = (err + b.toString()).slice(-4000); });
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', (e) => resolve({ code: -1, out: '', err: 'spawn 失败: ' + e.message }));
  });
}

function parseM2Pipe(out) {
  const line = out.split('\n').find((l) => l.startsWith('M2PIPE:'));
  if (!line) return null;
  try { return JSON.parse(line.slice('M2PIPE:'.length)); } catch { return null; }
}

async function runPipelineChecks(hintRunner) {
  const runner = hintRunner === 'node' ? 'node' : 'electron';
  let r = await spawnPipeline(runner);
  let pj = parseM2Pipe(r.out);
  if (!pj && runner === 'node' && /ERR_DLOPEN_FAILED/.test(r.err)) {
    console.log('  流水线 node ABI 不匹配，回落 electron.exe');
    r = await spawnPipeline('electron');
    pj = parseM2Pipe(r.out);
  }
  if (!pj) {
    // 解析不出 M2PIPE：流水线子进程崩了/没产出，如实记一条 FAIL（不给假绿）
    return { groups: [{ title: 'A9-A12 生成流水线', ids: ['A9', 'A10', 'A11', 'A12'], list: [{ k: 'PIPELINE_subprocess_no_output', pass: false, skip: false, msg: `exit=${r.code} stderr=${r.err.slice(-300)}` }] }], runner };
  }
  // 按前缀分节，与验收表 A9/A10/A11/A12 对齐（比一坨列表更好读）
  const bucket = (pfx) => (pj.results || []).filter((x) => x.k.startsWith(pfx)).map((x) => ({ k: x.k, pass: !!x.pass, skip: false, msg: x.msg }));
  const sections = [
    ['A9_', 'A9 控制台阶段日志（≥6 条）与中断即止', 'A9'],
    ['A10_', 'A10 草稿全流程（结构完整 + 确认导入落库 + 关联正确需求）', 'A10'],
    ['A11_', 'A11 覆盖率（全覆盖=100% / 部分覆盖未覆盖项显式告警）', 'A11'],
    ['A12_', 'A12 同一 PRD 二次生成幂等（alreadyImported + 再导入不重复）', 'A12'],
  ];
  const groups = [];
  const consumed = new Set();
  for (const [pfx, title, id] of sections) {
    const list = bucket(pfx);
    list.forEach((x) => consumed.add(x.k));
    if (list.length) groups.push({ title, ids: [id], list });
  }
  const rest = (pj.results || []).filter((x) => !consumed.has(x.k)).map((x) => ({ k: x.k, pass: !!x.pass, skip: false, msg: x.msg }));
  if (rest.length) groups.push({ title: '流水线其它断言', ids: [], list: rest });
  return { groups, runner };
}

/** ---------- A7：卡片一致性（渲染/DOM 契约，本环境无 CDP 探针）---------- */
function a7SkipGroup() {
  return {
    title: 'A7 生成卡片与既有卡片样式一致（渲染/DOM 契约）', ids: ['A7'],
    list: [{
      k: 'A7_card_visual_consistency', pass: false, skip: true,
      msg: 'A7 判定项本质是渲染与样式一致性（computedStyle/className 比对），接口与 pipeline 均打不出；本环境无开着 CDP 的浏览器探针承接。由 T01496「全量验收与打包」在真实 UI 抽查，或补 m2-checks-ui.mjs。此处如实标 SKIP。',
    }],
  };
}

/** ---------- 报告渲染 ---------- */
const ACCEPT_MAP = [
  ['A7', '生成卡片与既有卡片样式一致', 'UI/渲染契约——本次标 SKIP（见未判定项）'],
  ['A8', '内部 PRD 选择 / 外部文件上传双通道并存 + 前置校验 + 确认触发', 'A8 段 HTTP 契约（通道选择与 400 守卫；「确认后才触发」属前端交互标 SKIP）'],
  ['A9', '控制台 ≥6 条阶段日志、可中断（起始/生成中）', 'A9 段（in-process 桩 adapter 驱动真实 pipeline）'],
  ['A10', '草稿结构完整、确认后 importDraft 落库、每条挂正确需求', 'A10 段（真实 TestCaseService.importDraft 落库回读）'],
  ['A11', '覆盖度 100% 或未覆盖项显式告警', 'A11 段（全覆盖=100% + 部分覆盖=50%带告警）'],
  ['A12', '同一份 PRD 二次生成幂等', 'A12 段（alreadyImported + 再导入 imported=0 + 总数不变）'],
];

function renderMd(groups, meta) {
  const flat = groups.flatMap((g) => g.list);
  const pass = flat.filter((x) => x.pass).length;
  const skip = flat.filter((x) => x.skip).length;
  const fail = flat.length - pass - skip;
  const lines = [
    '# M2 验收回归报告（T01494）',
    '',
    `> 生成时间 ${meta.time} ｜ A8 实例 ${meta.base}（${meta.instance}）｜ runner=${meta.runner}`,
    `> 判定合计：**通过 ${pass} / 失败 ${fail} / 跳过 ${skip}** ｜ 退出码 ${meta.exit}`,
    '',
    '本报告由 `node server/scripts/m2-regression.mjs` 生成。A9-A12 用 in-process 桩 adapter 驱动真实生成流水线（无需真实模型即可确定性复现阶段/中断/覆盖率/幂等）；A8 打隔离实例 HTTP 契约。',
    '',
    `**退出码 ${meta.exit} 的含义**（故意不给假绿）：0=全通过；1=有 FAIL；2=无 FAIL 但有 SKIP。`,
    skip > 0
      ? `本次 **${skip} 项判定不完整**（A7 需真实 UI；「确认后才触发」需前端交互），因此不报“M2 验收通过”——每一项 SKIP 都写了原因与承接方。`
      : '本次无 SKIP，判定层全部覆到。',
    '',
    '## 验收项对应关系（PRD §13 A7-A12）',
    '',
    '| 验收项 | 内容 | 本报告的实测位置 |',
    '|---|---|---|',
  ];
  for (const [k, what, where] of ACCEPT_MAP) lines.push(`| ${k} | ${what} | ${where} |`);
  const skipped = flat.filter((x) => x.skip);
  if (skipped.length > 0) {
    lines.push('', '## 未判定项（逐条列出，不默认算通过）', '', '| 断言 | 为什么判不了 |', '|---|---|');
    for (const x of skipped) lines.push(`| \`${x.k}\` | ${(x.msg || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`);
    lines.push('');
  }
  for (const g of groups) {
    const gp = g.list.filter((x) => x.pass).length;
    const gs = g.list.filter((x) => x.skip).length;
    const gf = g.list.length - gp - gs;
    lines.push(`## ${g.title}`, '', `条目 ${g.ids.join(' / ')} ｜ 通过 ${gp} · 失败 ${gf} · 跳过 ${gs}`, '', '| 结果 | 断言 | 实测 |', '|---|---|---|');
    for (const x of g.list) {
      const mark = x.skip ? '⚠️ SKIP' : x.pass ? '✅' : '❌';
      lines.push(`| ${mark} | \`${x.k}\` | ${(x.msg || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const startedAt = new Date().toISOString();
  const groups = [];
  let base = EXTERNAL_BASE;
  let instance = '外部实例（--base 指定，A8 不自举）';
  let child = null;
  let dataDir = null;
  let runner = 'external';

  try {
    if (has('skip-build')) {
      groups.push({ title: '构建前置', ids: ['BUILD'], list: [{ k: 'BUILD_skipped', pass: false, skip: true, msg: '本次以 --skip-build 复跑，构建结论沿用上一次运行' }] });
    } else {
      groups.push(await phaseBuild());
    }

    if (!base && !has('skip-api')) {
      const booted = await bootIsolated();
      base = booted.base; child = booted.child; dataDir = booted.dataDir; runner = booted.runner;
      instance = '隔离实例（临时 DATA_DIR）';
    } else if (base) {
      const r = await fetch(`${base}/api/health`).catch(() => null);
      if (!r?.ok) throw new Error(`--base 指向的实例不可用：${base}`);
    }

    console.log('\n== A8 双输入通道（HTTP 契约）==');
    if (has('skip-api')) {
      console.log('  已跳过（--skip-api）');
      groups.push({ title: 'A8 段未执行（--skip-api）', ids: ['A8'], list: [{ k: 'A8_skippedThisRun', pass: false, skip: true, msg: '本次以 --skip-api 快跑，A8 通道契约未执行，不得当作已验' }] });
    } else {
      const apiGroups = await runM2ApiChecks({ base });
      for (const g of apiGroups) console.log(`  ${g.title}: ${g.list.filter((x) => x.pass).length}/${g.list.length} pass`);
      groups.push(...apiGroups);
    }

    console.log('\n== A9-A12 生成流水线（in-process 桩 adapter）==');
    if (has('skip-pipeline')) {
      console.log('  已跳过（--skip-pipeline）');
      groups.push({ title: 'A9-A12 段未执行（--skip-pipeline）', ids: ['A9', 'A10', 'A11', 'A12'], list: [{ k: 'PIPELINE_skippedThisRun', pass: false, skip: true, msg: '本次以 --skip-pipeline 快跑，A9-A12 未执行，不得当作已验' }] });
    } else {
      const pl = await runPipelineChecks(runner);
      for (const g of pl.groups) console.log(`  ${g.title}: ${g.list.filter((x) => x.pass).length}/${g.list.length} pass`);
      groups.push(...pl.groups);
    }

    console.log('\n== A7 卡片一致性（UI）==');
    groups.push(a7SkipGroup());
    console.log('  SKIP（无 CDP 探针，交 T01496/人工 UI 抽查）');

    if (has('skip-api') || has('skip-pipeline') || has('skip-build')) {
      groups.push({ title: '本次为分段快跑（不是完整验收）', ids: ['RUN'], list: [{ k: 'RUN_partial', pass: false, skip: true, msg: `分段开关：${argv.filter((a) => a.startsWith('--skip')).join(' ') || '无'}——全量验收请不加任何 --skip 重跑` }] });
    }

    const flat = groups.flatMap((g) => g.list);
    const fail = flat.filter((x) => !x.pass && !x.skip).length;
    const skip = flat.filter((x) => x.skip).length;
    const exit = fail > 0 ? 1 : skip > 0 ? 2 : 0;
    const meta = { time: startedAt, base: base || '(未自举)', instance, runner, exit };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, renderMd(groups, meta), 'utf8');
    console.log(`\n报告落盘 ${OUT}`);
    console.log(`合计 失败=${fail} 跳过=${skip} → exit=${exit}`);
    if (fail > 0) {
      console.log('\n失败明细：');
      for (const x of flat.filter((y) => !y.pass && !y.skip)) console.log(`  ❌ ${x.k}  ${x.msg}`);
    }
    return exit;
  } catch (e) {
    console.error('\n回归脚本自身异常（这不是产品 FAIL，是脚本没跑完，同样不给绿）：', e);
    return 1;
  } finally {
    if (child) child.kill();
    if (dataDir) {
      await new Promise((r) => setTimeout(r, 600));
      console.log(`  临时数据目录 ${sweepTemp(dataDir)}：${dataDir}`);
    }
  }
}

process.exit(await main());
