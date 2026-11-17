#!/usr/bin/env node
/**
 * T01488：M1 验收回归——编排器（隔离实例自举 + A14 构建前置 + API/UI 断言 + 报告落盘）。
 *
 * 用法：
 *   node server/scripts/m1-regression.mjs                     # 全自动：构建 → 起隔离实例 → API+UI 断言 → 报告
 *   node server/scripts/m1-regression.mjs --skip-build        # 已在改代码外的场合复跑，不重新构建
 *   node server/scripts/m1-regression.mjs --skip-ui            # 只跑服务端契约（无浏览器环境下的退化跑法）
 *   node server/scripts/m1-regression.mjs --skip-api           # 只跑交互断言（调 UI 探针时迭代用）
 *   node server/scripts/m1-regression.mjs --base=http://127.0.0.1:39924   # 打已在跑的实例，不自举也不销毁
 *   node server/scripts/m1-regression.mjs --cdp=http://127.0.0.1:9333
 *
 * 为什么坚持「自己起一个隔离实例」而不是复用 39924：
 *   回归脚本会造项目/需求/用例并删，跑在共享实例上就是在污染别人的现场数据；
 *   且 CASCADE、净零残渣这类断言依赖「开跑前的库基线」，共享库里有别人在建数据，基线就是假的。
 *   隔离实例 + 临时 DATA_DIR 才是可重复的（同一天跑十遍结果一致）。
 *
 * 退出码三态，**故意不给假绿**：
 *   0 = 全通过；1 = 有 FAIL；2 = 无 FAIL 但存在 SKIP（判定不完整，不能算验收通过）。
 *   CDP 不可达时 UI 整段 SKIP → 退出码必为 2，绝不因为 API 全绿就报「M1 验收通过」。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runApiChecks, mkHttp } from './m1-checks-api.mjs';
import { runUiChecks, seedUiFixture } from './m1-checks-ui.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name, dft) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(hit.indexOf('=') + 1) : dft;
};
const has = (name) => argv.includes(`--${name}`);

const CDP = flag('cdp', 'http://127.0.0.1:9333');
const OUT = flag('out', path.join(ROOT, 'docs', 'M1-验收回归报告.md'));
const EXTERNAL_BASE = flag('base', '');

/** ---------- A14：构建与类型校验 ---------- */
function runCmd(cmd, args, tag) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Windows 下 npm 是 npm.cmd，不走 shell 直接 spawn 会 ENOENT。
    // 拼成单字符串而不传 args 数组：避开 DEP0190 弃用告警（它会把噪声当 stderr 打进报告），
    // 这里的 cmd/args 全是本文件写死的字面量，没有任何外部输入能流入命令行
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

async function phaseA14() {
  console.log('\n== A14 构建 / 类型校验 ==');
  const list = [];
  list.push(await runCmd('npm', ['run', 'typecheck'], 'A14_server_tsc_noEmit'));
  list.push(await runCmd('npm', ['run', 'build:web'], 'A14_web_tsc_and_vite_build'));
  list.push(await runCmd('npm', ['run', 'build:server'], 'A14_server_build_emit_dist'));
  list.push({
    k: 'A14_electron_builder_dist', pass: false, skip: true,
    msg: '完整打包（electron-builder 出安装包）不在本单范围：T01496「全量验收与打包」承接。此处如实标 SKIP，不冒充已验。',
  });
  // §13 A14 原文是“tsc --noEmit 与打包通过，无新增 Sonar 阻断”——前两条能用构建退出码判定，
  // 最后一条需要 Sonar 服务端在线 + mvn/npm 扫描，不属本脚本能力，不能因为“没报错”就当它过了
  list.push({
    k: 'A14_sonarNoNewBlocker', pass: false, skip: true,
    msg: '「无新增 Sonar 阻断」需 SonarQube 服务端与 sonar:scan（本脚本不联网不扫描）；由 T01496 全量验收跑扫描承接。',
  });
  return { title: 'A14 tsc / 构建（§13 判定：CI 结果）', ids: ['A14'], list };
}

