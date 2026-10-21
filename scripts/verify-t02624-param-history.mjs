#!/usr/bin/env node
/**
 * T02624（§11-E13「改值历史」面 · §12-R1 后半）验收门。
 *
 * 判据对象是**这一版新出的那一面**：`GET /api/estimates/params` 的 `logs` 字段（T02120 已建、契约不动）
 * 经面板渲染出来的**表结构 / 行集 / 顺序 / 单元格取值 / 刷新前后的状态转移**，外加三个纯谓词与
 * `/meta` 的标签单源。字面文案一律降级为 `okPair` 的锚点腿（T02293 改判口径）。
 *
 * 分五组：
 *   A 命令层：面板导出的三谓词（键标签 / 未署名 / effective 解析）两态可判 + 名单外键不编造标签；
 *   R 数据层（隔离实例真 HTTP）：PUT 三次改值 + 一次越界拒绝 + 一次同值重写 + 一次显式清空，
 *     断言 logs 的条数 / 顺序 / 旧值取自上一次写入 / 零写入零留痕 / actor 口径 / effective 快照与同次 config 一致；
 *   V 真机层（CDP 驱动系统 Chrome）：空态 →（REST 改值）面板不自变 → 点「刷新」出表 →
 *     行集与 /params 同序同值 → 清空后再刷新归位；
 *   S 锚点层：文案字面腿走 `git show HEAD:`，与行为腿配对，红因可区分；
 *   N 负对照：判据副本反证 + okPair 契约 + 取证面自证 + 真机活体摘按钮反证。
 *
 * 用法（本仓内置 Browser 无视口不能点击/截图，见 memory）：
 *   <node22> node_modules/tsx/dist/cli.mjs scripts/verify-t02624-param-history.mjs
 *   环境变量：T02624_PH_PORT（默认 39962）、T02624_PH_CDP（默认 9362）
 *
 * 隔离纪律（skill 红线 8）：MTask_DATA_DIR 指临时目录、端口自配，不碰生产库与生产实例（39877）；
 * 截图落每轮独立子目录（gate-results 的进程级 RUN_TAG），临时根优先 D:/code/tmp（反模式 1）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = existsSync('D:/code/tmp') ? 'D:/code/tmp' : tmpdir();
const DATA_DIR = mkdtempSync(join(TMP_ROOT, 't02624-ph-'));
const CHROME_PROFILE = mkdtempSync(join(TMP_ROOT, 't02624-ph-chrome-'));
const { gateShotsDir, writeGateResults } = await import(pathToFileURL(join(ROOT, 'scripts/lib/gate-results.mts')).href);
const { okPair } = await import(pathToFileURL(join(ROOT, 'scripts/lib/anchor-pair.mts')).href);
const SHOTS = gateShotsDir('t02624');
const OUT_DIR = join(ROOT, '.workbuddy');
const OUT_BASE = 't02624-param-history-gate-results.txt';
const PORT = Number(process.env.T02624_PH_PORT ?? 39962);
const CDP = Number(process.env.T02624_PH_CDP ?? 9362);
const CHROME = process.env.T02624_PH_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0; let skip = 0;
const lines = [];
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; lines.push(`[PASS] ${name}`); console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    const tail = extra !== undefined ? ` -> ${JSON.stringify(extra).toString().slice(0, 500)}` : '';
    lines.push(`[FAIL] ${name}${tail}`);
    console.log(`  [FAIL] ${name}${tail}`);
  }
};
const skipped = (name, why) => {
  skip += 1;
  lines.push(`[SKIP] ${name}（${why}）——不计 PASS`);
  console.log(`  [SKIP] ${name}（${why}）`);
};
const note = (s) => { lines.push(`[INFO] ${s}`); console.log(`  · ${s}`); };

/** 反模式 11：字面腿只读**已提交树**（工作树里可能躺着别的会话留下的过期文件） */
function headSource(rel) {
  try { return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8' }); } catch { return ''; }
}
const ENG_REL = 'server/src/services/estimate-engine.ts';
const RT_REL = 'server/src/routes/estimates.ts';
const API_REL = 'web/src/api/estimates.ts';
const EP_REL = 'web/src/components/EstimatePanel.tsx';
const ENG_HEAD = headSource(ENG_REL);
const RT_HEAD = headSource(RT_REL);
const API_HEAD = headSource(API_REL);
const EP_HEAD = headSource(EP_REL);
const literalOn = (src, anchors) => src.length > 0 && anchors.every((a) => src.includes(a));

/** 运行期实测料（反模式 14）：只有真跑过浏览器/REST 才回填；N 组把它清空，行为腿必须立刻转假 */
const EV = { ran: false };
const evSet = (k, v) => { EV[k] = v; };

/**
 * S 组：每条都带**行为腿**（读运行期料 / 读谓词真身），字面锚只是佐证。
 * 浏览器没跑成时整组走 skipped()（判据 5：不拿字面锚冒充 PASS）。
 */
const S_SPECS = [
  {
    L: 'S-01 「无改值记录」空态不被读成「查询失败」（措辞换掉判据照样成立，但告警态必须与空态互斥）',
    anchors: ['本次版本起尚无改值记录', '不是查询失败'], src: EP_HEAD, SRCLBL: EP_REL,
    behavior: () => J.emptyNotError(EV),
  },
  {
    L: 'S-02 未署名态有出口（actor 空串渲染成一枚可读标记，而不是空白单元格）',
    anchors: ['未署名'], src: EP_HEAD, SRCLBL: EP_REL,
    behavior: () => J.actorAnonymous(EV),
  },
  {
    L: 'S-03 「未设置」与「显式清空」两态各有文字（空串不画成空白）',
    anchors: ['（未设置）', '（清空回落默认）'], src: EP_HEAD, SRCLBL: EP_REL,
    behavior: () => J.oldNewStates(EV),
  },
  {
    L: 'S-04 留痕消费面只有 `logs` 一处（路由里没有第二条「查历史」端点）',
    anchors: ['logs: EstimateParamLog[]'], src: API_HEAD, SRCLBL: API_REL,
    behavior: () => J.noSecondHistoryEndpoint(RT_HEAD),
  },
  {
    L: 'S-05 键名标签走 `/meta` 的 `settingLabels` 单源',
    anchors: ['settingLabels: ESTIMATE_SETTING_LABELS'], src: RT_HEAD, SRCLBL: RT_REL,
    behavior: () => J.labelSingleSource(EV),
  },
  {
    L: 'S-06 系数标签派生自 `ESTIMATE_COEF_LABELS`，不在标签表里重写第二份',
    anchors: ['ESTIMATE_COEF_LABELS[k]'], src: ENG_HEAD, SRCLBL: ENG_REL,
    behavior: () => J.coefLabelDerived(EV),
  },
  {
    L: 'S-07 刷新是面板内一枚显式按钮（不弹 prompt/confirm——Electron 渲染层里那两枚根本不可用）',
    anchors: ['刷新改值历史'], src: EP_HEAD, SRCLBL: EP_REL,
    behavior: () => J.refreshAffordance(EV),
  },
  {
    L: 'S-08 时间列取可读全时间（`fullTime`），不铺 ISO 串',
    anchors: ['fullTime(log.created_at)'], src: EP_HEAD, SRCLBL: EP_REL,
    behavior: () => J.timeReadable(EV),
  },
];

const pad = (n) => String(n).padStart(2, '0');
/** 与面板 `fullTime()` 同一形态（本地时区、年-月-日 时:分）——门用它比对页面文本，不是自己定一套 */
const localFull = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const numsOf = (s) => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number);

