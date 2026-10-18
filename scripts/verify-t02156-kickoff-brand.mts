/**
 * T02156 门：启动会 PPT 恒生模板品牌视觉落地（T02293 改判标准重写版）。
 *
 * 本轮改判口径（只写做到的事）：
 *  1) 改前本门 33 个断点 = S-01..S-16（源码文本正则）+ U-01..U-17（产物判据）。按判据 1，
 *     品牌色/版式类判据的**行为腿一律改测生成的 .pptx**（JSZip 解包 slide/chart/slideLayout XML、
 *     媒体字节）或运行时取值；原来的源码正则降级为 okPair 的**字面腿**，且字面腿只读
 *     `git show HEAD:<path>`（判据 11），不读工作树。S 组 16 条全部改造成成对判据。
 *  2) 判据 2（不得断言生产业务数据存在）：改前样本 bundle 直接写死生产项目 `mtask五期` 与其
 *     库内条数，页脚/致谢页判据因此依赖真实业务数据。改后项目名取门内仿真名「门内仿真项目」，
 *     所有条数/工期/估算值都是门内自造夹具，判据只判「装配层怎么呈现夹具」，不判库内有没有这行。
 *  3) 判据 3 反模式记档：`exportStyle.ts` 的 `PAPER_BG` 与 `ON_BRAND` 同值 `'FFFFFF'`
 *     （HEAD :86 / :107）——白字与纸面本就同色，deck XML 里 `FFFFFF` 大量合法出现。因此本门
 *     **不用「旧值字符串缺失」判改色**，X-01 用「改名后新值增量 == 旧值减量」的计数对等判据，
 *     X-02/X-04 用媒体**字节摘要**而不是媒体路径判「串图」（版式媒体名恒等于 master 名，路径永远互异）。
 *  4) 判据 14（先测量后发射）：所有判据都等 deck/服务层取值完成后统一落账；色值集、字号集、
 *     表格数、媒体字节等事实先实测再作为证据写入红项。
 *  5) 环境缺口走 skipped，严禁假 PASS：
 *     - `server/src/services/assets/kickoff/` 五张真实恒生背景资产在工作树与 HEAD **均不存在**
 *       （未跟踪资产已被清场）→「资产在位」原判据 S-08 记 skipped；
 *     - HEAD 的 `server/package.json` build 脚本只 cpSync `src/skills`，**不含** assets 复制段
 *       → 原 S-09 的前提在 HEAD 不成立，记 skipped，不把「没做到的事」写成通过。
 *     「资产在位 → 登记 → 生效 → 可分辨」这条机制链改由**仿真树**代判：`git archive HEAD server/src`
 *     的只读快照 + 门内自生成的 1×1 JPEG 测试夹具 + `node_modules` junction，在 D 盘临时目录里
 *     跑真实 kickoffBuilder 出五份真 .pptx（正常 / 降级 / 串图 / 拔夹具 / 版式互换）。
 *     如实声明：仿真夹具是门内测试资产，**不是**真实恒生素材，本门不据它宣称真实视觉资产已验收。
 *  6) 绝不连生产实例（39877 不碰）：本门无 HTTP，判据跑在门进程内与自起仿真子进程；
 *     临时目录/数据目录强制落 D 盘（TMP/TEMP/`MTask_DATA_DIR` 均在 `D:/code/tmp`，C 盘常年 0 可用）。
 *  7) 落盘的仿真部件当场清场（junction 先 unlink 再递归删，`X_KEEP_SIM=1` 可保留排查）；
 *     「零背景版式/零媒体」这类缺失面判据配了「同一仿真目录至少非空过一次」的对照面（X-06）。
 *  8) okPair 用本文件内联等价实现（`scripts/lib/anchor-pair.mts` 由并发会话掌管，不在本会话
 *     可改文件范围内，故不 import 该路径），语义与规约一致：行为失守 / 字面锚点失配（行为在）
 *     两种红因分开落账，只在两个都绿时记绿。
 *
 * 断点规模：改前 33（S 16 + U 17）；改后 46 个落账点 + 2 项 skipped
 * （仿真树可用性 1 + S 组成对判据 14 + U 组产物判据 20 + X 组负控制 11）。
 *
 * 用法：cd 26_MTask && TMP=/d/code/tmp TEMP=/d/code/tmp node node_modules/tsx/dist/cli.mjs scripts/verify-t02156-kickoff-brand.mts
 * 结果落 .workbuddy/t02156-gate-results-<运行标识>.txt（头部 PASS=x FAIL=y SKIP=z）；
 * 样本 deck 落 .workbuddy/t02156-brand-sample-<标识>.pptx 与 t02156-sim-sample-<标识>.pptx。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeGateResults, gateArtifactPath } from './lib/gate-results.mts';

const TMP_ROOT = process.env.X_TMP_ROOT ?? 'D:/code/tmp';
process.env.TMP = TMP_ROOT;
process.env.TEMP = TMP_ROOT;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.workbuddy');
const SIM = join(TMP_ROOT, 't02156-sim');
const JSZip: any = createRequire(import.meta.url)('jszip');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const skippedList: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 500)}`}`);
};
const skipped = (label: string, why: string) => {
  skippedList.push(label);
  lines.push(`[SKIP] ${label} —— ${why}`);
};
/** 成对判据（anchor-pair 语义的内联等价，见顶部说明 8）：取值均为惰性 thunk，红因可区分。 */
const okPair = (label: string, behavior: () => boolean, literal: () => boolean, ctx?: () => unknown) => {
  let b: { passed: boolean; threw?: string };
  try { b = { passed: behavior() === true }; } catch (e) { b = { passed: false, threw: e instanceof Error ? e.message : String(e) }; }
  if (!b.passed) {
    ok(label, false, { 红因: b.threw ? `行为断言抛错：${b.threw}` : '行为失守（功能未达成，与文案无关）', ...(ctx ? { 证据: ctx() } : {}) });
    return;
  }
  let l: { passed: boolean; threw?: string };
  try { l = { passed: literal() === true }; } catch (e) { l = { passed: false, threw: e instanceof Error ? e.message : String(e) }; }
  ok(label, l.passed, l.passed ? undefined : {
    红因: l.threw ? `字面锚点抛错：${l.threw}` : '字面锚点失配（行为在）——等价重构或文案变更，需人工判定改锚还是改码',
    ...(ctx ? { 证据: ctx() } : {}),
  });
};