/** ---------- 隔离实例自举 ---------- */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** better-sqlite3 是原生模块：dev ABI(node) 与打包 ABI(electron) 互不兼容，
 *  故先试 node，`ERR_DLOPEN_FAILED` 再回落 electron——并把这个信息记进报告（它反映当前 ABI 状态） */
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
  let exited = false;
  let stderr = '';
  child.on('exit', () => { exited = true; });
  child.stderr?.on('data', (b) => { stderr = (stderr + b.toString()).slice(-3000); });
  while (Date.now() - t0 < timeoutMs) {
    if (exited) return { ok: false, stderr };
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return { ok: true, stderr };
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, stderr: stderr || 'health 等待超时' };
}

async function bootIsolated() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-m1-'));
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

/** 只删本次脚本自建、且带明确前缀的临时目录——绝不把别人的目录当残渣清掉 */
function sweepTemp(dir) {
  if (!dir || !path.basename(dir).startsWith('mtask-m1-')) {
    console.log(`  跳过清理（非本脚本前缀）：${dir}`);
    return 'skipped';
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return 'removed';
  } catch (e) {
    return 'locked:' + e.message;
  }
}

/** ---------- UI 段的种子 ---------- */
// 数量与关键词不在这里写：seedUiFixture 与断言集同源于 m1-checks-ui.mjs 的 UI_SEED，
// 避免“种子造两条、断言却要求切出第 2 页”这种脱节（曾经真跳过这一坑）
async function seedForUi(base, tag) {
  const { call } = mkHttp(base);
  const seeded = await seedUiFixture(base, tag, { call });
  return { ...seeded, call };
}

/** ---------- 报告渲染 ---------- */
// PRD §13 验收表 → 本次由哪些断言组盯住。写进报告而不是只存在脚本里：
// 读者需要能直接看出“A1~A6/A13/A14/A15 里到底哪一条对应哪个实测”，而不是自己反推
const ACCEPT_MAP = [
  ['A1', '用例入口与矩阵入口样式一致', 'UI 段 A1（className + 同态 computedStyle）'],
  ['A2', '用例 CRUD / 默认值 / 枚举 / 编号唯一', 'API 段 A2（含 meta.defaults 单源比对）'],
  ['A3', '步骤 0~N 可编 / 排序 / 刷新仍在', 'API 段 A3'],
  ['A4', '矩阵行「用例 N」chip 下钻 + 用例侧「关联需求」chip 反向跳转（各 3 次）', 'API 段 A4（交叉核对）+ UI 段 A4（正向含重复下钻 3 轮 + 反向 3 轮）'],
  ['A5', '批量改 / 复制 / 删除（多项样本）', 'API 段 A5'],
  ['A6', '三格式导出 / 覆盖率子表 / 版式同源', 'API 段 A6（exceljs + pizzip 回读解包）'],
  ['A13', '切菜单返回后展开态/筛选/分页/多选/AI 草稿均保持', 'UI 段 A13（逐键渲染回读 + 越界回落；AI 草稿键属 M2，见未判定项）'],
  ['A14', '`tsc --noEmit` 与打包通过，无新增 Sonar 阻断', 'A14 段（三条构建实测；打包与 Sonar 见未判定项）'],
  ['A15', '删除确认明示连带用例条数', 'API 段 CASCADE + UI 段 A15（弹窗文本命中）'],
];

