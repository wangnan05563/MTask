#!/usr/bin/env node
/**
 * T01496：全量验收与打包——总编排器（A1-A15 全量走查 + 真实构建 + 真实出包 + 真实 CDP UI + 汇总报告）。
 *
 * 用法：
 *   node server/scripts/full-acceptance.mjs                 # 全自动：起无头Chrome → 构建 → 打包 → M1/M2/M3 → 汇总
 *   node server/scripts/full-acceptance.mjs --skip-build     # 复用已有 dist（迭代本脚本时用）
 *   node server/scripts/full-acceptance.mjs --skip-package   # 不出包（本机不便跑 electron-builder 时；如实标 SKIP）
 *   node server/scripts/full-acceptance.mjs --skip-ui        # 不驱动浏览器（A7/A8门控/A13草稿/M3DOM 会如实标 SKIP）
 *
 * 为什么这个单子要「聚合 + 补差集」而不是重写断言：
 *  - A1-A6/A13/A15 已由 m1-regression 覆盖（API + CDP UI），A8-A12 由 m2-regression 覆盖（HTTP + 桩流水线）；
 *  - 但 M1/M2 当时把「完整打包、Sonar 在线扫描、A7 卡片视觉、A8 确认门控、A13 AI 草稿、M3 虚拟滚动 DOM」
 *    如实标了 SKIP，并在报告里点名「由 T01496 承接」。本单就做那个承接方：
 *      · 打包：真跑 electron-builder --win 出 .exe（先杀 repo dev electron 释放 better_sqlite3 锁）；
 *      · UI：自举无头 Chrome（CDP）+ 调 m3-checks-ui.mjs 把 A7/A8门控/A13草稿/M3DOM 打成实测；
 *      · Sonar：本环境无服务端 → 如实标 SKIP，绝不因“没跑”就当它过了。
 *  - 最终把三路断言 + 构建 + 打包**按 A 编号取并集**渲染成一张 A1-A15 主表：
 *    某 A 只要有 1 条实测 PASS 且无 FAIL 即判 PASS；含 SKIP 则标「部分」；全 SKIP 才「未判定」。
 *    M2 里被标 SKIP 的 A7，会被 M3-UI 的同编号 PASS 自动升级——这正是聚合的意义。
 *
 * 退出码三态，**故意不给假绿**：0=全通过（含无 SKIP）；1=有 FAIL；2=无 FAIL 但有 SKIP（Sonar 未扫必致 2）。
 * 隔离纪律（硬规则#8）：Chrome/实例/临时目录全带 mtask-*- 前缀，用完即杀即清；打包只杀 repo electron.exe，
 *  绝不杀已安装的 MTask.exe（那是用户正在用的桌面应用与本 Agent 的回连通道）。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const OUT = path.join(ROOT, 'docs', '全量验收报告.md');

const A_DEF = {
  A1: '项目管理页出现「测试用例视图」按钮，样式/动画/激活态与相邻按钮一致',
  A2: '用例增删改查：新增/行内编辑/枚举下拉改值/删除带确认',
  A3: '每条用例 0~N 步骤可编、可增删排序、刷新仍在',
  A4: '矩阵行「用例N」chip 下钻 + 用例侧「关联需求」chip 反向跳转（双向各 3 次）',
  A5: '多选批量改优先级/类型/状态/所属需求、复制、删除、导出',
  A6: 'Excel/Word/Markdown 三格式导出，Excel 含覆盖率子表，版式与矩阵同源',
  A7: 'AI 工作台「从 PRD 生成测试用例」卡片图标/排版/重置/徽标与其余 5 卡一致',
  A8: '内部 PRD 选择与外部文件上传两通道可共存，确认后才触发',
  A9: '生成全过程控制台滚动阶段日志（≥6 条），可中断',
  A10: '结果进草稿视图：覆盖率、未覆盖可补、勾选/编辑/删除后确认入库',
  A11: '覆盖率 100%（或缺失项显式告警），关联关系正确',
  A12: '同一份 PRD 二次生成不产生重复用例（幂等）',
  A13: '切菜单再返回，展开态/筛选/分页/多选/AI 草稿均保持',
  A14: 'tsc --noEmit 与打包通过，无新增 Sonar 阻断',
  A15: '删除带用例的需求时确认弹窗明示「将一并删除 N 条测试用例」',
};

function runCmd(cmd, args, tag) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn([cmd, ...args].join(' '), { cwd: ROOT, shell: true, windowsHide: true });
    let tail = '';
    child.stdout.on('data', (b) => { tail = (tail + b.toString()).slice(-6000); });
    child.stderr.on('data', (b) => { tail = (tail + b.toString()).slice(-6000); });
    child.on('close', (code) => {
      const ok = code === 0;
      console.log(`  ${ok ? 'PASS' : 'FAIL'} ${tag} exit=${code} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      resolve({ k: tag, pass: ok, skip: false, msg: `exit=${code} 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s${ok ? '' : ' | 尾部: ' + tail.slice(-400).replace(/\s+/g, ' ')}` });
    });
    child.on('error', (e) => resolve({ k: tag, pass: false, skip: false, msg: 'spawn 失败: ' + e.message }));
  });
}

/** 释放 repo dev electron 对 better_sqlite3.node 的锁：无进程时非零退出属预期，不算失败 */
function killDevElectron() {
  return new Promise((resolve) => {
    const child = spawn('taskkill /F /IM electron.exe', { cwd: ROOT, shell: true, windowsHide: true });
    child.on('close', (code) => {
      console.log(code === 0 ? '  OK 已释放 repo dev electron 锁' : '  INFO repo dev 无 electron.exe 在跑（无需杀，正常）');
      resolve();
    });
    child.on('error', () => { console.log('  INFO taskkill 不可用，跳过锁释放'); resolve(); });
  });
}

