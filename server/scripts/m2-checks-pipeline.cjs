#!/usr/bin/env node
/**
 * T01494（M2 验收回归）：A9/A10/A11/A12 的确定性验证——in-process 驱动真实 pipeline，
 * 用「桩 adapter」替换 AI 调用，从而无需真实模型即可断言：
 *   A9  —— 阶段日志 ≥6 条 + AbortSignal 中断即止；
 *   A10 —— 草稿结构完整 + 确认后 importDraft 落库、每条用例挂到正确需求；
 *   A11 —— 覆盖率计算（全覆盖=100%，部分覆盖=未覆盖项有显式告警）；
 *   A12 —— 同一份 PRD 二次生成：生成期用例即标 alreadyImported、再导入不产生重复（用例总数不变）。
 *
 * 隔离纪律（硬规则#8）：临时 MTask_DATA_DIR + initSchema 的独立库，绝不写生产。
 * 原生模块 better-sqlite3 按 Electron ABI 编译 → 本脚本须由 electron.exe（ELECTRON_RUN_AS_NODE=1）运行。
 * 结果以单行 `M2PIPE:<json>` 输出到 stdout，供 m2-regression.mjs 解析；退出码 0 全通过 / 1 有失败。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');
process.env.MTask_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtask-m2-'));

const { getDb } = require(path.join(ROOT, 'server', 'dist', 'db', 'connection.js'));
const { initSchema } = require(path.join(ROOT, 'server', 'dist', 'db', 'schema.js'));
const adaptersMod = require(path.join(ROOT, 'server', 'dist', 'adapters', 'index.js'));
const cfgMod = require(path.join(ROOT, 'server', 'dist', 'services', 'ConfigService.js'));
const { PlanService } = require(path.join(ROOT, 'server', 'dist', 'services', 'PlanService.js'));
const { TestCaseService } = require(path.join(ROOT, 'server', 'dist', 'services', 'TestCaseService.js'));
const gen = require(path.join(ROOT, 'server', 'dist', 'services', 'TestCaseGenService.js'));

const results = [];
const ck = (k, cond, msg = '') => { results.push({ k, pass: !!cond, msg: String(msg).slice(0, 220) }); };

/** 桩 chatStream：从「本次分块范围」里解析 reqNo，按模式产出用例数组。mode='full' 全覆盖，'partial' 只覆盖 REQ-001。 */
function makeStub(mode, hooks = {}) {
  return {
    chatStream: async (_sys, user, _cfg, onDelta) => {
      hooks.onCall && hooks.onCall(user);
      const scopeNos = [...new Set((user.match(/REQ-\d+/g) || []))];
      const cover = mode === 'partial' ? scopeNos.filter((n) => n === 'REQ-001') : scopeNos;
      const cases = cover.map((reqNo, i) => ({
        reqNo,
        title: `${reqNo} 正向用例 ${i + 1}`,
        module: '认证',
        preconditions: '已登录系统',
        expected: '返回成功且状态正确',
        testData: 'admin/123456',
        postconditions: '',
        priority: 'P1',
        type: 'functional',
        method: 'manual',
        tags: 'gen',
        steps: [{ action: '执行操作', expected: '结果符合预期' }, { action: '校验状态', expected: '状态一致' }],
      }));
      onDelta && onDelta('');
      return { ok: true, content: `<<<REQUIREMENTS>>>\n[]\n<<<CASES>>>\n${JSON.stringify(cases)}\n` };
    },
  };
}

function seedProject(name) {
  const db = getDb();
  const now = new Date().toISOString();
  const pid = 'p-' + name + '-' + now;
  db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(pid, name, now, now);
  PlanService.createRequirement(pid, { reqNo: 'REQ-001', title: '用户登录', content: '账号密码登录', priority: 'high' });
  PlanService.createRequirement(pid, { reqNo: 'REQ-002', title: '订单取消', content: '未支付订单可取消', priority: 'normal' });
  return pid;
}

