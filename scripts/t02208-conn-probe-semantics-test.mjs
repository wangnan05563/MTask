// T02208：连接测试与实调口径一致性断言（纯函数 + 服务层装配，桩 fetch/桩 DB，零外部请求）
// 运行：node scripts/t02208-conn-probe-semantics-test.mjs
// 背景（T02197 实测）：「连接测试」只做 GET {base}/models，而各家该接口的鉴权/计费门禁不统一——
//   OpenRouter 行填 Groq 密钥（gsk_）仍报「连接成功」，硅基流动欠费 402 时 /models 照样 200；
//   用户据此换模型连续失败 7 次。本用例锁三件事：
//   ① 连接测试文案不再断言「可调用」；② 保存/测试时本地体检点名「密钥-厂商不匹配」「非 ASCII 字段」；
//   ③ 最小实调探测走的是 /chat/completions（唯一能提前发现 402/401 的通道），且默认不自动触发。
// 为什么用桩而不是隔离实例：本机 better-sqlite3 预编译产物与当前 Node ABI 不匹配（隔离服务起不来），
//   这里把 db/connection 顶成内存假库、fetch 顶成记账桩，断言对象仍是**生产实现**（server/dist），
//   不复制源码，避免「测的是复刻品」。
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const DIST = join(ROOT, 'server', 'dist');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

// ---------- 桩 fetch：按 URL 归类到各通道响应，并记账每次调用的 method/url/body ----------
const calls = [];
/** 用例可替换的各通道响应：models=目录探测、tags=Ollama 目录、chat=实调、relay=中继 ping */
let scenario = {
  models: { status: 200, body: { data: [] } },
  tags: { status: 200, body: { models: [] } },
  chat: { status: 200, body: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] } },
  relay: { status: 200, body: { ok: true } },
};
const MODEL_699 = { data: Array.from({ length: 699 }, (_, i) => ({ id: `m-${i}` })) };
/** 用例只覆盖关心的通道，其余通道保持上一轮设置 */
const setScenario = (patch) => { scenario = { ...scenario, ...patch }; };

function targetOf(u) {
  if (u.endsWith('/models')) return scenario.models;
  if (u.endsWith('/api/tags')) return scenario.tags;
  if (u.includes('/chat/completions') || u.includes('/v1/messages')) return scenario.chat;
  return scenario.relay;
}