// ---------------- 0) 行为判据（参数化取证面：N 组喂副本必须能翻红） ----------------
const J = {
  /** 空态：section 在场、无 alert（不是查询失败）、无表格、有文字 */
  emptyNotError: (e) => !!e && !!e.empty0 && e.empty0.present === true && e.empty0.alert === false
    && e.empty0.hasTable === false && e.empty0.textLength > 0,
  /** 未署名：谓词两态 + 真机列内确实出现该态一次（署名前那条） */
  actorAnonymous: (e) => !!e && !!e.A && e.A.paramLogActorLabel('') === '未署名' && e.A.paramLogActorLabel('  ') === '未署名'
    && e.A.paramLogActorLabel('  张三  ') === '张三' && !!e.rows1 && e.rows1.anonRows === 1 && e.rows1.actorAllNonEmpty === true,
  /** 未设置态在首轮表里、显式清空态在次轮表里（两态各一处，缺一不可） */
  oldNewStates: (e) => !!e && !!e.rows1 && !!e.rows2 && e.rows1.unsetState === true && e.rows2.clearedState === true,
  /** 留痕消费面单点：路由端点名单里除 params 外没有第二条带 logs 的入口 */
  noSecondHistoryEndpoint: (rtHead) => {
    const s = String(rtHead);
    if (s.length < 400) return false;
    const endpoints = s.match(/estimateApi\.(get|put|post|delete)\(\s*'\/[^']+'/g) || [];
    const historyish = endpoints.filter((h) => /histor/i.test(h));
    const logsMentions = (s.match(/\blogs\b/g) || []).length;
    return historyish.length === 0 && logsMentions <= 2 && /estimateApi\.get\('\/params'/.test(s);
  },
  /** 标签单源：UI 每列键名 == `/meta.settingLabels` 下发的那一份（名单外原样显示键），且行数与服务端一致 */
  labelSingleSource: (e) => !!e && !!e.rows1 && e.rows1.labelMatchServer === true && e.rows1.rowCount === e.logCount,
  /** 系数标签是从 ESTIMATE_COEF_LABELS 派生的（两处取到同一份值） */
  coefLabelDerived: (e) => !!e && !!e.A && e.A.coefLabelCheck === true,
  /** 刷新入口在真机摸得到（一枚、有文字、aria-label 指向历史区） */
  refreshAffordance: (e) => !!e && !!e.section && e.section.refreshBtns === 1 && e.section.btnTexts.length > 0,
  /** 时间列可读：每格都是「年-月-日 时:分」且与同序 created_at 的本地时间一致 */
  timeReadable: (e) => !!e && !!e.rows1 && e.rows1.timeOk === true && e.rows1.rowCount > 0,
  /** 刷新是真的重取：改值前面板停在旧态（0 行），刷新后追上服务端（1 = 追上） */
  refreshTakesEffect: (e) => !!e && !!e.staleCheck && e.staleCheck.before === 0 && e.staleCheck.after === 1,
  /** 清空后再刷新归位：行数与服务端一致且清空那条落了文字 */
  clearedRowShown: (e) => !!e && !!e.rows2 && e.rows2.clearedState === true && e.rows2.rowCount === e.logCount2,
};

// ---------------- 1) A 组：命令层（进程内直调面板导出的谓词与引擎常量） ----------------
console.log('\n=== A 组 命令层：面板导出的三个谓词 + 引擎标签单源 ===');
const { shimWebDocumentForNode } = await import(pathToFileURL(join(ROOT, 'scripts/lib/web-dom-shim.mts')).href);
// EstimatePanel transitively imports api/client.ts（顶层从 document.baseURI 推 apiBase），Node 侧要垫片
shimWebDocumentForNode(PORT);
const P = await import(pathToFileURL(join(ROOT, 'web', 'src', 'components', 'EstimatePanel.tsx')).href);
const ENG = await import(pathToFileURL(join(ROOT, 'server', 'src', 'services', 'estimate-engine.ts')).href);
const { ESTIMATE_SETTING_KEYS, ESTIMATE_COEF_KEYS, ESTIMATE_COEF_LABELS, ESTIMATE_COEF_SETTING_KEYS, ESTIMATE_SETTING_LABELS } = ENG;
const SETTING_KEYS = Object.values(ESTIMATE_SETTING_KEYS);
const COEF_SETTING_KEYS = Object.values(ESTIMATE_COEF_SETTING_KEYS);
/** 系数键本身就在 §3.3 八键里，两侧并集要去重后再比名单（否则八键会被数成十二键） */
const LABEL_KEY_UNION = [...new Set([...SETTING_KEYS, ...COEF_SETTING_KEYS])];
/** 署名键只在夹具里当**写入输入**用一次（它是 routes 里的模块常量，不在 §3.3 名单里，正是本组要验的「名单外」）*/
const K_REVIEWER = 'estimate.reviewer';
const K_MD = ESTIMATE_SETTING_KEYS.manDaysPerManMonth;
const A = {
  paramLogKeyLabel: P.paramLogKeyLabel, paramLogActorLabel: P.paramLogActorLabel,
  parseParamLogEffective: P.parseParamLogEffective,
  coefLabelCheck: ESTIMATE_COEF_KEYS.every((k) => ESTIMATE_SETTING_LABELS[ESTIMATE_COEF_SETTING_KEYS[k]] === ESTIMATE_COEF_LABELS[k]),
};
evSet('A', A);

ok('A-00 取证面在场：面板导出 paramLogKeyLabel / paramLogActorLabel / parseParamLogEffective，引擎导出 ESTIMATE_SETTING_LABELS',
  [P.paramLogKeyLabel, P.paramLogActorLabel, P.parseParamLogEffective].every((x) => typeof x === 'function')
  && ESTIMATE_SETTING_LABELS && typeof ESTIMATE_SETTING_LABELS === 'object',
  { 面板: [typeof P.paramLogKeyLabel, typeof P.paramLogActorLabel, typeof P.parseParamLogEffective], 引擎: typeof ESTIMATE_SETTING_LABELS });
ok('A-01 键标签：§3.3 八键逐个有非空中文标签，谓词取回的就是引擎那一份（不显示成 `estimate.xxx` 原键）',
  SETTING_KEYS.length === 8 && SETTING_KEYS.every((k) => typeof ESTIMATE_SETTING_LABELS[k] === 'string'
    && ESTIMATE_SETTING_LABELS[k].length > 0
    && P.paramLogKeyLabel(k, ESTIMATE_SETTING_LABELS) === ESTIMATE_SETTING_LABELS[k]
    && !P.paramLogKeyLabel(k, ESTIMATE_SETTING_LABELS).startsWith('estimate.')),
  SETTING_KEYS.map((k) => [k, ESTIMATE_SETTING_LABELS[k]]));
ok('A-02 名单外的键不编造标签：库里出现没登记过的键时照原样显示（否则历史区会把未知键伪装成已知键）',
  P.paramLogKeyLabel('estimate.unknown.key', ESTIMATE_SETTING_LABELS) === 'estimate.unknown.key'
  && P.paramLogKeyLabel(K_REVIEWER, ESTIMATE_SETTING_LABELS) === K_REVIEWER
  && ESTIMATE_SETTING_LABELS[K_REVIEWER] === undefined,
  P.paramLogKeyLabel(K_REVIEWER, ESTIMATE_SETTING_LABELS));
ok('A-03 §9 单源红线：系数键标签从 `ESTIMATE_COEF_LABELS` 派生，两处取到同一份值（改标签不会只改一处）',
  COEF_SETTING_KEYS.length === 4 && ESTIMATE_COEF_KEYS.every((k) => ESTIMATE_SETTING_LABELS[ESTIMATE_COEF_SETTING_KEYS[k]] === ESTIMATE_COEF_LABELS[k]),
  ESTIMATE_COEF_KEYS.map((k) => [ESTIMATE_COEF_SETTING_KEYS[k], ESTIMATE_SETTING_LABELS[ESTIMATE_COEF_SETTING_KEYS[k]], ESTIMATE_COEF_LABELS[k]]));
ok('A-04 标签名单恰等于 §3.3 八键（含四系数键），不掺进署名项（T02086 裁决：参数面不出现「估算人」那一栏，API 写入通道保留）',
  LABEL_KEY_UNION.length === 8
  && JSON.stringify(Object.keys(ESTIMATE_SETTING_LABELS).slice().sort()) === JSON.stringify(LABEL_KEY_UNION.slice().sort()),
  { 名单: Object.keys(ESTIMATE_SETTING_LABELS).sort(), 应为: LABEL_KEY_UNION.slice().sort() });
ok('A-05 未署名态：空串/纯空白/null → 「未署名」，有名去空白照原样（不留空单元格让复核的人以为漏了一列）',
  P.paramLogActorLabel('') === '未署名' && P.paramLogActorLabel('   ') === '未署名'
  && P.paramLogActorLabel(null) === '未署名' && P.paramLogActorLabel(' 张三 ') === '张三');
ok('A-06 effective 快照解析：合法 JSON 三数原样取；坏 JSON / 空串 / null / 缺字段 / 非数字 / 非对象一律「读不出」（null），不猜数也不让整块历史消失',
  JSON.stringify(P.parseParamLogEffective('{"manDaysPerManMonth":22,"hoursPerManDay":8,"coefSum":0.23}'))
    === JSON.stringify({ manDaysPerManMonth: 22, hoursPerManDay: 8, coefSum: 0.23 })
  && P.parseParamLogEffective('{bad json') === null && P.parseParamLogEffective('') === null
  && P.parseParamLogEffective(null) === null && P.parseParamLogEffective('{"manDaysPerManMonth":22}') === null
  && P.parseParamLogEffective('{"manDaysPerManMonth":"22","hoursPerManDay":8,"coefSum":0.23}') === null
  && P.parseParamLogEffective('[1,2,3]') === null,
  [P.parseParamLogEffective('{bad json'), P.parseParamLogEffective('{"manDaysPerManMonth":"22","hoursPerManDay":8,"coefSum":0.23}')]);

// ---------------- 2) 夹具：临时库直写（进程内，起服务前完成） ----------------
process.env.MTask_DATA_DIR = DATA_DIR;
const { getDb, closeDb } = await import('../server/src/db/connection.ts');
const { initSchema } = await import('../server/src/db/schema.ts');
initSchema();
const T = new Date().toISOString();
const PID = 'ph-t02624';
const db = getDb();
db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
  .run(PID, 'T02624-改值历史走查', '', T, T);
db.prepare(
  `INSERT INTO plan_tasks (id, project_id, title, description, start_date, end_date, duration_days,
     progress, status, assignee, sort_order, created_at, updated_at, kind, complexity, req_ids, deps)
   VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, null, ?)`,
).run('p-one', PID, '夹具计划一条', T, T, 5, 100, 'done', 1, T, T, 'normal', 2, null);
db.prepare(
  `INSERT INTO estimate_items (id, project_id, plan_id, phase, unit, optimistic, likely, pessimistic, source, note, created_at, updated_at)
   VALUES (?, ?, ?, 'dev', 'man_day', ?, ?, ?, 'manual', '', ?, ?)`,
).run('e-one', PID, 'p-one', 3, 5, 8, T, T);
closeDb();

// ---------------- 2.5) 前置件就位（批㉚ U-00e 同款口径；T02767 改判） ----------------
// dist 缺失＝「考卷没发」、dist 早于 HEAD＝「考卷是旧的」：两支都记 SKIP 收口并 exit≠0，
// 不再用 ok(existsSync(DIST)) 记 FAIL——那会把「谁没跑 build」变成恒红门（红因不可归因，T02293 要打的那一类）。
// 检查放在起服务之前：产物缺失时不必空烧一次隔离实例启动。
const DIST = join(ROOT, 'web', 'dist', 'index.html');
const distReady = existsSync(DIST);
const distMtime = distReady ? statSync(DIST).mtimeMs : 0;
const headCommitMs = Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, encoding: 'utf8' }).toString().trim() || 0) * 1000;
if (!distReady) {
  skipped('E-01 前端产物就位', `web/dist/index.html 不在（${DIST}）——前置件缺失，不是判据失守`);
  lines.push('[ABORT] 前置件未就位（dist 缺失）——运行期料不会有，S/N 组按 skipped 处理');
  finishAndExit(1);
}
if (headCommitMs > 0 && distMtime < headCommitMs) {
  skipped('E-01 前端产物不早于 HEAD 提交', `dist 构建于 ${new Date(distMtime).toISOString()}，HEAD 提交于 ${new Date(headCommitMs).toISOString()}——旧产物测新代码，红绿不可归因；跑「cd web && npm run build」后复跑本门`);
  lines.push('[ABORT] web/dist 早于 HEAD 提交——前置件过期，浏览器腿不跑');
  finishAndExit(1);
}