async function run() {
  getDb();
  initSchema();
  // 安装桩：ConfigService 返回带 model 的运行配置；getAdapter 返回桩
  cfgMod.ConfigService.getRuntimeConfig = () => ({ type: 'stub', config: { model: 'stub-model', maxTokens: 4096, timeoutMs: 60000 } });
  const origGetAdapter = adaptersMod.getAdapter;

  try {
    // ===== A11 全覆盖 + A9 阶段 + A10 草稿/导入 + A12 二次幂等（主场景）=====
    adaptersMod.getAdapter = () => makeStub('full');
    const pid1 = seedProject('M2-full');
    const stages1 = [];
    const content = '# PRD\n需求：REQ-001 用户登录；REQ-002 订单取消。';
    const draft = await gen.generateTestCasesStream({
      projectId: pid1, toolId: 'stub', content, source: '内部 PRD',
      onStage: (m) => stages1.push(m), onDelta: () => {},
    });

    // A9：阶段日志 ≥6 条
    ck('A9_stage_logs_ge_6', stages1.length >= 6, `stages=${stages1.length} :: ${stages1.slice(0, 3).join(' | ')}`);
    // A11：全覆盖率 = 100%，未覆盖 = 0
    ck('A11_full_coverage_rate_100', draft.coverage.rate === 100 && draft.coverage.uncovered === 0, `cov=${JSON.stringify(draft.coverage)}`);
    // A10：草稿结构完整（2 需求 + ≥2 用例，每用例带步骤/预期）
    ck('A10_draft_shape', Array.isArray(draft.requirements) && draft.requirements.length === 2 && draft.cases.length >= 2 && draft.cases.every((c) => c.title && c.expected), `reqs=${draft.requirements.length} cases=${draft.cases.length}`);

    // A10：确认导入落库 + 关联正确
    const imp1 = TestCaseService.importDraft({ projectId: pid1, requirements: draft.requirements, cases: draft.cases, writeRequirements: false });
    ck('A10_import_inserts_all', imp1.imported === draft.cases.length && imp1.skipped === 0, `imp=${JSON.stringify(imp1)}`);
    const listed = TestCaseService.list({ projectId: pid1, limit: 0 });
    const linkOk = listed.items.length === draft.cases.length && listed.items.every((x) => x.reqNo && /^REQ-00[12]$/.test(String(x.reqNo)));
    ck('A10_cases_linked_to_req', linkOk, `linked=${listed.items.map((x) => x.reqNo).join(',')}`);

    // A12：同一份 PRD 二次生成——生成期即标 alreadyImported，再导入不产生重复，用例总数不变
    const draft2 = await gen.generateTestCasesStream({
      projectId: pid1, toolId: 'stub', content, source: '内部 PRD', onStage: () => {}, onDelta: () => {},
    });
    ck('A12_second_gen_marked_already_imported', draft2.cases.length > 0 && draft2.cases.every((c) => c.alreadyImported === true), `alreadyImported=${draft2.cases.map((c) => c.alreadyImported).join(',')}`);
    const imp2 = TestCaseService.importDraft({ projectId: pid1, requirements: draft2.requirements, cases: draft2.cases, writeRequirements: false });
    ck('A12_second_import_imported_0', imp2.imported === 0 && imp2.skipped === draft2.cases.length, `imp2=${JSON.stringify(imp2)}`);
    const listed2 = TestCaseService.list({ projectId: pid1, limit: 0 });
    ck('A12_total_unchanged', listed2.items.length === listed.items.length, `before=${listed.items.length} after=${listed2.items.length}`);

    // ===== A11 部分覆盖：只覆盖 REQ-001 → 未覆盖项有显式告警 =====
    adaptersMod.getAdapter = () => makeStub('partial');
    const pid2 = seedProject('M2-partial');
    let warnSeen = false;
    const draftP = await gen.generateTestCasesStream({
      projectId: pid2, toolId: 'stub', content: '# PRD\nREQ-001 登录；REQ-002 取消。', source: '内部 PRD',
      onStage: (m) => { if (/未覆盖|仍未产出|补生成/.test(m)) warnSeen = true; }, onDelta: () => {},
    });
    ck('A11_partial_rate_50', draftP.coverage.rate === 50 && draftP.coverage.uncovered === 1, `cov=${JSON.stringify(draftP.coverage)}`);
    ck('A11_partial_explicit_warning', warnSeen || draftP.notes.some((n) => /未覆盖|仍未产出/.test(n)), `notes=${draftP.notes.join(' / ').slice(0, 120)}`);

    // ===== A9 中断：预置 aborted 信号 → pipeline 立即抛「生成已中止」 =====
    adaptersMod.getAdapter = () => makeStub('full');
    const pid3 = seedProject('M2-abort');
    const ac = new AbortController();
    ac.abort();
    let abortErr = '';
    try {
      await gen.generateTestCasesStream({ projectId: pid3, toolId: 'stub', content: '# PRD REQ-001', source: 'x', onStage: () => {}, onDelta: () => {}, signal: ac.signal });
    } catch (e) { abortErr = e && e.message; }
    ck('A9_abort_honored', /中止|aborted/i.test(abortErr), `err=${abortErr}`);

    // ===== A9 中断（生成中）：勾选「重新拆分」走 step1 拆分→桩在拆分调用时 abort→步骤后 signal 检查点抛中止
    // （证明中断在真实 AI 调用之后仍被 pipeline 检查点捕获，非仅起始检查）=====
    const ac2 = new AbortController();
    adaptersMod.getAdapter = () => makeStub('full', { onCall: () => ac2.abort() });
    let abortMid = '';
    try {
      await gen.generateTestCasesStream({ projectId: seedProject('M2-abortmid'), toolId: 'stub', content: '# PRD REQ-001 REQ-002', source: 'x', resplitRequirements: true, onStage: () => {}, onDelta: () => {}, signal: ac2.signal });
    } catch (e) { abortMid = e && e.message; }
    ck('A9_abort_mid_generation', /中止|aborted/i.test(abortMid), `err=${abortMid}`);
  } catch (e) {
    ck('PIPELINE_NO_EXCEPTION', false, 'pipeline 驱动异常：' + (e && (e.stack || e.message)));
  } finally {
    adaptersMod.getAdapter = origGetAdapter;
    try { fs.rmSync(process.env.MTask_DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  const pass = results.filter((x) => x.pass).length;
  const fail = results.length - pass;
  process.stdout.write('M2PIPE:' + JSON.stringify({ results, pass, fail }) + '\n');
  for (const x of results) process.stderr.write(`${x.pass ? 'PASS' : 'FAIL'}  ${x.k}  ${x.msg}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { process.stdout.write('M2PIPE:' + JSON.stringify({ results, error: String(e && e.stack || e) }) + '\n'); process.exit(1); });