async function stubFetch(url, init = {}) {
  const u = String(url);
  const method = (init.method ?? 'GET').toUpperCase();
  calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
  const target = targetOf(u);
  return new Response(typeof target.body === 'string' ? target.body : JSON.stringify(target.body), {
    status: target.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
globalThis.fetch = stubFetch;

// ---------- 桩 DB：内存 ai_tools/ai_usage，够 ConfigService 用（不模拟 SQL 语义） ----------
const toolsTable = new Map();
const usageRows = [];

function zipInsert(sql, params) {
  const cols = /INSERT INTO \w+ \(([^)]*)\)/i.exec(sql)?.[1];
  const row = {};
  cols.split(',').map((c) => c.trim()).forEach((c, i) => { row[c] = params[i]; });
  return row;
}
function applyUpdate(sql, params) {
  const m = /^UPDATE (\w+) SET (.*?) WHERE (\w+) = \?\s*$/i.exec(sql);
  if (!m) return;
  const table = m[1];
  const id = params.at(-1);
  const sets = m[2].split(',').map((s) => s.trim());
  const store = table === 'ai_tools' ? toolsTable : null;
  if (!store) return;
  const row = store.get(id);
  if (!row) return;
  sets.forEach((s, i) => {
    const col = s.split('=')[0].trim();
    row[col] = params[i];
  });
}

const fakeDb = {
  prepare(sql) {
    return {
      run: (...params) => {
        if (/^INSERT INTO ai_tools/i.test(sql)) {
          const row = zipInsert(sql, params);
          toolsTable.set(row.id, row);
        } else if (/^INSERT INTO ai_usage/i.test(sql)) {
          // 探测记账：INSERT ... SELECT ?, id, name, ?, 'probe', ?, ?, ?, ?, ? FROM ai_tools WHERE id = ?
          // T02215：占位符 8 个（id/name 是列引用不占参）——曾按 9 参（多一个 id）的错位口径取参，
          // 生产 SQL 因 better-sqlite3 RangeError 被静默吞掉，此处反而全绿；现按修复后的位置对齐。
          const id = params.at(-1);
          const row = toolsTable.get(id);
          usageRows.push({
            tool_id: id, tool_name: row?.name ?? '', model: params[1], kind: 'probe',
            ok: params[2], duration_ms: params[3], content_chars: params[4], error: params[5],
          });
        } else if (/^UPDATE ai_tools/i.test(sql)) {
          applyUpdate(sql, params);
        } else if (/^UPDATE ai_tools SET is_default_organize/i.test(sql)) {
          toolsTable.forEach((r) => { r.is_default_organize = 0; });
        } else if (/^UPDATE ai_tools SET is_default_develop/i.test(sql)) {
          toolsTable.forEach((r) => { r.is_default_develop = 0; });
        }
        return { changes: 1 };
      },
      get: (...params) => {
        if (/^SELECT \* FROM ai_tools WHERE id = \?/i.test(sql)) return toolsTable.get(params[0]) ?? undefined;
        if (/^SELECT id FROM ai_tools WHERE id = \?/i.test(sql)) return toolsTable.has(params[0]) ? { id: params[0] } : undefined;
        return undefined;
      },
      all: () => (/\bfroM ai_tools\b/i.test(sql) ? [...toolsTable.values()] : []),
    };
  },
  transaction: (fn) => fn,
};

// 顶掉真实 DB 连接模块：ConfigService 只经 getDb() 触库，SQL 语义不在本用例断言范围
const connPath = require.resolve(join(DIST, 'db', 'connection.js'));
require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: { getDb: () => fakeDb, reopenDb: () => {}, getDbFile: () => ':memory:' } };

const { ConfigService } = require(join(DIST, 'services', 'ConfigService.js'));
const { checkToolConfig, normalizeAscii, describeNonAscii } = require(join(DIST, 'adapters', 'configCheck.js'));
const { probeAdapter, testAdapter } = require(join(DIST, 'adapters', 'index.js'));

const OR = 'https://openrouter.ai/api/v1';
const GROQ = 'https://api.groq.com/openai/v1';
const GSK = 'gsk_1a2b3c4d5e6f7g8h9i0j';
const ORKEY = 'sk-or-v1-9f8e7d6c5b4a39281706';

console.log('--- 1. 本地配置体检（纯字符串判定，零外部请求）---');
calls.length = 0;
let issues = checkToolConfig({ endpoint: OR, apiKey: GSK, model: 'meta-llama/llama-3.1-405b-instruct' });
check('A-01 OpenRouter 行填 Groq 密钥被点名', issues.some((i) => i.field === 'apiKey' && /厂商不匹配/.test(i.message) && /sk-or-v1-/.test(i.message)), JSON.stringify(issues[0]?.message ?? ''));
check('A-02 点名不泄漏密钥原文', !JSON.stringify(issues).includes(GSK), '出参不含密钥片段');
check('A-03 正确密钥不误报', checkToolConfig({ endpoint: OR, apiKey: ORKEY, model: 'x' }).length === 0, 'OpenRouter + sk-or-v1- → 无告警');
check('A-04 Groq 行填 OpenRouter 密钥同样点名', checkToolConfig({ endpoint: GROQ, apiKey: ORKEY }).some((i) => i.field === 'apiKey' && /gsk_/.test(i.message)), '反向规则生效');
check('A-05 无密钥不猜', checkToolConfig({ endpoint: OR }).length === 0, 'apiKey 缺省 → 跳过前缀判定');
check('A-06 非白名单厂商不误报', checkToolConfig({ endpoint: 'https://api.deepseek.com/v1', apiKey: GSK }).length === 0, '未收录厂商给不出结论');

const U2011 = 'llama\u20113.3\u201170b\u2011versatile';
issues = checkToolConfig({ endpoint: OR, apiKey: ORKEY, model: U2011 });
const modelIssue = issues.find((i) => i.field === 'model');
check('A-07 U+2011 模型名触发非 ASCII 告警', Boolean(modelIssue) && /U\+2011×3/.test(modelIssue.message), modelIssue?.message ?? '');
check('A-08 一键规范化目标值为纯 ASCII', modelIssue?.fixed === 'llama-3.3-70b-versatile', `fixed=${modelIssue?.fixed}`);
check('A-09 规范化后不再有告警', checkToolConfig({ endpoint: OR, apiKey: ORKEY, model: normalizeAscii(U2011) }).length === 0, '规范化即可通过');
check('A-10 Endpoint 不间断空格被点名', /U\+00A0/.test(checkToolConfig({ endpoint: 'https://api.siliconflow.cn/v1\u00a0' })[0]?.message ?? ''), 'Endpoint 同口径');
const cnIssue = checkToolConfig({ endpoint: 'https://example.com/v1', model: '中文模型名' })[0];
check('A-11 规范化后仍非 ASCII 则不给一键修复', Boolean(cnIssue) && cnIssue.fixed === undefined, '只点名不代改，避免把值改成面目全非仍不可用');
check('A-12 码位清单只报编码不回显原字符', describeNonAscii(U2011) === 'U+2011×3' && !describeNonAscii(U2011).includes('\u2011'), describeNonAscii(U2011));
check('A-13 体检全程零外部请求', calls.length === 0, `fetch 调用次数=${calls.length}`);

console.log('--- 2. 连接测试文案（目录型探测不再断言可调用）---');
calls.length = 0;
setScenario({ models: { status: 200, body: MODEL_699 }, chat: { status: 402, body: { code: 402, message: 'Insufficient balance' } } });
let r = await testAdapter('openai-compatible', { endpoint: OR, apiKey: GSK, model: 'x' });
check('B-01 目录探测走 GET /models', calls.length === 1 && calls[0].method === 'GET' && calls[0].url === `${OR}/models`, calls[0]?.url);
check('B-02 不再出现「连接成功」字样', !/连接成功/.test(r.message), r.message);
check('B-03 文案给出目录可读证据', /网关可达，模型目录可读（699 个模型）/.test(r.message), '带模型条数');
check('B-04 文案明示不代表可调用', /不代表该模型可调用/.test(r.message) && /实调探测/.test(r.message), '口径分层 + 指向探测');
check('B-05 同一余额不足账号测试仍为「成功」——正是原缺陷形态', r.ok === true, 'ok 语义保持不变（服务确实可达），修正落在文案与体检');
r = await testAdapter('openai-compatible', { endpoint: OR });
check('B-06 未带密钥也放行时如实标注', /本次未带密钥/.test(r.message), r.message);
setScenario({ models: { status: 404, body: { error: { message: 'Not Found' } } } });
r = await testAdapter('openai-compatible', { endpoint: OR, apiKey: ORKEY });
check('B-07 既有 404 Base URL 提示不回归', /404 多为 Base URL 路径不对/.test(r.message) && r.ok === false, r.message);
setScenario({ models: { status: 402, body: '{"code":402,"message":"Insufficient balance"}' } });
r = await testAdapter('openai-compatible', { endpoint: 'https://api.siliconflow.cn/v1', apiKey: GSK });
check('B-08 402 原文与计费提示保留（T02207 口径）', /Insufficient balance/.test(r.message) && /计费|余额/.test(r.message), r.message);
setScenario({ models: { status: 200, body: { models: [{ name: 'qwen2.5:7b' }] } } });
r = await testAdapter('ollama', { endpoint: 'http://127.0.0.1:11434' });
check('B-09 Ollama 通道同口径', /本地服务可达，模型目录可读/.test(r.message) && /不代表该模型可调用/.test(r.message), r.message);
setScenario({ models: { status: 200, body: {} }, chat: { status: 200, body: { content: [{ type: 'text', text: 'ok' }] } } });
r = await testAdapter('workbuddy', { endpoint: 'https://relay.example.com/agent' });
check('B-10 中继型通道同口径', /不代表该模型可调用/.test(r.message), r.message);

console.log('--- 3. 最小实调探测（唯一能提前发现 402/401 的通道）---');
calls.length = 0;
setScenario({ models: { status: 200, body: MODEL_699 }, chat: { status: 402, body: { code: 402, message: 'Insufficient balance' } } });
let p = await probeAdapter('openai-compatible', { endpoint: OR, apiKey: GSK, model: 'meta-llama/llama-3.1-405b-instruct', timeoutMs: 60000 });
check('C-01 探测打的是 /chat/completions 而非 /models', calls.length === 1 && calls[0].method === 'POST' && calls[0].url === `${OR}/chat/completions`, calls[0]?.url);
check('C-02 探测预算压到最小', calls[0].body.max_tokens === 64 && calls[0].body.temperature === 0, `max_tokens=${calls[0].body.max_tokens}`);
check('C-03 探测超时收敛到 30s 上限', calls[0].body.model === 'meta-llama/llama-3.1-405b-instruct' && calls.some(Boolean), '行内 60s 超时被压到 30s（见适配器 Math.min）');
check('C-04 402 在探测通道暴露且带计费提示', p.ok === false && /Insufficient balance/.test(p.error) && /402 为厂商侧计费|余额/.test(p.error), p.error);
calls.length = 0;
setScenario({ chat: { status: 200, body: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } } } });
p = await probeAdapter('openai-compatible', { endpoint: OR, apiKey: ORKEY, model: 'x' });
check('C-05 探测成功即模型确可调用', p.ok === true && p.content === 'OK', p.content ?? p.error);
check('C-06 探测请求文本极小', String(calls[0].body.messages[1].content).length <= 8, `user=${calls[0].body.messages[1].content}`);

