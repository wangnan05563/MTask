// T02278：probe 实调链路 API 级回归门（mock 厂商夹具 + kind='probe' 落库列对齐断言）
//
// 拦的缺陷族（T02215 实测）：`recordProbeUsage` 的 `INSERT…SELECT` 共 8 个占位符（`id`/`name` 是
//   ai_tools 列引用不占参），却实传 9 个 → better-sqlite3 抛 RangeError 被 `catch {}` 静默吞掉，
//   `kind='probe'` 用量**从未落库**，而接口照样回「实调通过」。该缺陷落在「假库桩测不到 SQL 语义」的
//   盲区——t02208 套件的内存假库按同一错位口径取参，51 条断言全绿未报警。所以本门一律走**真 SQLite +
//   真 HTTP**：自己拉一个隔离实例（独立端口 + mkdtemp 数据目录），不连生产 39877、不碰生产数据目录。
//
// 用法：
//   node scripts/t02278-probe-usage-test.mjs                      # 正对照：全绿
//   node scripts/t02278-probe-usage-test.mjs --negative-control   # 错位注入：必须红（证明门拦得住）
//   注册进 scripts/run-api-tests.mjs 后亦可：node scripts/run-api-tests.mjs <baseUrl> t02278
//   （run-api-tests 传入的 baseUrl 仅作可达性自检，本套件始终另起隔离实例，避免误写生产库）
//
// 环境变量：
//   T02278_PORT（默认 39971）、T02278_TMP_ROOT（默认 D:/code/tmp，**勿指 C:**——C: 常年 0 可用会 SQLITE_FULL 假性失败）、
//   T02278_SERVER_NODE（指定能加载 better-sqlite3 的 node 可执行文件；缺省按 execPath → electron RUN_AS_NODE 探测）
//
// 负对照实现：把 `server/src/services/ConfigService.ts` 里 `.run(...)` 的参数改回当年那行 9 参错位形态
//   （逐字节备份，finally + exit 钩子双重回写，下次启动若发现残留备份先自愈），重启隔离实例后要求
//   ① 探测接口仍回 ok:true（缺陷对接口不可见）② `kind='probe'` 行为 0（本组断言会红）。
//
// 约定：以 `==== T02278 SUMMARY: x/y passed ====` 结尾，并以退出码表达成败（run-api-tests 依赖此口径）。
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NEG = process.argv.includes('--negative-control');
const PORT = Number(process.env.T02278_PORT || 39971);
const TMP_ROOT = process.env.T02278_TMP_ROOT || 'D:/code/tmp';
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api`;
const SRC_FILE = join(ROOT, 'server', 'src', 'services', 'ConfigService.ts');
const BACKUP_FILE = `${SRC_FILE}.t02278-bak`;

// 夹具行统一带该前缀，便于在实例库里一眼识别/过滤（ai_usage 是审计追加表，无删除接口）
const TAG = 'T02278门-';
const MODEL_OK = 'mock-gpt-ok';
const MODEL_402 = 'mock-gpt-402';

let pass = 0;
let fail = 0;
/** 负对照三条件单独记账：该模式下 B 组「必须红」，退出码不能只看 fail 总数 */
const nc = {};
const check = (id, name, cond, detail = '') => {
  if (cond) pass++; else fail++;
  if (id.startsWith('NC-')) nc[id] = cond;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} ${name} :: ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (method, path, body) => {
  const res = await fetch(API + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
};

// ---------- mock 厂商（OpenAI 兼容形状，进程内起，端口交给 OS 分配） ----------
function startMockVendor() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [MODEL_OK, MODEL_402].map((id) => ({ id, object: 'model' })) }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let model = '';
          try { model = String(JSON.parse(body)?.model ?? ''); } catch { /* 忽略 */ }
          if (model.includes('402')) {
            res.writeHead(402, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 103, message: 'Insufficient balance: your account balance is insufficient, please recharge' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: `chatcmpl-mock-${Date.now()}`, object: 'chat.completion', model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
          }));
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// ---------- 隔离实例启动器（与 scripts/isolated-server-launcher.mts 同口径，此处内联以便 plain node 直跑） ----------
function resolveLauncher() {
  const probe = "const D=require('better-sqlite3'); new D(':memory:');";
  const can = (exec, env) => {
    try {
      const r = spawnSync(exec, ['-e', probe], { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'pipe', timeout: 30_000 });
      return r.status === 0;
    } catch { return false; }
  };
  const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const electron = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const cands = [];
  if (process.env.T02278_SERVER_NODE) cands.push({ exec: process.env.T02278_SERVER_NODE, env: {}, label: `T02278_SERVER_NODE=${process.env.T02278_SERVER_NODE}` });
  cands.push({ exec: process.execPath, env: {}, label: `node ${process.version}（ABI ${process.versions.modules}）` });
  if (existsSync(electron)) cands.push({ exec: electron, env: { ELECTRON_RUN_AS_NODE: '1' }, label: 'electron + RUN_AS_NODE（Electron ABI）' });
  for (const c of cands) if (can(c.exec, c.env)) return { ...c, tsx: [tsx, join(ROOT, 'server', 'src', 'index.ts')] };
  return { ...cands[0], tsx: [tsx, join(ROOT, 'server', 'src', 'index.ts')], label: `${cands[0].label}：原生模块探测全失败，按 execPath 直跑（实例日志会如实报错）` };
}

async function startServer(dataDir) {
  const L = resolveLauncher();
  console.log(`隔离实例启动器：${L.label} / 数据目录 ${dataDir}`);
  const proc = spawn(L.exec, L.tsx, {
    cwd: ROOT,
    env: { ...process.env, ...L.env, MTask_DATA_DIR: dataDir, MTask_PORT: String(PORT), MTask_LOG_DIR: dataDir },
    stdio: 'ignore',
  });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${API}/health`); if (r.status < 500) return proc; } catch { /* 未就绪 */ }
    if (proc.exitCode !== null) break;
    await sleep(500);
  }
  proc.kill();
  throw new Error(`隔离实例未就绪（${BASE}）——检查端口占用 / 启动器 ABI / ${dataDir} 磁盘余量`);
}

