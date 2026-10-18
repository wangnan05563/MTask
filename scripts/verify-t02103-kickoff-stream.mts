/**
 * T02103 门：SSE 流式生成接口（技术方案 §2.3 / PRD FR-1.4 FR-4.8 验收 9）。
 *
 * 断言：
 *   S 组 契约守卫（T02293 判据 1/3 改判）：18 条字面锚点**全部降级为配对项的字面腿**——
 *                  行为腿取自 G/E 组的线上帧、下载工件、tmp 目录、并发闸实测与 B 组夹具调用，
 *                  在 E 组跑完后统一发射（okPair），红因区分「行为失守」与「等价重构换措辞」。
 *                  字面腿的取证对象是 `git show HEAD:` 的已提交树（批⑫ · 反模式 11：读工作树会把
 *                  并发会话的半成品算成本门的红），并有一条 S-00 钉住「四份源码都取到了」。
 *   G 组 现场行为：措辞配额自检（无风险/沟通页零模型调用）、落盘唯一性（未下载时 tmp 恰一个 UUID 文件）、
 *                  周报两条链路令牌可下载（同一收口点）、并发闸 3+1 路实测（2 放行 / 1 拒 / 周报同闸被拒）。
 *   X 组 改名模拟（判据 3~4）：门内夹具项目改名后下载名跟着改、旧名零残留。
 *   N 组 负对照（判据 4）：形态谓词对等价改写判假、头前 400 与流内 error 可区分、零残留判据的对照面、
 *                  中止消息单源非同义反复、降级判据双向、同步变体看不到中止（yieldToLoop 的失效形态）、
 *                  表集合快照能识别多出一张表。
 *   W 组 措辞回锁纯函数 wordingFromAi：条数/数字/「」名称/长度四道钉，source 不经模型。
 *   O 组 入参形状 assertOutlineShape：用户编辑过的大纲逐页点名坏字段，页数只兜失控不套 AI 铁律。
 *   B 组 装配接缝：onPage 逐页回调、预中止不留稿、取消在装配中途真的生效、单独载入 service 即拿到常量。
 *   E 组 隔离实例 + 本地 mock AI 走真 SSE：stage 逐页、done 令牌换回可解包 .pptx、
 *      措辞违约仍出稿且如实告警、客户端断开后临时目录零半成品零孤儿令牌（验收 9）。
 *      数据一律来自**门内自建夹具项目**（判据 2：旧版直接钉 mtask五期 的 uuid，等于断言生产库某条业务行存在）。
 * 环境缺口记 SKIP 不记 FAIL（夹具项目建不起来时，依赖线上实测的条目如实跳过并写明原因）。
 * 用法（与 T02095/T02096 同口径，better-sqlite3 需匹配当前 Node ABI）：
 *   node node_modules/tsx/dist/cli.mjs scripts/verify-t02103-kickoff-stream.mts
 * 环境变量：`T02103_PORT`（默认随机 39700+rand300）。
 * 隔离纪律（skill 红线 8）：空库（批⑫ 起不再复制生产库）+ 随机端口 + 临时目录，全程不读不写生产库，mock 不消耗真实配额。
 * 结果落 .workbuddy/t02103-gate-results-<运行标识>.txt 与 t02103-stream-<运行标识>.pptx（T02309 旁证同标识）。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';
import { okPair } from './lib/anchor-pair.mts'; // T02293 判据 3：字面锚点必须配同义行为断言

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.T02103_PORT ?? 39_700 + Math.floor(Math.random() * 300));
const DATA_DIR = mkdtempSync(join(tmpdir(), 't02103-stream-'));
const BASE = `http://127.0.0.1:${PORT}/api`;
const OUT_DIR = join(ROOT, '.workbuddy');
const TMP_DIR = join(DATA_DIR, 'tmp');

let pass = 0;
let fail = 0;
const skippedList: string[] = [];
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 400)}`}`);
};
/** 判据 2：环境缺口如实记 SKIP（不记 PASS），例如夹具项目建不起来时依赖 E 组实测的配对项 */
const skipped = (name: string, why: string) => {
  skippedList.push(name);
  lines.push(`[SKIP] ${name} —— ${why}（不计 PASS）`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * S 组配对项的**行为腿数据源**（T02293 判据 1/3）：全部由 B/E 组实测回填，不是「源码里能 grep 到这句」。
 * 声明在此处、赋值在 B/E 组，S 组的配对断言在 E 组之后统一发射（见 S_PAIRS）。
 */
const RT = {
  seeded: false, // 门内夹具项目 + 阻塞计划已建（判据 2：不依赖生产库某条业务行）
  fixtureName: '',
  bAbortMsg: '', bMidAbortMsg: '', bTimerAbortMsg: '', bCallbackCount: 0, bBuiltPages: 0,
  bSeq: '', builderTmpDelta: 0,
  fastNoPid: 0, fastNoTool: 0, fastBadShape: 0, fastBadShapeCtype: '', fastAsks: 0,
  doneFileName: '', promptBansOk: false, promptRiskBlockOk: false, noModelWarnText: '',
  unknownToolStatus: 0, unknownToolCtype: '', unknownToolErrorFrames: 0, errorShapeOk: false,
  stageShapesOk: false, doneFieldsOk: false, stageDenomOk: false, pageCount: 0,
  dlBytes: 0, dlMagic: false, tmpEmptyAfterDl: false, tmpFilesWhenKept: [] as string[],
  tmpEmptyAfterAbort: false, clientAbortNoDone: false, midAbortNoDone: false,
  weeklyTokenOk: false, weeklyDownloadOk: false, weeklyStreamDownloadOk: false,
  weeklyRejected: false, gateRejected: 0, gateAccepted: 0,
  degradeBadCount: false, degradeBadNum: false, degradeBoom: false, degradeNoModel: false,
  noDegradeOnGood: false,
  noWordingPagesSkipsModel: false, noWordingStillDone: false,
  sourceLocalInArtifact: false, aiWordingInArtifact: false, sourceLocalMissing: [] as string[],
  schemaTablesSame: false, planCountSame: false,
  abortMsgFromBuilder: '', abortMsgFromService: '',
  fileNameHasFixture: false,
  cycles: false, dynamicImportBuilt: false,
};
// 表集合快照读取器（模块作用域：E 组与 N 组负对照都要用）
const GATE_DB = join(DATA_DIR, 'mtask.db');
const Sqlite = (await import('better-sqlite3')).default;
const listTablesAt = (file: string) => {
  const db = new Sqlite(file, { readonly: true });
  try {
    return (db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table') as Array<{ name: string }>).map((r) => r.name).sort().join(',');
  } finally {
    db.close();
  }
};
const listTables = () => listTablesAt(GATE_DB);
// 开工时的表集合快照（E 组装完数据后取，N-07 与 S-13 行为腿都要比它）
let tables0 = '';

const S = await import('../server/src/services/kickoffService.ts');
const B = await import('../server/src/services/kickoffBuilder.ts');

/**
 * 字面腿的取证对象 = **已提交树**（T02293 批⑫ / 反模式 11）。
 * 读工作树时，并发会话留下的未完成产品文件会让红因指错地方（本门与 t02099 同族历史踩过）；
 * 行为腿不受影响——它跑的是 tsx 直接 import 的同一份模块，两者不一致时恰好暴露「工作树未提交」。
 */
const HEAD_CACHE = new Map<string, string>();
function headSrc(rel: string): string {
  if (!HEAD_CACHE.has(rel)) {
    let t = '';
    try {
      t = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
    } catch (e) {
      lines.push(`[WARN] git show HEAD:${rel} 取证失败：${(e as Error).message.slice(0, 140)}`);
    }
    HEAD_CACHE.set(rel, t);
  }
  return HEAD_CACHE.get(rel) as string;
}
const RSRC = headSrc('server/src/services/ReportService.ts');
const SSRC = headSrc('server/src/services/kickoffService.ts');
const BSRC = headSrc('server/src/services/kickoffBuilder.ts');
const ROUTE = headSrc('server/src/routes/plans.ts');
// 只截本端点这一段：plans.ts 有 900+ 行别的注册，整文件断言会把别人的写法算到我头上
const routeCut = ROUTE.indexOf("planApi.post('/kickoff-ppt-stream'");
const streamRoute = routeCut < 0 ? '' : ROUTE.slice(routeCut, ROUTE.indexOf('\nplanApi.', routeCut + 10));
const streamSrc = SSRC.slice(SSRC.indexOf('// ---------- 流式生成'));
ok('S-00 字面腿取证对象非空（git show HEAD: 四份源码都取到了，锚点不是对着空气判的）',
  RSRC.length > 3000 && SSRC.length > 8000 && BSRC.length > 3000 && ROUTE.length > 3000 && !!streamRoute && !!streamSrc,
  { ReportService: RSRC.length, kickoffService: SSRC.length, kickoffBuilder: BSRC.length, plans: ROUTE.length, streamRoute: streamRoute.length, streamSrc: streamSrc.length });

// =====================================================================
// S 组：契约守卫（T02293 判据 1/3 改判）
//   字面锚点保留（这些是**契约文本**：事件字段名、中止消息、降级话术，等价重构真会改它们），
//   但每条都配一条取自 B/E 组实测的同义行为断言，且只在行为绿的前提下才认字面绿。
//   配对项在 E 组跑完后统一发射（行为腿必须是实测值，写在这里就等于「先假定功能好使再读源码」）。
// =====================================================================
const S_PAIRS: Array<{ label: string; needsE?: boolean; behavior: () => boolean; literal: () => boolean; ctx: () => unknown }> = [
  {
    label: 'S-01 令牌落盘收口为 saveReportBuffer 单源（纠偏 C3：令牌形态一分叉，白名单与下载端点就得处处加特例）',
    needsE: true,
    behavior: () => RT.dlBytes > 20_000 && RT.dlMagic && RT.tmpEmptyAfterDl && RT.weeklyDownloadOk,
    literal: () =>
      /export function saveReportBuffer\(buffer: Buffer\): string \{[\s\S]{0,160}randomUUID\(\)[\s\S]{0,120}writeFileSync\(join\(reportTmpDir\(\), token\), buffer\)/.test(RSRC) &&
      (RSRC.match(/writeFileSync\(join\(reportTmpDir\(\), token\), buffer\)/g) ?? []).length === 1,
    ctx: () => ({ 落盘文件: RT.tmpFilesWhenKept, 下载字节: RT.dlBytes, tmp清空: RT.tmpEmptyAfterDl }),
  },
  {
    label: 'S-02 周报两条链路都改走单源（不在别处再拼一遍 randomUUID+writeFileSync）',
    needsE: true,
    behavior: () => RT.weeklyDownloadOk && RT.weeklyStreamDownloadOk,
    literal: () => (RSRC.match(/const token = saveReportBuffer\(buffer\);/g) ?? []).length === 2,
    ctx: () => ({ 非流式可下载: RT.weeklyDownloadOk, 流式可下载: RT.weeklyStreamDownloadOk, 锚点命中: (RSRC.match(/const token = saveReportBuffer\(buffer\);/g) ?? []).length }),
  },
  {
    label: 'S-03 kickoffService 不自己碰文件系统落盘（只经 saveReportBuffer）',
    needsE: true,
    behavior: () =>
      RT.tmpFilesWhenKept.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(RT.tmpFilesWhenKept[0]),
    literal: () => /saveReportBuffer\(assembled\.buffer\)/.test(SSRC) && !/writeFileSync|createWriteStream|\.part/.test(SSRC),
    ctx: () => ({ 未下载时tmp内容: RT.tmpFilesWhenKept, builder零落盘: RT.builderTmpDelta === 0 }),
  },
  {
    label: 'S-04 事件形态与周报逐字同构：stage {msg} / done {token, fileName, pageCount, warnings} / error {error}',
    needsE: true,
    behavior: () => RT.stageShapesOk && RT.doneFieldsOk && RT.errorShapeOk,
    literal: () =>
      /send\('stage', \{ msg \}\)/.test(streamRoute) &&
      /send\('done', \{ token: r\.token, fileName: r\.fileName, pageCount: r\.pageCount, warnings: r\.warnings \}\)/.test(streamRoute) &&
      /send\('error', \{ error: /.test(streamRoute),
    ctx: () => ({ 线上帧形态: { stage: RT.stageShapesOk, done: RT.doneFieldsOk } }),
  },
  {
    label: "S-05 断连监听 res 的 close 并 ac.abort()（监听 req 会被 express.json() 提前 close，stage/done 全误丢——T00838 实测坑）",
    needsE: true,
    behavior: () => RT.clientAbortNoDone && RT.midAbortNoDone && RT.tmpEmptyAfterAbort,
    literal: () => /res\.on\('close', \(\) => \{[\s\S]{0,80}closed = true;[\s\S]{0,80}ac\.abort\(\);/.test(streamRoute) && !/req\.on\('close'/.test(streamRoute),
    ctx: () => ({ 断连未收到done: RT.clientAbortNoDone, 断连后tmp: RT.tmpEmptyAfterAbort }),
  },
  {
    label: 'S-06 参数与大纲形状在 SSE 头之前快速失败（前端要拿到结构化 400，不是流里一条 error）',
    needsE: true,
    behavior: () =>
      RT.fastNoPid === 400 && RT.fastNoTool === 400 && RT.fastBadShape === 400 &&
      !RT.fastBadShapeCtype.includes('event-stream') && RT.fastAsks === 0,
    literal: () =>
      streamRoute.indexOf('assertOutlineShape(b.outline)') < streamRoute.indexOf('res.flushHeaders?.()') &&
      /projectId 必填/.test(streamRoute) && /toolId 必填（生成需要模型工具）/.test(streamRoute),
    ctx: () => ({ noPid: RT.fastNoPid, noTool: RT.fastNoTool, badShape: RT.fastBadShape, ctype: RT.fastBadShapeCtype, mock请求: RT.fastAsks }),
  },
  {
    label: 'S-07 挂并发闸且 defer（与周报共用闸语义，超限 429）',
    needsE: true,
    behavior: () => RT.gateAccepted === 2 && RT.gateRejected === 1 && RT.weeklyRejected,
    literal: () => /planApi\.post\('\/kickoff-ppt-stream', exportGate\(REPORT_GATE, undefined, \{ defer: true \}\)/.test(ROUTE),
    ctx: () => ({ 放行: RT.gateAccepted, 拒绝: RT.gateRejected, 周报同闸被拒: RT.weeklyRejected }),
  },
  {
    label: 'S-08 中止消息单源（builder 抛出与 service 检查同一句，面板与门禁都认这句）',
    behavior: () =>
      RT.bAbortMsg === RT.abortMsgFromService && RT.bMidAbortMsg === RT.abortMsgFromService && RT.bTimerAbortMsg === RT.abortMsgFromService,
    literal: () =>
      /export const KICKOFF_ABORT_MSG = '[^']*';/.test(SSRC) &&
      (BSRC.match(/throw new Error\(KICKOFF_ABORT_MSG\)/g) ?? []).length >= 2 &&
      SSRC.includes('throw new Error(KICKOFF_ABORT_MSG)'),
    ctx: () => ({ builder抛出: RT.bAbortMsg, service常量: RT.abortMsgFromService }),
  },
  {
    label: 'S-09 措辞段失败不阻断：try/catch + 未配模型同步抛错同样收口，逐字降级告警在位',
    needsE: true,
    behavior: () =>
      RT.degradeBadCount && RT.degradeBadNum && RT.degradeBoom && RT.degradeNoModel && RT.noDegradeOnGood,
    literal: () =>
      /KICKOFF_WORDING_FALLBACK_MSG = '风险措辞 AI 失败，已用本地条目'/.test(SSRC) &&
      /\}\s*catch \(e\) \{\s*\/\/ runtimeWithModel/.test(SSRC) &&
      /warnings\.push\(`\$\{KICKOFF_WORDING_FALLBACK_MSG\}（原因：/.test(SSRC),
    ctx: () => ({ badCount: RT.degradeBadCount, badNum: RT.degradeBadNum, boom: RT.degradeBoom, 未配模型: RT.degradeNoModel, 合规轮不降级: RT.noDegradeOnGood }),
  },
  {
    label: 'S-10 溯源 source 一律保留本地值（措辞是话术，出处不是，不经模型）',
    needsE: true,
    behavior: () => RT.sourceLocalInArtifact && RT.aiWordingInArtifact,
    literal: () => /source: r\.source,/.test(streamSrc),
    ctx: () => ({ 产物含AI措辞: RT.aiWordingInArtifact, 未落到页面上的本地出处: RT.sourceLocalMissing }),
  },
  {
    label: 'S-11 无风险页且无沟通页就不发这次模型调用（不烧没落点的配额）',
    needsE: true,
    behavior: () => RT.noWordingPagesSkipsModel && RT.noWordingStillDone,
    literal: () => /function needsWording\(/.test(streamSrc) && /跳过措辞润色（不消耗模型配额）/.test(streamSrc),
    ctx: () => ({ 零模型请求: RT.noWordingPagesSkipsModel, 仍出稿: RT.noWordingStillDone }),
  },
  {
    label: 'S-12 service→builder 用动态 import（builder 静态引用本模块常量，双向静态 import 成环）',
    behavior: () => RT.dynamicImportBuilt && RT.bBuiltPages === 5,
    literal: () => /const \{ buildKickoffPpt[^}]*\} = await import\('\.\/kickoffBuilder'\)/.test(streamSrc),
    ctx: () => ({ 环检测: RT.cycles, 动态import产出稿: RT.dynamicImportBuilt }),
  },
  {
    label: 'S-13 生成链路零落库（A-3 决定日志只进控制台 SSE 流，不建 kickoff_ppt_logs）',
    needsE: true,
    behavior: () => RT.schemaTablesSame && RT.planCountSame,
    literal: () => !/INSERT INTO|UPDATE /.test(streamSrc),
    ctx: () => ({ 表集合不变: RT.schemaTablesSame, 计划条数不变: RT.planCountSame }),
  },
  {
    label: 'S-14 逐页 stage 文案按 §2.3 口径「页 n/N 已装配：<章节>」（N=渲染页数，T02171 分页后不等于大纲页数）',
    needsE: true,
    behavior: () => RT.stageDenomOk && RT.pageCount >= 13,
    literal: () => /页 \$\{pageNo\}\/\$\{renderTotal\} 已装配：\$\{item\.section\}/.test(streamSrc) && /renderTotal = expandTimelinePages\(/.test(streamSrc),
    ctx: () => ({ 页码分母同源: RT.stageDenomOk, pageCount: RT.pageCount }),
  },
  {
    label: 'S-15 装配循环每页开头检查 signal.aborted 且逐页让出事件循环（否则 stage 憋到最后、取消形同虚设）',
    behavior: () => RT.bCallbackCount === 2 && RT.bTimerAbortMsg === RT.abortMsgFromService,
    literal: () =>
      /if \(opts\.signal\?\.aborted\) throw new Error\(KICKOFF_ABORT_MSG\)/.test(BSRC) &&
      /await yieldToLoop\(\);/.test(BSRC) && /setImmediate\(resolve\)/.test(BSRC),
    ctx: () => ({ 第2页取消后回调数: RT.bCallbackCount, 外部timer插入: RT.bTimerAbortMsg }),
  },
  {
    // 批⑫：下载名的三段式文案是 §2.4 契约文本，但「名字对不对」的行为事实不靠这四个字
    label: 'S-16 下载名走 §2.4 三段式（类型前缀-项目名-数据日.pptx）：项目名与日期确实由入参推导',
    needsE: true,
    behavior: () =>
      RT.doneFileName.endsWith('.pptx') && RT.doneFileName.includes(RT.fixtureName) && /20\d{6}/.test(RT.doneFileName),
    literal: () => /^项目启动会-.+-20\d{6}\.pptx$/.test(RT.doneFileName),
    ctx: () => ({ fileName: RT.doneFileName, 夹具名: RT.fixtureName }),
  },
  {
    // 批⑫：提示词禁令是产品文案（模型行为由它决定），行为腿取「违约真被拒收」这一不依赖措辞的事实
    label: 'S-17 措辞提示词写明数字/名称/条数三道禁令（禁令有牙：违约轮真被拒并降级，而非照单全收）',
    needsE: true,
    behavior: () => RT.degradeBadCount && RT.degradeBadNum,
    literal: () => RT.promptBansOk,
    ctx: () => ({ 提示词禁令命中: RT.promptBansOk, badCount降级: RT.degradeBadCount, badNum降级: RT.degradeBadNum }),
  },
  {
    label: 'S-18 风险清单的本地条目原文进提示词（AI 只在系统枚举的事实上改措辞，看不到就没法编）',
    needsE: true,
    behavior: () => RT.sourceLocalInArtifact && RT.aiWordingInArtifact,
    literal: () => RT.promptRiskBlockOk,
    ctx: () => ({ 未落到页面上的本地出处: RT.sourceLocalMissing, 产物含AI措辞: RT.aiWordingInArtifact }),
  },
];

// =====================================================================
// W 组：wordingFromAi 措辞回锁（纯函数）
// =====================================================================
const LOCAL_RISKS = [
  { item: '计划「数据面联调」当前为阻塞态', impact: '该计划及其后继无法按期开工', mitigation: '会上明确阻塞责任方与解除时限', source: 'plan_tasks.status=blocked' },
  { item: '14 条需求未关联任何计划', impact: '这部分范围没有排期承载', mitigation: '逐条确认纳入本期或列入范围外', source: 'prd_requirements.linkedPlans' },
];
const LOCAL_COMMS = ['里程碑节点后一次周会', '变更走需求跟踪矩阵登记'];
const local = { risks: LOCAL_RISKS, comms: LOCAL_COMMS };
const good = {
  risks: [
    { item: '「数据面联调」处于阻塞态，卡住后续', impact: '后继计划无法按期开工', mitigation: '会上定阻塞责任方与解除时限' },
    { item: '14 条需求还没挂到计划上', impact: '这部分范围无人承载，易漏交付', mitigation: '会上逐条定纳入本期或列入范围外' },
  ],
  comms: ['周会跟里程碑节点走', '变更先登记进需求跟踪矩阵'],
};
const w1 = S.wordingFromAi(local, good);
ok('W-01 合规改写通过：条目原样采纳（不裁字、不丢条、不改数）',
  w1.risks.length === good.risks.length && w1.comms.length === good.comms.length &&
    w1.risks.every((r, i) => r.item === good.risks[i].item && r.impact === good.risks[i].impact && r.mitigation === good.risks[i].mitigation) &&
    w1.comms.every((c, i) => c === good.comms[i]),
  { risks: w1.risks.map((r) => r.item), comms: w1.comms });
ok('W-02 source 保持本地原值（模型没机会改溯源）', w1.risks.every((r, i) => r.source === LOCAL_RISKS[i].source));
/**
 * 判据 3：措辞校验器抛出的**消息文案**是契约文本（面板/日志按它区分违约类型），
 * 但「等价重构换了说法」与「根本不拒收了」两种红必须分开——所以每条都配对：
 * 行为腿 = 这一路确实被拒收（抛错）；字面腿 = 消息里仍是这句人话。
 */
const expectErr = (label: string, payload: unknown, re: RegExp) => {
  let threw = false;
  let msg = '';
  try {
    S.wordingFromAi(local, payload);
  } catch (e) {
    threw = true;
    msg = String(e);
  }
  okPair(ok, label, () => threw, () => threw && re.test(msg), () => ({ 抛错: threw, 消息: msg.slice(0, 200) }));
};
expectErr('W-03 增删条目拒收：风险条数 1≠2 点名「不得增删」',
  { ...good, risks: [good.risks[0]] }, /风险条目数 1 与系统枚举的 2 不一致/);
expectErr('W-04 沟通口径条数同样钉死',
  { ...good, comms: ['a', 'b', 'c'] }, /沟通口径条数 3 与系统给出的 2 不一致/);
expectErr('W-05 数字幻觉拒收：凭空多出的 999 条', { ...good, comms: ['999 条变更每周复盘', good.comms[1]] }, /没有的数字「999」/);
expectErr('W-06 百分比幻觉同样拒收', { ...good, comms: ['覆盖率 80% 每周复盘', good.comms[1]] }, /没有的数字「80」/);
expectErr('W-07 名称幻觉拒收：「」里出现输入中没有的计划名',
  { ...good, risks: [{ ...good.risks[0], item: '计划「幽灵模块」阻塞' }, good.risks[1]] }, /没有的名称/);
expectErr('W-08 超长拒收：item 超 60 字（页面上会挤成三行）',
  { ...good, risks: [{ item: '长'.repeat(61), impact: good.risks[0].impact, mitigation: good.risks[0].mitigation }, good.risks[1]] }, /item 超 60 字/);
expectErr('W-09 空字段拒收：不把「空措辞」当合法改写',
  { ...good, risks: [{ item: '  ', impact: good.risks[0].impact, mitigation: good.risks[0].mitigation }, good.risks[1]] }, /item 为空/);
expectErr('W-10 缺数组拒收：本轮要 2 条风险却没给 risks', { comms: good.comms }, /缺 risks 数组/);
const w2 = S.wordingFromAi({ risks: LOCAL_RISKS, comms: [] }, { risks: good.risks });
ok('W-11 未索要 comms 时缺键不算违约（回空数组，别把可用改写打成降级）', w2.comms.length === 0);
expectErr('W-12 索要了 comms 却缺键 → 抛错', { risks: good.risks }, /缺 comms 数组/);
ok('W-13 两份清单都空时只回空对象（不因此放弃整份稿）',
  S.wordingFromAi({ risks: [], comms: [] }, {}).risks.length === 0);

// =====================================================================
// O 组：assertOutlineShape 入参形状
// =====================================================================
const page = (i: number, over: Record<string, unknown> = {}) => ({
  section: '项目计划', title: `启动会页 ${i}`, bullets: ['范围与交付物'], dataKeys: ['preflight'], layout: 'table', ...over,
});
/**
 * O 组同样按判据 3 配对：拒收（抛错）+ 点名坏字段所在页/坏值本身是**行为**，
 * 「第 N 页缺标题」这类消息措辞是**字面锚点**。opts.page/echo 让行为腿不依赖措辞。
 */
const shapeErr = (label: string, raw: unknown, re: RegExp, opts: { page?: number; echo?: string } = {}) => {
  let threw = false;
  let msg = '';
  try {
    S.assertOutlineShape(raw);
  } catch (e) {
    threw = true;
    msg = String(e);
  }
  const { page, echo } = opts;
  okPair(ok, label, () => threw && (echo ? msg.includes(echo) : true), () => threw && re.test(msg),
    () => ({ 抛错: threw, 消息: msg.slice(0, 200), 点名坏值: echo }));
  if (page !== undefined) {
    const nums = (msg.match(/\d+/g) ?? []).map(Number);
    okPair(ok, `${label}——逐页点名（面板才知道去改哪一页）`,
      () => threw && nums.includes(page), () => threw && /第 \d+ 页/.test(msg),
      () => ({ 消息: msg.slice(0, 200), 点到的数字: nums, 期望页: page }));
  }
};
ok('O-01 合规大纲原样收（section/bullets/dataKeys/layout 齐）',
  S.assertOutlineShape([page(1), page(2)]).length === 2);
shapeErr('O-02 空数组拒收（面板没确认就别开工）', [], /非空数组/);
shapeErr('O-03 非数组拒收', { outline: [] }, /非空数组/);
shapeErr('O-04 缺标题逐页点名', [page(1), page(2, { title: '  ' })], /第 2 页缺标题/, { page: 2 });
shapeErr('O-05 版式不在枚举 → 拒收（不能让 builder 拿到未知 layout 猜一套）', [page(1, { layout: 'gantt' })], /版式「gantt」不在枚举/, { page: 1, echo: 'gantt' });
shapeErr('O-06 未知 dataKey → 拒收（拼错键会静默少一整块内容）', [page(1, { dataKeys: ['reqlists'] })], /未知数据键「reqlists」/, { page: 1, echo: 'reqlists' });
shapeErr('O-07 缺 dataKeys 数组 → 拒收', [page(1, { dataKeys: undefined })], /缺 dataKeys 数组/, { page: 1 });
shapeErr('O-08 bullet 混进非字符串 → 拒收', [page(1, { bullets: [3] })], /第 1 页第 2? 条要点不是字符串|不是字符串/, { page: 1 });
okPair(ok, 'O-09 section 缺失补默认分组名（§3.2 口径），空 bullet 丢弃',
  () => {
    const r = S.assertOutlineShape([page(1, { section: '  ', bullets: ['甲', '  ', '乙'] })]);
    return r[0].bullets.join() === '甲,乙' && r[0].section.trim().length > 0 && r[0].section !== '  ';
  },
  () => {
    const r = S.assertOutlineShape([page(1, { section: '  ', bullets: ['甲', '  ', '乙'] })]);
    return r[0].section === '正文';
  },
  () => S.assertOutlineShape([page(1, { section: '  ', bullets: ['甲', '  ', '乙'] })])[0]);
shapeErr('O-10 页数失控（>40）拒收，但 9 页这种用户手删不拦——12~18 是 AI 编排铁律不是装配铁律',
  Array.from({ length: 41 }, (_, i) => page(i + 1)), /超出上限 40 页/, { echo: '41' });
ok('O-11 用户删到 9 页仍能装配（不把大纲段规则二次套上）', S.assertOutlineShape(Array.from({ length: 9 }, (_, i) => page(i + 1))).length === 9);
/**
 * 判据 1/3：下载名的**模板文案**（`项目启动会-` 前缀 + `.pptx` 后缀）是 §2.4 契约文本，留作字面腿；
 * 行为腿换成与文案无关的结构事实——同一函数换任意项目名/日期都得到「含该名、含紧凑日期、以 .pptx 结尾」，
 * 且两个不同输入产出两个不同名字（名字真由入参推导，不是哪里写死的一串）。
 */
okPair(ok, 'O-12 下载名按 §2.4：项目启动会-<项目名>-<YYYYMMDD>.pptx',
  () => {
    const a = S.kickoffFileName('甲项目', '2026-01-05');
    const b = S.kickoffFileName('乙项目', '2027-12-31');
    return a.includes('甲项目') && a.includes('20260105') && a.endsWith('.pptx') &&
      b.includes('乙项目') && b.includes('20271231') && b.endsWith('.pptx') && a !== b;
  },
  () => S.kickoffFileName('mtask五期', '2026-10-13') === '项目启动会-mtask五期-20261013.pptx',
  () => ({ 甲: S.kickoffFileName('甲项目', '2026-01-05'), 乙: S.kickoffFileName('乙项目', '2027-12-31') }));

// =====================================================================
// B 组：装配接缝（夹具内构造，不连库不起服务）
// =====================================================================
const DAY = 86400_000;
const T0 = Date.UTC(2026, 0, 5);
const iso = (off: number) => new Date(T0 + off * DAY).toISOString().slice(0, 10);
const planRow = (i: number) => ({
  id: `q${i}`, project_id: 'p1', title: `任务 ${i + 1}`, description: '', start_date: iso(i * 3), end_date: iso(i * 3 + 6),
  duration_days: 5, progress: i < 8 ? 100 : 20, status: i < 8 ? 'done' : 'doing', assignee: '张三', sort_order: i,
  linked_task_id: null, req_ids: null, color: '', deps: '', complexity: (i % 5) + 1, kind: 'normal', archived: 0,
  archived_at: null, created_at: '', updated_at: '',
});
const fixtureBundle = {
  project: { id: 'p1', name: 'mtask五期', workspacePath: ROOT },
  prdDocs: [{ id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentChars: 1200 }],
  prdDoc: { id: 'd1', filename: 'PRD-项目启动会PPT生成.md', updatedAt: '2026-10-12', contentMd: '# 背景\n口径来源说明。' },
  prdExcerpt: '# 背景\n口径来源说明。',
  prdTruncated: false,
  requirements: Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`, project_id: 'p1', req_no: `R${i + 1}`, title: `需求 ${i + 1}`, content: null, source_ref: null,
    priority: 'normal', status: 'doing', sort_order: i, created_at: null, updated_at: null, prd_id: 'd1',
    linkedPlans: [{ id: 'x', title: '计划', status: 'doing' }], linkedTasks: [], prdDoc: null,
  })),
  plans: Array.from({ length: 23 }, (_, i) => planRow(i)),
  milestones: Array.from({ length: 6 }, (_, i) => ({ ...planRow(100 + i), id: `m${i}`, title: `M${i + 1} 里程碑`, kind: 'milestone', start_date: iso(i * 12), end_date: iso(i * 12 + 2) })),
  coverage: { total: 40, covered: 32, uncovered: 8, rate: 80 },
  assignees: [{ name: '张三', planCount: 23 }],
  risks: LOCAL_RISKS,
  workload: {
    source: 'estimate', manDays: { expected: 96, optimistic: 78, pessimistic: 132 }, manMonth: 4.6,
    quote: { p50ManDays: 96, p84ManDays: 118 }, phases: [{ phase: '开发', expected: 60, rowCount: 12 }],
    complexity: [{ level: '3', count: 5 }], counted: 23, manDaysPerManMonth: 20.83, noData: false, reviewTrace: null,
    footer: '工作量来源：估算引擎（P50 96 人天 / P84 118 人天）',
  },
  preflight: {
    projectId: 'p1', projectName: 'mtask五期', blocked: false, missingHard: [], workloadSource: 'estimate',
    items: (['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const).map((key, i) => ({
      key, label: `项${key}`, count: [1, 14, 23, 6, 40, 23, 1][i], status: (i === 4 ? 'warn' : 'ok') as 'ok' | 'warn' | 'fail',
      note: '示例说明', deepLink: 'plan', hard: i < 3,
    })),
  },
  workspaceNote: '工作空间可访问',
  dataAsOf: '2026-10-13',
} as never;

const outlinePages = (n: number) =>
  S.assertOutlineShape(
    Array.from({ length: n }, (_, i) => ({
      section: i === 0 ? '封面' : i === 2 ? '项目风险' : i === 3 ? '沟通管理' : '项目计划',
      title: `启动会页 ${i + 1}`,
      bullets: ['范围与交付物', '责任分工'],
      dataKeys: i === 2 ? ['risks'] : ['planRows'],
      layout: i === 0 ? 'cover' : 'table',
    })),
  );

{
  const seen: Array<{ n: number; section: string }> = [];
  const fxOutline5 = outlinePages(5);
  const built = await B.buildKickoffPpt(fixtureBundle, fxOutline5, {
    onPage: (n, item) => seen.push({ n, section: item.section }),
  });
  RT.bBuiltPages = built.pageCount;
  RT.bSeq = seen.map((s) => s.n).join();
  // 章节名比的是「回调里的那一页 == 传进去的那一页」（回显忠实），不是「产品里恰好有『项目风险』这四个字」
  ok('B-01 onPage 逐页回调：页码连续 1..N 且章节名逐页回显（stage 文案的原料）',
    seen.map((s) => s.n).join() === '1,2,3,4,5' && seen.length === fxOutline5.length &&
      seen.every((s, i) => s.section === fxOutline5[i].section) && seen.every((s) => s.section.length > 0),
    { seen, want: fxOutline5.map((o) => o.section) });
  ok('B-01b 不传 opts 与 T02099 行为一致（pageCount/warnings 齐，向后兼容既有门禁）',
    built.pageCount === 5 && Array.isArray(built.warnings) && built.buffer.length > 10_000);

  const ac1 = new AbortController();
  ac1.abort();
  let msg1 = '';
  const r1 = await B.buildKickoffPpt(fixtureBundle, outlinePages(4), { signal: ac1.signal }).catch((e: unknown) => {
    msg1 = e instanceof Error ? e.message : String(e);
    return null;
  });
  RT.bAbortMsg = msg1;
  RT.abortMsgFromService = S.KICKOFF_ABORT_MSG;
  ok('B-02 预中止信号 → 抛中止消息且不产出 buffer（不返半成品）', r1 === null && msg1 === S.KICKOFF_ABORT_MSG, msg1);

  const ac2 = new AbortController();
  let callbackCount = 0;
  const err2 = await B.buildKickoffPpt(fixtureBundle, outlinePages(8), {
    signal: ac2.signal,
    onPage: () => {
      callbackCount += 1;
      if (callbackCount === 2) ac2.abort();
    },
  }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  RT.bMidAbortMsg = typeof err2 === 'string' ? err2 : '';
  RT.bCallbackCount = callbackCount;
  ok('B-03 画到第 2 页时被取消 → 后续页不再画（callbackCount 停在 2，不是 8）',
    err2 === S.KICKOFF_ABORT_MSG && callbackCount === 2, { err2, callbackCount });

  const ac3 = new AbortController();
  const p3 = B.buildKickoffPpt(fixtureBundle, outlinePages(8), { signal: ac3.signal });
  setTimeout(() => ac3.abort(), 0);
  const err3 = await p3.then(() => 'RESOLVED').catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  RT.bTimerAbortMsg = err3 === 'RESOLVED' ? '' : err3;
  ok('B-04 取消在装配中途真的生效（外部 timer 能在两页之间插进去）——同步死循环里这条不可能成立',
    err3 === S.KICKOFF_ABORT_MSG, err3);

  mkdirSync(TMP_DIR, { recursive: true });
  const before = readdirSync(TMP_DIR);
  const built13 = await B.buildKickoffPpt(fixtureBundle, outlinePages(6));
  writeFileSync(gateArtifactPath(OUT_DIR, 't02103-builder.pptx'), built13.buffer);
  RT.builderTmpDelta = readdirSync(TMP_DIR).length - before.length;
  ok('B-05 builder 层零落盘（只回 Buffer，令牌落盘只在 saveReportBuffer 一处）',
    readdirSync(TMP_DIR).length === before.length, { before, after: readdirSync(TMP_DIR) });

  // B-06 模块环实测：只 import service 就能经动态 import 拿到 builder 并产出真稿
  //（双向静态 import 成环时，这里要么拿不到函数、要么常量未初始化抛错）
  const onlyService = await import('../server/src/services/kickoffService.ts');
  const dyn = await (async () => {
    try {
      const mod = await import('../server/src/services/kickoffBuilder.ts');
      const buf = await mod.buildKickoffPpt(fixtureBundle, outlinePages(3));
      return buf.buffer.length;
    } catch {
      return 0;
    }
  })();
  RT.cycles = typeof onlyService.KICKOFF_ABORT_MSG === 'string' && onlyService.KICKOFF_ABORT_MSG.length > 0;
  RT.dynamicImportBuilt = dyn > 10_000;
  ok('B-06 单独载入 kickoffService 即拿到中止消息常量，且经 builder 产出真稿（成环时这条必红）',
    RT.cycles && RT.dynamicImportBuilt, { 常量: onlyService.KICKOFF_ABORT_MSG, 字节: dyn });
}

// =====================================================================
// mock OpenAI 兼容服务（本地、零真实配额）
// =====================================================================
type MockMode = 'good' | 'badNum' | 'badCount' | 'boom';
let mockMode: MockMode = 'good';
let mockDelayMs = 0;
const mockRequests: Array<{ system: string; user: string }> = [];
const AI_MARK_IMPACT = '该计划延后会顶到下个里程碑';
const AI_MARK_MITIGATION = '会上定责任方与解除时限';
const AI_MARK_COMM = '周会跟里程碑节点走';
/**
 * item 只保留本地条目里的「计划名」再换说法：计划名是库里原文（pinField 认这条白名单），
 * 直接照抄本地长条目会撞上 60 字上限，反而把「合规改写」这条路测不到。
 */
function rewordItem(localItem: string): string {
  const name = /「([^」]+)」/.exec(localItem)?.[1];
  return name && name.length <= 24 ? `「${name}」这条要会上定责任方` : '这条计划要会上定责任方';
}
function wordingReply(user: string): string {
  const risks = [...user.matchAll(/^\d+\. 风险：(.+)$/gm)].map((m) => ({
    item: rewordItem(m[1].trim()),
    impact: AI_MARK_IMPACT,
    mitigation: AI_MARK_MITIGATION,
  }));
  const commBlock = user.split('【沟通口径')[1] ?? '';
  const comms = [...commBlock.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1].trim());
  // 注入必须「一定违规」而不是「通常违规」：提示词里的本地条目数随库内数据而变（M6 推进后进度落后类
  // 风险归零、只剩 1 条），旧的 `risks.length > 1` 门槛会让 pop 退化成空操作——两轮问答都合规、不降级、
  // 整组静默假绿。风险数组空到无可 pop 时把违规挪到沟通数组，保证注入始终打得到校验。
  if (mockMode === 'badCount') {
    if (risks.length) risks.pop();
    else if (comms.length) comms.pop();
  }
  if (mockMode === 'badNum') {
    if (risks.length) risks[0] = { item: '999 条计划全部阻塞', impact: AI_MARK_IMPACT, mitigation: AI_MARK_MITIGATION };
    else if (comms.length) comms[0] = '999 条计划全部阻塞';
  }
  if (comms.length && mockMode === 'good') comms[0] = AI_MARK_COMM;
  return JSON.stringify({ risks, comms });
}
const mock = createServer((req, res) => {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString()));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}') as { messages?: Array<{ role: string; content: string }>; stream?: boolean };
    const user = body.messages?.[1]?.content ?? '';
    mockRequests.push({ system: body.messages?.[0]?.content ?? '', user });
    const reply = () => {
      if (mockMode === 'boom') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock 上游异常' } }));
        return;
      }
      // 周报流式链路走 chat/completions 的 SSE 形态（openaiCompat 适配器只认 data: 载荷里的 delta.content）；
      // mock 不回 stream 形态，ai-generate-stream 那条链路就根本没有可判的产物（G-03b 实测踩到）
      if (body.stream === true) {
        const content = wordingReply(user);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        const half = Math.ceil(content.length / 2);
        const emit = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        emit({ choices: [{ delta: { content: content.slice(0, half) }, finish_reason: null }] });
        emit({ choices: [{ delta: { content: content.slice(half) }, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: wordingReply(user) }, finish_reason: 'stop' }], usage: { total_tokens: 10 } }));
    };
    if (mockDelayMs > 0) setTimeout(reply, mockDelayMs);
    else reply();
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = (mock.address() as { port: number }).port;

// =====================================================================
// E 组：隔离实例（生产库只读副本 → 临时目录）真 SSE
// =====================================================================
// 夹具项目没建起来时，后面每条 E 都是「环境缺口」而不是「行为失守」——如实记 SKIP，不冒充 FAIL
const okE = (name: string, cond: boolean, extra?: unknown) => {
  if (!RT.seeded) skipped(name, '门内夹具项目未建成（见 E-00c）');
  else ok(name, cond, extra);
};
const { resolveServerLauncher } = await import('./isolated-server-launcher.mts');
const LAUNCHER = resolveServerLauncher(ROOT, join(ROOT, 'server', 'src', 'index.ts'));
/**
 * 判据 2（T02293 批⑫）：隔离实例从**空目录**起，库表由服务自身迁移建出。
 * 旧写法 `new Database(生产库).backup(DATA_DIR/mtask.db)` 有两重问题：
 * ① 门把生产业务数据搬进测试面，E 组的「能装配」里混着库里真实项目/计划；
 * ② 「副本已生成」这条断言本身就是在断言生产库某条业务行的存在性（判据 2 明令禁止）。
 * 夹具项目/计划全部由门在 E-00c 自建，因此空库不影响任何一条判据。
 */
ok('E-00a 隔离数据目录里没有库文件（不复制生产库，库表由服务自建；门内夹具稍后再建）',
  readdirSync(DATA_DIR).every((f) => f === 'tmp') && !readdirSync(DATA_DIR).some((f) => /\.(db|sqlite3?|db-wal|db-shm)$/i.test(f)),
  readdirSync(DATA_DIR));

const child: ChildProcess = spawn(LAUNCHER.exec, LAUNCHER.tsx, {
  cwd: ROOT,
  env: { ...process.env, ...LAUNCHER.env, MTask_PORT: String(PORT), MTask_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
child.stdout?.on('data', (b: Buffer) => serverLog.push(b.toString()));
child.stderr?.on('data', (b: Buffer) => serverLog.push(b.toString()));

async function waitUp(ms = 90_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok && (await res.json().catch(() => null))?.service === 'mtask-server') return true;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  return false;
}
async function call(method: string, path: string, json?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  // 先取文本再解析：res 一旦回传给调用方就再没读过 body，避免 "Body has already been read"
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON（如二进制下载） */ }
  return { status: res.status, body, text };
}

async function postRaw(path: string, json: unknown) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
  });
}

interface SseResult {
  status: number;
  ctype: string;
  json: any;
  events: Array<{ event: string; data: any }>;
  clientAborted: boolean;
}
/** 走真 SSE：按空行切事件，可指定「收到某事件后由客户端断开」或固定时长后断开（模拟面板点「停止」） */
async function sse(path: string, body: unknown, opts: { abortAfterMs?: number; stopAfter?: string } = {}): Promise<SseResult> {
  const ac = new AbortController();
  const events: Array<{ event: string; data: any }> = [];
  let raw = '';
  let clientAborted = false;
  const kill = () => { clientAborted = true; ac.abort(); };
  const timer = opts.abortAfterMs ? setTimeout(kill, opts.abortAfterMs) : null;
  let status = 0;
  let ctype = '';
  let json: any = null;
  try {
    const res = await fetch(BASE + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
    });
    status = res.status;
    ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('event-stream')) {
      if (timer) clearTimeout(timer);
      json = await res.json().catch(() => null);
      return { status, ctype, json, events, clientAborted };
    }
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      let i = raw.indexOf('\n\n');
      while (i >= 0) {
        const chunk = raw.slice(0, i);
        raw = raw.slice(i + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? '';
        const dataStr = /^data: (.*)$/m.exec(chunk)?.[1] ?? '{}';
        try { events.push({ event, data: JSON.parse(dataStr) }); } catch { /* 忽略坏帧 */ }
        if (opts.stopAfter && event === opts.stopAfter) {
          if (timer) clearTimeout(timer);
          kill();
        }
        i = raw.indexOf('\n\n');
      }
    }
  } catch { /* 客户端 abort 会抛 AbortError：预期内 */ }
  if (timer) clearTimeout(timer);
  return { status, ctype, json, events, clientAborted };
}