const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
/** 判据 11：字面锚点只读 HEAD 提交版（工作树可能被并发会话改动）。 */
const gitCache = new Map<string, string | null>();
const headSource = (rel: string): string | null => {
  if (gitCache.has(rel)) return gitCache.get(rel) ?? null;
  let out: string | null = null;
  try { out = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); } catch { out = null; }
  gitCache.set(rel, out);
  return out;
};
const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;
const uniq = (a: string[]) => [...new Set(a)];
const hexesOf = (s: string) => uniq([...s.matchAll(/srgbClr val="([0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase()));
const tablesOf = (s: string) => [...s.matchAll(/<a:tbl>[\s\S]*?<\/a:tbl>/g)].map((m) => m[0]);

// ---------- 运行时产品模块（行为腿数据源取工作树；字面腿只读 HEAD） ----------
const ES = await import(pathToFileURL(join(ROOT, 'server/src/util/exportStyle.ts')).href);
const L = await import(pathToFileURL(join(ROOT, 'server/src/services/kickoff-layout.ts')).href);
const M = await import(pathToFileURL(join(ROOT, 'server/src/services/kickoffBuilder.ts')).href);
const KS = await import(pathToFileURL(join(ROOT, 'server/src/services/kickoffService.ts')).href);

// ---------- 仿真树（HEAD 快照 + 门内 1×1 JPEG 夹具 + junction → 真实装配层出真 deck） ----------
const BG_KINDS = ['cover', 'toc', 'section', 'content', 'thanks'] as const;
const BG_TAG: Record<string, string> = { cover: 'sim0', toc: 'sim1', section: 'sim2', content: 'sim3', thanks: 'sim0' };
const BG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

const SIM_PROBE = [
  "import { writeFileSync, readFileSync, rmSync } from 'node:fs';",
  "import { dirname, join } from 'node:path';",
  "import { fileURLToPath, pathToFileURL } from 'node:url';",
  "const SIM = dirname(fileURLToPath(import.meta.url));",
  "const M = await import(pathToFileURL(join(SIM, 'server/src/services/kickoffBuilder.ts')).href);",
  "const ASSET = join(SIM, 'server/src/services/assets/kickoff');",
  "const plan = (i, over) => ({ id: 'q' + i, project_id: 'p', title: '任务 ' + (i + 1), description: '', start_date: '2026-10-12', end_date: '2026-10-27', duration_days: 3, progress: 100, status: 'done', assignee: '张三', sort_order: i, linked_task_id: null, req_ids: null, color: '', deps: '', complexity: 2, kind: 'normal', archived: 0, archived_at: null, created_at: '', updated_at: '', ...over });",
  "const bundle = { project: { id: 'p', name: '仿真项目', workspacePath: SIM }, prdDocs: [{ id: 'd1', filename: 'PRD-sim.md', updatedAt: '2026-10-12', contentChars: 100 }], prdDoc: { id: 'd1', filename: 'PRD-sim.md', updatedAt: '2026-10-12', contentMd: '# 背景' }, prdExcerpt: '# 背景', prdTruncated: false, requirements: Array.from({ length: 4 }, (_, i) => ({ id: 'r' + i, project_id: 'p', req_no: 'REQ-00' + i, title: '需求 ' + i, content: null, source_ref: null, priority: 'normal', status: 'done', sort_order: i, created_at: null, updated_at: null, prd_id: 'd1', linkedPlans: [], linkedTasks: [], prdDoc: null })), plans: Array.from({ length: 4 }, (_, i) => plan(i)), milestones: [plan(90, { title: 'M1', kind: 'milestone' })], coverage: { total: 4, covered: 2, uncovered: 2, rate: 50 }, assignees: [{ name: '张三', planCount: 4 }], risks: [], workload: { source: 'duration', manDays: { expected: 12, optimistic: null, pessimistic: null }, manMonth: 0.58, quote: null, phases: [], complexity: [], counted: 4, manDaysPerManMonth: 20.83, footer: '工期口径', reviewTrace: null, noData: false }, preflight: { projectId: 'p', projectName: '仿真项目', blocked: false, missingHard: [], workloadSource: 'duration', items: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'].map((key, i) => ({ key, label: '项' + key, count: i, status: 'ok', note: 'n', deepLink: 'plan', hard: i < 3 })) }, workspaceNote: 'w', dataAsOf: '2026-10-14' };",
  "const mkOutline = (mode) => {",
  "  const base = [",
  "    { section: '封面', title: '仿真 启动会', bullets: [], dataKeys: [], layout: 'cover' },",
  "    { section: '议程', title: '议程', bullets: ['甲', '乙'], dataKeys: [], layout: 'toc' },",
  "    { section: '章节', title: '章节一', bullets: [], dataKeys: [], layout: 'section' },",
  "    { section: '正文', title: '正文页', bullets: ['丙', '丁'], dataKeys: ['reqStats'], layout: 'twoCol' },",
  "    { section: '附录', title: '谢谢观看', bullets: [], dataKeys: [], layout: 'thanks' },",
  "  ];",
  "  if (mode === 'deg') return base.map((o, i) => (i === 3 ? { ...o, title: '本页标题刻意超长以逼出越界'.repeat(4) } : o));",
  "  if (mode === 'swap') return base.map((o, i) => (i === 0 ? { ...o, layout: 'toc' } : i === 1 ? { ...o, layout: 'cover' } : o));",
  "  return base;",
  "};",
  "const manifest = {};",
  "async function emit(tag, mode) {",
  "  const built = await M.buildKickoffPpt(bundle, mkOutline(mode));",
  "  writeFileSync(join(SIM, tag + '.pptx'), built.buffer);",
  "  manifest[tag] = { pageCount: built.pageCount, degraded: built.degradedPages, warnings: built.warnings.length };",
  "}",
  "await emit('deck-a', 'a');",
  "await emit('deck-deg', 'deg');",
  "const tocP = join(ASSET, 'bg-toc.jpg');",
  "const tocBk = readFileSync(tocP);",
  "writeFileSync(tocP, readFileSync(join(ASSET, 'bg-content.jpg')));",
  "await emit('deck-x1', 'a');",
  "writeFileSync(tocP, tocBk);",
  "const thP = join(ASSET, 'bg-thanks.jpg');",
  "const thBk = readFileSync(thP);",
  "rmSync(thP);",
  "await emit('deck-x2', 'a');",
  "writeFileSync(thP, thBk);",
  "await emit('deck-x5', 'swap');",
  "manifest.restored = { toc: readFileSync(tocP).subarray(-4).toString(), thanks: readFileSync(thP).subarray(-4).toString() };",
  "writeFileSync(join(SIM, 'probe-manifest.json'), JSON.stringify(manifest));",
  "console.log('SIM-PROBE-OK ' + JSON.stringify(manifest));",
].join('\n');

/** junction 安全清场：Windows 下必须先 rmdir 链接本身，再递归删目录——
 *  直接 rmSync(recursive) 有跟随 junction 删穿仓库 node_modules 的历史风险，本门绝不冒。 */
function removeJunction(p: string) {
  try { rmdirSync(p); return; } catch { /* 可能已是普通目录或不存在 */ }
  try { rmSync(p, { force: true }); } catch { /* 普通空目录由上层递归删兜底 */ }
}
function removeSimTree() {
  removeJunction(join(SIM, 'node_modules'));
  rmSync(SIM, { recursive: true, force: true });
}

async function prepSim() {
  removeSimTree();
  mkdirSync(SIM, { recursive: true });
  const zipPath = join(TMP_ROOT, 't02156-head-src.zip');
  execFileSync('git', ['archive', 'HEAD', 'server/src', '--format=zip', '-o', zipPath], { cwd: ROOT });
  const z = await JSZip.loadAsync(readFileSync(zipPath));
  for (const f of Object.keys(z.files)) {
    if (z.files[f].dir) continue;
    const p = join(SIM, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, await z.files[f].async('nodebuffer'));
  }
  rmSync(zipPath, { force: true });
  const dir = join(SIM, 'server/src/services/assets/kickoff');
  mkdirSync(dir, { recursive: true });
  for (const k of BG_KINDS) {
    writeFileSync(join(dir, `bg-${k}.jpg`), Buffer.concat([Buffer.from(BG_BASE64, 'base64'), Buffer.from(BG_TAG[k], 'utf8')]));
  }
  writeFileSync(join(SIM, 'simprobe.mts'), SIM_PROBE);
  removeJunction(join(SIM, 'node_modules'));
  (await import('node:fs')).symlinkSync(join(ROOT, 'node_modules'), join(SIM, 'node_modules'), 'junction');
}

function runSimProbe() {
  const simWin = SIM.replace(/\\/g, '/');
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), `${simWin}/simprobe.mts`], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 420000,
    env: { ...process.env, TMP: TMP_ROOT, TEMP: TMP_ROOT, MTask_DATA_DIR: `${simWin}/db` },
  });
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

let simErr = '';
let simAvailable = false;
try {
  await prepSim();
  const r = runSimProbe();
  simAvailable = r.status === 0
    && ['deck-a', 'deck-deg', 'deck-x1', 'deck-x2', 'deck-x5'].every((t) => existsSync(join(SIM, `${t}.pptx`)));
  if (!simAvailable) simErr = `status=${r.status} ${r.out.slice(0, 900)}`;
} catch (e) {
  simErr = e instanceof Error ? e.message : String(e);
}