// ---------------- 3) 隔离服务 ----------------
const { resolveServerLauncher } = await import(pathToFileURL(join(ROOT, 'scripts/isolated-server-launcher.mts')).href);
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
const server = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT, env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(`隔离实例启动器：${LAUNCHER.label}`);
const serverLog = [];
server.stdout?.on('data', (b) => serverLog.push(b.toString()));
server.stderr?.on('data', (b) => serverLog.push(b.toString()));

function finishAndExit(code) {
  try {
    if (EV.ran !== true) {
      for (const it of S_SPECS) lines.push(`[SKIP] ${it.L}（运行期料缺失——不以字面锚冒充 PASS：浏览器/服务未跑成）——不计 PASS`);
      lines.push('[SKIP] N-07 活体摘按钮反证（同上）——不计 PASS');
      skip += S_SPECS.length + 1;
    }
    const head = 'T02624 §11-E13 改值历史真机门（T02293 改判：判据对象＝真实页面产出的结构/行集/顺序/单元格取值 + REST 留痕契约）\n';
    const file = writeGateResults(OUT_DIR, OUT_BASE,
      `PASS=${pass} FAIL=${fail} SKIP=${skip}\n${head}${lines.join('\n')}\n`,
      { port: PORT, dataDir: DATA_DIR, note: `CDP=${CDP} S组锚点=${S_SPECS.length} 运行期实测=${EV.ran ? '已回填' : '缺失'}` });
    console.log(`\nPASS=${pass} FAIL=${fail} SKIP=${skip} → ${file}`);
  } catch { /* 结果文件写失败不改变结论 */ }
  process.exit(code);
}

