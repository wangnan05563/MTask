/**
 * T02320 · 派生单溯源兜底 / 归并幂等 / 存量对账 验收门。
 *
 * 证的四件事（判据服从 T02293：夹具自造、不锁实现字面量、不依赖生产数据）：
 *  ① 建单溯源：`derivedFrom` 缺省时按正文首行「来源：Txxxx」回填 `derived_from`（MCP 与 REST 同一判据），
 *     母单查无 ⇒ 不猜、只回告警；显式传值 ⇒ 优先于解析；
 *  ② 告警可见：标题带【AI回写待审核】却拿不到溯源时，响应里必须带 create_warning（不静默）；
 *  ③ 归并幂等：同一子单重复回传结论，母单里只出现一份归并节；
 *  ④ 存量对账：启动时把「字段为空但正文首行有来源」的历史行回填，且**回填后归并通道真的复活**
 *     （只改字段不算修好）——为此本门用同一临时库起两次实例（阶段二即「重启后」）。
 *
 * 用法（ABI127 的 node22 通道，与其余 .mts 门一致）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02320-derived-origin.mts
 * 可选环境变量：T02320_TMP_ROOT（临时库根，默认 D:/code/tmp/gate-tmp，**勿指 C:**——常年 0 可用会假性失败）、
 *   T02320_PORT（阶段一端口，默认 39651；阶段二用 PORT+1）、T02320_KEEP=1（保留临时库）
 *
 * 负对照（改法自证，逐条改完单跑再还原）：
 *   N1 `derivedOrigin.ts` 里把 `if (parsed)` 改成 `if (false && parsed)` ⇒ A-02/A-03/C-03/C-05 应红；
 *   N2 删掉 mcp 结果通道的 `alreadyMerged` 分支（一律走追加）⇒ B-03 应红；
 *   N3 `reconcileDerivedFrom` 首行直接 `return { scanned: 0, backfilled: 0, missingOrigin: 0 }` ⇒ C-03/C-05 应红。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServerLauncher } from './isolated-server-launcher.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = process.env.T02320_TMP_ROOT || 'D:/code/tmp/gate-tmp';
mkdirSync(TMP_ROOT, { recursive: true });
const DATA_DIR = mkdtempSync(join(TMP_ROOT, `t02320-${process.pid}-`));
const PORT1 = Number(process.env.T02320_PORT ?? 39651);
const PORT2 = PORT1 + 1;

let pass = 0;
let fail = 0;
function group(t: string) { console.log(`\n== ${t}`); }
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 260) : ''}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Inst { child: ChildProcess; base: string; log: string[] }
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));

/** 端口避让：并发会话常留隔离实例，撞端口会让本门对着别人的服务取证（t01875 S00 同口径） */
async function pickPort(base: number): Promise<number> {
  for (let p = base; p < base + 40; p++) {
    const occupied = await fetch(`http://127.0.0.1:${p}/api/health`).then(() => true).catch(() => false);
    if (!occupied) return p;
  }
  throw new Error(`端口 ${base}~${base + 39} 全被占用，放弃（避免对其他实例取证）`);
}

async function startServer(port: number): Promise<Inst> {
  const child = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
    cwd: ROOT,
    env: {
      ...process.env, ...LAUNCHER.env,
      MTask_PORT: String(port), MTask_DATA_DIR: DATA_DIR, MTask_LOG_DIR: DATA_DIR,
      TEMP: TMP_ROOT, TMP: TMP_ROOT, TMPDIR: TMP_ROOT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const inst: Inst = { child, base: `http://127.0.0.1:${port}/api`, log: [] };
  child.stdout?.on('data', (b: Buffer) => inst.log.push(b.toString()));
  child.stderr?.on('data', (b: Buffer) => inst.log.push(b.toString()));
  child.on('exit', (code, sig) => inst.log.push(`\n[child exit code=${code} sig=${sig}]\n`));
  for (let i = 0; i < 450; i++) { // 180s：本机并发会话多时冷启动会超过 90s（实测同库二次启动更慢）
    try { if ((await fetch(`${inst.base}/health`)).ok) return inst; } catch { /* 未就绪 */ }
    await sleep(400);
  }
  child.kill('SIGKILL'); // 超时即收口，否则失败路径会泄漏持有临时库句柄的孤儿子进程
  throw new Error(`隔离实例 ${port} 未就绪（exit=${child.exitCode}）：\n${inst.log.join('').slice(-1500)}`);
}

/** 门经验：kill 是异步的，必须等 exit 再在同 DATA_DIR 起第二个实例，否则 SQLite 句柄未释放 */
async function stopServer(inst: Inst): Promise<void> {
  const { child } = inst;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(15_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(5000)]);
  }
  await sleep(800);
}

