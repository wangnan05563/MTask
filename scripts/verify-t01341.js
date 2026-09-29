// T01341 隔离验证：未配置访问令牌时拒绝启动公网穿透（只验守卫层返回，不实际连通公网）
// 起隔离实例（临时数据目录 + 独立端口），不触碰生产库/生产配置。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const PORT = 39913;
const BASE = `http://127.0.0.1:${PORT}/api`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-t01341-'));
const REPO = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, cond, extra) => {
  if (!cond) fail++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? ' → ' + extra : ''}`);
};

async function waitHealth(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch (_) { /* 未就绪 */ }
    await sleep(500);
  }
  return false;
}

const post = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
};

(async () => {
  console.log(`[setup] 临时数据目录: ${TMP}`);
  const server = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(REPO, 'server'),
    env: { ...process.env, MTask_DATA_DIR: TMP, MTask_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
  });
  const logs = [];
  server.stdout.on('data', (d) => logs.push(String(d)));
  server.stderr.on('data', (d) => logs.push(String(d)));

  try {
    if (!(await waitHealth())) throw new Error('服务启动超时：\n' + logs.join(''));

    console.log('\n[场景1] 未配置访问令牌 → 拒绝启动（400 + 可操作文案）');
    let cfg = await (await fetch(`${BASE}/tunnel/config`)).json();
    check('初始 accessTokenConfigured=false', cfg.accessTokenConfigured === false, String(cfg.accessTokenConfigured));
    let r = await post('/tunnel/start');
    check('未配令牌时启动返回 400', r.status === 400, `status=${r.status}`);
    check('errorType=access_token_required', r.json?.errorType === 'access_token_required', String(r.json?.errorType));
    check('文案含「未配置访问令牌」与「无鉴权暴露」',
      (r.json?.error ?? '').includes('未配置访问令牌') && (r.json?.error ?? '').includes('无鉴权'), r.json?.error ?? '');
    // 拒绝发生在**启动之前**：隧道不应被拉起（无公网地址）
    let st = await (await fetch(`${BASE}/tunnel/status`)).json();
    check('隧道未被拉起（无 publicUrl）', !st.publicUrl, `publicUrl=${st.publicUrl}`);

    console.log('\n[场景2] 生成令牌后 → 不再被本守卫拒绝（已进入真实启动流程）');
    const gen = await post('/tunnel/reset-token');
    check('生成令牌成功', gen.status === 200 && !!gen.json?.accessToken);
    cfg = await (await fetch(`${BASE}/tunnel/config`)).json();
    check('accessTokenConfigured=true', cfg.accessTokenConfigured === true);
    // 不再真的等启动完成：缺二进制时服务端会去**联网下载** cloudflared/cpolar，可能拖数分钟。
    // 用「守卫拦截=立即返回 400」这个时间特征做判据：8s 内拿到响应就必须不是 access_token_required；
    // 若超时没响应，同样证明守卫没拦截（否则早就秒回 400 了）——真实联网启动不属本单验证范围。
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let timedOut = false;
    let status = 0; let errType = '';
    try {
      const res = await fetch(`${BASE}/tunnel/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), signal: ctrl.signal,
      });
      status = res.status;
      const txt = await res.text();
      try { errType = JSON.parse(txt)?.errorType ?? ''; } catch { /* 非 JSON */ }
    } catch (e) {
      timedOut = e instanceof Error && e.name === 'AbortError';
    } finally {
      clearTimeout(timer);
    }
    check('守卫不再拦截（非 access_token_required）', errType !== 'access_token_required',
      timedOut ? '8s 内未返回 → 已进入真实启动流程（守卫若拦截会秒回 400）' : `status=${status} errorType=${errType || '(无)'}`);

    console.log('\n[场景3] 回归：隧道管理端点仍仅本机可管、状态/配置读取正常');
    const st2 = await (await fetch(`${BASE}/tunnel/status`)).json();
    check('GET /tunnel/status 正常', st2 && typeof st2.status === 'string', `status=${st2?.status}`);
    const cfg2 = await (await fetch(`${BASE}/tunnel/config`)).json();
    check('GET /tunnel/config 本机返回明文令牌', typeof cfg2.accessToken === 'string' && cfg2.accessToken.length > 0);

    console.log(fail === 0 ? '\nALL PASS' : `\nHAS FAILURE (${fail})`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('验证异常：', e);
    console.error('服务日志：\n' + logs.join(''));
    process.exitCode = 1;
  } finally {
    if (process.platform === 'win32' && server.pid) {
      spawn('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' });
    } else {
      server.kill('SIGTERM');
    }
  }
})();
