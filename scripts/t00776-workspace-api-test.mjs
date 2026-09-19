// T00776 API 级断言：工作空间文件搜索 / 按需读文件 / 忽略配置 / 防穿越
// 用法：node t00776-workspace-api-test.mjs [baseUrl]
const BASE = process.argv[2] ?? 'http://127.0.0.1:39904';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}
const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const WS = mkdtempSync(join(tmpdir(), 'mtask-ws-')); // Windows 短路径亦可，服务端按字面解析

// 工作空间样例目录
mkdirSync(join(WS, 'src', 'auth'), { recursive: true });
mkdirSync(join(WS, 'node_modules', 'lib'), { recursive: true });
mkdirSync(join(WS, 'secrets'), { recursive: true });
writeFileSync(join(WS, 'README.md'), '# Demo\n\n登录鉴权模块说明\n');
writeFileSync(join(WS, 'src', 'auth', 'login.ts'), 'export function login(user: string) {\n  // JWT token 解析逻辑\n  return true;\n}\n');
writeFileSync(join(WS, 'src', 'auth', 'jwt.ts'), 'export function parseToken(raw: string) {\n  // JWT token 解析\n  return raw.split(".");\n}\n');
writeFileSync(join(WS, 'node_modules', 'lib', 'index.js'), '// JWT token 解析 in node_modules —— 不应被搜到\n');
writeFileSync(join(WS, 'secrets', 'api-key.txt'), 'API_KEY=secret-xxxxx\n');
writeFileSync(join(WS, '.mtaskignore'), '# 注释行\nsecrets/\n');
writeFileSync(join(WS, 'big.log'), Array.from({ length: 600 }, (_, i) => `log line ${i}`).join('\n'));

// 项目绑定工作空间
const proj = (await api('POST', '/api/projects', { name: `T00776-WS-${Date.now() % 100000}` })).json;
const pid = proj.id;
check('P-01 创建项目', !!pid, `id=${pid}`);
const bind = await api('PATCH', `/api/projects/${pid}`, { workspacePath: WS });
check('P-02 绑定工作空间', bind.status === 200, `status=${bind.status}`);

// ---- 搜索 ----
const hit = (await api('GET', `/api/workspace/search?projectId=${pid}&q=token`)).json?.items ?? [];
check('S-1 全文关键词命中多文件', Array.isArray(hit) && hit.some((h) => h.path === 'src/auth/login.ts') && hit.some((h) => h.path === 'src/auth/jwt.ts'),
  `hits=${JSON.stringify(hit.map((h) => h.path))}`);
check('S-2 命中带行号与片段', hit.some((h) => h.path === 'src/auth/login.ts' && h.line === 2 && h.snippet.includes('JWT')),
  JSON.stringify(hit.find((h) => h.path === 'src/auth/login.ts')));
check('S-3 node_modules 被忽略', !(hit ?? []).some((h) => h.path.includes('node_modules')), '');
const fileNameHit = (await api('GET', `/api/workspace/search?projectId=${pid}&q=login`)).json?.items ?? [];
check('S-4 文件名命中', fileNameHit.some((h) => h.path === 'src/auth/login.ts' && h.line === 0), JSON.stringify(fileNameHit.map((h) => h.path)));
const globHit = (await api('GET', `/api/workspace/search?projectId=${pid}&q=token&glob=*.ts`)).json?.items ?? [];
check('S-5 glob 限定文件类型', (globHit ?? []).every((h) => h.path.endsWith('.ts')), JSON.stringify(globHit.map((h) => h.path)));
const noHit = (await api('GET', `/api/workspace/search?projectId=${pid}&q=zzzznotexist`)).json?.items ?? [];
check('S-6 无命中返回空数组', Array.isArray(noHit) && noHit.length === 0, `count=${noHit.length}`);
const shortQ = await api('GET', `/api/workspace/search?projectId=${pid}&q=a`);
check('S-7 q 过短 400', shortQ.status === 400, `error=${shortQ.json?.error}`);