/** 跑一个子脚本，收集 stdout（用于解析 M3UI:/T01495: JSON），stderr 透传到控制台便于排障 */
function runSub(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'scripts', script), ...args], { cwd: ROOT, windowsHide: true });
    let out = ''; let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); process.stderr.write(b); });
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', (e) => resolve({ code: -1, out: '', err: 'spawn 失败: ' + e.message }));
  });
}

/* ---------- 无头 Chrome（CDP）自举 ---------- */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
async function launchChrome() {
  const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) return { ok: false, reason: '未找到 Chrome/Edge 可执行文件——UI 段（A7/A8门控/A13草稿/M3DOM）无法实测' };
  const port = await freePort();
  const udd = path.join(os.tmpdir(), `mtask-cdp-${Math.random().toString(36).slice(2, 8)}`);
  const child = spawn(exe, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { cwd: ROOT, windowsHide: true });
  const cdp = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const list = await fetch(`${cdp}/json`).then((r) => r.json()).catch(() => null);
    if (Array.isArray(list) && list.some((t) => t.type === 'page')) {
      console.log(`  无头浏览器就绪 ${cdp} (${path.basename(exe)})`);
      return { ok: true, cdp, child, udd };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  try { child.kill(); } catch { /* noop */ }
  return { ok: false, reason: `无头浏览器 ${cdp} 启动超时（20s 内未见 page target）` };
}

/* ---------- A14 构建 ---------- */
async function phaseBuild() {
  console.log('\n== A14 构建 / 类型校验 ==');
  const list = [];
  list.push(await runCmd('npm', ['run', 'typecheck'], 'A14_tsc_noEmit'));
  list.push(await runCmd('npm', ['run', 'build:server'], 'A14_build_server'));
  list.push(await runCmd('npm', ['run', 'build:web'], 'A14_build_web'));
  return { name: 'build', list };
}