// ---------- 负对照：源码错位注入与回写 ----------
const BUG_LINE = `    ).run(uuid(), model, ok ? 1 : 0, ms, contentChars, (error ?? '').slice(0, 300) || null, new Date().toISOString(), id);`;
const BUGGY_LINE = `    ).run(uuid(), id, model, ok ? 1 : 0, ms, contentChars, (error ?? '').slice(0, 300) || null, new Date().toISOString(), id);`;

function selfHeal() {
  if (existsSync(BACKUP_FILE)) {
    copyFileSync(BACKUP_FILE, SRC_FILE);
    rmSync(BACKUP_FILE);
    console.log('检测到上次残留备份，已回写 ConfigService.ts（自愈）');
  }
}
function injectBug() {
  const src = readFileSync(SRC_FILE, 'utf8');
  if (!src.includes(BUG_LINE)) throw new Error('负对照锚点未命中：recordProbeUsage 的 .run(...) 参数形态已变，请同步本套件锚点');
  writeFileSync(BACKUP_FILE, src, 'utf8');
  writeFileSync(SRC_FILE, src.replace(BUG_LINE, BUGGY_LINE), 'utf8');
}
function restoreBug() {
  if (!existsSync(BACKUP_FILE)) return;
  copyFileSync(BACKUP_FILE, SRC_FILE);
  rmSync(BACKUP_FILE);
}