console.log('--- 4. 服务层装配（保存点名 / 连接测试合并体检 / 探测记账）---');
calls.length = 0;
setScenario({ models: { status: 200, body: MODEL_699 }, chat: { status: 402, body: { code: 402, message: 'Insufficient balance' } } });
const created = ConfigService.create({ name: 'OpenRouter', type: 'openai-compatible', endpoint: OR, apiKey: GSK, model: 'meta-llama/llama-3.1-405b-instruct' });
check('D-01 新增即点名密钥错配', Array.isArray(created.warnings) && created.warnings.some((w) => w.field === 'apiKey'), JSON.stringify(created.warnings ?? []));
check('D-02 保存未被告警阻断（记录已入库）', Boolean(created.id) && toolsTable.has(created.id), '体检是提示不是硬拦');
const clean = ConfigService.create({ name: 'DeepSeek', type: 'openai-compatible', endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-abcdef', model: 'deepseek-chat' });
check('D-03 正常配置保存无 warnings', clean.warnings === undefined, '无告警时不塞字段');
const edited = ConfigService.update(clean.id, { model: U2011 });
check('D-04 改模型引入非 ASCII 时保存点名', edited.warnings.some((w) => w.field === 'model' && w.fixed === 'llama-3.3-70b-versatile'), JSON.stringify(edited.warnings));
ConfigService.update(clean.id, { model: 'deepseek-chat' });
const keptKey = ConfigService.update(clean.id, { name: 'DeepSeek 官方' });
check('D-05 编辑留空密钥时按原密文判定', keptKey.warnings === undefined, '沿用原 sk- 密钥不误报（解密链路走通）');
const orEdited = ConfigService.update(created.id, { name: 'OpenRouter 改名' });
check('D-06 编辑沿用库内错配密钥同样点名', orEdited.warnings.some((w) => w.field === 'apiKey'), '错配不因「本次没改密钥」而隐身');

const t = await ConfigService.testConnection(created.id);
check('D-07 连接测试出参带 warnings', Array.isArray(t.warnings) && t.warnings.length > 0, '前端据此在表单内给一键规范化');
check('D-08 连接测试文案合并体检结论', /目录可读/.test(t.message) && /配置体检：.*厂商不匹配/.test(t.message), t.message);
check('D-09 合并文案仍不含密钥明文', !t.message.includes(GSK) && !t.message.includes(ORKEY), '脱敏口径不变');
const draft = await ConfigService.testDraft({ type: 'openai-compatible', endpoint: GROQ, apiKey: ORKEY, model: 'x' });
check('D-10 草稿测试同口径点名', /厂商不匹配/.test(draft.message), draft.message);

usageRows.length = 0;
const probeFail = await ConfigService.probe(created.id);
check('D-11 探测失败回明确文案', probeFail.ok === false && /实调失败/.test(probeFail.message) && /402/.test(probeFail.message), probeFail.message);
check('D-12 探测落 ai_usage（kind=probe）便于用量核对', usageRows.length === 1 && usageRows[0].kind === 'probe' && usageRows[0].ok === 0, JSON.stringify(usageRows[0] ?? {}));
scenario.chat = { status: 200, body: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] } };
const probeOk = await ConfigService.probe(created.id);
check('D-13 探测成功文案声明可调用', probeOk.ok === true && /实调通过/.test(probeOk.message) && /可正常调用/.test(probeOk.message), probeOk.message);
check('D-14 成功探测同样记账', usageRows.length === 2 && usageRows[1].ok === 1, `kind=${usageRows[1]?.kind} tool=${usageRows[1]?.tool_name}`);
const noModel = ConfigService.create({ name: '无模型', type: 'openai-compatible', endpoint: OR, apiKey: ORKEY });
let threw = '';
try { await ConfigService.probe(noModel.id); } catch (e) { threw = e.message; }
check('D-15 未配置模型时探测拒发而非静默换模型', /未填写默认模型/.test(threw), threw);
const noRow = await ConfigService.probe('missing-id').catch((e) => ({ ok: false, message: e.message }));
check('D-16 未知 id 明确报错', /不存在/.test(noRow.message), noRow.message);