/* ---------- A14 打包：先杀 repo dev electron（释放 better_sqlite3 锁），再 electron-builder --win ---------- */
async function phasePackage(buildOk) {
  console.log('\n== A14 打包（electron-builder --win 出安装包）==');
  const list = [];
  if (!buildOk) {
    list.push({ k: 'A14_pack_installer', pass: false, skip: true, msg: '前置构建未通过（tsc/build 有 FAIL），不打——避免用陈旧 dist 出包造成假绿' });
    return { name: 'package', list };
  }
  // 只杀 repo dev electron.exe；已安装的 MTask.exe（用户桌面应用/回连通道）绝不碰——它的进程终止由 nsis-kill-process.nsh 在“安装时”处理
  // 与 打包.bat 同口径：无 dev electron 时 taskkill 非零退出属预期，打 INFO 而非 FAIL（曾以 runCmd 误报 FAIL 干扰排障）
  await killDevElectron();
  const startedAt = Date.now();
  const relDir = path.join(ROOT, 'release');
  const pack = await runCmd('npm', ['run', 'dist'], 'A14_pack_electronBuilder');
  // 断言产物：release 下存在 mtime ≥ 本次起点的 Setup .exe（真出了新包，不是翻旧账）
  let fresh = null;
  try {
    if (fs.existsSync(relDir)) {
      for (const f of fs.readdirSync(relDir)) {
        if (!/^MTask Setup .*\.exe$/.test(f)) continue;
        const st = fs.statSync(path.join(relDir, f));
        if (st.mtimeMs >= startedAt - 1000) { fresh = { f, size: st.size, mtime: st.mtimeMs }; break; }
      }
    }
  } catch { /* 目录不可读 → fresh 保持 null */ }
  const produced = pack.pass && !!fresh;
  list.push(pack);
  list.push({
    k: 'A14_pack_installer', pass: produced, skip: false,
    msg: produced
      ? `安装包已产出：release\\${fresh.f}（${(fresh.size / 1048576).toFixed(1)} MB，mtime 晚于本次打包起点）`
      : `electron-builder exit=${pack.code} 且未在 release\\ 发现本次新产 Setup .exe（详见 pack 尾部输出）`,
  });
  return { name: 'package', list };
}

/* ---------- A14 Sonar：本环境无服务端 → 如实标 SKIP ---------- */
async function phaseSonar() {
  console.log('\n== A14 Sonar 扫描 ==');
  let host = 'http://localhost:9000';
  try {
    const props = fs.readFileSync(path.join(ROOT, 'sonar-project.properties'), 'utf8');
    const m = props.match(/sonar\.host\s*=\s*(\S+)/);
    if (m) host = m[1];
  } catch { /* 用默认 */ }
  let reachable = false;
  try { reachable = await fetch(`${host}/api/server/version`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok).catch(() => false); } catch { /* 不可达 */ }
  // 即便可达，本脚本不执行 sonar-scanner 全量扫描（需 CI/凭据），仍如实标 SKIP，但记录可达性
  return {
    name: 'sonar',
    list: [{
      k: 'A14_sonar_scan', pass: false, skip: true,
      msg: `「无新增 Sonar 阻断」需 sonar-scanner 全量扫描（${host} 本脚本探测可达性=${reachable}），不属离线回归能力，由 CI 承接。此处如实标 SKIP，不冒充已验。`,
    }],
  };
}

/* ---------- 解析子报告 md 里的断言行 ---------- */
function parseReportMd(file) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(✅|❌|⚠️ ?SKIP)\s*\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|\s*$/);
    if (!m) continue;
    out.push({ k: m[2], pass: m[1] === '✅', skip: /SKIP/.test(m[1]), msg: m[3] });
  }
  return out;
}

/* ---------- 清洗子回归（M1/M2）回灌的断言 ----------
 * 两件事：
 *  1) 剔除构建/编排「记账标记」：M1/M2 本次都以 --skip-build 复跑，其报告里的 `A14_*`/`BUILD_*`/`RUN_*`
 *     SKIP 只是它们各自的分段开关记录。本编排器已亲自跑过权威构建+打包（A14 明细），若原样回灌会与
 *     真构建 PASS 自相矛盾（一边「构建通过」一边「以 --skip-build 复跑」），且 `RUN_partial` 会重复出现。
 *  2) 退役「已承接的遗留 SKIP」：M1/M2 把打不了的 A7 卡片视觉 / A8 确认门控 / A13 AI 草稿明确标 SKIP 并
 *     点名「由 T01496 承接」。本单 M3-UI 已把同名 A 编号打成真实 CDP 实测——handoff 已兑现，这些 SKIP 应退役，
 *     不再把已实测项错误拖成 🟡。仅当该 A 编号确有 M3-UI PASS 时才退役，否则保留（诚实原则）。 */
const ORCH_MARK = /^(A14_|BUILD_|RUN_)/;
const HANDOFF_SKIP = { A7: 'A7_card_visual_consistency', A8: 'A8_confirm_then_trigger', A13: 'A13_aiDraftKept' };
function cleanSubAssertions(sub, m3ui) {
  const m3VerifiedA = new Set(
    m3ui.filter((x) => x.pass && !x.skip).map((x) => (x.k.match(/^(A\d+)_/) || [])[1]).filter(Boolean)
  );
  const retired = new Set();
  for (const aid in HANDOFF_SKIP) if (m3VerifiedA.has(aid)) retired.add(HANDOFF_SKIP[aid]);
  return { list: sub.filter((x) => !ORCH_MARK.test(x.k) && !retired.has(x.k)), retired: [...retired] };
}