function makeApi(inst: Inst) {
  return async function api(method: string, path: string, json?: unknown) {
    const res = await fetch(inst.base + path, {
      method, headers: { 'Content-Type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json),
    });
    let out: Record<string, any> | null = null;
    try { out = (await res.json()) as Record<string, any>; } catch { /* 非 JSON */ }
    return { status: res.status, json: out };
  };
}

// ---------------- MCP 通道（streamable HTTP：SSE 帧要拼完再解析，T01490/T00978 教训）
function makeMcp(inst: Inst) {
  let sessionId = '';
  let rpcId = 0;
  async function mcpRaw(payload: Record<string, unknown>) {
    const res = await fetch(`${inst.base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(payload),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    const frames = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    try { return JSON.parse(frames || text); } catch { return undefined; }
  }
  async function init() {
    await mcpRaw({
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-t02320', version: '1.0' } },
    });
    await mcpRaw({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  async function callTool(name: string, args: Record<string, unknown>) {
    const body = await mcpRaw({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
    const r = (body as any)?.result ?? {};
    return {
      isError: r?.isError === true,
      text: String(r?.content?.[0]?.text ?? ''),
      structured: (r?.structuredContent ?? {}) as Record<string, any>,
    };
  }
  return { init, callTool };
}

const PROJ = 'T02320 溯源兜底门';
const GHOST = 'T900099'; // 刻意不存在的编号：只用于「不猜母单」用例
const GHOST2 = 'T900098';

interface Ref { no: string; id: string; derived: string; warning?: string }

async function phase1(): Promise<Record<string, Ref>> {
  const port1 = await pickPort(PORT1);
  const inst = await startServer(port1);
  const api = makeApi(inst);
  const mcp = makeMcp(inst);
  await mcp.init();
  const out: Record<string, Ref> = {};
  try {
    const proj = (await api('POST', '/projects', { name: PROJ })).json;
    const pid = String(proj?.id ?? '');
    ok('A-00 隔离项目已建（夹具自造，绝不连生产实例）', !!pid, proj);

    /** MCP 建单；返回编号/id/溯源字段/告警（溯源字段按编号回查，避免依赖响应结构细节） */
    const mk = async (key: string, title: string, description: string, extra: Record<string, unknown> = {}): Promise<Ref> => {
      const r = await mcp.callTool('mtask_create_task', { projectId: pid, title, description, ...extra });
      const t = r.structured?.task ?? {};
      const no = String(t.task_no ?? '');
      const back = (await api('GET', `/tasks/by-no/${no}`)).json;
      const ref: Ref = { no, id: String(t.id ?? ''), derived: String(back?.derived_from ?? ''), warning: r.structured?.create_warning };
      out[key] = ref;
      return ref;
    };

    group('A 建单溯源兜底（MCP / REST 同一判据）');
    const M1 = await mk('M1', '母单甲：接收子单结论', '正文无来源行。');
    const M2 = await mk('M2', '母单乙：显式 derivedFrom 的目标', '正文无来源行。');
    ok('A-01 母单自身不被误挂溯源（无来源行 ⇒ 字段为空）', M1.derived === '', { derived: M1.derived });

    const C1 = await mk('C1', '子单甲：只写首行来源，不传 derivedFrom', `来源：${M1.no}\n\n## 要做什么\n验证解析回填。`);
    ok('A-02 MCP 建单：正文首行「来源：Txxxx」被回填进 derived_from', C1.derived === M1.no, { got: C1.derived, want: M1.no });

    const c2res = await api('POST', '/tasks', { projectId: pid, title: '子单乙：REST 通道同判据', description: `来源：${M1.no}\n\nREST 建单也要回填。` });
    const C2: Ref = { no: String(c2res.json?.task_no ?? ''), id: String(c2res.json?.id ?? ''), derived: String(c2res.json?.derived_from ?? '') };
    out.C2 = C2;
    ok('A-03 REST POST /tasks 同判据回填', C2.derived === M1.no, { got: C2.derived, want: M1.no, status: c2res.status });

    const C3 = await mk('C3', '子单丙：显式值优先于正文解析', `来源：${M1.no}`, { derivedFrom: M2.no });
    ok('A-04 显式 derivedFrom 优先，不被正文首行覆盖', C3.derived === M2.no, { got: C3.derived, want: M2.no });

    const W1 = await mk('W1', '【AI回写待审核】子单丁：无溯源可认', '正文里没有来源行，应当回显告警。');
    ok('A-05 无溯源的 AI 回写单：响应带显式告警（不静默）',
      typeof W1.warning === 'string' && W1.warning.includes('不会自动归并'), { warning: W1.warning });

    const w1rest = await api('POST', '/tasks', { projectId: pid, title: '【AI回写待审核】子单戊：REST 侧同样告警', description: '正文无来源行。' });
    ok('A-06 REST 侧同样回显 create_warning', typeof w1rest.json?.create_warning === 'string' && w1rest.json.create_warning.length > 0, w1rest.json?.create_warning);

    const G1 = await mk('G1', '子单己：来源编号查无', `来源：${GHOST}\n\n母单不存在时不猜。`);
    ok('A-07 来源编号查无 ⇒ 不猜母单（derived_from 保持空）', G1.derived === '', { derived: G1.derived });
    ok('A-08 来源编号查无 ⇒ 回显告警说明未归并', String(G1.warning).includes('查无'), G1.warning);

    const N1 = await mk('N1', '日常单：既非回写单也无来源行', '普通待办，不该产生任何告警。');
    ok('A-09 无关单不被打扰（无告警、无溯源）', N1.warning === undefined && N1.derived === '', { warning: N1.warning, derived: N1.derived });

    group('B 归并幂等（重复回传不叠加）');
    const CONCLUSION = '## 根因\n结论正文（甲）。\n\n## 验证\n实测通过。';
    const sectionCount = (text: string, no: string) => (String(text ?? '').split(`【派生单 ${no} 处理结果`).length - 1);
    await mcp.callTool('mtask_update_task_result', { id: C1.id, result: CONCLUSION });
    let m1 = (await api('GET', `/tasks/by-no/${M1.no}`)).json;
    ok('B-01 回填溯源的子单回传结论 ⇒ 自动进母单',
      String(m1?.handle_result ?? '').includes(C1.no) && String(m1?.handle_result ?? '').includes('结论正文（甲）'),
      { hit: sectionCount(m1?.handle_result, C1.no) });
    ok('B-02 母单归并节恰好一节', sectionCount(m1?.handle_result, C1.no) === 1, { hits: sectionCount(m1?.handle_result, C1.no) });

    const b2 = await mcp.callTool('mtask_update_task_result', { id: C1.id, result: CONCLUSION });
    m1 = (await api('GET', `/tasks/by-no/${M1.no}`)).json;
    ok('B-03 重复回传不再叠加第二遍（幂等）', sectionCount(m1?.handle_result, C1.no) === 1,
      { hits: sectionCount(m1?.handle_result, C1.no), resp: b2.text.slice(-140) });
    ok('B-04 幂等跳过时如实回显「未重复追加」', b2.text.includes('未重复追加'), b2.text.slice(-140));
    const c1after = (await api('GET', `/tasks/by-no/${C1.no}`)).json;
    ok('B-05 跳过归并不影响子单自身结论落库', String(c1after?.handle_result ?? '').includes('结论正文（甲）'), String(c1after?.handle_result ?? '').slice(0, 60));
    ok('B-06 母单归并后仍是未读态（原设计不回归）', String(m1?.ai_state ?? '') === 'unread', m1?.ai_state);

    const ghost = await mcp.callTool('mtask_update_task_result', { id: G1.id, result: '这段结论不该出现在任何母单里。' });
    ok('B-07 无溯源单回传 ⇒ 不猜母单（响应无归并话术）', !ghost.text.includes('并已整合回原任务'), ghost.text.slice(-140));

    await api('PATCH', `/tasks/${N1.id}`, { derivedFrom: GHOST }); // 模拟历史脏值：字段有值但母单查无
    const dirty = await mcp.callTool('mtask_update_task_result', { id: N1.id, result: '脏溯源单自身的结论。' });
    ok('B-08 derived_from 指向不存在编号 ⇒ 如实告警且不抛错',
      dirty.isError === false && dirty.text.includes('查无') && !dirty.text.includes('并已整合回原任务'), dirty.text.slice(-160));
    const nAfter = (await api('GET', `/tasks/by-no/${N1.no}`)).json;
    ok('B-09 脏溯源单的结论仍完整留在自身', String(nAfter?.handle_result ?? '').includes('脏溯源单自身的结论'), String(nAfter?.handle_result ?? '').slice(0, 50));

    group('C 存量对账夹具（抹空字段 = 历史失联形态）');
    const M5 = await mk('M5', '母单戊：等待对账后接收结论', '正文无来源行。');
    const C5 = await mk('C5', '子单庚：历史失联形态', `来源：${M5.no}\n\n字段被抹空即等价于历史存量。`, { derivedFrom: M5.no });
    await api('PATCH', `/tasks/${C5.id}`, { derivedFrom: '' });
    const c5before = (await api('GET', `/tasks/by-no/${C5.no}`)).json;
    ok('C-01 夹具已造出「字段空 + 首行有来源」的失联单', String(c5before?.derived_from ?? '') === '', c5before?.derived_from);
    const C6 = await mk('C6', '子单辛：首行来源指向不存在的编号', `来源：${GHOST2}\n\n对账也不该猜。`);
    ok('C-02 母单查无的失联单建单即不回填', C6.derived === '', C6.derived);
  } finally {
    await stopServer(inst);
  }
  return out;
}

async function phase2(refs: Record<string, Ref>) {
  const port2 = await pickPort(PORT2); // 同 DATA_DIR 二次启动 = 走一遍启动对账
  const inst = await startServer(port2);
  const api = makeApi(inst);
  const mcp = makeMcp(inst);
  await mcp.init();
  try {
    group('C 启动对账（同库重启后）');
    const { M5, C5, C6, N1 } = refs;
    const c5 = (await api('GET', `/tasks/by-no/${C5.no}`)).json;
    ok('C-03 启动对账把失联单回填成正确母单编号', String(c5?.derived_from ?? '') === M5.no, { got: c5?.derived_from, want: M5.no });
    const c6 = (await api('GET', `/tasks/by-no/${C6.no}`)).json;
    ok('C-04 首行来源指向不存在编号的行不被猜（重启后仍为空）', String(c6?.derived_from ?? '') === '', c6?.derived_from);
    const n1 = (await api('GET', `/tasks/by-no/${N1.no}`)).json;
    ok('C-05 对账不越界改写：脏值行的显式编号保持原样（只补空不覆盖）', String(n1?.derived_from ?? '') === GHOST, n1?.derived_from);

    const r = await mcp.callTool('mtask_update_task_result', { id: C5.id, result: '对账后回传的结论应进母单。' });
    const m5 = (await api('GET', `/tasks/by-no/${M5.no}`)).json;
    ok('C-06 回填后归并通道真的复活（结论落到母单，不是只改字段）',
      String(m5?.handle_result ?? '').includes('对账后回传的结论应进母单') && String(m5?.handle_result ?? '').includes(C5.no),
      { resp: r.text.slice(-140) });
    ok('C-07 对账量在启动日志里可数（不静默改写存量）',
      /derived-from reconcile/.test(inst.log.join('')), inst.log.join('').slice(-260));
  } finally {
    await stopServer(inst);
  }
}

try {
  console.log(`隔离实例启动器：${LAUNCHER.label}\n临时库：${DATA_DIR}`);
  const refs = await phase1();
  await phase2(refs);
} catch (e) {
  fail += 1;
  console.log(`  [FAIL] 门自身异常：${(e as Error).message}`);
} finally {
  if (process.env.T02320_KEEP !== '1') { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 被占用则留待人工清 */ } }
  console.log(`\n== 汇总：PASS=${pass} FAIL=${fail}（临时库${process.env.T02320_KEEP === '1' ? '保留：' + DATA_DIR : '已清理'}）`);
  process.exit(fail === 0 ? 0 : 1);
}