const outline13 = Array.from({ length: 13 }, (_, i) => ({
  section: i === 0 ? '封面' : i === 2 ? '项目风险' : i === 3 ? '沟通管理' : i === 6 ? '项目计划' : i === 7 ? '工作量评估' : '项目需求',
  title: `启动会页 ${i + 1}`,
  bullets: i === 3 ? ['周会跟里程碑节点开', '变更先登记进需求跟踪矩阵'] : ['范围与交付物', '责任分工'],
  dataKeys: i === 2 ? ['risks'] : i === 6 ? ['timeline', 'planRows'] : i === 7 ? ['workload'] : ['reqStats'],
  layout: i === 0 ? 'cover' : i === 6 ? 'timeline' : i === 7 ? 'chart' : 'table',
}));

if (!(await waitUp())) {
  ok('E-00 隔离实例启动', false, serverLog.join('').slice(-600));
} else {
  ok('E-00 隔离实例启动', true);
  const toolMock = await call('POST', '/aitools', { name: 't02103-mock', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'mock-key', model: 'mock-wording', timeoutMs: 20000 });
  const toolNoModel = await call('POST', '/aitools', { name: 't02103-nomodel', type: 'openai-compatible', endpoint: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'mock-key', timeoutMs: 20000 });
  const mockId = String(toolMock.body?.id ?? '');
  const noModelId = String(toolNoModel.body?.id ?? '');
  ok('E-00b 测试工具已建（含无 model 的那个）', !!mockId && toolNoModel.status === 201 && !toolNoModel.body?.model);

  // ---- 判据 2：门内自建夹具，不赌生产库某条业务行存在 ----
  // 旧写法直接钉 `FIVE_PID`（mtask五期 的 uuid）：那条项目一旦被改名/归档，整组 E 会以「行为失守」误红；
  // 且它断言的是「生产库里恰好有 13 页可装配的数据」——属于门不得依赖的业务数据存在性。
  const FIX_NAME = `t02103-门内夹具-${Date.now().toString(36)}`;
  const projRes = await call('POST', '/projects', { name: FIX_NAME, description: 'T02103 验收门自建夹具项目（门内数据，不代表任何真实项目）' });
  const PID = String((projRes.body as { id?: string } | null)?.id ?? '');
  const planTitles = ['夹具计划甲（阻塞）', '夹具计划乙', '夹具计划丙'];
  const planRes = await Promise.all(
    planTitles.map((title, i) =>
      call('POST', '/plans', {
        projectId: PID, title, status: i === 0 ? 'blocked' : 'doing',
        startDate: '2026-01-05', durationDays: 7, assignee: '夹具责任人', kind: 'normal',
      }),
    ),
  );
  RT.seeded = !!PID && planRes.every((r) => r.status === 201 || r.status === 200);
  RT.fixtureName = FIX_NAME;
  if (RT.seeded) okE('E-00c 门内夹具项目与计划已建（阻塞计划 1 条 → 风险枚举必有落点）', true);
  else {
    ok('E-00c 门内夹具项目与计划已建（阻塞计划 1 条 → 风险枚举必有落点）', false, { proj: projRes.status, plans: planRes.map((r) => r.status) });
    skipped('依赖夹具项目的 E 组与 S 组配对项', `夹具项目建不起来（POST /projects → ${projRes.status}）`);
  }

  // 表集合快照（S-13 行为腿）：整条链路跑完不得多出任何表（A-3：日志只进控制台流）
  tables0 = RT.seeded ? listTables() : '';

  const body = (over: Record<string, unknown> = {}) => ({ projectId: PID, toolId: mockId, outline: outline13, ...over });
  const planCount0 = ((await call('GET', `/plans?projectId=${PID}`)).body as unknown[])?.length ?? -1;

  // E-01 快速失败：不建流
  mockMode = 'good';
  const noPid = await sse('/plans/kickoff-ppt-stream', { toolId: mockId, outline: outline13 });
  const noTool = await sse('/plans/kickoff-ppt-stream', { projectId: PID, outline: outline13 });
  const badShape = await sse('/plans/kickoff-ppt-stream', body({ outline: [{ section: '项目风险', bullets: [], dataKeys: ['risks'], layout: 'table' }] }));
  const badProject = await sse('/plans/kickoff-ppt-stream', body({ projectId: 'no-such-project-zz' }));
  RT.fastNoPid = noPid.status; RT.fastNoTool = noTool.status; RT.fastBadShape = badShape.status;
  RT.fastBadShapeCtype = badShape.ctype; RT.fastAsks = mockRequests.length;
  RT.unknownToolStatus = badProject.status; RT.unknownToolCtype = badProject.ctype;
  RT.unknownToolErrorFrames = badProject.events.filter((e) => e.event === 'error').length;
  // 流内 error 帧的负载形态同样从线上判定（S-04 error {error} 的行为腿）
  RT.errorShapeOk = RT.unknownToolErrorFrames >= 1 &&
    badProject.events.filter((e) => e.event === 'error').every((e) => Object.keys(e.data).join() === 'error');
  okE('E-01b 库内不存在的项目 → 头之后才失败（200 + event-stream + error 帧）：与坏形状的 400 是两条路径',
    badProject.status === 200 && badProject.ctype.includes('event-stream') && RT.unknownToolErrorFrames === 1,
    { status: badProject.status, ctype: badProject.ctype, errorFrames: RT.unknownToolErrorFrames });
  // 快速失败探针可能各自落过盘（未知工具那类会降级出稿），先清场再测「零残留」——
  // 否则 E-03e 的空目录判据会被自己的前一个探针污染（实测踩过：残留 1 个令牌）
  readdirSync(TMP_DIR).forEach((f) => rmSync(join(TMP_DIR, f), { force: true }));
  okPair(okE, 'E-01 缺 projectId / 缺 toolId / 大纲坏形状 → 结构化 400 且不是 event-stream（零 mock 请求、零装配）',
    () => noPid.status === 400 && !noPid.ctype.includes('event-stream') && noTool.status === 400 &&
      badShape.status === 400 && mockRequests.length === 0 && !!String(badShape.json?.error ?? ''),
    () => /第 1 页缺标题/.test(String(badShape.json?.error)),
    () => ({ noPid: noPid.status, noTool: noTool.status, badShape: badShape.json, asks: mockRequests.length }));

  // E-02 正常链路：逐页 stage + done
  mockMode = 'good';
  mockRequests.length = 0;
  const good1 = await sse('/plans/kickoff-ppt-stream', body());
  const stages = good1.events.filter((e) => e.event === 'stage');
  const dones = good1.events.filter((e) => e.event === 'done');
  // T02171：大纲 13 页是**下界**——计划超行数的时间线页会展开续页，产物页数由装配层报，
  // 判据改成「stage 页序 / done.pageCount / 解包页数三者同源」，比钉死 13 更严。
  const reportPages = Number(dones[0]?.data?.pageCount ?? 0);
  const pageStages = stages.filter((e) => /页 \d+\/\d+ 已装配：/.test(String(e.data.msg)));
  // 行为腿：帧形态从**线上字节**判定（不是读 send(...) 那句源码）
  RT.pageCount = reportPages;
  RT.stageShapesOk =
    stages.length > 0 && stages.every((e) => Object.keys(e.data).join() === 'msg' && typeof e.data.msg === 'string');
  RT.doneFieldsOk =
    dones.length === 1 && Object.keys(dones[0].data).sort().join() === 'fileName,pageCount,token,warnings' &&
      typeof dones[0].data.token === 'string' && typeof dones[0].data.fileName === 'string' &&
      typeof dones[0].data.pageCount === 'number' && Array.isArray(dones[0].data.warnings);
  RT.stageDenomOk =
    pageStages.length === reportPages && pageStages.every((e, i) => String(e.data.msg).startsWith(`页 ${i + 1}/${reportPages} 已装配：`));
  RT.noDegradeOnGood =
    !((dones[0]?.data?.warnings ?? []) as string[]).some((w) => w.startsWith(S.KICKOFF_WORDING_FALLBACK_MSG));
  okE('E-02a done 事件恰好 1 条且无 error 事件', dones.length === 1 && !good1.events.some((e) => e.event === 'error'),
    good1.events.map((e) => e.event).join(','));
  RT.doneFileName = String(dones[0]?.data?.fileName ?? '');
  okE('E-02b done 负载字段齐（token 是 UUID、名字由入参推导、pageCount ≥ 大纲 13 页、warnings 是数组）',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(dones[0]?.data?.token)) &&
      RT.doneFileName.endsWith('.pptx') && RT.doneFileName.includes(RT.fixtureName) && /20\d{6}/.test(RT.doneFileName) &&
      reportPages >= 13 && Array.isArray(dones[0]?.data?.warnings), dones[0]?.data);
  // 这里的正则是**取材选择器**（从 stage 流里挑出逐页装配那几条），判据本身是条数/页序/分母同源；
  // 「页 n/N 已装配」这句文案作为契约锚点在 S-14 配对（行为腿 = 下面这条同源事实）。
  okE('E-02c 逐页 stage 按页序一条不拆，且分母与 done.pageCount 同源（分页后页码不错位）',
    pageStages.length === reportPages && pageStages.every((e, i) => String(e.data.msg).startsWith(`页 ${i + 1}/${reportPages} 已装配：`)),
    { stages: stages.map((e) => e.data.msg).slice(0, 6), reportPages });
  RT.promptBansOk =
    mockRequests.length === 1 && /严禁新增输入里没有的数字/.test(mockRequests[0].system) &&
      /「」内的计划名/.test(mockRequests[0].system) && /条目数量与顺序必须与输入完全一致/.test(mockRequests[0].system);
  okE('E-02d 措辞段恰好发一次 askJson（一次调用覆盖风险+沟通两段，不逐条烧配额）',
    mockRequests.length === 1 && mockRequests[0].user.length > 200, { asks: mockRequests.length, systemLen: mockRequests[0]?.system?.length });
  const promptSources = [...(mockRequests[0]?.user ?? '').matchAll(/出处：([^\n|]+)/g)].map((m) => m[1].trim()).filter(Boolean);
  RT.promptRiskBlockOk =
    /风险条目（系统按本地规则枚举/.test(mockRequests[0]?.user ?? '') && /出处：plan_tasks\./.test(mockRequests[0]?.user ?? '');
  okE('E-02e 提示词把本地枚举行的「出处」逐条带上（可数：至少一条且每条都非空，出处是库里原文不经模型）',
    promptSources.length >= 1 && promptSources.every((s) => s.length > 3), { 枚举出处: promptSources });

  // E-03 令牌换回真产物（下载即删，命名走 §2.4）
  const token1 = String(dones[0]?.data?.token);
  const fileName1 = String(dones[0]?.data?.fileName);
  const dlRes = await postRaw('/report/ai-download', { token: token1, filename: fileName1 });
  const buf = Buffer.from(await dlRes.arrayBuffer());
  let slides: string[] = [];
  if (buf.length > 1000) {
    writeFileSync(gateArtifactPath(OUT_DIR, 't02103-stream.pptx'), buf);
    const zip = await JSZip.loadAsync(buf);
    slides = await Promise.all(
      Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => Number(/(\d+)\.xml/.exec(a)?.[1]) - Number(/(\d+)\.xml/.exec(b)?.[1]))
        .map((f) => zip.file(f)!.async('string')),
    );
  }
  const allText = slides.join('\n').replace(/<[^>]+>/g, '|');
  RT.dlBytes = buf.length;
  RT.dlMagic = buf.subarray(0, 2).toString() === 'PK';
  RT.tmpEmptyAfterDl = readdirSync(TMP_DIR).length === 0;
  RT.fileNameHasFixture = fileName1.includes(RT.fixtureName);
  // 出处是本地值（模型这条路上根本没有 source 字段）：夹具阻塞计划的 source 原文必须出现在风险页
  // 出处列被 builder 截到 12 字（risksTable 列宽预算），故按「页面应有的形态」比前缀；
  // 本地出处逐条取自提示词枚举值，不写死某条业务数据
  const promptUser0 = mockRequests[0]?.user ?? '';
  const localSources = [...promptUser0.matchAll(/出处：([^\n|]+)/g)].map((m) => m[1].trim());
  RT.sourceLocalMissing = localSources.filter((x) => !allText.includes(x.slice(0, 12)));
  RT.sourceLocalInArtifact = localSources.length > 0 && RT.sourceLocalMissing.length === 0;
  RT.aiWordingInArtifact = allText.includes(AI_MARK_IMPACT) || allText.includes(AI_MARK_MITIGATION);
  okE('E-03a2 下载名取自门内夹具项目名（改名模拟见 X 组，这里先钉「名字确实走这条通道」）',
    RT.fileNameHasFixture, { fileName: fileName1, fixtureName: RT.fixtureName });
  okE('E-03a 令牌经 /report/ai-download 换回 .pptx（A-2 零改动：白名单已含 pptx）',
    dlRes.status === 200 && buf.length > 20_000 && buf.subarray(0, 2).toString() === 'PK', { status: dlRes.status, bytes: buf.length });
  okE('E-03b 产物页数 = done.pageCount（原生页，非贴图；T02171 后含时间线续页）',
    slides.length === Number(dones[0]?.data?.pageCount ?? -1) && slides.length >= 13 && !/id="Picture/.test(allText),
    { slides: slides.length, pageCount: dones[0]?.data?.pageCount });
  okE('E-03c 第 2 段措辞真落到风险页（AI 改的词在页面上，不是只改了内存）',
    allText.includes(AI_MARK_IMPACT) || allText.includes(AI_MARK_MITIGATION), allText.slice(allText.indexOf('风险'), allText.indexOf('风险') + 240));
  okE('E-03d 沟通页 bullets 同样被改写（FR-4.9 协作口径走 AI）', allText.includes(AI_MARK_COMM),
    allText.match(/周会[^\n|]{0,40}/)?.[0]);
  okE('E-03e 下载即删：tmp 目录回到空（不留孤儿令牌文件）', readdirSync(TMP_DIR).length === 0, readdirSync(TMP_DIR));

  // E-04 措辞违约不阻断（验收：任一段失败仍给得出稿子，且如实说明用的是本地条目）
  for (const mode of ['badCount', 'badNum'] as MockMode[]) {
    mockMode = mode;
    mockRequests.length = 0;
    const r = await sse('/plans/kickoff-ppt-stream', body());
    const d = r.events.find((e) => e.event === 'done');
    const warns = (d?.data?.warnings ?? []) as string[];
    if (mode === 'badCount') RT.degradeBadCount =
      !!d && warns.some((w) => w.startsWith(S.KICKOFF_WORDING_FALLBACK_MSG));
    if (mode === 'badNum') RT.degradeBadNum = !!d && warns.some((w) => w.startsWith(S.KICKOFF_WORDING_FALLBACK_MSG));
    okE(`E-04-${mode} 措辞不合约束 → 触发自带重试后整段降级，done 仍成功且 warnings 点名原因`,
      !!d && !r.events.some((e) => e.event === 'error') && mockRequests.length === 2 &&
        warns.some((w) => w.startsWith(S.KICKOFF_WORDING_FALLBACK_MSG)) && /原因：/.test(warns.find((w) => w.startsWith(S.KICKOFF_WORDING_FALLBACK_MSG)) ?? ''),
      { asks: mockRequests.length, warns: warns.slice(0, 3) });
    if (d) {
      const dlt = await postRaw('/report/ai-download', { token: String(d.data.token), filename: String(d.data.fileName) });
      const b2 = Buffer.from(await dlt.arrayBuffer());
      const z2 = await JSZip.loadAsync(b2);
      const t2 = (await Promise.all(Object.keys(z2.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).map((f) => z2.file(f)!.async('string')))).join(' ')
        .replace(/<[^>]+>/g, '|')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      // 逐条比对提示词里枚举的本地原文（库内真值随项目而变，写死断言话术等于猜数据）；
      // 表列宽预算会把单元格截到 22 字（T02099 risksTable 口径），故按「页面应有的形态」比对前缀。
      // 风险与沟通两组都纳入比对：违规注入落在哪组，回落证据就在哪组页面。
      const prompt0 = mockRequests[0]?.user ?? '';
      const localItems = [...prompt0.matchAll(/^\d+\. 风险：(.+)$/gm)].map((m) => m[1].trim());
      const localComms = [...(prompt0.split('【沟通口径')[1] ?? '').matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1].trim());
      const missing = [...localItems, ...localComms].filter((s) => !t2.includes(s.slice(0, 22)));
      okE(`E-04-${mode}-0 提示词确有可注入的本地条目（两组皆空则本组等于空跑，先钉住再说降级）`,
        localItems.length + localComms.length > 0, { risks: localItems.length, comms: localComms.length });
      okE(`E-04-${mode}b 降级页整表回落本地条目（与提示词枚举的库内真值逐条一致，不是空表也不是半路截行）`,
        missing.length === 0, { localCount: localItems.length + localComms.length, missing: missing.slice(0, 2) });
    }
  }

  // E-05 上游 500：askJson 两轮皆败 → 同样只降级
  mockMode = 'boom';
  const boom = await sse('/plans/kickoff-ppt-stream', body());
  RT.degradeBoom = (() => {
    const dd = boom.events.find((e) => e.event === 'done');
    return !!dd && ((dd.data?.warnings ?? []) as string[]).some((w) => w.startsWith(S.KICKOFF_WORDING_FALLBACK_MSG));
  })();
  okE('E-05 模型上游 500 不阻断生成（done 成功 + 降级 warning）',
    !!boom.events.find((e) => e.event === 'done') &&
      ((boom.events.find((e) => e.event === 'done')?.data?.warnings ?? []) as string[]).some((w) => w.startsWith(S.KICKOFF_WORDING_FALLBACK_MSG)),
    boom.events.map((e) => e.event).join(','));

  // E-06 工具未配 model：同步抛错也被措辞段收口（不因模型配置没得稿子）
  mockMode = 'good';
  mockRequests.length = 0;
  const noModel = await sse('/plans/kickoff-ppt-stream', body({ toolId: noModelId }));
  const noModelDone = noModel.events.find((e) => e.event === 'done');
  const noModelWarns = ((noModelDone?.data?.warnings ?? []) as string[]);
  RT.noModelWarnText = noModelWarns.join(' | ');
  RT.degradeNoModel = !!noModelDone && mockRequests.length === 0 && noModelWarns.length > 0;
  okPair(okE, 'E-06 未配 model 的工具 → 仍出稿，warnings 原文透传「所选模型未配置…」且零 mock 请求',
    () => RT.degradeNoModel,
    () => /所选模型未配置/.test(RT.noModelWarnText),
    () => ({ warns: noModelWarns.slice(0, 2), asks: mockRequests.length }));

  // -------------------------------------------------------------------
  // G 组：单源收口 / 共用闸 / 配额自检的**现场行为**（S 组配对项的行为腿来源）
  // -------------------------------------------------------------------
  // G-01 无风险页且无沟通页：整条链路不发措辞调用，但稿子照样出（S-11 行为腿）
  mockMode = 'good';
  mockRequests.length = 0;
  const noWordingOutline = outline13.map((pg) => ({
    ...pg,
    section: pg.section === '项目风险' || pg.section === '沟通管理' ? '项目范围' : pg.section,
    dataKeys: pg.dataKeys.filter((k: string) => k !== 'risks'),
  }));
  const noWd = await sse('/plans/kickoff-ppt-stream', body({ outline: noWordingOutline }));
  RT.noWordingPagesSkipsModel = mockRequests.length === 0;
  RT.noWordingStillDone = !!noWd.events.find((e) => e.event === 'done');
  okE('G-01 大纲不含风险页/沟通页 → 零模型调用且仍出稿（措辞配额只在有落点时才花）',
    RT.noWordingPagesSkipsModel && RT.noWordingStillDone, { asks: mockRequests.length, events: noWd.events.map((e) => e.event).join(',') });

  // G-02 只落一个盘点：生成后不下载，tmp 目录应恰好一个「UUID 令牌」文件（S-01/S-03 行为腿）
  readdirSync(TMP_DIR).forEach((f) => rmSync(join(TMP_DIR, f), { force: true }));
  mockRequests.length = 0;
  const keep = await sse('/plans/kickoff-ppt-stream', body());
  RT.tmpFilesWhenKept = readdirSync(TMP_DIR);
  okE('G-02 生成未下载时 tmp 恰好一个 UUID 名文件（落盘点唯一，且「零残留」判据不是永远绿的空目录）',
    RT.tmpFilesWhenKept.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(RT.tmpFilesWhenKept[0]),
    RT.tmpFilesWhenKept);
  void keep;

  // G-03 周报两条链路都走同一收口点：非流式与流式各自给的令牌都能经同一个 ai-download 换回文件
  const wNon = await call('POST', '/report/ai-generate', { period: 'week', format: 'pptx', toolId: mockId, projectId: PID });
  const wNonToken = String((wNon.body as { token?: string } | null)?.token ?? '');
  const wNonName = String((wNon.body as { filename?: string } | null)?.filename ?? 'MTask-ai-report.pptx');
  const wNonDl = wNonToken ? await postRaw('/report/ai-download', { token: wNonToken, filename: wNonName }) : null;
  const wNonBytes = wNonDl ? (await wNonDl.arrayBuffer()).byteLength : 0;
  RT.weeklyDownloadOk = /^[0-9a-f-]{36}$/i.test(wNonToken) && wNonBytes > 5_000;
  okE('G-03a 周报非流式链路令牌可下载（saveReportBuffer 单源在链路上成立）',
    RT.weeklyDownloadOk, { status: wNon.status, token: wNonToken.slice(0, 8), bytes: wNonBytes });

  mockRequests.length = 0;
  const wStr = await sse('/report/ai-generate-stream', { period: 'week', format: 'pptx', toolId: mockId, projectId: PID });
  const wStrDone = wStr.events.find((e) => e.event === 'done');
  const wStrToken = String((wStrDone as { data?: { token?: string } } | undefined)?.data?.token ?? '');
  const wStrName = String((wStrDone as { data?: { filename?: string } } | undefined)?.data?.filename ?? 'MTask-ai-report.pptx');
  const wStrDl = wStrToken ? await postRaw('/report/ai-download', { token: wStrToken, filename: wStrName }) : null;
  const wStrBytes = wStrDl ? (await wStrDl.arrayBuffer()).byteLength : 0;
  RT.weeklyStreamDownloadOk = /^[0-9a-f-]{36}$/i.test(wStrToken) && wStrBytes > 5_000;
  okE('G-03b 周报流式链路令牌可下载（两条链路同收口，不是各写一套）',
    RT.weeklyStreamDownloadOk, { token: wStrToken.slice(0, 8), bytes: wStrBytes, ctype: wStr.ctype });

  // G-04 共用闸实测：闸上限 2（EXPORT_GATE_LIMIT），3 路 kickoff + 1 路周报同时进来
  //       → 2 路 kickoff 放行、第 3 路与周报都被同一个闸拒（周报被拒正是「共用」的证据）
  readdirSync(TMP_DIR).forEach((f) => rmSync(join(TMP_DIR, f), { force: true }));
  mockMode = 'good';
  mockDelayMs = 2000;
  mockRequests.length = 0;
  const burst = await Promise.all([
    sse('/plans/kickoff-ppt-stream', body()),
    sse('/plans/kickoff-ppt-stream', body()),
    sse('/plans/kickoff-ppt-stream', body()),
    call('POST', '/report/ai-generate', { period: 'week', format: 'pptx', toolId: mockId, projectId: PID }),
  ]);
  mockDelayMs = 0;
  const kick = burst.slice(0, 3) as Array<{ status: number }>;
  const weeklyRes = burst[3] as { status: number; body?: { error?: string } };
  RT.gateAccepted = kick.filter((r) => r.status === 200).length;
  RT.gateRejected = kick.filter((r) => r.status === 429).length;
  RT.weeklyRejected = weeklyRes.status === 429;
  okE('G-04a 并发闸有牙：3 路 kickoff 同时进来 → 恰好 1 路 429（闸被摘掉时这里 0×429）',
    RT.gateAccepted === 2 && RT.gateRejected === 1, { 放行: RT.gateAccepted, 拒绝: RT.gateRejected, 状态: kick.map((r) => r.status) });
  okPair(okE, 'G-04b 与周报共用同一闸：kickoff 占满时周报请求同样被拒 429',
    () => RT.weeklyRejected && weeklyRes.status === 429,
    () => /导出任务过多/.test(String(weeklyRes.body?.error ?? '')),
    () => ({ status: weeklyRes.status, error: weeklyRes.body?.error }));
  readdirSync(TMP_DIR).forEach((f) => rmSync(join(TMP_DIR, f), { force: true }));

  // -------------------------------------------------------------------
  // X 组：改名模拟（判据 3 的另一半——单源改名后通道零残留）
  // -------------------------------------------------------------------
  // 改名用**不含旧名子串**的新名：否则「旧名零残留」会被新名前缀误判，判据自己骗自己
  const RENAMED = `t02103-夹具改名-${Date.now().toString(36)}`;
  const rn = await call('PATCH', `/projects/${PID}`, { name: RENAMED });
  const afterRename = await sse('/plans/kickoff-ppt-stream', body());
  const rnDone = afterRename.events.find((e) => e.event === 'done');
  const rnFileName = String((rnDone as { data?: { fileName?: string } } | undefined)?.data?.fileName ?? '');
  okE('X-01 项目改名后下载名跟着改、旧名零残留（名字不是哪里硬写的第二份）',
    rn.status === 200 && rnFileName.includes(RENAMED) && !rnFileName.includes(RT.fixtureName),
    { status: rn.status, fileName: rnFileName, oldName: RT.fixtureName });

  // E-07 断连无残留（验收 9）：AI 等待期客户端走人
  mkdirSync(TMP_DIR, { recursive: true });
  readdirSync(TMP_DIR).forEach((f) => rmSync(join(TMP_DIR, f), { force: true }));
  mockMode = 'good';
  mockDelayMs = 2500;
  const disc = await sse('/plans/kickoff-ppt-stream', body(), { abortAfterMs: 600 });
  await sleep(3200); // 等模型回来 + 服务端 abort 检查跑完
  mockDelayMs = 0;
  RT.clientAbortNoDone = disc.clientAborted && !disc.events.some((e) => e.event === 'done');
  okE('E-07a 客户端断开被识别（未收到 done/error，连接由客户端主动 abort）',
    disc.clientAborted && !disc.events.some((e) => e.event === 'done'), { events: disc.events.map((e) => e.event).join(','), aborted: disc.clientAborted });
  RT.tmpEmptyAfterAbort = readdirSync(TMP_DIR).length === 0 && !readdirSync(TMP_DIR).some((f) => f.endsWith('.part'));
  okE('E-07b 断连后 tmp 目录零半成品零孤儿令牌（验收 9；只有一个落盘点才守得住这条）',
    readdirSync(TMP_DIR).length === 0 && !readdirSync(TMP_DIR).some((f) => f.endsWith('.part')), readdirSync(TMP_DIR));

  // E-08 装配中途取消同样零残留（页数多 + 无风险页时没有 AI 等待窗口）
  readdirSync(TMP_DIR).forEach((f) => rmSync(join(TMP_DIR, f), { force: true }));
  mockMode = 'good';
  const mid = await sse('/plans/kickoff-ppt-stream', body({ outline: outline13.map((p, i) => (i === 2 ? { ...p, section: '项目范围', dataKeys: ['reqStats'] } : p)) }), { stopAfter: 'stage' });
  await sleep(800);
  RT.midAbortNoDone = mid.clientAborted && !mid.events.some((e) => e.event === 'done');
  okE('E-08 收到首条 stage 即断开：装配被中止且临时目录仍空',
    mid.clientAborted && readdirSync(TMP_DIR).length === 0, { events: mid.events.length, tmp: readdirSync(TMP_DIR) });

  // E-09 零落库：整条链路只读聚合，不写任何业务表（A-3：日志只进控制台流）
  const planCount1 = ((await call('GET', `/plans?projectId=${PID}`)).body as unknown[])?.length ?? -2;
  RT.planCountSame = planCount0 > 0 && planCount1 === planCount0;
  RT.schemaTablesSame = RT.seeded && listTables() === tables0;
  okE('E-09 生成链路不改计划/需求数据（只读聚合；计划条数与开工前一致）',
    planCount0 > 0 && planCount1 === planCount0, { planCount0, planCount1 });
}