ok('E-01 前端产物就位且不早于 HEAD 提交（隔离实例按它伺服前端）', true,
  `${DIST}|mtime=${new Date(distMtime).toISOString()}|head=${new Date(headCommitMs).toISOString()}`);
const ARTIFACT = `${DIST}|mtime=${new Date(distMtime).toISOString()}|HEAD=${new Date(headCommitMs).toISOString()}`;
note(`本轮页面断言所跑的产物：${ARTIFACT}`);
ok('E-02 Chrome 可执行文件在场（可用 T02624_PH_CHROME 覆盖）', existsSync(CHROME), CHROME);
if (!existsSync(CHROME)) {
  lines.push('[ABORT] 环境预检未过（Chrome 缺失）——运行期料不会有，S/N 组按 skipped 处理');
  finishAndExit(1);
}
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP}`, '--headless=new', '--no-first-run', '--disable-gpu',
  '--force-device-scale-factor=1', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  `--user-data-dir=${CHROME_PROFILE}`, '--window-size=1920,1080', 'about:blank',
], { stdio: 'ignore' });
const killTree = (pid) => { try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } };
const bye = () => { killTree(chrome.pid); killTree(server.pid); };
process.on('exit', bye);
const sleepSync = (i) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * (i + 1)); };
const cleanup = () => {
  if (process.env.T02624_PH_KEEP) return;
  for (const dir of [DATA_DIR, CHROME_PROFILE]) {
    for (let i = 0; i < 8; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { sleepSync(i); }
    }
  }
};
process.on('exit', cleanup);

let serverUp = false;
let healthBody = null;
for (let i = 0; i < 90; i++) {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) {
      const ct = String(r.headers.get('content-type') ?? '');
      if (!ct.includes('application/json')) throw new Error(`health 不是 JSON（${ct}）`);
      healthBody = await r.json();
      if (healthBody?.service === 'mtask-server') { serverUp = true; break; }
    }
  } catch { /* 还没起来 */ }
  await sleep(500);
}
ok('E-03 隔离服务启动并回 JSON 体检体（临时端口 + 临时库：1 条计划 1 条估算，改值留痕表为空）',
  serverUp && healthBody?.ok === true, { healthBody, dataDir: DATA_DIR });
if (!serverUp) {
  console.log(`\n—— 服务日志（${DATA_DIR}）——\n${serverLog.join('').split('\n').slice(-40).join('\n')}`);
  finishAndExit(1);
}

let wsUrl = '';
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
    if (r.ok) { const t = (await r.json()).find((x) => x.type === 'page'); if (t) { wsUrl = t.webSocketDebuggerUrl; break; } }
  } catch { /* Chrome 还在起 */ }
  await sleep(400);
}
ok('E-04 Chrome CDP 通道就绪（系统 Chrome, headless=new）', !!wsUrl, wsUrl);
if (!wsUrl) {
  lines.push('[ABORT] CDP 通道拿不到 page target——运行期料不会有，S/N 组按 skipped 处理');
  finishAndExit(1);
}

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
const netLog = [];
ws.onmessage = (ev2) => {
  const m = JSON.parse(ev2.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const { method, url } = m.params.request;
    if (/\/api\/estimates\/(params|meta)/.test(url)) netLog.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
async function until(expr, ms = 20_000) {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < ms) {
    v = await ev(expr);
    if (v) return v;
    await sleep(300);
  }
  return v;
}
async function setViewport(width, height = 1000) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
}
const shotFiles = [];
async function shot(name) {
  mkdirSync(SHOTS, { recursive: true });
  await send('Page.bringToFront');
  for (let i = 0; i < 3; i++) {
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const b64 = r.result && r.result.data;
    if (b64) {
      const file = join(SHOTS, `${name}.png`);
      writeFileSync(file, Buffer.from(b64, 'base64'));
      shotFiles.push(file);
      return file;
    }
    await sleep(700);
  }
  return '';
}

/**
 * 页面探针：只取**结构 / 单元格文本 / 样式解析值**（T02293 口径——文案换措辞不影响判据，
 * 但把「未署名」整枚删掉、把时间退回 ISO、把刷新按钮摘掉，判据立刻失守）。
 * 取色用临时 span 写 var(...) 再读回 computed，门不硬编码 rgb 常量。
 */
const PJ = `const cs=(v)=>{ let el=document.getElementById('__gate_csp'); if(!el){ el=document.createElement('span'); el.id='__gate_csp'; el.style.cssText='position:absolute;left:-9999px;top:0'; (document.body||document.documentElement).appendChild(el); } el.style.color='#000'; el.style.color=v; return getComputedStyle(el).color; };
  const p=()=>document.querySelector('aside[aria-label="估算面板"]');
  const ph=()=>document.querySelector('section[aria-label="估算参数改值历史"]');
  const rows=()=>{const t=ph(); if(!t) return null; return [...t.querySelectorAll('tbody tr')].map(tr=>{const td=[...tr.children]; return {time:(td[0]||{}).textContent||'',key:(td[1]||{}).textContent||'',oldNew:(td[2]||{}).textContent||'',actor:(td[3]||{}).textContent||'',eff:(td[4]||{}).textContent||'',effColor:td[4]?getComputedStyle(td[4]).color:''};}).map(x=>({time:x.time.trim(),key:x.key.trim(),oldNew:x.oldNew.replace(/\\s+/g,' ').trim(),actor:x.actor.trim(),eff:x.eff.replace(/\\s+/g,' ').trim(),effColor:x.effColor}));};
  const sec=()=>{const t=ph(); if(!t) return null; const bs=[...t.querySelectorAll('button')];
    return {present:true, hasTable:!!t.querySelector('tbody'), alert:!!t.querySelector('[role="alert"]'),
      ths:[...t.querySelectorAll('thead th')].map(c=>c.textContent.trim()),
      textLength:t.innerText.replace(/\\s+/g,'').length, head:t.innerText.slice(0,40).replace(/\\s+/g,' '),
      refreshBtns:bs.filter(b=>/改值历史/.test(String(b.getAttribute('aria-label')||''))&&String(b.textContent).trim().length>0).length,
      btnTexts:bs.map(b=>b.textContent.trim())};};`;
const PE = (strings, ...exprs) => {
  let body = strings[0];
  exprs.forEach((e, i) => { body += String(e) + strings[i + 1]; });
  return `(() => { ${PJ}${body} })()`;
};

/** REST：门自己走 HTTP 改值（面板外改，正是这一面要覆盖的真实场景） */
async function api(method, path, bodyObj) {
  const r = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
  let json = null;
  try { json = await r.json(); } catch { /* 非 JSON 响应按 null，让断言自己红 */ }
  return { status: r.status, json };
}
const PUT = (settings) => api('PUT', `/estimates/params?projectId=${PID}`, { settings });
const GETP = () => api('GET', `/estimates/params?projectId=${PID}`);
const byKey = (logs, key) => logs.filter((l) => l.key === key);

// ---------------- 4) 页面装载 + 空态（在任何改值之前） ----------------
await send('Page.enable');
await send('Network.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try {
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
    sessionStorage.setItem('plan.projectId', JSON.stringify(${JSON.stringify(PID)}));
    sessionStorage.setItem('plan.viewMode', JSON.stringify('timeline'));
    sessionStorage.setItem('plan.estimatePanelOpen', JSON.stringify(true));
    localStorage.setItem('mtask.projectGuide.seen', '1');
    ['tasks', 'aitools', 'prompts', 'req', 'plan', 'report', 'history', 'queue', 'exec-sessions', 'settings']
      .forEach((t) => localStorage.setItem('mtask.guide.seen.' + t, '1'));
  } catch (e) {}`,
});
await send('Page.navigate', { url: `${BASE}/?m=0` });
const shell = await until(`(() => { const r=document.querySelector('#root');
  return r && r.children.length>0 && document.querySelectorAll('button').length>=8 ? {root:r.children.length, btns:document.querySelectorAll('button').length} : ''; })()`, 30_000);