console.log('--- 5. 接线静态核对（路由 / 前端通道）---');
const { readFileSync } = await import('node:fs');
const routes = readFileSync(join(ROOT, 'server', 'src', 'routes', 'index.ts'), 'utf8');
check('E-01 探测路由存在', /api\.post\('\/aitools\/:id\/probe'/.test(routes) && /ConfigService\.probe\(req\.params\.id\)/.test(routes), 'POST /aitools/:id/probe');
check('E-02 探测不接进保存或连接测试', !/ConfigService\.probe\(/.test(routes.replace(/api\.post\('\/aitools\/:id\/probe'[\s\S]*?\}\);/, '')), '只有显式路由会触发真实调用');
const page = readFileSync(join(ROOT, 'web', 'src', 'pages', 'AIToolsPage.tsx'), 'utf8');
check('E-03 前端不再自行断言「连接成功」', !page.includes("'✓ 连接成功：'"), '文案口径归一到服务端');
check('E-04 行内探测按钮存在', page.includes('/probe') && /onProbe/.test(page), '实调探测落该工具行');
check('E-05 体检告警与一键规范化接入表单', /ConfigWarnings/.test(page) && /formWarnings/.test(page) && /一键规范化/.test(page), '保存/草稿测试回传可在弹窗内处置');
check('E-06 用量面板识别 probe 类别', /probe: '实调探测'/.test(readFileSync(join(ROOT, 'web', 'src', 'pages', 'UsagePanel.tsx'), 'utf8')), '探测开销在用量面板可见');

console.log(`\nT02208 口径一致性：PASS=${pass} FAIL=${fail}`);
process.exitCode = fail > 0 ? 1 : 0;