// =====================================================================
// S 组配对项发射（行为腿已由 B/G/E 组全部回填）+ N 组负对照
// =====================================================================
lines.push('');
lines.push('== S 组：契约守卫配对项（字面锚点 + 同源行为断言，红因可区分）');
for (const p of S_PAIRS) {
  if (p.needsE && !RT.seeded) {
    skipped(p.label, '门内夹具项目未建成（见 E-00c）——行为腿无从实测');
    continue;
  }
  okPair(ok, p.label, p.behavior, p.literal, p.ctx);
}

// =====================================================================
// N 组：负对照（T02293 判据 4）——每条改法都要证明「行为真坏时判据会红」
// =====================================================================
lines.push('');
lines.push('== N 组：负对照（证明上面的判据有牙，不是恒绿）');
{
  // N-01 事件形态谓词：把负载键换成 text（一种「等价重构」写法）必须判假；
  //      若它恒真，S-04 的行为腿等于没测任何东西。
  const stageShapeOk = (frames: Array<Record<string, unknown>>) =>
    frames.length > 0 && frames.every((d) => Object.keys(d).join() === 'msg');
  ok('N-01 形态判据有牙：真实负载判真、等价改写 {text} 判假，且本轮真实帧确实过了',
    stageShapeOk([{ msg: 'x' }]) && !stageShapeOk([{ text: 'x' }]) && RT.stageShapesOk,
    { 真实帧判定: RT.stageShapesOk });

  ok('N-02 头前 400 与流内 error 是两条可区分的路径（校验全被挪进流里时这条会红）',
    RT.fastBadShape === 400 && !RT.fastBadShapeCtype.includes('event-stream') &&
      RT.unknownToolStatus === 200 && RT.unknownToolCtype.includes('event-stream') && RT.unknownToolErrorFrames >= 1,
    { 坏形状: [RT.fastBadShape, RT.fastBadShapeCtype], 未知工具: [RT.unknownToolStatus, RT.unknownToolCtype, RT.unknownToolErrorFrames] });

  ok('N-03 「零残留」判据的对照面：同一个目录本轮确曾非空（TMP_DIR 指错时 E-03e/E-07b 会恒绿）',
    RT.tmpFilesWhenKept.length === 1 && RT.tmpEmptyAfterDl && RT.tmpEmptyAfterAbort,
    { 未下载时: RT.tmpFilesWhenKept, 下载后空: RT.tmpEmptyAfterDl, 断连后空: RT.tmpEmptyAfterAbort });

  const sameAbortMsg = (m: string) => m === RT.abortMsgFromService;
  ok('N-04 中止消息单源不是同义反复：另一份等价措辞必须判假（否则 S-08 恒绿）',
    sameAbortMsg(RT.bAbortMsg) && sameAbortMsg(RT.bMidAbortMsg) && !sameAbortMsg('装配已取消（另写一份的措辞）'),
    { 单源值: RT.abortMsgFromService });

  ok('N-05 降级判据双向有牙：合规轮不出现降级话术，四种坏轮各自都出现（恒真式判据在这里会红）',
    RT.noDegradeOnGood && RT.degradeBadCount && RT.degradeBadNum && RT.degradeBoom && RT.degradeNoModel,
    { 合规轮: RT.noDegradeOnGood, badCount: RT.degradeBadCount, badNum: RT.degradeBadNum, boom: RT.degradeBoom, 未配模型: RT.degradeNoModel });

  // N-06 让出事件循环判据：同步死循环里外部 timer 插不进来（builder 若去掉 await yieldToLoop()，
  //      B-04 的「取消在装配中途生效」就会失去意义——这里直接复现那个失效形态）
  const runSyncVariant = async () => {
    const ac = new AbortController();
    setImmediate(() => ac.abort()); // 排在 check 阶段：同步循环不交还事件循环就永远看不到它
    let sawAbortMidway = false;
    for (let i = 0; i < 8; i++) {
      if (ac.signal.aborted) sawAbortMidway = true; // 同步循环：这一句永远看不到 aborted
    }
    await Promise.resolve();
    return sawAbortMidway;
  };
  const runYieldVariant = async () => {
    const ac = new AbortController();
    setImmediate(() => ac.abort());
    let sawAbortMidway = false;
    for (let i = 0; i < 8 && !sawAbortMidway; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // 与 builder 的 yieldToLoop 同形
      if (ac.signal.aborted) sawAbortMidway = true;
    }
    return sawAbortMidway;
  };
  const syncSaw = await runSyncVariant();
  const yieldSaw = await runYieldVariant();
  ok('N-06 逐页让出判据有牙：同步变体看不到中止、让出变体看得到（builder 去掉 yieldToLoop 时 B-04 会红在这里）',
    !syncSaw && yieldSaw && RT.bTimerAbortMsg === RT.abortMsgFromService, { 同步变体: syncSaw, 让出变体: yieldSaw });

  // N-07 表集合快照判据有牙：往一份临时库里多建一张表，快照字符串必须变（恒等比较不算判据）
  const scratch = join(DATA_DIR, 'n07-scratch.db');
  const scratchDb = new Sqlite(scratch);
  scratchDb.exec('CREATE TABLE zzz_kickoff_log (id INTEGER)');
  scratchDb.close();
  ok('N-07 表集合快照能识别「多出一张表」：临时库快照与门内库快照不同（链路真建日志表时会红）',
    listTablesAt(scratch) !== tables0 && listTables() === tables0,
    { 临时库: listTablesAt(scratch).slice(0, 60), 门内库含zzz: listTables().includes('zzz') });
  rmSync(scratch, { force: true });

  // N-08 配对器本身的对照面（批⑫ 新加的 6 条腿全靠这套归因，归因错了等于没配对）
  {
    const rec: Array<{ name: string; cond: boolean; extra?: unknown }> = [];
    const fakeOk = (name: string, cond: boolean, extra?: unknown) => { rec.push({ name, cond, extra }); };
    okPair(fakeOk, 'p1', () => false, () => true, () => null);
    okPair(fakeOk, 'p2', () => true, () => false, () => null);
    okPair(fakeOk, 'p3', () => true, () => true, () => null);
    const dump = JSON.stringify(rec);
    ok('N-08 配对器分得清两种红：行为假记「行为失守」、字面假记「字面锚点失配（行为在）」、双真才 PASS（恒真式配对在这里会红）',
      rec.length === 3 && rec[0].cond === false && /行为失守/.test(dump) &&
        rec[1].cond === false && /字面锚点失配/.test(dump) && rec[2].cond === true, dump.slice(0, 300));
  }
  // N-09 名字判据两条腿各有反例：只换前缀是等价重构（行为真/字面假），把项目名整个摘掉才是行为失守
  {
    const nameStruct = (n: string, proj: string, dateCompact: string) => n.endsWith('.pptx') && n.includes(proj) && n.includes(dateCompact);
    ok('N-09 下载名两条腿都有对照面：等价换前缀时行为真而字面假；丢了项目名时行为假（S-16/O-12 不是恒真式）',
      nameStruct('启动会-甲项目-20260105.pptx', '甲项目', '20260105') === true &&
        /^项目启动会-.+-20\d{6}\.pptx$/.test('启动会-甲项目-20260105.pptx') === false &&
        nameStruct('项目启动会--20260105.pptx', '甲项目', '20260105') === false);
  }
}

child.kill();
mock.close();
await new Promise<void>((r) => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows 上句柄可能未释放 */ }
  r();
});
rmSync(TMP_DIR, { recursive: true, force: true });

lines.push('');
const SUMMARY = `PASS=${pass} FAIL=${fail}${skippedList.length ? ` SKIP=${skippedList.length}` : ''}`;
lines.push(SUMMARY);
mkdirSync(OUT_DIR, { recursive: true });
writeGateResults(
  OUT_DIR,
  't02103-gate-results.txt',
  `T02103 SSE 流式生成门（T02293 改判版）：${SUMMARY}\n${lines.join('\n')}${skippedList.length ? '\n\n跳过项：\n' + skippedList.join('\n') + '\n' : ''}`,
{ port: PORT, dataDir: DATA_DIR },
);
console.log(SUMMARY);
process.exit(fail === 0 ? 0 : 1);
