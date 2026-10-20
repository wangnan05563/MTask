// T01484 隔离验证：测试用例路由（PRD §6.1~§6.3）的注册顺序、参数收窄与错误语义。
// 起隔离实例（临时数据目录 + 独立端口），不触碰生产库；全部走真实 HTTP。
// 运行：node scripts/verify-testcase-routes.js [--port 39922]
//   --pair-selftest     合成夹具自证道（零服务）：证「文案锚拆配」对自己有牙（判据 4）
//   T01484_USE_DIST=1   复现旧行为：跑未入版的构建产物 server/dist/index.js（默认改跑 server/src，随 HEAD）
//   T01484_BOOT_BUDGET  就绪预算 ms（默认 180000）；超时整族记 SKIP 而非 FAIL，退出码 2 出声（反模式 47）
//
// 本脚本的核心价值是「反向断言注册顺序」：Express 按注册顺序匹配，静态段一旦排在
// /test-cases/:id 之后，GET /test-cases/meta 会变成「id=meta 的详情查询」并返回
// 400 用例不存在——只看状态码看不出来，必须断言响应体里确实是枚举/覆盖度结构。
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(REPO, 'server');
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 39922);
const BASE = `http://127.0.0.1:${PORT}/api`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-t01484-'));

let fail = 0, pass = 0, skip = 0;
const check = (name, cond, extra) => {
  if (cond) pass++; else fail++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? ' → ' + extra : ''}`);
};
/** 反模式 47（批㉚ 立）：前置件没就位 ≠ 功能失守。记 SKIP、不记 FAIL，但整门 exit≠0 仍要出声 */
const skipped = (name, why) => { skip++; console.log(`  [SKIP] ${name}${why ? ' → ' + why : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── T02293 批㉛：文案锚拆配三件套（本门是 CJS `.js`，不能引 `.mts`，故落本地孪生；
//    两条红因文案与 scripts/lib/anchor-pair.mts 共享版逐字一致，漂移会立刻在取证里显形）──
const probe = (fn) => { try { return { passed: fn() === true }; } catch (e) { return { passed: false, threw: e instanceof Error ? e.message : String(e) }; } };
const okPair = (name, behavior, literal, ctx) => {
  const ev = () => { try { return ctx ? String(ctx()) : ''; } catch { return '(取证自身抛错)'; } };
  const b = probe(behavior);
  if (!b.passed) return check(name, false, `${b.threw ? `行为断言抛错：${b.threw}` : '行为失守（功能未达成，与文案无关）'} | ${ev()}`);
  const l = probe(literal);
  return check(name, l.passed, l.passed ? ev()
    : `字面锚点失配（行为在）——等价重构或文案变更，需人工判定改锚还是改码${l.threw ? `（锚点自身抛错：${l.threw}）` : ''} | ${ev()}`);
};
/** 判据 4 用：只回红因字符串、不落地，供合成夹具自证拆配对自己有牙 */
const pairVerdict = (behavior, literal) => {
  const b = probe(behavior);
  if (!b.passed) return b.threw ? `行为断言抛错：${b.threw}` : '行为失守（功能未达成，与文案无关）';
  const l = probe(literal);
  return l.passed ? 'PASS' : (l.threw ? `字面锚点抛错：${l.threw}` : '字面锚点失配（行为在）——等价重构或文案变更，需人工判定改锚还是改码');
};
// 拆出的判据谓词写成「吃数据的函数」而不是内联闭包——这样负对照能用合成夹具跑，不必真起服务
// （批㉚ 的教训：跑不到的 PA 就是从未执行过的断言）。
const metaBehavior = (m) => Array.isArray(m.priority) && m.priority.length > 0
  && m.priority.every((p) => typeof ((m.priorityLabel || {})[p]) === 'string' && m.priorityLabel[p].length > 0)
  && m.priority.includes(m.defaults && m.defaults.priority) && Array.isArray(m.modules);
const metaLiteral = (m) => (m.priorityLabel || {}).P0 === 'P0 关键' && (m.defaults || {}).priority === 'P1' && Array.isArray(m.modules);
const status2态Behavior = (okRes, badRes, code) => okRes.status === 200 && badRes.status === code;
const sideEffectFreeBehavior = (badRes, code, totalBefore, totalAfter) => badRes.status === code && totalBefore === totalAfter;

if (process.argv.includes('--pair-selftest')) {
  // 合成夹具自证道：零服务、零落盘，退出前不动任何目录（本轮实测 dist 起不来时这是唯一能证拆配有牙的道）
  const L = '字面锚点失配（行为在）——等价重构或文案变更，需人工判定改锚还是改码';
  const B = '行为失守（功能未达成，与文案无关）';
  const good = { priority: ['P0', 'P1', 'P2', 'P3'], priorityLabel: { P0: 'P0 关键', P1: 'P1 高', P2: 'P2 中', P3: 'P3 低' }, defaults: { priority: 'P1' }, modules: ['登录'] };
  const relabeled = { ...good, priorityLabel: { ...good.priorityLabel, P0: 'P0 极高' } };      // 等价重构：只改措辞
  const missingLabel = { ...good, priorityLabel: { P1: 'P1 高', P2: 'P2 中', P3: 'P3 低' } };     // 真失守：枚举 P0 没标签
  const badDefault = { ...good, defaults: { priority: 'P9' } };                                  // 真失守：默认值不在枚举内
  check('ST-01 夹具自证·原样必须 PASS（否则后面的红不是变异带来的）', pairVerdict(() => metaBehavior(good), () => metaLiteral(good)) === 'PASS');
  check('ST-02 只改措辞（等价重构）：字面腿必须转假、行为腿照旧为真', pairVerdict(() => metaBehavior(relabeled), () => metaLiteral(relabeled)) === L);
  check('ST-03 枚举缺标签（功能失守）：红因必须是「行为失守」而非文案', pairVerdict(() => metaBehavior(missingLabel), () => metaLiteral(missingLabel)) === B);
  check('ST-04 默认值越出枚举（功能失守）：同上，红因不落文案', pairVerdict(() => metaBehavior(badDefault), () => metaLiteral(badDefault)) === B);
  const ok200 = { status: 200 }, bad400 = { status: 400, text: '{"error":"标题必填"}' };
  check('ST-05 错误语义两态：合法请求 200 + 非法请求 400 都成立才算行为在（文案改了不红）',
    pairVerdict(() => status2态Behavior(ok200, bad400, 400), () => /必填/.test(bad400.text)) === 'PASS');
  check('ST-06 文案漂移（服务端把「必填」改成「不能为空」）：只让字面腿红，行为腿仍真',
    pairVerdict(() => status2态Behavior(ok200, bad400, 400), () => /必填/.test(bad400.text.replace('必填', '不能为空'))) === L);
  console.log(`\n==== pair 自证：${pass} PASS / ${fail} FAIL / ${skip} SKIP（合成夹具，未起服务） ====`);
  process.exit(fail > 0 ? 1 : 0);
}

/** 运行时探测：必须实例化内存库才会真正加载原生模块（只 require 是假阳性） */
function pickRuntime() {
  const electronBin = path.join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const probe = "const D=require('better-sqlite3'); new D(':memory:').close();";
  const candidates = [{ cmd: process.execPath, env: {} }, ...(fs.existsSync(electronBin) ? [{ cmd: electronBin, env: { ELECTRON_RUN_AS_NODE: '1' } }] : [])];
  for (const c of candidates) {
    const r = spawnSync(c.cmd, ['-e', probe], { cwd: SERVER_DIR, env: { ...process.env, ...c.env }, encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  throw new Error('没有可加载 better-sqlite3 的运行时：先执行 scripts\\native-switch.bat dev|electron');
}

const req = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
};
const errOf = (r) => (r.json && r.json.error) || r.text.slice(0, 120);

// 就绪预算 120s→180s 且 T01484_BOOT_BUDGET 可覆盖，实测等待时长写进证据（批㉘ t02144 / 批㉛ t01875 同口径：
// 「起得慢」不能判成「起不来」——本机本轮实测 src 面就绪 44.6s，旧预算下的 flake 全是门的时序红）
async function waitHealth() {
  const budget = Number(process.env.T01484_BOOT_BUDGET ?? 180000);
  const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return { up: true, waited: Date.now() - t0, budget }; } catch (_) { /* 未就绪 */ }
    await sleep(500);
  }
  return { up: false, waited: Date.now() - t0, budget };
}

(async () => {
  // ── 运行面对象（批㉛）：原先硬跑 `server/dist/index.js`——dist 是**未入版的构建产物**，
  // 并发会话改了 src 没重建 dist 时，门会「起不来」并把整轮证据炸成零（2026-10-20 实测：
  // dist/services/estimate-engine.js require 的 ./estimateCopy 在 dist 里不存在，整轮只有一坨堆栈、
  // 连 PASS/FAIL 汇总都没打印出来）。现默认走与 verify-t01875 / t02043 同一条 launcher 通道
  // （server/src，随 HEAD 走），保留 `T01484_USE_DIST=1` 复现旧行为；两种模式都把跑的是哪一面写进取证。
  const REPO_HEAD = (rel) => {
    const r = spawnSync('git', ['-C', REPO, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git show HEAD:${rel} 失败：${r.stderr}`);
    return r.stdout;
  };
  const useDist = process.env.T01484_USE_DIST === '1';
  // P-00 构建产物完整性（结构判据，零起服务）：扫 dist 里的相对 require，逐个验目标文件在不在
  const scanDistGaps = () => {
    const gaps = [];
    const jsFiles = [];
    const walk = (d, depth) => {
      if (depth > 6) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith('.js')) jsFiles.push(p);
      }
    };
    if (fs.existsSync(path.join(SERVER_DIR, 'dist'))) walk(path.join(SERVER_DIR, 'dist'), 0);
    for (const f of jsFiles) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
        const t = path.resolve(path.dirname(f), m[1]);
        const hit = ['', '.js', '.json', '.node'].some((x) => fs.existsSync(t + x)) || fs.existsSync(path.join(t, 'index.js'));
        if (!hit) gaps.push(`${path.relative(SERVER_DIR, f)} → ${m[1]}`);
      }
    }
    return { count: jsFiles.length, gaps };
  };
  const dist = scanDistGaps();
  check('P-00 构建产物自洽性（dist 相对 require 全部可解析）——或本门不依赖 dist',
    useDist ? dist.gaps.length === 0 : true,
    `${useDist ? 'DIST 模式：dist 是考卷本身，缺模块即前置件没就位' : 'SRC 模式（默认）：本门不读 dist，此腿仅作事实留痕'}｜js=${dist.count} 缺模块=${dist.gaps.length}${dist.gaps.length ? ` [${dist.gaps.slice(0, 4).join(' ; ')}]` : ''}`);
  // ---------- EX 组：判据 3 的「豁免」被证明而不是被声明（反模式 46），且零起服务——前置件没就位时这两腿照跑 ----------
  const ENUM_SRC = REPO_HEAD('server/src/util/testCaseEnums.ts');
  const SVC_SRC = REPO_HEAD('server/src/services/TestCaseService.ts');
  const SELF_SRC = fs.readFileSync(__filename, 'utf8');
  check('EX-01 「P0 关键」「非法优先级」「部分用例不存在」等串确由产品侧生成 ⇒ 它们是字面锚，必须配行为腿（本批已拆 8 条）',
    ENUM_SRC.includes("P0: 'P0 关键'") && /非法优先级/.test(SVC_SRC) && /部分用例不存在/.test(SVC_SRC),
    `enums=${ENUM_SRC.includes("P0: 'P0 关键'")}｜service 非法优先级=${/非法优先级/.test(SVC_SRC)}｜service 部分用例不存在=${/部分用例不存在/.test(SVC_SRC)}`);
  check('EX-02 「登录校验 / REQ-001」是本门自己 POST 进去的夹具数据 ⇒ 不锁产品文案，该族豁免成立',
    SELF_SRC.includes("req_no: 'REQ-001'") && SELF_SRC.includes("title: '登录校验'") && !SVC_SRC.includes('登录校验'),
    `门内定义=${/title: '登录校验'/.test(SELF_SRC)}｜服务源码命中=否（⚠ 不做全库 grep：帮助文档/示例数据里同名串不代表产品生成，整片 grep 会把夹具误判成文案锚）`);

  const rt = pickRuntime();
  const LAUNCHER = useDist ? null
    : await (await import(pathToFileURL(path.join(REPO, 'scripts', 'isolated-server-launcher.mts')).href)).resolveServerLauncher(REPO, path.join(SERVER_DIR, 'src', 'index.ts'));
  console.log(`[setup] 运行面: ${useDist ? 'server/dist/index.js（T01484_USE_DIST=1）' : 'server/src/index.ts（tsx，随 HEAD）'}｜运行时: ${useDist ? path.basename(rt.cmd) : LAUNCHER.label}｜端口 ${PORT}｜临时数据目录: ${TMP}`);
  const server = useDist
    ? spawn(rt.cmd, ['dist/index.js'], {
      cwd: SERVER_DIR,
      env: { ...process.env, ...rt.env, MTask_DATA_DIR: TMP, MTask_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    : spawn(LAUNCHER.exec, LAUNCHER.tsx, {
      cwd: REPO,
      env: { ...process.env, ...LAUNCHER.env, MTask_DATA_DIR: TMP, MTask_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const logs = [];
  server.stdout.on('data', (d) => logs.push(String(d)));
  server.stderr.on('data', (d) => logs.push(String(d)));

  const now = () => new Date().toISOString();
  const pid = `t01484-proj-${Date.now()}`;
  const reqId = `t01484-req-${Date.now()}`;
  const TC = '/plans/test-cases';

  try {
    const boot = await waitHealth();
    check('S0 隔离实例已就绪', boot.up, `等待 ${boot.waited}ms / 预算 ${boot.budget}ms · 运行面=${useDist ? 'dist' : 'src'}`);
    if (!boot.up) throw Object.assign(new Error(`隔离实例 ${boot.budget}ms 内未就绪（前置件没就位，非功能失守）`), { precondition: true });

    console.log('\n[场景1] 种项目与需求（走 dbadmin 通用表接口）');
    const p1 = await req('POST', '/dbadmin/tables/projects/rows', { id: pid, name: 'T01484 验证项目', created_at: now(), updated_at: now() });
    check('项目创建成功', p1.status < 300, `status=${p1.status}`);
    const r1 = await req('POST', '/dbadmin/tables/prd_requirements/rows', { id: reqId, project_id: pid, req_no: 'REQ-001', title: '登录校验', created_at: now(), updated_at: now() });
    check('需求创建成功', r1.status < 300, `status=${r1.status}`);

    console.log('\n[场景2] 注册顺序铁律：静态段必须不被 /:id 抢占');
    const meta = await req('GET', `${TC}/meta?projectId=${pid}`);
    check('GET /test-cases/meta 返回枚举而非「用例不存在」', meta.status === 200 && Array.isArray(meta.json.priority) && meta.json.priority[0] === 'P0', errOf(meta));
    // 判据 3（批㉛）：'P0 关键' 这串由 server/src/util/testCaseEnums.ts 生成（EX-01 取证 HEAD 源码），
    // 原先「标签是否覆盖全部枚举」与「标签具体怎么写」串在同一个条件里——改措辞（等价重构）与标签真缺失都红且红因不可分。
    okPair('meta 带中文标签与默认值（前端 select 单源）', () => metaBehavior(meta.json), () => metaLiteral(meta.json), () => JSON.stringify(meta.json));
    check('meta 缺 projectId 报 400', (await req('GET', `${TC}/meta`)).status === 400);
    const cov = await req('GET', `${TC}/coverage?projectId=${pid}`);
    check('GET /test-cases/coverage 返回覆盖度结构而非详情查询', cov.status === 200 && typeof cov.json.rate === 'number' && Array.isArray(cov.json.byReq), errOf(cov));

    console.log('\n[场景3] POST /test-cases：新建（自动编号 + 步骤 + 关联摘要）');
    const created = await req('POST', TC, { projectId: pid, reqId, title: '手机号+正确密码登录成功', steps: [{ action: '打开登录页', expected: '展示输入框' }, { action: '提交', expected: '进入首页' }] });
    const c1 = created.json ?? {};
    // 判据 3（批㉛）：编号串 `TC-001` 的形态由服务端生成。行为腿只认「编号真被服务端补齐、形如 前缀+数字、
    // 且随创建严格递增、本批内唯一」；字面腿才锁 TC-001 / TC-003 这两条具体读数（改前缀或改补零宽度只红字面腿）。
    const num = (s) => Number(String(s ?? '').replace(/\D/g, ''));
    okPair('返回新建行且编号由服务端自动补齐（形态锚 TC-001）',
      () => created.status === 200 && /^TC-\d+$/.test(String(c1.case_no ?? '')),
      () => c1.case_no === 'TC-001', () => `${c1.case_no}`);
    check('步骤随主体一次提交', Array.isArray(c1.steps) && c1.steps.length === 2 && c1.steps[1].step_no === 2, JSON.stringify(c1.steps?.map?.((s) => s.step_no)));
    // '登录校验' / 'REQ-001' 是本门自己 POST 进去的数据（判据 2 的门自造夹具），不是产品文案 ⇒ 无需配行为腿，
    // 豁免由 EX-02 证明（取证面：这两串只出现在本门源码，产品侧零生成）。
    check('返回体带关联需求摘要 reqNo/reqTitle', c1.reqNo === 'REQ-001' && c1.reqTitle === '登录校验', `${c1.reqNo}/${c1.reqTitle}`);
    const c2 = await req('POST', TC, { projectId: pid, title: '未挂需求的孤儿用例', priority: 'P9', type: 'integration' });
    check('脏枚举走回落：创建不报错且落默认值', c2.status === 200 && c2.json.priority === 'P1' && c2.json.type === 'functional', `${c2.json.priority}/${c2.json.type}`);
    const c3 = await req('POST', TC, { projectId: pid, reqId, title: '导出 xlsx', steps: [{ action: '点导出', expected: '下载成功' }] });
    okPair('第三条编号递增（形态锚 TC-003）',
      () => c3.status === 200 && num(c3.json?.case_no) > num(c2.json?.case_no) && num(c2.json?.case_no) > num(c1.case_no),
      () => c3.json?.case_no === 'TC-003', () => `${c1.case_no}→${c2.json?.case_no}→${c3.json?.case_no}`);
    const listBeforeBad = await req('GET', `${TC}?projectId=${pid}`);
    const bad = await req('POST', TC, { projectId: pid });
    const listAfterBad = await req('GET', `${TC}?projectId=${pid}`);
    // 判据 3（批㉛）：错误响应文案（「必填」等）由服务端生成，改措辞是等价重构；
    // 行为腿认「400 + 没有造成副作用（行数不变）+ 响应体不是半个成功体」，字面腿才认措辞。
    okPair('缺 title 报 400 且不落库（措辞锚：必填）',
      () => bad.status === 400 && listBeforeBad.json?.total === listAfterBad.json?.total && !bad.json?.id,
      () => /必填/.test(bad.text), () => `status=${bad.status} 行数 ${listBeforeBad.json?.total}→${listAfterBad.json?.total} 响应=${bad.text.slice(0, 80)}`);

    console.log('\n[场景4] GET 列表：过滤 / 分页 / 非法枚举');
    const list = await req('GET', `${TC}?projectId=${pid}`);
    check('列表返回 {total, items} 且 total=3', list.status === 200 && list.json.total === 3 && list.json.items.length === 3, `total=${list.json.total}`);
    const one = await req('GET', `${TC}?projectId=${pid}&limit=1&offset=1`);
    check('limit/offset 服务端分页（items=1，total 仍 3）', one.json.items?.length === 1 && one.json.total === 3, `items=${one.json.items?.length} total=${one.json.total}`);
    const orphans = await req('GET', `${TC}?projectId=${pid}&orphanOnly=true`);
    check('orphanOnly=true 命中 1 条孤儿', orphans.json.total === 1 && orphans.json.items[0].id === c2.json.id, errOf(orphans));
    const kw = await req('GET', `${TC}?projectId=${pid}&q=${encodeURIComponent('登录')}`);
    check('中文关键词过滤生效', kw.json.total === 1, `total=${kw.json.total}`);
    const byReq = await req('GET', `${TC}?projectId=${pid}&reqId=${reqId}`);
    check('按需求筛选命中 2 条', byReq.json.total === 2, `total=${byReq.json.total}`);
    const okEnum = await req('GET', `${TC}?projectId=${pid}&priority=P1`);
    const badEnum = await req('GET', `${TC}?projectId=${pid}&priority=P9`);
    // 判据 3（批㉛）：错误措辞由服务端生成，改措辞＝等价重构。行为腿用**两态对照**（合法枚举 200、非法枚举被拒），
    // 单看 400 分不清「拒了非法值」与「路由挂了」；字面腿才认「非法优先级」这串措辞。
    okPair('非法筛选枚举被拒（措辞锚：非法优先级）',
      () => status2态Behavior(okEnum, badEnum, 400), () => /非法优先级/.test(badEnum.text),
      () => `P1=${okEnum.status} P9=${badEnum.status} ${badEnum.text.slice(0, 80)}`);
    const noPid = await req('GET', TC);
    okPair('缺 projectId 被拒（措辞锚：projectId 必填）',
      () => status2态Behavior(list, noPid, 400), () => /projectId 必填/.test(noPid.text),
      () => `带参=${list.status} 缺参=${noPid.status} ${noPid.text.slice(0, 80)}`);

    console.log('\n[场景5] GET /:id 与 PATCH /:id');
    const got = await req('GET', `${TC}/${c1.id}`);
    check('GET /test-cases/:id 返回单条含步骤', got.status === 200 && got.json.steps.length === 2, errOf(got));
    const miss = await req('GET', `${TC}/no-such-case-id`);
    okPair('不存在的 id 被拒（措辞锚：用例不存在）——两态对照：真实 id 仍 200',
      () => status2态Behavior(got, miss, 400), () => /用例不存在/.test(miss.text),
      () => `真实=${got.status} 越界=${miss.status} ${miss.text.slice(0, 80)}`);
    const patched = await req('PATCH', `${TC}/${c1.id}`, { priority: 'P0', lastResult: 'fail' });
    check('PATCH 单字段即存（P0/fail）', patched.status === 200 && patched.json.priority === 'P0' && patched.json.last_result === 'fail', `${patched.json.priority}/${patched.json.last_result}`);
    const unlink = await req('PATCH', `${TC}/${c1.id}`, { reqId: '' });
    check("PATCH reqId:'' 解除关联（不是「不改」）", unlink.status === 200 && unlink.json.req_id === null && unlink.json.reqNo === null, `req_id=${unlink.json.req_id}`);
    const dupNo = await req('PATCH', `${TC}/${c2.json.id}`, { caseNo: 'TC-001' });
    const c2After = await req('GET', `${TC}/${c2.json.id}`);
    // 行为腿＝「拒了且原编号一字未动」（重号约束真生效），字面腿才认「用例编号已存在」这串措辞
    okPair('改重号被拒且原编号不动（措辞锚：用例编号已存在）',
      () => dupNo.status === 400 && c2After.json?.case_no === c2.json.case_no,
      () => /用例编号已存在/.test(dupNo.text), () => `status=${dupNo.status} 回读编号=${c2After.json?.case_no}`);
    const rewrite = await req('PATCH', `${TC}/${c1.id}`, { steps: [{ action: '仅一步', expected: '只看展示' }] });
    check('PATCH steps 整表重写 2→1', rewrite.json.steps?.length === 1 && rewrite.json.steps[0].action === '仅一步', JSON.stringify(rewrite.json.steps?.map?.((s) => s.action)));
    const keep = await req('PATCH', `${TC}/${c1.id}`, { module: '登录模块' });
    check('不传 steps 时步骤保持', keep.json.steps?.length === 1 && keep.json.module === '登录模块', `steps=${keep.json.steps?.length}`);

    console.log('\n[场景6] 批量静态段：/batch、/reorder、/duplicate（PATCH/DELETE 带 body）');
    const batchPatch = await req('PATCH', `${TC}/batch`, { ids: [c1.id, c3.json.id], patch: { type: 'smoke', status: 'approved' } });
    check('PATCH /test-cases/batch 未被 /:id 吞（返回 updated=2）', batchPatch.status === 200 && batchPatch.json.updated === 2, errOf(batchPatch));
    const smoke = await req('GET', `${TC}?projectId=${pid}&type=smoke`);
    check('批量结果可被筛选复核', smoke.json.total === 2, `total=${smoke.json.total}`);
    const badBatch = await req('PATCH', `${TC}/batch`, { ids: [], patch: { type: 'ui' } });
    const uiAfterBadBatch = await req('GET', `${TC}?projectId=${pid}&type=ui`);
    // 行为腿＝「拒了且没有任何行被改成 type=ui」（这正是本判据要防的「全量改」事故），字面腿才认措辞
    okPair('空 ids 被拒且未全量改（措辞锚：ids 需为非空字符串数组）',
      () => badBatch.status === 400 && uiAfterBadBatch.json?.total === 0,
      () => /ids 需为非空字符串数组/.test(badBatch.text), () => `status=${badBatch.status} type=ui 行数=${uiAfterBadBatch.json?.total}`);
    const reorder = await req('POST', `${TC}/reorder`, { projectId: pid, ids: [c3.json.id, c1.id] });
    check('POST /test-cases/reorder 成功', reorder.status === 200 && reorder.json.reordered === 3, errOf(reorder));
    const afterOrder = await req('GET', `${TC}?projectId=${pid}`);
    check('排序后首条为被前置的用例', afterOrder.json.items[0].id === c3.json.id, afterOrder.json.items.map((x) => x.case_no).join(','));
    // 孤儿范围得等到上一步「unlink 把 c1 也变成孤儿」之后再算，写死 1 行是错的期望
    const orphanCount = (await req('GET', `${TC}?projectId=${pid}&orphanOnly=true`)).json.total;
    const orphanScope = await req('POST', `${TC}/reorder`, { projectId: pid, reqId: null, ids: [c2.json.id] });
    check('reorder reqId=null 只重写孤儿范围', orphanScope.json?.reordered === orphanCount && orphanCount >= 1, `reordered=${orphanScope.json?.reordered} 孤儿=${orphanCount}`);
    const dup = await req('POST', `${TC}/duplicate`, { ids: [c3.json.id] });
    check('POST /test-cases/duplicate 返回新 id 列表', dup.status === 200 && dup.json.ids?.length === 1, errOf(dup));
    const dupRow = await req('GET', `${TC}/${dup.json.ids[0]}`);
    check('副本编号重排为 TC-004 且步骤连带', dupRow.json.case_no === 'TC-004' && dupRow.json.steps.length === 1, `${dupRow.json.case_no}/${dupRow.json.steps?.length}`);
    const totalBeforeOverreach = (await req('GET', `${TC}?projectId=${pid}`)).json?.total;
    const dupOverreach = await req('POST', `${TC}/duplicate`, { ids: ['no-such-id'] });
    const totalAfterOverreach = (await req('GET', `${TC}?projectId=${pid}`)).json?.total;
    // 行为腿＝「拒了且一行副本都没多出」（部分失败不能悄悄写成半份），字面腿才认「部分用例不存在」措辞
    okPair('越界 id 被拒且不产生副本（措辞锚：部分用例不存在）',
      () => dupOverreach.status === 400 && totalBeforeOverreach === totalAfterOverreach,
      () => /部分用例不存在/.test(dupOverreach.text),
      () => `status=${dupOverreach.status} 行数 ${totalBeforeOverreach}→${totalAfterOverreach}`);

    console.log('\n[场景7] 删除：DELETE /:id 与 DELETE /batch（带 body）');
    const delOne = await req('DELETE', `${TC}/${c2.json.id}`);
    check('DELETE /test-cases/:id 返回 {ok:true}', delOne.status === 200 && delOne.json.ok === true, errOf(delOne));
    const delBatch = await req('DELETE', `${TC}/batch`, { ids: [dup.json.ids[0]] });
    check('DELETE /test-cases/batch 未被 /:id 吞（返回 deleted=1）', delBatch.status === 200 && delBatch.json.deleted === 1, errOf(delBatch));
    const survivor = await req('GET', `${TC}/${c1.id}`);
    const gone = await req('GET', `${TC}/${c2.json.id}`);
    // 两态对照：幸存行仍 200、已删行被拒——把「400」与「整条路由坏了」分开（措辞锚另立一腿）
    okPair('删除后再查被拒（措辞锚：用例不存在）——两态对照：幸存行仍 200',
      () => status2态Behavior(survivor, gone, 400), () => /用例不存在/.test(gone.text),
      () => `幸存=${survivor.status} 已删=${gone.status} ${gone.text.slice(0, 80)}`);
    // 正向对照：幸存用例的步骤仍能搜到，否则「残留 0 条」可能只是 search 参数从来没生效
    const stepsAlive = await req('GET', `/dbadmin/tables/case_steps/rows?search=${c1.id}`);
    check('对照：幸存用例的步骤仍在（search 通道本身有效）', Array.isArray(stepsAlive.json.rows) && stepsAlive.json.rows.length === 1, `命中 ${(stepsAlive.json.rows ?? []).length} 条`);
    const stepsGone = await req('GET', `/dbadmin/tables/case_steps/rows?search=${dup.json.ids[0]}`);
    check('删除用例后其步骤一并消失', (stepsGone.json.rows ?? []).length === 0, `残留 ${(stepsGone.json.rows ?? []).length} 条`);
    const finalList = await req('GET', `${TC}?projectId=${pid}`);
    check('剩余 2 条用例', finalList.json.total === 2, `total=${finalList.json.total}`);

    console.log('\n[场景8] 回归：既有计划/矩阵路由未被新块遮蔽（/:id 仍归 PlanService）');
    const plan = await req('POST', '/plans', { projectId: pid, title: '计划条目回归', startDate: '2026-10-05', durationDays: 2 });
    check('POST /plans 仍可用', plan.status === 200 && plan.json.id, errOf(plan));
    const planPatch = await req('PATCH', `/plans/${plan.json.id}`, { progress: 50 });
    check('PATCH /plans/:id 仍走计划更新（progress=50）', planPatch.status === 200 && planPatch.json.progress === 50, errOf(planPatch));
    const planDel = await req('DELETE', `/plans/${plan.json.id}`);
    check('DELETE /plans/:id 仍走计划删除', planDel.status === 200, errOf(planDel));
    const matrix = await req('GET', `/plans/prd-requirements?projectId=${pid}`);
    check('GET /plans/prd-requirements 不受影响', matrix.status === 200 && Array.isArray(matrix.json), `rows=${Array.isArray(matrix.json) ? matrix.json.length : '-'}`);
  } catch (e) {
    if (e && e.precondition) skipped('场景1~8 全部 HTTP 断言', `${e.message}——整族记 SKIP 而非 FAIL（「考卷没发」≠「功能失守」），但退出码非零仍出声`);
    else { console.error(e); fail++; }
  } finally {
    server.kill();
    // kill 是异步的，Windows 上 tsx 拉起的进程还可能继续占端口（批㉘ t02144 实测：不确认端口真空就断言/重启，
    // 既能造成假红也能造成假绿——下一轮可能被这一轮的旧实例应答）。改为轮询到 /health 不再应答。
    const t0down = Date.now();
    let stillUp = true;
    while (Date.now() - t0down < 15000) {
      stillUp = await fetch(`${BASE}/health`).then(() => true).catch(() => false);
      if (!stillUp) break;
      await sleep(500);
    }
    check('Z1 隔离实例已退出（不留驻进程，下一轮不会被旧实例应答）', stillUp === false, `端口真空实测等待 ${Date.now() - t0down}ms`);
    // 批㉘「门不留残留」落到删除动作：Windows 上 rmSync 可能删光子项却留空目录（sqlite 句柄晚于进程释放），
    // 原先它一声不响——残骸靠人肉清理。改为轮询重试，并把「目录真的没了」做成一条判据（Z2）。
    let removed = false;
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 句柄未放，下一轮再试 */ }
      removed = !fs.existsSync(TMP);
      if (removed) break;
      await sleep(500);
    }
    check('Z2 临时数据目录已删除（不积累残骸）', removed, `${TMP}（重试至 ${removed ? '成功' : '超时 10s'}）`);
  }

  console.log(`\n==== 结论：${pass} PASS / ${fail} FAIL / ${skip} SKIP ====`);
  if (fail > 0 || skip > 0) console.log('[server 日志尾]\n' + logs.join('').split('\n').slice(-12).join('\n'));
  process.exit(fail > 0 ? 1 : (skip > 0 ? 2 : 0));
})().catch((e) => { console.error(e); process.exit(3); });