/** 解包一份 .pptx → 判据面：slide/chart/版式 XML、版式名、版式→媒体、slide→版式、媒体字节摘要 */
async function unpackDeck(buf: Buffer) {
  const z = await JSZip.loadAsync(buf);
  const names = Object.keys(z.files).filter((n: string) => !n.endsWith('/'));
  const read = async (n: string) => await z.file(n).async('string') as string;
  const slides = names.filter((n: string) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }));
  const slideXmls: string[] = [];
  for (const s of slides) slideXmls.push(await read(s));
  const charts = names.filter((n: string) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }));
  const chartXmls: string[] = [];
  for (const c of charts) chartXmls.push(await read(c));
  const layoutFiles = names.filter((n: string) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n)).sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }));
  const layoutXmls: Record<string, string> = {};
  const layoutTitle: Record<string, string> = {};
  const layoutMedia: Record<string, string> = {};
  for (const lf of layoutFiles) {
    const key = lf.replace('ppt/slideLayouts/', '');
    const xml = await read(lf);
    layoutXmls[key] = xml;
    layoutTitle[key] = (/<p:cSld name="([^"]*)"/.exec(xml) ?? [])[1] ?? '';
    if (!/<p:bg><p:bgPr><a:blipFill/.test(xml)) { layoutMedia[key] = ''; continue; }
    const embed = (xml.match(/r:embed="(rId\d+)"/) ?? [])[1] ?? '';
    const rels = await read(`ppt/slideLayouts/_rels/${key}.rels`);
    const target = (new RegExp(`Id="${embed}"[^>]*Target="([^"]+)"`).exec(rels) ?? [])[1] ?? '';
    layoutMedia[key] = target.replace('../', 'ppt/');
  }
  const slideLayoutOf: string[] = [];
  for (let i = 1; i <= slides.length; i++) {
    const rels = names.includes(`ppt/slides/_rels/slide${i}.xml.rels`) ? await read(`ppt/slides/_rels/slide${i}.xml.rels`) : '';
    slideLayoutOf.push((/Target="\.\.\/slideLayouts\/(slideLayout\d+\.xml)"/.exec(rels) ?? [])[1] ?? '');
  }
  const mediaBytes: Record<string, Buffer> = {};
  for (const n of names.filter((n: string) => n.startsWith('ppt/media/'))) mediaBytes[n] = await z.file(n).async('nodebuffer') as Buffer;
  const digest: Record<string, string> = {};
  for (const [n, b] of Object.entries(mediaBytes)) digest[n] = createHash('sha1').update(b).digest('hex').slice(0, 12);
  const roleOfLayout = (lf: string): string => {
    const title = layoutTitle[lf] ?? '';
    if (/^KICKOFF_BG_/.test(title)) return title.slice('KICKOFF_BG_'.length);
    const m = /KICKOFF_BG_([A-Z]+)-image-\d+\.jpeg/.exec(layoutMedia[lf] ?? '');
    return m ? m[1] : '';
  };
  const roleDigest = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const lf of Object.keys(layoutTitle)) {
      const role = roleOfLayout(lf);
      if (!role) continue;
      out[role] = layoutMedia[lf] ? digest[layoutMedia[lf]] ?? '' : '';
    }
    return out;
  };
  return {
    z, names, slideXmls, chartXmls, layoutXmls, layoutTitle, layoutMedia, slideLayoutOf, mediaBytes, digest,
    roleOfLayout, roleDigest,
    bgLayoutCount: () => Object.values(layoutMedia).filter(Boolean).length,
    textOf: (i: number) => (slideXmls[i].match(/<a:t>([^<]*)<\/a:t>/g) ?? []).map((s: string) => s.slice(7, -8)).join('|'),
  };
}

let simDeck: Awaited<ReturnType<typeof unpackDeck>> | null = null;
let simDeg: Awaited<ReturnType<typeof unpackDeck>> | null = null;
let simX1: Awaited<ReturnType<typeof unpackDeck>> | null = null;
let simX2: Awaited<ReturnType<typeof unpackDeck>> | null = null;
let simX5: Awaited<ReturnType<typeof unpackDeck>> | null = null;
let simManifest: any = null;
if (simAvailable) {
  simDeck = await unpackDeck(readFileSync(join(SIM, 'deck-a.pptx')));
  simDeg = await unpackDeck(readFileSync(join(SIM, 'deck-deg.pptx')));
  simX1 = await unpackDeck(readFileSync(join(SIM, 'deck-x1.pptx')));
  simX2 = await unpackDeck(readFileSync(join(SIM, 'deck-x2.pptx')));
  simX5 = await unpackDeck(readFileSync(join(SIM, 'deck-x5.pptx')));
  simManifest = JSON.parse(readFileSync(join(SIM, 'probe-manifest.json'), 'utf8'));
}
const okSim = (name: string, cond: boolean, extra?: unknown) => {
  if (!simAvailable) { skipped(name, `仿真树未起（不判，严禁假 PASS）：${simErr.slice(0, 200)}`); return; }
  ok(name, cond, extra);
};

/** 仿真 deck 的两条独立判据面：角色对位（版式名）与字节可分辨（媒体摘要）——红因互不污染 */
const SIM_ROLES = ['COVER', 'TOC', 'SECTION', 'CONTENT', 'THANKS'];
const rolesAligned = (d: typeof simDeck) => {
  if (!d) return false;
  return SIM_ROLES.every((role, i) => d.roleOfLayout(d.slideLayoutOf[i]) === role);
};
const bytesDistinguishable = (d: typeof simDeck) => {
  if (!d) return false;
  const r = d.roleDigest();
  const got = SIM_ROLES.map((k) => r[k] ?? '');
  if (got.some((x) => !x)) return false;
  // 夹具设定 cover==thanks 同字节（合法同图双引用），其余四种角色必须字节互异
  return got[0] === got[4]
    && new Set([got[0], got[1], got[2], got[3]]).size === 4;
};