function renderMd(groups, meta) {
  const flat = groups.flatMap((g) => g.list);
  const pass = flat.filter((x) => x.pass).length;
  const skip = flat.filter((x) => x.skip).length;
  const fail = flat.length - pass - skip;
  const lines = [
    '# M1 验收回归报告（T01488）',
    '',
    `> 生成时间 ${meta.time} ｜ 被测实例 ${meta.base}（${meta.instance}）｜ runner=${meta.runner}`,
    `> 判定合计：**通过 ${pass} / 失败 ${fail} / 跳过 ${skip}** ｜ 退出码 ${meta.exit}`,
    '',
    `> 浏览器 console 错误：${meta.consoleErrors === 0 ? '0 条' : meta.consoleErrors + ' 条（详见 UI 段）'}`,
    '',
    '本报告由 `node server/scripts/m1-regression.mjs` 生成，脚本自带隔离实例与临时数据目录，跑完即清。',
    '',
    `**退出码 ${meta.exit} 的含义**（故意不给假绿）：0=全通过；1=有 FAIL；2=无 FAIL 但有 SKIP。`,
    skip > 0
      ? `本次 **${skip} 项判定不完整**，因此不报“M1 验收通过”——每一项 SKIP 都在下表写了原因与承接方，而不是默认归入绿。`
      : '本次无 SKIP，判定层全部覆到。',
    '',
    '## 验收项对应关系（PRD §13）',
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
  let instance = '外部实例（--base 指定，不自举）';
  let child = null;
  let dataDir = null;
  let runner = 'external';

  try {
    if (has('skip-build')) {
      groups.push({ title: 'A14 tsc / 构建（§13 判定：CI 结果）', ids: ['A14'], list: [{ k: 'A14_skipped', pass: false, skip: true, msg: '本次以 --skip-build 复跑，构建结论沿用上一次运行' }] });
    } else {
      groups.push(await phaseA14());
    }

    if (!base) {
      const booted = await bootIsolated();
      base = booted.base;
      child = booted.child;
      dataDir = booted.dataDir;
      runner = booted.runner;
      instance = '隔离实例（临时 DATA_DIR）';
    } else {
      const r = await fetch(`${base}/api/health`).catch(() => null);
      if (!r?.ok) throw new Error(`--base 指向的实例不可用：${base}`);
    }

    console.log('\n== API 断言 ==');
    let apiGroups = [];
    if (has('skip-api')) {
      console.log('  已跳过（--skip-api）');
    } else {
      apiGroups = await runApiChecks({ base });
      for (const g of apiGroups) console.log(`  ${g.title}: ${g.list.filter((x) => x.pass).length}/${g.list.length} pass`);
      groups.push(...apiGroups);
    }

    console.log('\n== UI 断言（需 CDP）==');
    const tag = `M1UI-${Date.now()}`;
    let ui = { groups: [], consoleErrors: [], skipped: true };
    if (has('skip-ui')) {
      // 跳过的段必须自己出现在报告里：不登记就会看起来像“UI 根本不需要验”，而不是“本次没跑”
      ui.groups = [{ title: 'UI 段未执行（--skip-ui）', ids: ['A1', 'A13', 'A4', 'A15'], list: [{ k: 'UI_skippedThisRun', pass: false, skip: true, msg: '本次以 --skip-ui 快跑，交互级断言（A1/A13/A4 双向跳转/A15）未执行，不得当作已验' }] }];
      console.log('  已跳过（--skip-ui）→ 报告里显式登一条 SKIP');
    } else {
      const seed = await seedForUi(base, tag);
      ui = await runUiChecks({ base, cdp: CDP, projectId: seed.projectId, reqIdWithCases: seed.reqIdWithCases });
      groups.push(...ui.groups);
      for (const g of ui.groups) console.log(`  ${g.title}: ${g.list.filter((x) => x.pass).length}/${g.list.length} pass`);
      try { await seed.call('DELETE', `/projects/${seed.projectId}`); } catch { /* UI 种子删不掉不影响判定，隔离库随后整体销毁 */ }
    }
    if (has('skip-api') || has('skip-ui') || has('skip-build')) {
      groups.push({ title: '本次为分段快跑（不是完整验收）', ids: ['RUN'], list: [{ k: 'RUN_partial', pass: false, skip: true, msg: `分段开关：${argv.filter((a) => a.startsWith('--skip')).join(' ') || '无'}——全量验收请不加任何 --skip 重跑` }] });
    }

    const flat = groups.flatMap((g) => g.list);
    const fail = flat.filter((x) => !x.pass && !x.skip).length;
    const skip = flat.filter((x) => x.skip).length;
    const exit = fail > 0 ? 1 : skip > 0 ? 2 : 0;
    const meta = {
      time: startedAt, base, instance, runner, exit,
      consoleErrors: (ui.consoleErrors ?? []).length,
    };
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
      await new Promise((r) => setTimeout(r, 600)); // 让 sqlite 句柄释放，否则 rm 撞锁
      console.log(`  临时数据目录 ${sweepTemp(dataDir)}：${dataDir}`);
    }
  }
}

process.exit(await main());