/* ---------- 聚合：所有断言按 A 编号取并集 → A1-A15 主表 ---------- */
function aggregate(allAssertions) {
  const byA = {};
  const others = [];
  for (const a of allAssertions) {
    const m = a.k.match(/^A(\d+)_/);
    if (m) { const id = 'A' + m[1]; (byA[id] ??= []).push(a); } else others.push(a);
  }
  const rows = [];
  for (const id of Object.keys(A_DEF)) {
    const items = byA[id] || [];
    const p = items.filter((x) => x.pass && !x.skip).length;
    const f = items.filter((x) => !x.pass && !x.skip).length;
    const s = items.filter((x) => x.skip).length;
    let verdict;
    if (items.length === 0) verdict = '⏭ 未覆盖';
    else if (f > 0) verdict = '❌ 未通过';
    else if (p > 0 && s === 0) verdict = '✅ 通过';
    else if (p > 0) verdict = '🟡 部分（含 SKIP）';
    else verdict = '⏭ 全 SKIP 未判定';
    const sources = [...new Set(items.map((x) => srcOf(x.k, x)))];
    rows.push({ id, what: A_DEF[id], p, f, s, verdict, sources, total: items.length });
  }
  return { rows, byA, others };
}
function srcOf(key) {
  if (key.startsWith('A14_pack') || key.startsWith('A14_tsc') || key.startsWith('A14_build') || key.startsWith('A14_sonar')) return '构建/打包/扫描';
  if (/^(A7|A8_ch|A8_single|A8_not|A13_aiDraft|M3_)/.test(key)) return 'M3-UI(CDP)';
  return 'M1/M2 回归';
}

/* ---------- 渲染主报告 ---------- */
function renderMd(agg, ctx) {
  const flat = ctx.allAssertions;
  const pass = flat.filter((x) => x.pass && !x.skip).length;
  const skip = flat.filter((x) => x.skip).length;
  const fail = flat.filter((x) => !x.pass && !x.skip).length;
  const L = [];
  L.push('# MTask 测试用例管理 · 全量验收报告（T01496）');
  L.push('');
  L.push(`> 生成时间 ${ctx.time} ｜ HEAD=${ctx.head}`);
  L.push(`> 无头浏览器(CDP)：${ctx.chrome.ok ? '✅ ' + ctx.chrome.cdp : '⚠️ 未启用——' + (ctx.chrome.reason || '')}`);
  L.push(`> 断言合计：**通过 ${pass} / 失败 ${fail} / 跳过 ${skip}** ｜ 退出码 ${ctx.exit}`);
  L.push('');
  const partials = agg.rows.filter((r) => r.verdict.startsWith('🟡')).map((r) => r.id);
  L.push(`> 一句话结论：${fail === 0 ? `A1-A15 已实测项全部通过（${agg.rows.filter((r) => r.verdict.startsWith('✅')).length}/15 判 ✅），0 FAIL。` : '存在 FAIL，见下。'}${partials.length ? `以下因不可离线判定的成分如实留 SKIP 而标 🟡 部分：${partials.join('、')}（主因 Sonar 在线扫描需服务端、A5 批量导出真实落盘属交互层）——详见「未判定项」。` : '无 SKIP。'}`);
  L.push('');
  L.push('本报告由 `node server/scripts/full-acceptance.mjs` 聚合生成：');
  L.push('- **M1**（`m1-regression.mjs`，`--skip-build --cdp`）：A1-A6/A13/A15 API + CDP 交互；');
  L.push('- **M2**（`m2-regression.mjs`，`--skip-build`）：A8 HTTP 双通道契约 + A9-A12 桩 adapter 流水线；');
  L.push('- **M3-UI**（`m3-checks-ui.mjs`，CDP）：把 M1/M2 遗留标 SKIP 的 A7 卡片一致、A8 确认门控、A13 AI 草稿、M3 虚拟滚动 DOM 打成真实浏览器实测；');
  L.push('- **构建/打包**：tsc + build + `electron-builder --win` 出安装包；**Sonar**：本环境无服务端，如实 SKIP。');
  L.push('');
  L.push(`**退出码 ${ctx.exit}（故意不给假绿）**：0=全通过；1=有 FAIL；2=无 FAIL 但有 SKIP。`);
  L.push('');
  L.push('## A1-A15 主验收表（三路断言 + 构建打包按编号取并集）');
  L.push('');
  L.push('| # | 验收项 | 结论 | 断言(通过/失败/跳过) | 覆盖来源 |');
  L.push('|---|---|---|---|---|');
  for (const r of agg.rows) {
    L.push(`| ${r.id} | ${r.what} | ${r.verdict} | ${r.p}/${r.f}/${r.s}（共${r.total}） | ${r.sources.join('、') || '—'} |`);
  }
  L.push('');
  L.push('## 构建与打包（A14 明细）');
  L.push('');
  L.push('| 结果 | 断言 | 实测 |');
  L.push('|---|---|---|');
  for (const a of flat.filter((x) => x.k.startsWith('A14_'))) {
    const mark = a.skip ? '⚠️ SKIP' : a.pass ? '✅' : '❌';
    L.push(`| ${mark} | \`${a.k}\` | ${(a.msg || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`);
  }
  L.push('');
  L.push('## M3-UI（CDP 实测，补齐 M1/M2 遗留 SKIP）');
  L.push('');
  if (ctx.m3ui.length === 0) {
    L.push('> 本次未产出 M3-UI 断言（无头浏览器不可用或 --skip-ui）——A7/A8门控/A13草稿/M3DOM 保持未判定。');
  } else {
    L.push('| 结果 | 断言 | 实测 |');
    L.push('|---|---|---|');
    for (const a of ctx.m3ui) {
      const mark = a.skip ? '⚠️ SKIP' : a.pass ? '✅' : '❌';
      L.push(`| ${mark} | \`${a.k}\` | ${(a.msg || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`);
    }
  }
  L.push('');
  const skipped = flat.filter((x) => x.skip);
  L.push('## 未判定项（逐条列出，不默认算通过）');
  L.push('');
  if (skipped.length === 0) { L.push('（无）'); }
  else {
    L.push('| 断言 | 为什么判不了 |');
    L.push('|---|---|');
    for (const x of skipped) L.push(`| \`${x.k}\` | ${(x.msg || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`);
  }
  L.push('');
  L.push('## 分段报告索引');
  L.push('');
  L.push(`- M1：${ctx.m1.counts}（报告 docs/M1-验收回归报告.md）`);
  L.push(`- M2：${ctx.m2.counts}（报告 docs/M2-验收回归报告.md）`);
  L.push(`- 虚拟滚动命令级探针（T01495）：${ctx.probe.counts}`);
  L.push(`- 安装包：${ctx.installer || '（未产出）'}`);
  L.push('');
  return L.join('\n');
}