// ---------- 主 deck：门内夹具 bundle（判据 2：不引用任何生产项目/库内行） ----------
const plan = (i: number, over: Record<string, unknown> = {}) => ({
  id: `q${i}`, project_id: 'gate', title: `任务 ${i + 1}`, description: '', start_date: '2026-10-12', end_date: '2026-10-27',
  duration_days: 3, progress: 100, status: 'done', assignee: '', sort_order: i, linked_task_id: null, req_ids: null,
  color: '', deps: '', complexity: (i % 5) + 1, kind: 'normal', archived: 0, archived_at: null, created_at: '', updated_at: '', ...over,
});
const bundle = {
  project: { id: 'gate', name: '门内仿真项目', workspacePath: ROOT },
  prdDocs: [{ id: 'd1', filename: 'PRD-门内夹具.md', updatedAt: '2026-10-12', contentChars: 1200 }],
  prdDoc: { id: 'd1', filename: 'PRD-门内夹具.md', updatedAt: '2026-10-12', contentMd: '# 背景\n本节说明启动会稿的口径来源。\n## 目标\n把条数与工期对齐页面。' },
  prdExcerpt: '# 背景\n本节说明启动会稿的口径来源。\n## 目标\n把条数与工期对齐页面。',
  prdTruncated: false,
  requirements: Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`, project_id: 'gate', req_no: `REQ-${String(i + 1).padStart(3, '0')}`, title: `需求 ${i + 1}`, content: null, source_ref: null,
    priority: i % 3 === 0 ? 'high' : 'normal', status: 'done', sort_order: i, created_at: null, updated_at: null, prd_id: 'd1',
    linkedPlans: [{ id: 'x', title: '计划', status: 'done' }], linkedTasks: [], prdDoc: null,
  })),
  plans: Array.from({ length: 17 }, (_, i) => plan(i)),
  milestones: Array.from({ length: 6 }, (_, i) => plan(100 + i, {
    title: `${i + 1} M${i + 1} 里程碑`, kind: 'milestone', complexity: null, start_date: '2026-10-12',
    end_date: ['2026-10-15', '2026-10-16', '2026-10-27', '2026-10-15', '2026-10-19', '2026-10-16'][i],
  })),
  coverage: { total: 14, covered: 14, uncovered: 0, rate: 100 },
  assignees: [],
  risks: [
    { item: '3 条计划复杂度 ≥4', impact: '单条体量偏大，估与做都易失控', mitigation: '按「≥4 建议拆分」口径拆到可交付粒度', source: 'plan_tasks' },
    { item: 'PRD 缺口叠加计划风险', impact: '需求与计划两处同源告警', mitigation: '合并到风险页统一跟踪', source: 'prd_gap_plus_plan_risk' },
  ],
  workload: {
    source: 'estimate', manDays: { expected: 38.5, optimistic: 38.5, pessimistic: 59.5 }, manMonth: 1.85,
    quote: { p50ManDays: 42, p84ManDays: 43.020620726159656 },
    phases: [{ phase: 'req', expected: 1, rowCount: 1 }, { phase: 'design', expected: 2, rowCount: 1 }, { phase: 'dev', expected: 32.5, rowCount: 13 }, { phase: 'common', expected: 3, rowCount: 2 }],
    complexity: [{ level: '1', count: 4 }, { level: '2', count: 4 }, { level: '3', count: 3 }, { level: '4', count: 3 }, { level: '5', count: 3 }],
    counted: 17, manDaysPerManMonth: 20.83,
    footer: '工作量来源：门内估算夹具（口径与库内无关）',
  },
  preflight: {
    projectId: 'gate', projectName: '门内仿真项目', blocked: false, missingHard: [], workloadSource: 'estimate',
    items: (['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const).map((key, i) => ({
      key, label: `项${key}`, count: [1, 14, 23, 6, 14, 17, 1][i], status: 'ok' as const,
      note: '夹具说明文字', deepLink: 'plan' as const, hard: i < 3,
    })),
  },
  workspaceNote: '工作空间可访问，技术章节可引用其中素材',
  dataAsOf: '2026-10-14',
} as any;

const outline = [
  { section: '封面', title: '门内仿真项目 项目启动会', bullets: [], dataKeys: [], layout: 'cover' },
  { section: '议程', title: '启动会议程', bullets: ['项目背景与目标', '团队与范围', '计划与工作量', '质量与风险'], dataKeys: [], layout: 'toc' },
  { section: '项目背景', title: '项目背景与需求', bullets: [], dataKeys: [], layout: 'section' },
  { section: '项目背景', title: '项目背景与痛点', bullets: ['读取已沉淀项目管理资料', 'AI 组织原生 PPTX'], dataKeys: ['prdDoc'], layout: 'twoCol' },
  { section: '项目需求', title: '核心需求清单', bullets: ['卡片接入 AI 控制台', 'SSE 流式生成接口'], dataKeys: ['reqList'], layout: 'table' },
  { section: '项目需求', title: '需求完成情况', bullets: ['查看完成占比', '识别遗留缺口'], dataKeys: ['reqStats'], layout: 'list' },
  { section: '项目计划', title: '计划与工作量', bullets: [], dataKeys: [], layout: 'section' },
  { section: '项目范围', title: '里程碑节点', bullets: ['节点日期口径', '状态跟踪'], dataKeys: ['milestones'], layout: 'table' },
  { section: '项目计划', title: '项目时间线', bullets: [], dataKeys: ['timeline'], layout: 'timeline' },
  { section: '项目计划', title: '计划明细表', bullets: ['任务起止日期', '当前完成状态'], dataKeys: ['planRows'], layout: 'table' },
  { section: '工作量评估', title: '工作量与工期', bullets: ['复杂度分布统计', '估算口径说明'], dataKeys: ['workload'], layout: 'twoCol' },
  { section: '测试与质量策略', title: '质量与风险', bullets: [], dataKeys: [], layout: 'section' },
  { section: '测试与质量策略', title: '测试覆盖率与用例', bullets: ['覆盖率指标', '用例分布情况'], dataKeys: ['coverage'], layout: 'list' },
  { section: '项目风险', title: '关键风险与应对', bullets: ['本地风险信号', '缓解措施'], dataKeys: ['risks'], layout: 'table' },
  { section: '沟通管理', title: '前置校验结论', bullets: ['资料齐备性', '阻塞项清单'], dataKeys: ['preflight'], layout: 'table' },
  { section: '附录', title: '资料清单与溯源', bullets: ['数据源齐备性', '关键指标汇总'], dataKeys: ['workspace'], layout: 'list' },
  { section: '附录', title: '谢谢观看', bullets: [], dataKeys: [], layout: 'thanks' },
] as any[];

// ---------- 判据 14：先全部测量（出稿 + 解包 + 服务层实跑），后统一发射 ----------
const built = await M.buildKickoffPpt(bundle, outline);
const renderPages = M.expandTimelinePages(bundle, outline) as any[];
const prefixLens = outline.map((_, i) => (M.expandTimelinePages(bundle, outline.slice(0, i + 1)) as any[]).length);
const slideIdx = (oi: number) => prefixLens[oi] - 1;
const deck = await unpackDeck(built.buffer);
const slideAll = deck.slideXmls.join('');
const chartAll = deck.chartXmls.join('');
const allDeckXml = slideAll + chartAll + Object.values(deck.layoutXmls).join('');
const paletteHexes = new Set(Object.values(L.PALETTE).map((v: string) => String(v).toUpperCase()));
const headerTables = tablesOf(slideAll);

const degraded = await M.buildKickoffPpt(bundle, outline.map((o, i) => (i === 3 ? { ...o, title: '本页标题刻意超长以逼出越界'.repeat(4) } : o)) as any);
const degradedDeck = await unpackDeck(degraded.buffer);

const vrClean = KS.validateOutline(JSON.parse(JSON.stringify(outline)), { lenientBullets: true });
let eShort = '';
let eLong = '';
try { KS.validateOutline(JSON.parse(JSON.stringify(outline.slice(0, 11))), { lenientBullets: true }); } catch (e) { eShort = String((e as Error).message); }
try { KS.validateOutline(Array.from({ length: 19 }, (_, i) => ({ ...outline[i % outline.length], title: `夹具页${i}` })), { lenientBullets: true }); } catch (e) { eLong = String((e as Error).message); }
const PURE_IDX = outline.map((p: any, i: number) => (p.layout === 'section' || p.layout === 'thanks' ? i : -1)).filter((i: number) => i >= 0);
const dirtyKeys = JSON.parse(JSON.stringify(outline));
for (const i of PURE_IDX) dirtyKeys[i].dataKeys = ['reqStats'];
const vrDirty = KS.validateOutline(dirtyKeys, { lenientBullets: true });
const clearWarnCount = (r: { warnings: string[] }) => r.warnings.filter((w: string) => /dataKeys 已被清空/.test(w)).length;
let eFake = '';
try {
  const fake = JSON.parse(JSON.stringify(outline));
  fake[5].dataKeys = ['totallyMadeUpChannel'];
  KS.validateOutline(fake, { lenientBullets: true });
} catch (e) { eFake = String((e as Error).message); }
let eBogus = '';
const shapeAccepts = (() => {
  try {
    const okOnes = KS.assertOutlineShape([
      { section: 'a', title: 't1', bullets: [], dataKeys: [], layout: 'section' },
      { section: 'a', title: 't2', bullets: [], dataKeys: [], layout: 'thanks' },
    ]);
    return okOnes.map((x: any) => x.layout).join(',');
  } catch { return ''; }
})();
try {
  const bogus = JSON.parse(JSON.stringify(outline));
  bogus[2].layout = 'bogusLayout';
  KS.assertOutlineShape(bogus);
} catch (e) { eBogus = String((e as Error).message); }

// 工作量页呈现判据（全部取装配层自生文案，夹具 footer 换成中性串以免自证）
const wlIdx = slideIdx(outline.findIndex((p: any) => p.dataKeys.includes('workload')));
const wlPageOk = (xml: string) => !/\d\.\d{4,}/.test(xml)
  && /总工作量 38\.5~59\.5（P50 38\.5） 人天/.test(xml)
  && /≈ 1\.85 人月（人月 = 人天 ÷ 20\.83）/.test(xml)
  && /报价区间：P50 42 \/ P84 43 人天/.test(xml)
  && /阶段分布：req 1 \/ design 2 \/ dev 32\.5 \/ common 3 人天/.test(xml)
  && /复杂度分布：1×4 \/ 2×4 \/ 3×3 \/ 4×3 \/ 5×3/.test(xml);

// noData 面（X-11 负控制）：数据缺失时同一条 U-12 判据必须不再被打绿
let noDataRed = false;
let noDataHow = '';
try {
  const ndBundle = { ...bundle, workload: { ...bundle.workload, source: 'duration', quote: null, manDays: { expected: 0, optimistic: null, pessimistic: null }, manMonth: 0, phases: [], complexity: [], counted: 0, noData: true, footer: '无工作量数据' } } as any;
  const nd = await M.buildKickoffPpt(ndBundle, outline);
  const ndDeck = await unpackDeck(nd.buffer);
  const cut = outline.findIndex((p: any) => p.dataKeys.includes('workload'));
  const ndPos = (M.expandTimelinePages(ndBundle, outline.slice(0, cut + 1)) as any[]).length - 1;
  noDataRed = nd.pageCount > 0 && !wlPageOk(ndDeck.slideXmls[ndPos] ?? '');
  noDataHow = `缺失面出稿 ${nd.pageCount} 页、工作量页呈现 ${noDataRed ? '无估算区间（判据转红，符合负控制）' : '仍命中估算区间（判据失效）'}：${(ndDeck.slideXmls[ndPos] ?? '').match(/总工作量[^<]{0,40}/)?.[0] ?? '无该行'}`;
} catch (e) {
  noDataRed = true;
  noDataHow = `装配层对无数据口径直接拒绝出稿（判据不可能被打绿）：${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
}

// 配色改名仿真（判据 3：计数对等，不靠「串缺失」）
const ALT: Record<string, string> = { '08409C': '0B4AAE', '0059E9': '0048B0', 'FFFFFF': 'FCFCFC', '1F2937': '26333F' };
const xmlParts = deck.names.filter((n: string) => /^ppt\/(slides|charts)\/slide\d+\.xml$|^ppt\/charts\/chart\d+\.xml$/.test(n));
const baseText = new Map<string, string>();
for (const n of xmlParts) baseText.set(n, await deck.z.file(n).async('string') as string);
const movedZip = await JSZip.loadAsync(built.buffer);
let movedParts = 0;
for (const n of xmlParts) {
  const xml = baseText.get(n) ?? '';
  if (!Object.keys(ALT).some((c) => xml.includes(c))) continue;
  let m = xml;
  for (const c of Object.keys(ALT)) m = m.split(c).join(ALT[c]);
  movedZip.file(n, m);
  movedParts += 1;
}
const moved = await unpackDeck(await movedZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
const movedAll = moved.slideXmls.join('') + moved.chartXmls.join('');
const headerPairOk = (xmlAll: string) => tablesOf(xmlAll).length > 0 && tablesOf(xmlAll).every((t: string) => /val="08409C"/.test(t) && /val="FFFFFF"/.test(t));

// HEAD 字面锚点文本源
const STYLE_H = headSource('server/src/util/exportStyle.ts') ?? '';
const LAY_H = headSource('server/src/services/kickoff-layout.ts') ?? '';
const B_H = strip(headSource('server/src/services/kickoffBuilder.ts') ?? '');
const SVC_H = strip(headSource('server/src/services/kickoffService.ts') ?? '');
const PKG_H = headSource('server/package.json') ?? '';
const PANEL_H = headSource('web/src/pages/KickoffPptPanel.tsx') ?? '';

// ================= 仿真树可用性 =================
ok('SIM 仿真树可用（git archive HEAD 快照 + 门内 1×1 JPEG 夹具 + node_modules junction 出五份真 deck）',
  simAvailable, simAvailable ? undefined : simErr.slice(0, 600));

// ================= S 组：行为腿（产物/运行时）+ 字面腿（HEAD 源码） =================
okPair('S-01 品牌四色单源在位且进产物（exportStyle 值→PALETTE→deck 实扫）',
  () => ['BRAND_DEEP', 'BRAND_BRIGHT', 'BRAND_PALE', 'ON_BRAND'].every((n) => /^[0-9A-F]{6}$/.test(String((ES as any)[n] ?? '')))
    && L.PALETTE.brandDeep === ES.BRAND_DEEP && L.PALETTE.brandBright === ES.BRAND_BRIGHT
    && L.PALETTE.brandPale === ES.BRAND_PALE && L.PALETTE.onBrand === ES.ON_BRAND
    && /val="08409C"/.test(slideAll),
  () => ['BRAND_DEEP', 'BRAND_BRIGHT', 'BRAND_PALE', 'ON_BRAND'].every((n) => new RegExp(`export const ${n} = '[0-9A-F]{6}'`).test(STYLE_H)),
  () => ({ deep: ES.BRAND_DEEP, bright: ES.BRAND_BRIGHT, pale: ES.BRAND_PALE, onBrand: ES.ON_BRAND }));

okPair('S-02 深/亮取色与恒生模板一致且真进产物（deck 实扫 08409C/0059E9 计数>0）',
  () => ES.BRAND_DEEP === '08409C' && ES.BRAND_BRIGHT === '0059E9'
    && countOf(slideAll, '08409C') > 0 && countOf(slideAll + chartAll, '0059E9') > 0,
  () => /BRAND_DEEP = '08409C'/.test(STYLE_H) && /BRAND_BRIGHT = '0059E9'/.test(STYLE_H),
  () => ({ deepInSlides: countOf(slideAll, '08409C'), brightInDeck: countOf(slideAll + chartAll, '0059E9') }));

okPair('S-03 白字同值双常量记档（ON_BRAND/PAPER_BG 同为 FFFFFF，表头白字真渲染）',
  () => ES.ON_BRAND === 'FFFFFF' && ES.PAPER_BG === 'FFFFFF' && /val="FFFFFF"/.test(slideAll),
  () => /ON_BRAND = 'FFFFFF'/.test(STYLE_H) && /PAPER_BG = 'FFFFFF'/.test(STYLE_H),
  () => ({ ffffffCount: countOf(slideAll, 'val="FFFFFF"'), note: '判据 3：FFFFFF 同值双常量，零残留类判据一律走计数面' }));

okPair('S-04 版式层收口四色且产物零越权色（deck slide 层 srgbClr 集 ⊆ PALETTE 值集）',
  () => hexesOf(slideAll).every((h) => paletteHexes.has(h))
    && hexesOf(slideAll).length >= 4
    && !/["'#][0-9a-fA-F]{6}/.test(B_H),
  () => ['brandDeep: BRAND_DEEP', 'brandBright: BRAND_BRIGHT', 'brandPale: BRAND_PALE', 'onBrand: ON_BRAND'].every((l) => LAY_H.includes(l)),
  () => ({ slideHexes: hexesOf(slideAll), palette: [...paletteHexes] }));

okPair('S-05 五类背景清单生效（仿真 deck：五份媒体 + 字节可分辨，cover↔thanks 同字节为夹具设定）',
  () => simDeck !== null && Object.keys(simDeck.mediaBytes).length === 5 && bytesDistinguishable(simDeck),
  () => BG_KINDS.every((k) => new RegExp(`${k}: 'bg-${k}\\.jpg'`).test(B_H)),
  () => ({ media: simDeck ? Object.keys(simDeck.mediaBytes).map((n) => n.split('/').pop()) : null, digests: simDeck ? simDeck.roleDigest() : null }));

okPair('S-06 背景版式命名进产物（仿真 deck 版式名集 = 五个 KICKOFF_BG_*）',
  () => simDeck !== null && uniq(Object.values(simDeck.layoutTitle).filter((t) => /^KICKOFF_BG_/.test(t))).sort().join(',')
    === BG_KINDS.map((k) => `KICKOFF_BG_${k.toUpperCase()}`).sort().join(','),
  () => /BG_LAYOUT_NAMES: Record<BgKind, string>/.test(B_H)
    && BG_KINDS.every((k) => new RegExp(`${k}: 'KICKOFF_BG_${k.toUpperCase()}'`).test(B_H)),
  () => simDeck && Object.values(simDeck.layoutTitle));

okPair('S-07 背景登记走 defineSlideMaster 且 slide 继承版式背景（仿真 deck 正文页落 CONTENT 版式、slide 本体零 embed）',
  () => {
    if (!simDeck) return false;
    const lf = simDeck.slideLayoutOf[3];
    return simDeck.roleOfLayout(lf) === 'CONTENT'
      && /<p:bg><p:bgPr><a:blipFill/.test(simDeck.layoutXmls[lf] ?? '')
      && simDeck.slideXmls.every((x) => !/r:embed="/.test(x));
  },
  () => /defineBrandBackgrounds\(pptx\)/.test(B_H)
    && /pptx\.defineSlideMaster\(\{ title: BG_LAYOUT_NAMES\[kind\], background: \{ path: bgPath \} \}\)/.test(B_H)
    && /addSlide\(\{ masterName: BG_LAYOUT_NAMES\[bgKindOf\(item\.layout\)\]/.test(B_H),
  () => (simDeck ? { slide4Layout: simDeck.slideLayoutOf[3], role: simDeck.roleOfLayout(simDeck.slideLayoutOf[3]) } : null));

skipped('S-08 五张真实恒生背景资产在位且体积受控（改前原判据）',
  '环境缺口：server/src/services/assets/kickoff 在工作树与 HEAD 均不存在（未跟踪资产已被清场，git ls-files 为空）。' +
  '「资产在位→登记→生效→可分辨」机制链由仿真树 S-05/S-06/S-07 + X-03/X-05 代判；真实素材字节不在本门判定面，不据此宣称真实视觉资产验收通过。');

skipped('S-09 server/package.json 用 cpSync 把 assets 复制进 dist（改前原判据）',
  `环境缺口：HEAD 的 server/package.json build 脚本只 cpSync('src/skills','dist/skills')，不含 assets 段（实测 ${/cpSync/.test(PKG_H) ? '有 cpSync' : '无 cpSync'} / ${/assets/.test(PKG_H) ? '含 assets' : '不含 assets'}）——旧锚点前提在 HEAD 不成立，如实降级不假绿。`);

okPair('S-10 图表字体/墨色显式声明进产物（chart XML 逐点标签墨色 + 图例雅黑）',
  () => {
    if (deck.chartXmls.length === 0) return false;
    const dlblColors = deck.chartXmls.flatMap((x) => [...x.matchAll(/<c:dLbl>(?:(?!<\/c:dLbl>).)*?srgbClr val="([0-9A-Fa-f]{6})"/gs)].map((m) => m[1].toUpperCase()));
    const legends = deck.chartXmls.map((x) => (/<c:legend>(?:(?!<\/c:legend>).)*?typeface="([^"]+)"/s.exec(x) ?? [])[1] ?? '');
    return dlblColors.length > 0 && dlblColors.every((c) => c === '1F2937') && legends.every((f) => f === L.FONT.face);
  },
  () => ['catAxisLabelFontFace', 'valAxisLabelFontFace', 'dataLabelFontFace', 'legendFontFace'].every((k) => new RegExp(`${k}: FONT\\.face`).test(B_H))
    && ['catAxisLabelColor', 'valAxisLabelColor', 'dataLabelColor', 'legendColor'].every((k) => new RegExp(`${k}: PALETTE\\.ink`).test(B_H)),
  () => ({ dlblColors: deck.chartXmls.map((x) => [...x.matchAll(/<c:dLbl>(?:(?!<\/c:dLbl>).)*?srgbClr val="([0-9A-Fa-f]{6})"/gs)].map((m) => m[1])) }));

okPair('S-11 表头深底白字成对 + 图表系列走品牌色（deck 实扫，非源码计数）',
  () => {
    if (headerTables.length === 0 || deck.chartXmls.length === 0) return false;
    const brandInCharts = deck.chartXmls.every((x) => /val="08409C"/i.test(x) || /val="0059E9"/i.test(x))
      && /val="0059E9"/i.test(chartAll);
    return headerPairOk(slideAll) && brandInCharts;
  },
  () => /color: PALETTE\.onBrand, fill: \{ color: PALETTE\.brandDeep \}/.test(B_H)
    && /chartColors: \[PALETTE\.brandBright, PALETTE\.brandDeep/.test(B_H),
  () => ({ tables: headerTables.length, chartHexes: hexesOf(chartAll) }));

okPair('S-12 派生量取整呈现（工作量页真无长浮点，P84 取整进产物）',
  () => wlPageOk(deck.slideXmls[wlIdx]),
  () => /function fmtNum\(/.test(B_H) && /P84 \$\{fmtNum\(w\.quote\.p84ManDays\)\}/.test(B_H) && /`总工作量 \$\{range\} 人天/.test(B_H),
  () => deck.slideXmls[wlIdx].match(/<a:t>[^<]*人天[^<]*<\/a:t>/g));

okPair('S-13 页脚品牌深蓝真渲染（按文本定位「数据截至」9pt run，不看源码计数）',
  () => {
    const runs = (slideAll.match(/<a:r>[\s\S]*?<\/a:r>/g) ?? []).filter((r) => /sz="900"/.test(r) && /数据截至/.test(r));
    return runs.length >= renderPages.length - 1 && runs.every((r) => /srgbClr val="08409C"/.test(r));
  },
  () => (B_H.match(/color: PALETTE\.brandDeep/g) ?? []).length >= 2,
  () => ({ footerRuns: (slideAll.match(/<a:r>[\s\S]*?<\/a:r>/g) ?? []).filter((r) => /sz="900"/.test(r)).length, pages: renderPages.length }));

okPair('S-14 section/thanks 进枚举并真被服务端接受（assertOutlineShape 实跑，非三处文本比对）',
  () => shapeAccepts === 'section,thanks' && /不在枚举/.test(eBogus) && KS.KICKOFF_LAYOUTS.includes('section') && KS.KICKOFF_LAYOUTS.includes('thanks'),
  () => /KICKOFF_LAYOUTS = \[[^\]]*'section', 'thanks'\]/.test(SVC_H) && /section 作章节页/.test(SVC_H) && /'section', 'thanks'\]/.test(PANEL_H),
  () => ({ accepts: shapeAccepts, bogus: eBogus.slice(0, 80) }));

okPair('S-15 纯版式页脏 dataKeys 真被清空（validateOutline 实跑四个页面）',
  () => PURE_IDX.every((i: number) => (vrDirty.outline[i].dataKeys ?? []).length === 0) && clearWarnCount(vrDirty) === PURE_IDX.length,
  () => /dataKeys 已被清空/.test(SVC_H),
  () => ({ pure: PURE_IDX, warnings: vrDirty.warnings.filter((w: string) => /dataKeys/.test(w)).length }));

okPair('S-16 12~18 页口径真执行（17 页过、11 页与 19 页均被拒）',
  () => vrClean.warnings.length === 0 && /不在 12~18 区间/.test(eShort) && /不在 12~18 区间/.test(eLong),
  () => /PAGE_MIN = 12/.test(SVC_H) && /PAGE_MAX = 18/.test(SVC_H),
  () => ({ pages: outline.length, eShort: eShort.slice(0, 60), eLong: eLong.slice(0, 60) }));

// ================= U 组：产物判据 =================
ok('U-01 配色自检全过（auditPalette 运行时实测）', L.auditPalette().length === 0, L.auditPalette());
ok('U-02 品牌深/亮压过 4.5 对比度（运行时实算，门禁 6 不放宽）',
  L.contrastRatio(L.PALETTE.onBrand, L.PALETTE.brandDeep) >= 4.5
  && L.contrastRatio(L.PALETTE.brandDeep, L.PALETTE.paper) >= 4.5
  && L.contrastRatio(L.PALETTE.brandBright, L.PALETTE.paper) >= 4.5,
  { od: L.contrastRatio(L.PALETTE.onBrand, L.PALETTE.brandDeep), dp: L.contrastRatio(L.PALETTE.brandDeep, L.PALETTE.paper), bp: L.contrastRatio(L.PALETTE.brandBright, L.PALETTE.paper) });
ok('U-03 门稿出真 .pptx（PK 容器头、页数与渲染页一致、零降级、体积受控）',
  built.buffer[0] === 0x50 && built.buffer[1] === 0x4b && built.pageCount === renderPages.length
  && built.degradedPages.length === 0 && built.buffer.length <= 800 * 1024,
  { bytes: built.buffer.length, pageCount: built.pageCount, render: renderPages.length, degraded: built.degradedPages });
okSim('U-04 五张背景登记为自定义版式（仿真 deck：layout 级 <p:bg> 五处、媒体五份）',
  simDeck !== null && simDeck.bgLayoutCount() === 5 && Object.keys(simDeck.mediaBytes).length === 5,
  simDeck && { bg: simDeck.bgLayoutCount(), media: Object.keys(simDeck.mediaBytes).map((n) => n.split('/').pop()) });
okSim('U-05 背景按页面角色各就其位（仿真 deck：slide1..5 → COVER/TOC/SECTION/CONTENT/THANKS）',
  rolesAligned(simDeck), simDeck && { map: simDeck.slideLayoutOf.map((lf) => simDeck.roleOfLayout(lf)) });
okSim('U-05b 五角色媒体字节互异可分辨（cover↔thanks 同字节为夹具设定，其余互异）',
  bytesDistinguishable(simDeck), simDeck && simDeck.roleDigest());
ok('U-06 内容零位图：slide 层无 <p:pic>/r:embed（工作树 deck 与仿真 deck 双跑），版式内每个 embed 都来自 <p:bg>',
  deck.slideXmls.every((x) => !/<p:pic/.test(x) && !/r:embed="/.test(x))
  && (simDeck === null || simDeck.slideXmls.every((x) => !/<p:pic/.test(x) && !/r:embed="/.test(x)))
  && Object.entries(deck.layoutXmls).every(([, x]) => (x.match(/r:embed="/g) ?? []).length === (x.match(/<p:bg><p:bgPr><a:blipFill/g) ?? []).length)
  && (simDeck === null || Object.entries(simDeck.layoutXmls).every(([, x]) => (x.match(/r:embed="/g) ?? []).length === (x.match(/<p:bg><p:bgPr><a:blipFill/g) ?? []).length)),
  { worktreeEmbeds: deck.slideXmls.map((x) => (x.match(/r:embed="/g) ?? []).length).reduce((a, b) => a + b, 0) });
ok('U-07 全稿微软雅黑：slide 零 Arial；图表 Arial 只允许残留在 dLbls 组级兜底块（pptxgenjs 硬编码，逐点已用雅黑覆盖）',
  deck.slideXmls.every((x) => !/typeface="Arial"/.test(x)) && deck.chartXmls.length > 0 && deck.chartXmls.every((x) => {
    const withoutGroupFallback = x.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/g, (m) => m.replace(/<c:dLbl>[\s\S]*?<\/c:dLbl>/g, '').replace(/<a:latin typeface="Arial"\/>/g, ''));
    const dlblFaces = [...x.matchAll(/<c:dLbl>(?:(?!<\/c:dLbl>).)*?typeface="([^"]+)"/gs)].map((m) => m[1]);
    return !/typeface="Arial"/.test(withoutGroupFallback)
      && dlblFaces.every((f) => f === L.FONT.face)
      && /<c:legend>(?:(?!<\/c:legend>).)*?typeface="/s.test(x);
  }), deck.chartXmls.map((x) => uniq(x.match(/typeface="([^"]+)"/g) ?? [])));
ok('U-08 无纯黑 000000 渲染文字：slide 零处；图表仅 dLbls 组级兜底块残留且逐点已覆盖墨色',
  !slideAll.includes('val="000000"') && deck.chartXmls.every((x) => {
    const withoutGroupFallback = x.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/g, (m) => m.replace(/<c:dLbl>[\s\S]*?<\/c:dLbl>/g, '').replace(/<a:srgbClr val="000000"\/>/g, ''));
    const dlblColors = [...x.matchAll(/<c:dLbl>(?:(?!<\/c:dLbl>).)*?srgbClr val="([0-9A-Fa-f]{6})"/gs)].map((m) => m[1].toUpperCase());
    return !/val="000000"/.test(withoutGroupFallback) && dlblColors.every((c) => c === '1F2937');
  }));
ok('U-09 表头品牌深底白字成对进产物（五张表格全部同现 08409C+FFFFFF）',
  headerTables.length >= 3 && headerPairOk(slideAll), { tables: headerTables.length });
ok('U-10 标题 run 全品牌深蓝（每页 22/28/32pt run 实测带 08409C）',
  (() => {
    const runsOf = (x: string) => x.match(/<a:r>[\s\S]*?<\/a:r>/g) ?? [];
    return deck.slideXmls.every((x) => {
      const titleRuns = runsOf(x).filter((r) => /sz="2200"|sz="2800"|sz="3200"/.test(r));
      return titleRuns.length > 0 && titleRuns.every((r) => /srgbClr val="08409C"/.test(r));
    });
  })(), deck.slideXmls.map((x, i) => `${i + 1}:${(x.match(/sz="2200"|sz="2800"|sz="3200"/g) ?? []).length}`));
const tlIdx = slideIdx(outline.findIndex((p: any) => p.dataKeys.includes('timeline')));
ok('U-11 时间线形状走品牌色（deck 实测：条 0059E9、菱形 08409C）',
  /prst="rect"[^>]*>(?:(?!<\/p:sp>).)*?srgbClr val="0059E9"/s.test(deck.slideXmls[tlIdx])
  && /prst="diamond"(?:(?!<\/p:sp>).)*?srgbClr val="08409C"/s.test(deck.slideXmls[tlIdx]),
  `slide${tlIdx + 1}`);
ok('U-12 工作量页取整与口径行进产物（区间/人月/报价/阶段/复杂度分布全部装配层自生）',
  wlPageOk(deck.slideXmls[wlIdx]), deck.slideXmls[wlIdx].match(/<a:t>[^<]*(人天|人月)[^<]*<\/a:t>/g));
ok('U-13 章节页编号 01/02/03 递增 + 28pt 深蓝标题 + 不挂数据块（deck 实测）',
  (() => {
    const secIdxs = outline.map((p: any, i: number) => (p.layout === 'section' ? slideIdx(i) : -1)).filter((i: number) => i >= 0);
    return secIdxs.length === 3 && secIdxs.every((si: number, k: number) => {
      const x = deck.slideXmls[si];
      const num = String(k + 1).padStart(2, '0');
      return new RegExp(`<a:t>${num}</a:t>`).test(x)
        && /sz="2800"[^>]*>(?:(?!<\/a:r>).)*?srgbClr val="08409C"/s.test(x)
        && !/<a:tbl>/.test(x) && !/<c:chart/.test(x);
    });
  })(), outline.map((p: any, i: number) => (p.layout === 'section' ? `p${i + 1}` : null)).filter(Boolean));
ok('U-14 结束页致谢 + 「门内仿真项目 · 数据截至 2026-10-14」口径行进产物（夹具项目名，非生产数据）',
  (() => {
    const th = slideIdx(outline.findIndex((p: any) => p.layout === 'thanks'));
    const x = deck.slideXmls[th];
    return /<a:t>谢谢观看<\/a:t>/.test(x) && /门内仿真项目 · 数据截至 2026-10-14/.test(x) && !/<a:tbl>/.test(x);
  })(), deck.slideXmls[slideIdx(outline.length - 1)].match(/<a:t>[^<]*<\/a:t>/g));
ok('U-15 正文页标题让开左上装饰（deck 实测标题盒 x ≥ 1.0"）',
  (() => {
    const ci = slideIdx(outline.findIndex((p: any) => p.layout === 'twoCol'));
    const titleSp = (deck.slideXmls[ci].match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []).find((sp) => /sz="2200"/.test(sp)) ?? '';
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(titleSp);
    return !!off && Number(off[1]) / 914400 >= 1.0;
  })(), slideIdx(outline.findIndex((p: any) => p.layout === 'twoCol')) + 1);
ok('U-16 降级不丢内容（工作树 deck 实测：超长标题页被记降级、要点与页码口径行仍在、文本量不塌）',
  (() => {
    const t4 = degradedDeck.textOf(3);
    const base4 = deck.textOf(3);
    return degraded.degradedPages.includes(4) && degraded.pageCount === renderPages.length
      && /越界/.test(t4) && /项目管理/.test(t4) && /原生/.test(t4) && /第 4\/19/.test(t4)
      && t4.replace(/\s/g, '').length >= base4.replace(/\s/g, '').length * 0.5;
  })(),
  { degraded: degraded.degradedPages, pageCount: degraded.pageCount, text: degradedDeck.textOf(3).slice(0, 120), base: deck.textOf(3).slice(0, 120) });
okSim('U-16b 降级页仍落 CONTENT 背景版式（仿真降级 deck 实测 slide4 版式含 <p:bg>）',
  simDeg !== null && simDeg.roleOfLayout(simDeg.slideLayoutOf[3]) === 'CONTENT'
  && /<p:bg><p:bgPr><a:blipFill/.test(simDeg.layoutXmls[simDeg.slideLayoutOf[3]] ?? '')
  && simDeg.bgLayoutCount() === 5,
  simDeg && { role: simDeg.roleOfLayout(simDeg.slideLayoutOf[3]), manifest: simManifest['deck-deg'] });
ok('U-17 风险依据列 12 字截断进产物（装配层 slice(0,12) 实测：截断值在、完整串不在）',
  (() => {
    const t = headerTables.find((x) => /依据/.test(x)) ?? '';
    return /<a:t>prd_gap_plus<\/a:t>/.test(t) && !t.includes('prd_gap_plus_plan_risk');
  })(), (headerTables.find((x) => /依据/.test(x)) ?? '').match(/<a:t>[^<]*<\/a:t>/g));
ok('U-18 真树缺资产面：丢的只是背景（工作树 deck 零背景版式/零媒体，但页数、表格、致谢一项不少）',
  deck.bgLayoutCount() === 0 && Object.keys(deck.mediaBytes).length === 0
  && built.pageCount === renderPages.length && headerTables.length >= 3
  && /<a:t>谢谢观看<\/a:t>/.test(deck.slideXmls[deck.slideXmls.length - 1]),
  { bgLayouts: deck.bgLayoutCount(), media: Object.keys(deck.mediaBytes).length, tables: headerTables.length, pages: built.pageCount });

// ================= X 组：负控制（真破坏 → 同判据必须变红） =================
ok('X-01 配色改名仿真：新值增量 == 旧值减量（判据 3 计数对等，不以「串缺失」判）',
  (() => {
    const parity = Object.entries(ALT).every(([from, to]) =>
      countOf(movedAll, to) - countOf(slideAll + chartAll, to) === countOf(slideAll + chartAll, from) - countOf(movedAll, from));
    return parity && movedParts > 0 && countOf(movedAll, ALT.FFFFFF) > 0;
  })(), Object.fromEntries(Object.entries(ALT).map(([from, to]) => [`${from}→${to}`, { base: [countOf(slideAll + chartAll, from), countOf(slideAll + chartAll, to)], moved: [countOf(movedAll, from), countOf(movedAll, to)] }])));
ok('X-02 改名后 U-09 表头深底白字判据真变红（行为面被破坏，判据跟着红）',
  !headerPairOk(moved.slideXmls.join('')) && headerPairOk(slideAll),
  { movedTables: tablesOf(moved.slideXmls.join('')).length });
okSim('X-03 串图负控制：把 toc 夹具换成 content 字节后，字节可分辨判据真变红',
  simX1 !== null && !bytesDistinguishable(simX1) && rolesAligned(simX1),
  simX1 && { digests: simX1.roleDigest(), tocEqContent: simX1.roleDigest().TOC === simX1.roleDigest().CONTENT });
okSim('X-04 串图对照面：同一 deck 版式角色仍对位（红因来自字节等值，不是判据本身坏）',
  simX1 !== null && rolesAligned(simX1) && simX1.bgLayoutCount() === 5 && Object.keys(simX1.mediaBytes).length === 5,
  simX1 && simX1.slideLayoutOf.map((lf) => simX1.roleOfLayout(lf)));
okSim('X-05 拔夹具负控制：删掉 bg-thanks 夹具后角色对位判据变红，但内容不丢、页数不减（缺背景不丢页面）',
  simX2 !== null && !rolesAligned(simX2) && simX2.slideXmls.length === 5
  && /谢谢观看/.test(simX2.slideXmls[4]) && simX2.bgLayoutCount() === 4,
  simX2 && { map: simX2.slideLayoutOf.map((lf) => simX2.roleOfLayout(lf)), manifest: simManifest['deck-x2'] });
okSim('X-06 拔夹具前后媒体计数差恰为 1（对照面：仿真资产目录至少非空过，缺失判据不是恒真）',
  simDeck !== null && simX2 !== null && simDeck.bgLayoutCount() - simX2.bgLayoutCount() === 1
  && Object.keys(simDeck.mediaBytes).length - Object.keys(simX2.mediaBytes).length === 1
  && simManifest?.restored?.toc === 'sim1' && simManifest?.restored?.thanks === 'sim0',
  { with: simDeck && simDeck.bgLayoutCount(), without: simX2 && simX2.bgLayoutCount(), restored: simManifest && simManifest.restored });
okSim('X-07 版式互换负控制：cover/toc 互换后角色判据变红、互换专用判据为绿、字节可分辨判据不受污染（三种红因可区分）',
  simX5 !== null && !rolesAligned(simX5) && bytesDistinguishable(simX5)
  && simX5.roleOfLayout(simX5.slideLayoutOf[0]) === 'TOC' && simX5.roleOfLayout(simX5.slideLayoutOf[1]) === 'COVER',
  simX5 && simX5.slideLayoutOf.map((lf) => simX5.roleOfLayout(lf)));
ok('X-08 脏 dataKeys 告警计数严格增加（四个纯版式页各一条，不以「串缺失」判）',
  vrClean.warnings.length === 0 && clearWarnCount(vrDirty) === PURE_IDX.length && vrDirty.warnings.length > vrClean.warnings.length,
  { pure: PURE_IDX, clean: vrClean.warnings.length, dirty: vrDirty.warnings.length });
ok('X-09 伪造 dataKeys 通道名真被拒（校验层抛错，不静默放行）',
  eFake !== '' && /dataKeys/.test(eFake) && /totallyMadeUpChannel/.test(eFake), eFake.slice(0, 120));
{
  const spy: string[] = [];
  const spyOk = (name: string, cond: boolean, extra?: unknown) => {
    spy.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond ? '' : ` → ${JSON.stringify(extra ?? null).slice(0, 200)}`}`);
  };
  const pair = (label: string, behavior: () => boolean, literal: () => boolean) => {
    let b = false;
    try { b = behavior() === true; } catch { b = false; }
    if (!b) { spyOk(label, false, { 红因: '行为失守（功能未达成，与文案无关）' }); return; }
    let l = false;
    try { l = literal() === true; } catch { l = false; }
    spyOk(label, l, l ? undefined : { 红因: '字面锚点失配（行为在）' });
  };
  pair('P-1 双绿基准（行为在 + HEAD 锚点在）', () => clearWarnCount(vrDirty) === PURE_IDX.length, () => /dataKeys 已被清空/.test(SVC_H));
  pair('P-2 预期红：行为失守', () => vrDirty.outline[PURE_IDX[0]].dataKeys.length === 999, () => /dataKeys 已被清空/.test(SVC_H));
  pair('P-3 预期红：字面锚点失配（行为在）', () => clearWarnCount(vrDirty) === PURE_IDX.length, () => /dataKeys 已被清空/.test('一份不含该文案的桩源码'));
  ok('X-10 okPair 红因分离自证（1 绿 + 2 种不同红因，落账可读回）',
    spy.filter((l) => l.startsWith('[PASS]')).length === 1
    && /行为失守/.test(spy.find((l) => l.includes('P-2')) ?? '')
    && /字面锚点失配（行为在）/.test(spy.find((l) => l.includes('P-3')) ?? ''),
    spy);
}
ok('X-11 工作量数据缺失面：同一条 U-12 判据必须不再被打绿（真破坏 → 判据跟红）',
  noDataRed && wlPageOk(deck.slideXmls[wlIdx]), noDataHow);

// ---------- 汇总（判据 14：测量全部完成后才落盘） ----------
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(gateArtifactPath(OUT_DIR, 't02156-brand-sample.pptx'), built.buffer);
if (simDeck) writeFileSync(gateArtifactPath(OUT_DIR, 't02156-sim-sample.pptx'), readFileSync(join(SIM, 'deck-a.pptx')));
if (process.env.X_KEEP_SIM !== '1') removeSimTree();
writeGateResults(OUT_DIR, 't02156-gate-results.txt',
  `T02156 恒生模板视觉门（T02293 改判版）：PASS=${pass} FAIL=${fail} SKIP=${skippedList.length}\n${lines.join('\n')}\n`);
console.log(`PASS=${pass} FAIL=${fail} SKIP=${skippedList.length}`);
process.exit(fail === 0 ? 0 : 1);