// ---------- 主体 ----------
async function runSuite(mockPort, { expectProbeRows }) {
  const endpoint = `http://127.0.0.1:${mockPort}/v1`;
  const toolId = {};
  for (const [key, model] of [['ok', MODEL_OK], ['402', MODEL_402]]) {
    const created = await api('POST', '/aitools', {
      name: `${TAG}${key}`, type: 'openai-compatible', purpose: 'develop', endpoint, model, apiKey: 'sk-mock-t02278', timeoutMs: 15000,
    });
    if (created.json?.id) toolId[key] = created.json.id;
  }
  check('A-02', '两个 mock 工具创建成功', !!toolId.ok && !!toolId['402'], `ok=${toolId.ok} 402=${toolId['402']}`);

  const noModel = await api('POST', '/aitools', { name: `${TAG}无模型`, type: 'openai-compatible', purpose: 'develop', endpoint, apiKey: 'sk-mock-t02278' });
  const np = await api('POST', `/aitools/${noModel.json?.id}/probe`);
  check('A-06', '未填模型的探测被点名（400 而非静默）', np.status === 400 && /未填写默认模型/.test(np.json?.error ?? ''), `status=${np.status} error=${np.json?.error}`);

  const pOk = await api('POST', `/aitools/${toolId.ok}/probe`);
  check('A-03', '实调探测成功态：ok=true 且文案带耗时与输出字符数',
    pOk.status === 200 && pOk.json?.ok === true && /实调通过（\d+ms，输出 2 字符）/.test(pOk.json?.message ?? ''),
    `status=${pOk.status} msg=${pOk.json?.message}`);

  const p402 = await api('POST', `/aitools/${toolId['402']}/probe`);
  check('A-04', '402 探测：ok=false 且 message 带厂商原文',
    p402.json?.ok === false && /Insufficient balance/.test(p402.json?.message ?? ''),
    `msg=${p402.json?.message}`);
  check('A-05', '402 文案点名「厂商侧计费/余额门禁」（不把计费问题混成请求问题）',
    /402 为厂商侧计费\/余额门禁/.test(p402.json?.message ?? ''), `msg=${p402.json?.message}`);

  await sleep(300); // 记账是同步 INSERT，但留出跨进程可见性余量
  const usage = await api('GET', '/ai/usage?days=1');
  const rows = (usage.json?.recent ?? []).filter((r) => String(r.tool_name ?? '').startsWith(TAG));
  const rowOf = (key) => rows.find((r) => r.tool_name === `${TAG}${key}`);
  check('B-01', 'ai_usage 出现 kind=probe 的探测行（T02215 缺陷即「一行都没有」）',
    rows.length >= 2 && rows.every((r) => r.kind === 'probe'), `rows=${rows.length} kinds=${[...new Set(rows.map((r) => r.kind))].join(',')}`);

  const rOk = rowOf('ok');
  const r402 = rowOf('402');
  check('B-02', 'tool_name 列与夹具工具名逐字一致（错位时会被 model/uuid 顶替）',
    !!rOk && !!r402, `ok=${rOk?.tool_name} 402=${r402?.tool_name}`);
  check('B-03', 'model 列 = 各自夹具模型名（未被 ok/duration 挤位）',
    rOk?.model === MODEL_OK && r402?.model === MODEL_402, `ok=${rOk?.model} 402=${r402?.model}`);
  check('B-04', 'ok 列语义正确：成功行 1、402 行 0',
    Number(rOk?.ok) === 1 && Number(r402?.ok) === 0, `ok=${rOk?.ok} 402=${r402?.ok}`);
  check('B-05', 'duration_ms 是正整数且落在探测超时预算内（错位时这里会是 content_chars/文本）',
    Number.isInteger(rOk?.duration_ms) && rOk.duration_ms >= 0 && rOk.duration_ms < 60000,
    `ok=${rOk?.duration_ms} 402=${r402?.duration_ms}`);
  check('B-06', 'content_chars 列对齐：成功行=2（"OK"），402 行=0',
    Number(rOk?.content_chars) === 2 && Number(r402?.content_chars) === 0,
    `ok=${rOk?.content_chars} 402=${r402?.content_chars}`);
  check('B-07', 'error 列对齐：成功行为空，402 行含厂商原文且被截断到 ≤300 字符',
    !rOk?.error && /Insufficient balance/.test(r402?.error ?? '') && (r402?.error ?? '').length <= 300,
    `ok=${JSON.stringify(rOk?.error)} 402=${(r402?.error ?? '').slice(0, 60)}`);
  check('B-08', 'created_at 为 ISO 串（错位注入时会把 id 之类塞进时间列）',
    /^\d{4}-\d{2}-\d{2}T/.test(String(rOk?.created_at ?? '')), `created_at=${rOk?.created_at}`);
  const byTool = (usage.json?.byTool ?? []).filter((r) => r.kind === 'probe' && String(r.tool_name ?? '').startsWith(TAG));
  check('B-09', 'byTool 聚合含 probe 分组（用量面板看得见这笔真实开销）',
    byTool.length >= 2, `groups=${byTool.map((r) => `${r.tool_name}:${r.calls}`).join(' | ')}`);
  check('B-10', '落库行数与探测次数一致（各 1 行，无重复记账）',
    rows.filter((r) => r.tool_name === `${TAG}ok`).length === 1 && rows.filter((r) => r.tool_name === `${TAG}402`).length === 1,
    `ok行=${rows.filter((r) => r.tool_name === `${TAG}ok`).length} 402行=${rows.filter((r) => r.tool_name === `${TAG}402`).length}`);

  for (const key of Object.keys(toolId)) await api('DELETE', `/aitools/${toolId[key]}`);
  await api('DELETE', `/aitools/${noModel.json?.id}`);
  const list = await api('GET', '/aitools');
  const leftover = (list.json ?? []).filter((t) => String(t.name ?? '').startsWith(TAG));
  check('C-01', '夹具工具行自冸：跑完 ai_tools 不再含本套件行',
    leftover.length === 0, `残留=${leftover.map((t) => t.name).join(',')}`);

  const probeRowsOk = rows.length >= 2;
  if (expectProbeRows === false) {
    check('NC-02', '负对照：错位注入后 probe 用量行为 0（本组断言必须红，否则门是假的）',
      !probeRowsOk, `rows=${rows.length}`);
  }
  return probeRowsOk;
}