async function main() {
  const startedAt = new Date().toISOString();
  const allAssertions = [];
  let m3ui = [];
  let probeCounts = '未跑';
  let m1counts = '未跑'; let m2counts = '未跑';
  let installer = '';

  const chrome = has('skip-ui') ? { ok: false, reason: '--skip-ui' } : await launchChrome();

  let build;
  if (has('skip-build')) {
    build = { name: 'build', list: [{ k: 'A14_build_skipped', pass: false, skip: true, msg: '本次 --skip-build，构建结论沿用上次运行（全量验收请不加 --skip-build）' }] };
  } else {
    build = await phaseBuild();
  }
  const buildOk = build.list.every((x) => x.pass || x.skip) && build.list.some((x) => x.pass);
  allAssertions.push(...build.list);

  let pkg;
  if (has('skip-package')) {
    pkg = { name: 'package', list: [{ k: 'A14_pack_installer', pass: false, skip: true, msg: '本次 --skip-package，未出包（如实标 SKIP，不冒充）' }] };
  } else {
    pkg = await phasePackage(buildOk);
  }
  allAssertions.push(...pkg.list);
  const inst = pkg.list.find((x) => x.k === 'A14_pack_installer' && x.pass);
  if (inst) installer = inst.msg;

  const sonar = await phaseSonar();
  allAssertions.push(...sonar.list);

  // M1（API + CDP UI），--skip-build 复用本次已构建 dist；有 chrome 则传 --cdp
  console.log('\n== 子回归：M1 ==');
  const m1args = ['--skip-build']; if (chrome.ok) m1args.push(`--cdp=${chrome.cdp}`); else m1args.push('--skip-ui');
  await runSub('m1-regression.mjs', m1args);
  const m1parsed = parseReportMd(path.join(ROOT, 'docs', 'M1-验收回归报告.md'));
  { const p = m1parsed.filter((x) => x.pass && !x.skip).length, s = m1parsed.filter((x) => x.skip).length, f = m1parsed.filter((x) => !x.pass && !x.skip).length; m1counts = `通过 ${p} / 失败 ${f} / 跳过 ${s}`; }

  // M2（HTTP + 流水线），--skip-build
  console.log('\n== 子回归：M2 ==');
  await runSub('m2-regression.mjs', ['--skip-build']);
  const m2parsed = parseReportMd(path.join(ROOT, 'docs', 'M2-验收回归报告.md'));
  { const p = m2parsed.filter((x) => x.pass && !x.skip).length, s = m2parsed.filter((x) => x.skip).length, f = m2parsed.filter((x) => !x.pass && !x.skip).length; m2counts = `通过 ${p} / 失败 ${f} / 跳过 ${s}`; }

  // 虚拟滚动命令级探针（纯 node，无需浏览器）
  console.log('\n== 命令级探针：虚拟滚动（T01495）==');
  const pr = await runSub('m3-checks-virtual.cjs', []);
  { const j = (pr.out.split('\n').find((l) => l.startsWith('T01495:')) || '').slice('T01495:'.length); try { const o = JSON.parse(j); probeCounts = `通过 ${o.pass} / 失败 ${o.fail}（阈值${o.threshold}/行高${o.rowH}/视口${o.viewportH}/overscan${o.overscan}）`; } catch { probeCounts = `exit=${pr.code}（解析失败）`; } }

  // M3-UI（CDP 实测，把遗留 SKIP 转真测）
  console.log('\n== 子回归：M3-UI（CDP）==');
  if (chrome.ok) {
    const r3 = await runSub('m3-checks-ui.mjs', [`--cdp=${chrome.cdp}`]);
    const line = r3.out.split('\n').find((l) => l.startsWith('M3UI:'));
    if (line) { try { m3ui = JSON.parse(line.slice('M3UI:'.length)).results || []; } catch { m3ui = []; } }
    if (m3ui.length === 0) m3ui = [{ k: 'M3UI_noOutput', pass: false, skip: true, msg: `m3-checks-ui 无 M3UI 输出（exit=${r3.code}），A7/A8门控/A13草稿/M3DOM 保持未判定 stderr=${r3.err.slice(-200)}` }];
  } else {
    m3ui = [{ k: 'M3UI_noBrowser', pass: false, skip: true, msg: `无头浏览器不可用（${chrome.reason}）——A7/A8门控/A13草稿/M3DOM 未判定，不冒充已验` }];
  }
  allAssertions.push(...m3ui);

  // M1/M2 回灌的断言在 M3-UI 结果确定后清洗（剔除构建/编排记账 + 退役已承接 SKIP）再并入主表
  const subClean = cleanSubAssertions([...m1parsed, ...m2parsed], m3ui);
  if (subClean.retired.length) console.log('  退役已承接遗留 SKIP：' + subClean.retired.join('、'));
  allAssertions.push(...subClean.list);

  if (chrome.child) { try { chrome.child.kill(); } catch { /* noop */ } }
  if (chrome.udd) { try { fs.rmSync(chrome.udd, { recursive: true, force: true }); } catch { /* 占用则留待系统清理 */ } }

  const agg = aggregate(allAssertions);
  const flatFail = allAssertions.filter((x) => !x.pass && !x.skip).length;
  const flatSkip = allAssertions.filter((x) => x.skip).length;
  const exit = flatFail > 0 ? 1 : flatSkip > 0 ? 2 : 0;
  const ctx = {
    time: startedAt, head: await readHead(), chrome, exit, allAssertions, m3ui,
    m1: { counts: m1counts }, m2: { counts: m2counts }, probe: { counts: probeCounts }, installer,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, renderMd(agg, ctx), 'utf8');
  console.log(`\n报告落盘 ${OUT}`);
  console.log(`合计 通过=${allAssertions.filter((x) => x.pass && !x.skip).length} 失败=${flatFail} 跳过=${flatSkip} → exit=${exit}`);
  return exit;
}

function readHead() {
  return new Promise((resolve) => {
    const c = spawn('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, shell: true, windowsHide: true });
    let o = ''; c.stdout.on('data', (b) => { o += b.toString(); }); c.on('close', () => resolve(o.trim() || '?'));
  });
}

process.exit(await main());