ok('V-01 应用外壳挂载并渲染出可点导航（#root 有子节点且按钮 ≥ 8 枚）', !!shell, shell);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '项目管理'); b?.click(); return 1; })()`);
await setViewport(1920, 1000);
const panel0 = await until(PE`if(!p()) return ''; return { cells:p().querySelectorAll('input[type="number"]').length };`, 25_000);
ok('V-02 估算面板已打开（改值历史区挂在面板内，先要有面板与明细行）', !!panel0 && panel0.cells === 3, panel0);
const section0 = await until(PE`const s=sec(); return s||'';`, 25_000);
evSet('section', section0 || null);
ok('V-03 改值历史区已渲染（section[aria-label] 在场、恰一枚刷新入口、无 alert、表头尚未出现）',
  !!section0 && section0.present === true && section0.refreshBtns === 1 && section0.alert === false && section0.hasTable === false, section0);
evSet('empty0', section0 ? { present: section0.present, alert: section0.alert, hasTable: section0.hasTable, textLength: section0.textLength } : null);
await shot('v03-空态');

console.log('\n=== R 组 REST 层：PUT 三次改值 + 越界拒绝 + 同值重写 + 显式清空 ===');
const metaR = await api('GET', '/estimates/meta');
const labelMap = metaR.json?.settingLabels ?? {};
evSet('meta', { settingLabels: labelMap, coefLabels: metaR.json?.coefLabels, settingKeys: metaR.json?.settingKeys });
ok('R-01 `/meta` 随参数面下发 `settingLabels`（§9 标签单源：八键都有非空中文标签，系数键标签与 `coefLabels` 同值）',
  metaR.status === 200 && Object.values(metaR.json?.settingKeys ?? {}).every((k) => typeof labelMap[k] === 'string' && labelMap[k].length > 0)
  && ESTIMATE_COEF_KEYS.every((k) => labelMap[metaR.json.coefSettingKeys[k]] === metaR.json.coefLabels[k]),
  { 名单: Object.keys(labelMap), 系数: ESTIMATE_COEF_KEYS.map((k) => [labelMap[metaR.json.coefSettingKeys[k]], metaR.json.coefLabels[k]]) });
ok('R-02 `/meta` 的标签名单恰好是 §3.3 八键（含系数键），不掺进署名项（参数面不会长出「估算人」那一栏）',
  metaR.status === 200 && JSON.stringify(Object.keys(labelMap).slice().sort())
    === JSON.stringify([...new Set([...Object.values(metaR.json.settingKeys), ...Object.values(metaR.json.coefSettingKeys)])].sort())
  && labelMap[K_REVIEWER] === undefined,
  Object.keys(labelMap));

const logsBefore = (await GETP()).json?.logs ?? null;
ok('R-03 夹具初态：一条参数都没写过时 `logs` 是空数组（字段在、条数 0，不是缺字段），生效值取默认 20.83',
  Array.isArray(logsBefore) && logsBefore.length === 0, logsBefore);
const put1 = await PUT({ [K_MD]: '20' });
ok('R-04 PUT#1（默认态 → 20）logged=1，旧值取「未设置」的 KV 原件而不是生效默认 20.83（留痕记的是实际写入史）',
  put1.status === 200 && put1.json?.logged === 1, put1.json);
const put2 = await PUT({ [K_REVIEWER]: '历史门访客', [K_MD]: '22' });
ok('R-05 PUT#2（署名 + 20 → 22）logged=2：同一次多键写入逐键落痕，actor 改前未署名时回落本次新署名',
  put2.status === 200 && put2.json?.logged === 2, put2.json);
const put3 = await PUT({ [K_MD]: '24' });
const logs3 = (await GETP()).json?.logs ?? [];
evSet('logCount', logs3.length);
ok('R-06 PUT#3 后共 4 条（1+2+1）且严格新→旧：同一次多键写入时间戳相同也能定序（rowid 兜底，面板不重排）',
  put3.status === 200 && put3.json?.logged === 1 && logs3.length === 4
  && logs3.every((l, i) => i === 0 || new Date(l.created_at).getTime() <= new Date(logs3[i - 1].created_at).getTime()),
  logs3.map((l) => ({ key: l.key, old: l.old_value, nu: l.new_value, actor: l.actor, at: l.created_at })));
const mdSeq = byKey(logs3, K_MD).map((l) => [l.old_value, l.new_value]);
ok('R-07 旧值取自上一次写入（不是本次生效值、也不是默认值）：同一键按新→旧为 22→24 / 20→22 / （空）→20',
  JSON.stringify(mdSeq) === JSON.stringify([['22', '24'], ['20', '22'], ['', '20']]), mdSeq);
ok('R-08 actor 口径：署名之后的三条都带署名，署名之前那条恒为空串（由 UI 落「未署名」，不是查询缺列）',
  byKey(logs3, K_MD).every((l) => (l.new_value === '20' ? l.actor === '' : l.actor === '历史门访客'))
  && byKey(logs3, K_REVIEWER).length === 1,
  logs3.map((l) => [l.key, l.actor]));
const eff3 = P.parseParamLogEffective(logs3[0]?.effective);
const cfg3 = put3.json?.config;
ok('R-09 effective 快照与同次响应的生效值同源（人月标准 / 每天小时 / Σ系数三项逐值相等，Σ系数按两位小数）',
  !!eff3 && eff3.manDaysPerManMonth === cfg3?.manDaysPerManMonth && eff3.hoursPerManDay === cfg3?.hoursPerManDay
  && Math.abs(eff3.coefSum - ESTIMATE_COEF_KEYS.reduce((a, k) => a + cfg3.coefs[k], 0)) < 0.005
  && eff3.coefSum === Math.round(eff3.coefSum * 100) / 100,
  { eff3, cfg3 });
const over = await PUT({ [K_MD]: '99' });
const logsAfterOver = (await GETP()).json?.logs ?? [];
ok('R-10 越界改值（99 > 上限 30）→ 400 且点名被拒的键；零写入 ⇒ 零留痕（条数不变、值仍是 24，「没落痕」与「没改值」是同一件事）',
  over.status === 400 && String(over.json?.error ?? '').includes(K_MD)
  && logsAfterOver.length === logs3.length && byKey(logsAfterOver, K_MD)[0]?.new_value === '24',
  { 状态: over.status, 报错: over.json?.error, 条数: [logs3.length, logsAfterOver.length] });
const noop = await PUT({ [K_MD]: '24' });
ok('R-11 同值重写 logged=0 且不落痕（审计面不产噪声：有没有改过要看行数，而不是看刷了多少次）',
  noop.status === 200 && noop.json?.logged === 0 && ((await GETP()).json?.logs ?? []).length === logs3.length,
  noop.json);
ok('R-12 logs 的字段名与排序沿用 T02120 已断言的契约（六字段 snake_case 原样下发，本板只读不改）',
  logs3.length > 0 && logs3.every((l) => ['id', 'project_id', 'actor', 'key', 'old_value', 'new_value', 'effective', 'created_at'].every((f) => f in l)),
  Object.keys(logs3[0] ?? {}));

// ---------------- 5) 面板不自变 + 点「刷新」出表 ----------------
const stale = await ev(PE`const s=sec(); return {hasTable:s.hasTable, n:(rows()||[]).length, head:s.head};`);
ok('V-04 服务端已有 4 条留痕，面板仍停在空态（不轮询、不在写入瞬间自变——这一条是「显式刷新」设计的行为证据，不是惰性 bug）',
  !!stale && stale.hasTable === false && stale.n === 0, stale);
const clicked = await ev(PE`const b=ph().querySelector('button[aria-label*="改值历史"]');
  if(!b) return 'nobtn'; b.scrollIntoView({block:'center'}); b.click(); return 'clicked';`);
const rows1raw = await until(PE`const r=rows(); if(!r || !r.length) return ''; return r;`, 25_000);
const logsNow = (await GETP()).json?.logs ?? [];
const uiOf = (r, i) => ({
  keyOk: r.key === (labelMap[logsNow[i]?.key] ?? logsNow[i]?.key),
  oldNewOk: r.oldNew === `${logsNow[i]?.old_value || '（未设置）'} → ${logsNow[i]?.new_value || '（清空回落默认）'}`,
  actorOk: r.actor === P.paramLogActorLabel(logsNow[i]?.actor),
  timeOk: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.time) && r.time === localFull(logsNow[i]?.created_at ?? ''),
  effNums: numsOf(r.eff),
});
const zipped = (rows1raw ?? []).map((r, i) => ({ ui: r, cell: uiOf(r, i), srv: logsNow[i] }));
evSet('rows1', rows1raw ? {
  rowCount: rows1raw.length,
  labelMatchServer: zipped.every((z) => z.cell.keyOk),
  unsetState: rows1raw.some((r) => r.oldNew.includes('（未设置）')),
  timeOk: zipped.every((z) => z.cell.timeOk),
  anonRows: rows1raw.filter((r) => r.actor === '未署名').length,
  actorAllNonEmpty: rows1raw.every((r) => r.actor.length > 0),
  allSame: zipped.length === logsNow.length && zipped.every((z) => z.cell.keyOk && z.cell.oldNewOk && z.cell.actorOk),
} : null);
evSet('staleCheck', { before: stale && stale.hasTable === false ? 0 : 1, after: rows1raw && rows1raw.length > 0 ? 1 : 0 });
ok('V-05 点「刷新」后面板追上服务端：出表且行数 = logs 条数，且刷新真的重发了 `/params` 请求（不是把旧 state 重画）',
  clicked === 'clicked' && !!rows1raw && rows1raw.length === logs3.length
  && netLog.filter((x) => /\/api\/estimates\/params/.test(x)).length >= 2,
  { clicked, 行数: rows1raw?.length, logs: logs3.length, 请求: netLog.slice(-6) });
ok('V-06 逐行同序同值：UI 第 i 行的「参数 / 旧值→新值 / 操作人」三列等于服务端 logs[i]（面板不重排、不做第二次判定）',
  zipped.length === logsNow.length && zipped.length > 0 && zipped.every((z) => z.cell.keyOk && z.cell.oldNewOk && z.cell.actorOk),
  zipped.map((z) => ({ ui: [z.ui.key, z.ui.oldNew, z.ui.actor], srv: [z.srv?.key, z.srv?.old_value, z.srv?.new_value, z.srv?.actor] })));
ok('V-07 键名列走单源：每列取值要么是 `/meta.settingLabels` 里的标签，要么是名单外的原键；署名那条显示原键、不被编造成中文',
  zipped.length > 0 && zipped.every((z) => Object.values(labelMap).includes(z.ui.key) || z.ui.key === z.srv?.key)
  && zipped.some((z) => z.ui.key === K_REVIEWER),
  zipped.map((z) => z.ui.key));
ok('V-08 未署名态在真机上摸得到：署名前那一条落「未署名」，且整列没有空白单元格',
  (rows1raw ?? []).filter((r) => r.actor === '未署名').length === 1
  && (rows1raw ?? []).every((r) => r.actor.length > 0), (rows1raw ?? []).map((r) => [r.key, r.actor]));
ok('V-09 未设置态：首次改值那条画成「（未设置） → 20」，不把空串画成空白',
  (rows1raw ?? []).some((r) => r.oldNew === '（未设置） → 20'), (rows1raw ?? []).map((r) => r.oldNew));
const cols = await ev(PE`const t=ph(); const ths=[...t.querySelectorAll('thead th')];
  const td=(rows()[0]||{}); return { th:ths.length, thEmpty:ths.filter(x=>!x.textContent.trim()).length,
    td:(t.querySelector('tbody tr')||{children:[]}).children.length, scope:ths.map(x=>x.getAttribute('scope')) };`);
ok('V-10 表结构齐备：表头格数 = 每行数据格数（列不串位），表头无空格子且每格都声明 scope=col（读表器能逐列对上）',
  !!cols && cols.th === cols.td && cols.th === 5 && cols.thEmpty === 0 && cols.scope.every((s) => s === 'col'), cols);
ok('V-11 时间列可读：每格都是本地「年-月-日 时:分」并与同序 created_at 一致，不是 ISO 串',
  zipped.length > 0 && zipped.every((z) => z.cell.timeOk), zipped.map((z) => [z.ui.time, z.srv?.created_at]));
ok('V-12 改后生效值列：三个数与 `effective` 快照逐值相等（人天/人月、人时/天、Σ系数），前端不做第二次换算',
  zipped.length > 0 && zipped.every((z) => { const s = P.parseParamLogEffective(z.srv?.effective); return !!s && z.cell.effNums.length >= 3
    && Math.abs(z.cell.effNums[0] - s.manDaysPerManMonth) < 0.005 && Math.abs(z.cell.effNums[1] - s.hoursPerManDay) < 0.005
    && Math.abs(z.cell.effNums[2] - s.coefSum) < 0.005; }),
  zipped.map((z) => [z.ui.eff, z.srv?.effective]));
const mutedCells = await ev(PE`const v=cs('var(--text-muted)'); const r=rows(); return {v:v, same:r.every(x=>x.effColor===v), colors:r.map(x=>x.effColor)};`);
ok('V-13 生效值列配色口径与 CSS 变量一致（探针解析 `var(--text-muted)` 比对，门不硬编码 rgb 常量）',
  !!mutedCells && mutedCells.same === true, mutedCells);
await shot('v05-改值后出表');

// ---------------- 6) 显式清空 → 再刷新归位 ----------------
const clearPut = await PUT({ [K_MD]: '' });
const logsAfterClear = (await GETP()).json?.logs ?? [];
evSet('logCount2', logsAfterClear.length);
ok('R-13 显式清空本身就是一条留痕：cleared 点名该键、logged=1、新值为空串，生效值回落 §3.3 默认',
  clearPut.status === 200 && (clearPut.json?.cleared ?? []).includes(K_MD) && clearPut.json?.logged === 1
  && clearPut.json?.config?.manDaysPerManMonth === metaR.json?.defaults?.manDaysPerManMonth
  && byKey(logsAfterClear, K_MD)[0]?.new_value === '',
  { cleared: clearPut.json?.cleared, logged: clearPut.json?.logged, cfg: clearPut.json?.config?.manDaysPerManMonth, def: metaR.json?.defaults?.manDaysPerManMonth });
await ev(PE`const b=ph().querySelector('button[aria-label*="改值历史"]'); b?.click(); return 1;`);
const rows2raw = await until(PE`const r=rows(); if(!r || r.length!==${logsAfterClear.length}) return ''; return r;`, 25_000);
evSet('rows2', rows2raw ? {
  rowCount: rows2raw.length,
  clearedState: rows2raw.some((r) => r.oldNew.includes('（清空回落默认）')),
  topOldNew: rows2raw[0]?.oldNew ?? '',
} : null);
ok('V-14 清空后再刷新即归位：行数与服务端 logs 同步（5 条），且最新一条画成「24 → （清空回落默认）」',
  !!rows2raw && rows2raw.length === logsAfterClear.length && rows2raw[0]?.oldNew === '24 → （清空回落默认）',
  rows2raw?.map((r) => [r.key, r.oldNew]));
const cellsAfter = await ev(PE`const p2=p(); return p2?p2.querySelectorAll('input[type="number"]').length:-1;`);
ok('V-15 刷新只重取留痕，不动估算明细（数字格数量与首轮一致——留痕面与估算面不共享 state，刷新不会把在填的格子冲掉）',
  cellsAfter === panel0.cells, { 刷新后: cellsAfter, 首轮: panel0.cells });
const pageErrs = await ev('String((window.__errs||[]).join("|"))');
ok('V-16 整轮页面无 JS 报错（渲染留痕表与两次刷新都不抛异常）', pageErrs === '' || pageErrs === 'undefined', pageErrs);
evSet('ran', true);

console.log('\n=== N 组 负对照：判据必须能翻红 ===');
{
  const b1 = [];
  if (J.emptyNotError({ ...EV, empty0: { ...EV.empty0, alert: true } }) !== false) b1.push('N-01a 空态带 alert 仍判真');
  if (J.emptyNotError({ ...EV, empty0: { ...EV.empty0, hasTable: true } }) !== false) b1.push('N-01b 空态画出表格仍判真');
  if (J.actorAnonymous({ ...EV, rows1: { ...EV.rows1, anonRows: 0 } }) !== false) b1.push('N-01c 页面上没有「未署名」那一态仍判真');
  if (J.oldNewStates({ ...EV, rows1: { ...EV.rows1, unsetState: false } }) !== false) b1.push('N-01d 未设置态缺失仍判真');
  if (J.oldNewStates({ ...EV, rows2: { ...EV.rows2, clearedState: false } }) !== false) b1.push('N-01e 清空态缺失仍判真');
  if (J.labelSingleSource({ ...EV, rows1: { ...EV.rows1, labelMatchServer: false } }) !== false) b1.push('N-01f 列值对不上单源仍判真');
  if (J.refreshTakesEffect({ ...EV, staleCheck: { before: 0, after: 0 } }) !== false) b1.push('N-01g 刷新后没追上服务端仍判真');
  if (J.timeReadable({ ...EV, rows1: { ...EV.rows1, timeOk: false } }) !== false) b1.push('N-01h 时间退回 ISO 仍判真');
  if (J.clearedRowShown({ ...EV, rows2: { ...EV.rows2, rowCount: 1 } }) !== false) b1.push('N-01i 行数对不上服务端仍判真');
  if (J.noSecondHistoryEndpoint(RT_HEAD + "\nestimateApi.get('/history'") === true) b1.push('N-01j 路由里凭空多一条 /history 端点仍判真');
  ok('N-01 行为判据有牙：十类破坏形态（alert 冒头 / 画出表格 / 无未署名 / 无未设置 / 无清空态 / 标签对不上单源 / 刷新不生效 / 时间退回 ISO / 行数不同步 / 多出历史端点）各令对应判据转假',
    b1.length === 0, { 未转假: b1 });

  const b2 = [];
  if (P.paramLogKeyLabel(K_MD, {}) !== K_MD) b2.push('抽掉标签表后仍返回中文标签（说明断言算的是门自己那份）');
  if (P.paramLogActorLabel('张三') !== '张三') b2.push('有名署名被吞');
  if (P.parseParamLogEffective('{"manDaysPerManMonth":1,"hoursPerManDay":2,"coefSum":3.5}').coefSum !== 3.5) b2.push('快照数值被改写');
  ok('N-02 谓词真身反证：空标签表 ⇒ 原样显示键名；有名署名 ⇒ 原样；快照三数 ⇒ 逐值取回（断言用的是产品函数本身，不是门的副本）',
    b2.length === 0, b2);

  const tampered = JSON.parse(JSON.stringify(logsNow));
  if (tampered.length > 0) tampered[0] = { ...tampered[0], actor: '另一个人' };
  const cmpTampered = (rows1raw ?? []).every((r, i) => r.actor === P.paramLogActorLabel(tampered[i]?.actor));
  ok('N-03 行集比对反证：把服务端 logs 第一条的 actor 改掉，同一条「逐行同序同值」逻辑立刻判不一致（证明比的是真数据不是自证）',
    (rows1raw ?? []).length > 0 && cmpTampered === false, { 篡改后判一致: cmpTampered });

  const rewritten = { ...ESTIMATE_SETTING_LABELS, [ESTIMATE_COEF_SETTING_KEYS.collaboration]: `${ESTIMATE_COEF_LABELS.collaboration}（重写）` };
  ok('N-04 单源反证：系数标签一旦被「重写一份」（改一处不改另一处），A-03/R-01 那条同值判据当场失守',
    ESTIMATE_COEF_KEYS.some((k) => rewritten[ESTIMATE_COEF_SETTING_KEYS[k]] !== ESTIMATE_COEF_LABELS[k])
    && A.coefLabelCheck === true,
    ESTIMATE_COEF_KEYS.map((k) => [rewritten[ESTIMATE_COEF_SETTING_KEYS[k]], ESTIMATE_COEF_LABELS[k]]));

  const spy = [];
  okPair((n, c, e) => spy.push({ name: n, cond: c, extra: e }), 'N-05a 行为失守夹具',
    () => J.emptyNotError({ ...EV, empty0: null }), () => literalOn(EP_HEAD, ['本次版本起尚无改值记录']));
  okPair((n, c, e) => spy.push({ name: n, cond: c, extra: e }), 'N-05b 锚点失配夹具',
    () => J.emptyNotError(EV), () => literalOn(EP_HEAD, ['尚无改值记录（这个词已被改掉）']));
  okPair((n, c, e) => spy.push({ name: n, cond: c, extra: e }), 'N-05c 双侧齐全',
    () => J.emptyNotError(EV), () => literalOn(EP_HEAD, ['本次版本起尚无改值记录']));
  const reason = (x) => String(x?.extra?.红因 ?? '');
  ok('N-05 okPair 落地：行为失守记红因「行为失守」、锚点失配记红因「字面锚点失配」、两者齐绿才判绿（两条红不是同一种红）',
    spy.length === 3 && spy[0].cond === false && reason(spy[0]).includes('行为失守') && !reason(spy[0]).includes('字面锚点')
    && spy[1].cond === false && reason(spy[1]).includes('字面锚点失配') && spy[2].cond === true,
    spy.map((s) => ({ 条: s.name, 判: s.cond, 红因: reason(s).slice(0, 40) })));

  {
    // 行尾差异不算内容差异（本仓 core.autocrlf=true：blob 是 LF，checkout 落盘是 CRLF）
    const wt = (() => { try { return readFileSync(join(ROOT, EP_REL), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } })();
    const same = wt === EP_HEAD;
    const ids = ['WhiskerBar', 'whiskerLegendShown', 'paramLogKeyLabel', 'paramLogActorLabel', 'parseParamLogEffective'];
    const headOnly = ids.filter((a) => EP_HEAD.includes(a) && !wt.includes(a));
    const wtOnly = ids.filter((a) => wt.includes(a) && !EP_HEAD.includes(a));
    ok('N-06 取证面核验：S 组字面腿读的是 git show HEAD:（不是工作树）——两树行尾归一后仍不一致时，双向点名只属于一侧的标识符',
      EP_HEAD.length > 400 && (same || headOnly.length > 0 || wtOnly.length > 0),
      { 两树相同: same, HEAD独有: headOnly, 工作树独有: wtOnly, HEAD长度: EP_HEAD.length, 工作树长度: wt.length });
  }

  if (EV.ran === true) {
    const before = await ev(PE`const b=ph().querySelector('button[aria-label*="改值历史"]'); if(!b) return 'nobtn';
      const t=b.textContent.trim(); b.remove(); return { removed:t.length>0, after:sec().refreshBtns };`);
    const liveEv = { ...EV, section: { ...EV.section, refreshBtns: (before && before.after) ?? -1 } };
    ok('N-07 活体摘按钮反证：从真实 DOM 里摘掉刷新按钮后，同一条行为判据转假（先自证摘的是一枚在场按钮）',
      !!before && before !== 'nobtn' && before.removed === true && before.after === 0
      && J.refreshAffordance(liveEv) === false && J.refreshAffordance(EV) === true, before);
  } else {
    skipped('N-07 活体摘按钮反证', '运行期料缺失——浏览器没跑成，无法在真实 DOM 上做破坏对照');
  }
}

console.log('\n=== S 组 锚点腿（与行为腿配对，红因可区分） ===');
for (const it of S_SPECS) {
  okPair(ok, it.L, () => it.behavior(), () => literalOn(it.src, it.anchors), () => ({ 锚点: it.anchors, 取证文件: it.SRCLBL }));
}

const drift = serverLog.join('').split('\n').filter((l) => /param|estimates|error|异常/i.test(l)).slice(-6).join(' ⏎ ');
note(`服务日志尾部匹配行：${drift || '无'}`);
note(`留痕总条数（服务端 /params）：${(logsAfterClear.length)}；面板最终行数：${(rows2raw ?? []).length}`);
console.log(`\n截图 ${shotFiles.length} 张 → ${SHOTS}`);
finishAndExit(fail > 0 ? 1 : 0);