async function main() {
  selfHeal();
  mkdirSync(TMP_ROOT, { recursive: true });
  const dataDir = mkdtempSync(join(TMP_ROOT, 't02278-gate-'));
  const { srv, port: mockPort } = await startMockVendor();
  console.log(`mock 厂商已起：http://127.0.0.1:${mockPort}/v1（${MODEL_OK} / ${MODEL_402}）`);
  const mv = await fetch(`http://127.0.0.1:${mockPort}/v1/models`).then((r) => r.json());
  check('A-01', 'mock 厂商目录通道可用', Array.isArray(mv?.data) && mv.data.length === 2, `models=${(mv?.data ?? []).map((m) => m.id).join(',')}`);

  if (NEG) injectBug();
  console.log(NEG ? '>>> 负对照模式：已把 recordProbeUsage 参数改回 9 参错位形态' : '>>> 正对照模式');
  let server = null;
  try {
    server = await startServer(dataDir);
    if (NEG) {
      const endpoint = `http://127.0.0.1:${mockPort}/v1`;
      const created = await api('POST', '/aitools', { name: `${TAG}nc`, type: 'openai-compatible', purpose: 'develop', endpoint, model: MODEL_OK, apiKey: 'sk-mock-t02278' });
      const p = await api('POST', `/aitools/${created.json?.id}/probe`);
      check('NC-01', '负对照：接口侧仍回「实调通过」（缺陷只对落库可见——正是它当年躲过 51 条断言的原因）',
        p.json?.ok === true, `msg=${p.json?.message}`);
      await api('DELETE', `/aitools/${created.json?.id}`); // 先收掉 NC 夹具行，免得 C-01 把「已自冸」误报成红
      await runSuite(mockPort, { expectProbeRows: false });
    } else {
      await runSuite(mockPort, { expectProbeRows: true });
    }
  } finally {
    if (server) { server.kill(); await sleep(500); }
    srv.close();
    if (NEG) {
      restoreBug();
      check('NC-03', '负对照收尾：ConfigService.ts 已按备份逐字回写，残留备份已清除',
        !existsSync(BACKUP_FILE) && readFileSync(SRC_FILE, 'utf8').includes(BUG_LINE), `backup=${existsSync(BACKUP_FILE)}`);
    }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄释放慢 */ }
  }
}

await main();
const green = NEG ? (nc['NC-01'] === true && nc['NC-02'] === true && nc['NC-03'] === true) : fail === 0;
console.log(`\n==== T02278 SUMMARY: ${pass}/${pass + fail} passed${NEG ? `（负对照三条件 NC-01/02/03：${green ? '达成' : '未达成'}）` : ''} ====`);
process.exit(green ? 0 : 1);