// ---- 忽略配置 ----
check('I-1 内置忽略：node_modules 不可见', !(hit ?? []).some((h) => h.path.includes('node_modules')), '');
const secretHit = (await api('GET', `/api/workspace/search?projectId=${pid}&q=API_KEY`)).json?.items ?? [];
check('I-2 .mtaskignore 生效：secrets/ 不可见', Array.isArray(secretHit) && secretHit.length === 0, JSON.stringify(secretHit));
const secretRead = await api('GET', `/api/workspace/file?projectId=${pid}&path=secrets/api-key.txt`);
check('I-3 忽略列表内文件不可读', secretRead.status === 400 && (secretRead.json?.error ?? '').includes('忽略'), `error=${secretRead.json?.error}`);

// ---- 读文件 ----
const rd = (await api('GET', `/api/workspace/file?projectId=${pid}&path=big.log&offset=100&limit=5`)).json;
check('R-1 行号范围读取', rd?.offset === 100 && rd?.lines?.length === 5 && rd?.lines?.[0]?.n === 101 && rd?.lines?.[0]?.text.includes('log line 100'),
  JSON.stringify({ off: rd?.offset, first: rd?.lines?.[0] }));
check('R-2 totalLines 与 truncated', rd?.totalLines === 600 && rd?.truncated === true, `total=${rd?.totalLines} truncated=${rd?.truncated}`);
const travel = await api('GET', `/api/workspace/file?projectId=${pid}&path=../../etc/passwd`);
check('R-3 目录穿越被拒', travel.status === 400 && (travel.json?.error ?? '').includes('越界'), `error=${travel.json?.error}`);
const abs = await api('GET', `/api/workspace/file?projectId=${pid}&path=${encodeURIComponent('C:\\Windows\\win.ini')}`);
check('R-4 绝对路径穿越被拒', abs.status === 400 && (abs.json?.error ?? '').includes('越界'), `error=${abs.json?.error}`);
const noWsProj = (await api('POST', '/api/projects', { name: `T00776-无WS-${Date.now() % 100000}` })).json;
const noWs = await api('GET', `/api/workspace/search?projectId=${noWsProj.id}&q=token`);
check('R-5 未配置工作空间 400', noWs.status === 400 && (noWs.json?.error ?? '').includes('未配置工作空间'), `error=${noWs.json?.error}`);

// ---- 评审修复回归（H-2/H-3 + L-1） ----
const evilGlob = await api('GET', `/api/workspace/search?projectId=${pid}&q=token&glob=${encodeURIComponent('(a+)+$')}`);
check('F-1 ReDoS glob 被拒 400', evilGlob.status === 400 && (evilGlob.json?.error ?? '').includes('glob'), `error=${evilGlob.json?.error}`);
const longGlob = await api('GET', `/api/workspace/search?projectId=${pid}&q=token&glob=${encodeURIComponent('*'.repeat(200))}`);
check('F-2 超长 glob 被拒 400', longGlob.status === 400, `error=${longGlob.json?.error}`);
const globMd = (await api('GET', `/api/workspace/search?projectId=${pid}&q=login&glob=*.md`)).json?.items ?? [];
check('F-3 glob 过滤对文件名命中生效（H-3）', Array.isArray(globMd) && globMd.every((h) => h.path.endsWith('.md')),
  JSON.stringify((globMd ?? []).map((h) => h.path)));
const selfHit = (await api('GET', `/api/workspace/search?projectId=${pid}&q=secrets`)).json?.items ?? [];
check('F-4 .mtaskignore 自身被默认忽略（L-1）', Array.isArray(selfHit) && selfHit.length === 0, JSON.stringify(selfHit));

console.log(`==== T00776 SUMMARY: ${pass}/${pass + fail} passed ====`);
process.exit(fail > 0 ? 1 : 0);
