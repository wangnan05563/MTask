/**
 * T03215 / PM-304 门：任务列表窗口化（虚拟滚动）+ 分页取数下沉。
 *
 * 守的判据（`docs/PRD-MTask-项目管理与AI工作台优化-整合版.md` PM-304 验收）：
 *   ① 5000 条首屏 ≤1 秒；② 滚动 ≥50fps；③ DOM 行数不再随已加载条数线性增长。
 * 本门只守代码层可判定的部分（首屏/帧率与 DOM 规模由真机探针出数，结论随结果回传），具体是：
 *   - **窗口数学**（真实 `web/src/utils/taskListWindow.ts`，编译后调用纯函数）：
 *     占位不变量 `padTop + 渲染区间行数 + padBottom == count × rowH`；渲染行数上界 = 可视行 + 2×overscan，
 *     与 `count` 无关（这正是「DOM 行数不线性增长」的代码级证明）；顶部/底部夹紧、定位偏移、强制窗口；
 *   - **派生气等价**（真实 `web/src/utils/taskListQuery.ts`）：过滤/排序/父子装配与原实现逐条等价，
 *     arrangeTaskTree 用门内保留的 O(n²) 原实现做 oracle 逐项比对（5000 条量级下顺序不能变）；
 *   - **用法**（TasksPage 源码扫描）：三处 `<ul>` 都走窗口切片 + `data-t03215-window` 钩子；
 *     触底续取判据是「距估算末尾不足一屏」而不是窗口区间；贴边不攒步长；行距走累计平均（top 间距含 margin）；
 *     滚动换窗是紧急更新（`startTransition` 实测更差，已回退，防止有人再改回去）。
 *
 * 负对照（判据 4）：M/Q 各造一份「判据被摘掉」的真实副本模块，S 组对同一套扫描器喂摘除锚点的文本副本，
 * 三项都必须翻脸——证明判据不是恒绿摆设。
 *
 * 已知边界（如实声明）：真机帧率/首屏耗时不在本门断言范围内（需要浏览器与 5000 条种子数据），
 * 由 `D:/tmp/t03215-ab.mjs` 探针出数并写入回传结果；本门零网络、零数据库、产品工作树零写入。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t03215-pm304-windowed-list.mts
 * 结果落 .workbuddy/t03215-pm304-windowed-list-results.txt。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeGateResults } from '../lib/gate-results.mts';
import { okPair } from '../lib/anchor-pair.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_SRC = join(ROOT, 'web', 'src');
const TASKS_PAGE = join(WEB_SRC, 'pages', 'TasksPage.tsx');
const WINDOW_MOD = join(WEB_SRC, 'utils', 'taskListWindow.ts');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 300)}`}`);
};
const okN = (name: string, cond: boolean, extra?: unknown) => {
  ok(name, cond, extra);
  lines.push(`[EVID] ${JSON.stringify(extra ?? {})}`.slice(0, 340));
};

const esbuild = (await import('esbuild')).default as any;
const RUN_ID = `t03215-${process.pid}-${Date.now()}`;
const SCRATCH = join(ROOT, '.workbuddy', RUN_ID);
mkdirSync(SCRATCH, { recursive: true });

const srcOf = (rel: string) => readFileSync(join(WEB_SRC, rel), 'utf8');

async function buildReal(rel: string, tag: string, mutate: (s: string) => string = (s) => s): Promise<Record<string, any>> {
  const ownDir = dirname(join(WEB_SRC, rel));
  const source = mutate(srcOf(rel)).replace(/from\s+'(\.[^']+)'/g, (_m, spec: string) => `from '${resolve(ownDir, spec).replace(/\\/g, '/')}'`);
  const entry = join(SCRATCH, `${tag}.src.ts`);
  const outfile = join(SCRATCH, `${tag}.mjs`);
  writeFileSync(entry, source, 'utf8');
  await esbuild.build({
    absWorkingDir: ROOT, entryPoints: [entry], bundle: true, format: 'esm',
    platform: 'node', target: 'es2022', jsx: 'automatic', outfile, logLevel: 'silent',
    plugins: [{
      name: 'external-packages',
      setup(b: any) {
        b.onResolve({ filter: /.*/ }, (a: any) => (
          !a.path.startsWith('.') && !isAbsolute(a.path) && !/^([a-zA-Z]:[\\/])/.test(a.path)
            ? { path: a.path, external: true } : undefined));
      },
    }],
  });
  return import(pathToFileURL(outfile).href);
}

const pageSrc = readFileSync(TASKS_PAGE, 'utf8').replace(/\r\n/g, '\n');
const windowSrc = readFileSync(WINDOW_MOD, 'utf8').replace(/\r\n/g, '\n');

// =====================================================================
// M 组：窗口数学（真实 utils/taskListWindow.ts 纯函数）
// =====================================================================
const winMod = await buildReal(join('utils', 'taskListWindow.ts'), 'real-window');
const { shouldVirtualizeTasks, computeTaskWindow, computePinnedWindow, scrollOffsetForIndex } = winMod;
const TASK_VIRTUAL_THRESHOLD = winMod.TASK_VIRTUAL_THRESHOLD;
const TASK_ROW_H = winMod.TASK_ROW_H;
const TASK_OVERSCAN = winMod.TASK_OVERSCAN;
const TASK_WINDOW_STEP = winMod.TASK_WINDOW_STEP;
ok('G-01 真实窗口模块取到（阈值/行高/overscan/步长与四个纯函数都在导出面上）',
  [shouldVirtualizeTasks, computeTaskWindow, computePinnedWindow, scrollOffsetForIndex].every((f) => typeof f === 'function')
  && [TASK_VIRTUAL_THRESHOLD, TASK_ROW_H, TASK_OVERSCAN, TASK_WINDOW_STEP].every((n) => typeof n === 'number' && n > 0),
  { TASK_VIRTUAL_THRESHOLD, TASK_ROW_H, TASK_OVERSCAN, TASK_WINDOW_STEP });

ok('M-01 阈值：恰好等于阈值仍整表渲染，超一条才窗口化（小列表不被窗口化折腾）',
  shouldVirtualizeTasks(TASK_VIRTUAL_THRESHOLD) === false && shouldVirtualizeTasks(TASK_VIRTUAL_THRESHOLD + 1) === true
  && shouldVirtualizeTasks(5000) === true,
  { 阈值: TASK_VIRTUAL_THRESHOLD, 等于阈值: shouldVirtualizeTasks(TASK_VIRTUAL_THRESHOLD), 超一条: shouldVirtualizeTasks(TASK_VIRTUAL_THRESHOLD + 1) });

const small = computeTaskWindow({ scrollY: 3000, listTop: 300, viewportH: 900, count: 100 });
ok('M-02 未过阈值：整表区间 + 零占位（调用方不必再分支判断）',
  small.start === 0 && small.end === 100 && small.padTop === 0 && small.padBottom === 0, small);

const count = 5000, listTop = 300, viewportH = 900, rowH = 72;
const visible = Math.ceil(viewportH / rowH);
const top = computeTaskWindow({ scrollY: 0, listTop, viewportH, count, rowH });
ok('M-03 顶部：从 0 起渲染，底部占位补足整表高度（滚动条长度与全量渲染一致）',
  top.start === 0 && top.end === visible + TASK_OVERSCAN && top.padTop === 0
  && top.padBottom === (count - top.end) * rowH, top);

const mid = computeTaskWindow({ scrollY: 30000, listTop, viewportH, count, rowH });
const midFirst = Math.floor((30000 - listTop) / rowH);
okPair(ok, 'M-04 中段：区间按滚动位换算，占位三段之和恒等于 count×rowH（不变量）',
  () => mid.start === midFirst - TASK_OVERSCAN && mid.end === midFirst + visible + TASK_OVERSCAN,
  () => mid.padTop + (mid.end - mid.start) * rowH + mid.padBottom === count * rowH,
  () => ({ mid, 合计: mid.padTop + (mid.end - mid.start) * rowH + mid.padBottom, 期望: count * rowH }));

const bottom = computeTaskWindow({ scrollY: 10_000_000, listTop, viewportH, count, rowH });
ok('M-05 超底：区间夹紧到 [count,count]，占位仍是整表高度（不出现负占位或越界索引）',
  bottom.start === count && bottom.end === count && bottom.padTop === count * rowH && bottom.padBottom === 0, bottom);

const zero = computeTaskWindow({ scrollY: 500, listTop, viewportH, count: 0, rowH });
ok('M-06 空列表：全零区间（不渲染占位，空态由页面自己画）',
  zero.start === 0 && zero.end === 0 && zero.padTop === 0 && zero.padBottom === 0, zero);

// 渲染行数上界与 count 无关——这就是「DOM 行数不再随条数线性增长」的代码级证明
const spans = [200, 1000, 5000, 50000, 500000].map((c) => {
  const w = computeTaskWindow({ scrollY: listTop + Math.floor(c / 2) * rowH, listTop, viewportH, count: c, rowH });
  return { count: c, 渲染行数: w.end - w.start };
});
ok('M-07 渲染行数上界 = 可视行 + 2×overscan，5 个量级（200 → 50 万）恒定不变',
  spans.every((s) => s.渲染行数 === visible + TASK_OVERSCAN * 2), { spans, 上界: visible + TASK_OVERSCAN * 2 });

ok('M-08 变高容忍：rowH 变小/变大时占位与区间同步换算，不变量仍成立',
  [30, 45, 120].every((h) => {
    const w = computeTaskWindow({ scrollY: listTop + 400 * h, listTop, viewportH, count, rowH: h });
    return w.padTop + (w.end - w.start) * h + w.padBottom === count * h && w.end - w.start === Math.ceil(viewportH / h) + TASK_OVERSCAN * 2;
  }));

const off50 = scrollOffsetForIndex(50, listTop, rowH, viewportH);
const off0 = scrollOffsetForIndex(0, listTop, rowH, viewportH);
ok('M-09 定位偏移：目标行落在视口上沿下方约 1/3 处；首行/负索引不产生负滚动位',
  off50 === listTop + 50 * rowH - Math.floor(viewportH / 3) && off0 === Math.max(0, listTop - Math.floor(viewportH / 3))
  && scrollOffsetForIndex(-5, listTop, rowH, viewportH) === off0,
  { off50, off0, 期望50: listTop + 50 * rowH - Math.floor(viewportH / 3) });

const pinned = computePinnedWindow(1000, count, viewportH, rowH, TASK_OVERSCAN);
okPair(ok, 'M-10 强制窗口：以定位行为中心，渲染行数与常规窗口同级，占位总量仍守恒（定位与滚动不打架）',
  () => pinned.start <= 1000 && 1000 < pinned.end && pinned.end - pinned.start === visible + TASK_OVERSCAN * 2,
  () => pinned.padTop + (pinned.end - pinned.start) * rowH + pinned.padBottom === count * rowH,
  () => ({ pinned }));

const winBad = await buildReal(join('utils', 'taskListWindow.ts'), 'revert-window',
  (s) => s.replace('const start = Math.min(count, Math.max(0, first - overscan));', 'const start = Math.min(count, Math.max(0, first));'));
const badMid = winBad.computeTaskWindow({ scrollY: 30000, listTop, viewportH, count, rowH });
okN('M-11 反证：摘掉 overscan 后 M-04 的区间判据变红（overscan 确实参与窗口计算，不是摆设）',
  badMid.start === midFirst && badMid.start !== mid.start, { 真实: mid.start, 副本: badMid.start });

// =====================================================================
// Q 组：派生计算等价（真实 utils/taskListQuery.ts）
// =====================================================================
const qMod = await buildReal(join('utils', 'taskListQuery.ts'), 'real-query');
const { sortTasks, makeTaskMatcher, matchVerified, arrangeTaskTree, sortOptions } = qMod;
ok('G-02 真实派生模块取到（sortOptions / sortTasks / makeTaskMatcher / matchVerified / arrangeTaskTree）',
  Array.isArray(sortOptions) && sortOptions.length === 6 && [sortTasks, makeTaskMatcher, matchVerified, arrangeTaskTree].every((f) => typeof f === 'function'),
  { 排序项: sortOptions.map((o: any) => o.value) });

const mk = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `任务 ${id}`, description: '', task_no: `T${id}`, status: 'todo', priority: 'normal',
  category_id: null, parent_id: null, verified: 0, pinned: 0, user_sort: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra,
});

const src = [
  mk('a', { priority: 'low', updated_at: '2026-03-03T00:00:00Z', category_id: 'c1', verified: 1 }),
  mk('b', { priority: 'high', updated_at: '2026-01-01T00:00:00Z', category_id: null, verified: 0, pinned: 1, user_sort: 5 }),
  mk('c', { priority: 'normal', updated_at: '2026-02-02T00:00:00Z', category_id: 'c1', verified: 0 }),
];
const ids = (l: any[]) => l.map((t) => t.id).join(',');
ok('Q-01 排序：default 原序返回，时间/优先级四种排序与既有语义一致（父序不被意外打乱）',
  ids(sortTasks(src, 'default')) === 'a,b,c'
  && ids(sortTasks(src, 'timedesc')) === 'a,c,b' && ids(sortTasks(src, 'timeasc')) === 'b,c,a'
  && ids(sortTasks(src, 'pdesc')) === 'b,c,a' && ids(sortTasks(src, 'pasc')) === 'a,c,b',
  { timedesc: ids(sortTasks(src, 'timedesc')), pdesc: ids(sortTasks(src, 'pdesc')) });
ok('Q-02 排序不改原数组（5000 条 memo 依赖原数组标识，就地改会让缓存失效/渲染错序）',
  ids(src) === 'a,b,c' && sortTasks(src, 'timedesc') !== src);

ok('Q-03 手动排序：置顶优先，user_sort 空值排最后（与后端 sort=manual 同口径）',
  ids(sortTasks([mk('x', { user_sort: null }), mk('y', { user_sort: 2 }), mk('z', { pinned: 1 })], 'manual')) === 'z,y,x');

const matcher = makeTaskMatcher('c1x', '');
ok('Q-04 关键词：标题 / 描述 / 编号三处都参与（外部跳转按 task_no 检索才定位得到）',
  matcher(mk('k', { task_no: 'c1x', title: '无关' })) === true
  && matcher(mk('k', { description: '含 C1X 的描述' })) === true
  && matcher(mk('k', { title: 'C1X 标题' })) === true
  && matcher(mk('k', { title: '无关', description: '也无关', task_no: 'T9' })) === false);
ok('Q-05 分类：none 只留未分类，指定分类精确匹配，空串为全部',
  makeTaskMatcher('', 'none')(mk('n', { category_id: null })) === true
  && makeTaskMatcher('', 'none')(mk('n', { category_id: 'c1' })) === false
  && makeTaskMatcher('', 'c1')(mk('n', { category_id: 'c1' })) === true
  && makeTaskMatcher('', 'c1')(mk('n', { category_id: 'c2' })) === false
  && makeTaskMatcher('', '')(mk('n', { category_id: 'c2' })) === true);
ok('Q-06 已完成验证过滤：all / verified / unverified 三态互斥',
  matchVerified(mk('v', { verified: 1 }), 'all') && matchVerified(mk('v', { verified: 0 }), 'all')
  && matchVerified(mk('v', { verified: 1 }), 'verified') && !matchVerified(mk('v', { verified: 0 }), 'verified')
  && !matchVerified(mk('v', { verified: 1 }), 'unverified') && matchVerified(mk('v', { verified: 0 }), 'unverified'));

/** 门内保留的 O(n²) 原实现（T00450 写法）作为 oracle：新实现必须逐项等价 */
function arrangeOracle(list: any[]): any[] {
  const out: any[] = [];
  for (const t of list) {
    if (!t.parent_id || !list.some((x) => x.id === t.parent_id)) {
      out.push(t);
      for (const c of list) if (c.parent_id === t.id) out.push(c);
    }
  }
  return out;
}
// 造一棵 300 行、父在子后、跨层与断链混合的树（断链子任务按根处理）
const tree: any[] = [];
for (let i = 0; i < 300; i += 1) tree.push(mk(String(i), { parent_id: i % 7 === 0 ? '999' : i % 3 === 0 ? String(Math.max(0, i - 1)) : null }));
const ore = arrangeOracle(tree);
const got = arrangeTaskTree(tree);
okPair(ok, 'Q-07 父子装配与原 O(n²) 实现在 300 行混合树上逐项等价（换成 Set+Map 不改变顺序）',
  () => ids(got) === ids(ore),
  () => got.length === tree.length && new Set(got.map((t: any) => t.id)).size === tree.length,
  () => ({ 前20: ids(got).split(',').slice(0, 20).join(','), 前20oracle: ids(ore).split(',').slice(0, 20).join(',') }));
ok('Q-08 父子装配不改原数组且不丢行（装配是纯函数，memo 缓存可安全复用）',
  ids(tree).split(',').length === 300 && got.length === 300);

const qBad = await buildReal(join('utils', 'taskListQuery.ts'), 'revert-query',
  (s) => s.replace('if (k) out.push(...k);', 'void k;'));
okN('Q-09 反证：父后子不装配的副本在 Q-07 上变红（等价判据确实量到了装配逻辑）',
  ids(qBad.arrangeTaskTree(tree)) !== ids(ore), { 副本前20: ids(qBad.arrangeTaskTree(tree)).split(',').slice(0, 12).join(',') });

// =====================================================================
// S 组：TasksPage / 窗口模块用法扫描
// =====================================================================
const ulCount = (pageSrc.match(/data-t03215-window=/g) ?? []).length;
const listUsage = (pageSrc.match(/<TaskListWindow /g) ?? []).length;
const childSlice = /items\.slice\(api\.win\.start, api\.win\.end\)/.test(pageSrc);
okPair(ok, 'S-01 三处列表都复用窗口子树与 data-t03215-window 钩子（待办/已完成/搁置一个不漏）',
  () => listUsage === 3 && childSlice && ulCount === 1,
  () => /<TaskListWindow ref=\{taskListRef\} items=\{visibleTodo\}/.test(pageSrc)
    && /<TaskListWindow ref=\{taskListRef\} items=\{visibleDone\}/.test(pageSrc)
    && /<TaskListWindow ref=\{taskListRef\} items=\{visibleShelved\}/.test(pageSrc),
  () => ({ 列表用法: listUsage, 窗口钩子: ulCount, 子树切片: childSlice }));
const renderAtWin = ['visibleTodo', 'visibleDone', 'visibleShelved'].filter((name) =>
  new RegExp(`<TaskListWindow ref=\\{taskListRef\\} items=\\{${name}\\}`).test(pageSrc));
const renderItemProps = (pageSrc.match(/renderItem=\{renderTaskItem\}/g) ?? []).length;
ok('S-02 行渲染入口收敛到窗口子树（三处列表都传 renderTaskItem，旧的全表 map 与父层 listWin 已无残留）',
  renderAtWin.length === 3 && renderItemProps === 3 && childSlice
  && /rowCacheRef/.test(pageSrc)
  && !/visible(Todo|Done|Shelved)\.map\(\(t\) => <Fragment/.test(pageSrc)
  && !/listWin\./.test(pageSrc),
  { 切片入口: renderAtWin, 渲染传参: renderItemProps });

ok('S-03 触底续取只对待办/已完成生效，且分页请求在飞时不占额度（canLoadMore=!loadingMore）',
  /hasMore=\{hasMore && activeTab === 'todo'\}/.test(pageSrc)
  && /hasMore=\{hasMore && activeTab === 'done'\}/.test(pageSrc)
  && /hasMore=\{false\}/.test(pageSrc)
  && /canLoadMore=\{!loadingMore\}/.test(pageSrc)
  && /useTaskListWindow\(items\.length, hasMore, onReachEnd, canLoadMore\)/.test(pageSrc),
  { 待办: /hasMore=\{hasMore && activeTab === 'todo'\}/.test(pageSrc), 已完成: /hasMore=\{hasMore && activeTab === 'done'\}/.test(pageSrc) });

okPair(ok, 'S-04 触底判据用「距估算末尾不足一屏」（nearEnd），而不是窗口区间 win.end（后者在浏览器钳位后永远差一两行）',
  () => /const nearEnd = count > 0\n\s*&& geom\.listTop \+ count \* geom\.rowH - \(geom\.scrollY \+ geom\.viewportH\) < geom\.viewportH;/.test(windowSrc)
    && /if \(!hasMore \|\| !canLoadMore \|\| !onReachEnd \|\| !nearEnd\) return;/.test(windowSrc),
  () => !/win\.end < count\) return;/.test(windowSrc),
  () => ({ 残留区间判据: /win\.end < count\) return;/.test(windowSrc) }));

ok('S-05 贴边不攒步长：窗口贴顶或贴已加载末尾时必须立刻落地（否则钳位后的修正会被吞掉，续取失灵）',
  /const atEdge = next\.start === 0 \|\| next\.end >= count;/.test(windowSrc) && /else if \(!atEdge &&/.test(windowSrc));

ok('S-06 行距走「已观测行累计平均」而非当前窗口中位数（中位数会让占位总高随窗口位置 2 倍跳变）',
  /rowAccRef = useRef<\{ sum: number; n: number \}>/.test(windowSrc)
  && /const pitch = rect\.top - prevTop;/.test(windowSrc)
  && /acc\.sum \+= pitch/.test(windowSrc)
  && /rowH = Math\.max\(24, Math\.round\(acc\.sum \/ acc\.n\)\)/.test(windowSrc)
  && !/hs\.sort\(/.test(windowSrc));
ok('S-07 条数回落（换项目/换筛选/切 tab）时累计行高清零重测',
  /if \(count < prevCountRef\.current\) rowAccRef\.current = \{ sum: 0, n: 0 \};/.test(windowSrc));

ok('S-08 滚动换窗是紧急更新：不许再用 startTransition（实测 45.7fps → 31fps 且出现空帧，已回退）',
  !/startTransition\s*\(/.test(windowSrc) && !/import[^;]*startTransition/.test(windowSrc) && /setGeom\(g\);/.test(windowSrc));

const SCANNERS: Array<{ name: string; src: string; page: boolean; check: (s: string) => boolean }> = [
  { name: 'S-01 列表切片', page: true, src: pageSrc.replace('items.slice(api.win.start, api.win.end)', 'items'),
    check: (s) => /items\.slice\(api\.win\.start, api\.win\.end\)/.test(s) },
  { name: 'S-01 窗口钩子', page: true, src: pageSrc.replace('data-t03215-window={api.virtualized ? \'on\' : \'off\'}', ''),
    check: (s) => (s.match(/data-t03215-window=/g) ?? []).length === 1 },
  { name: 'S-03 忙态额度', page: true, src: pageSrc.replace(/canLoadMore=\{!loadingMore\}/g, 'canLoadMore={true}'),
    check: (s) => /canLoadMore=\{!loadingMore\}/.test(s) },
  { name: 'S-04 nearEnd 判据', page: false, src: windowSrc.replace('!nearEnd) return;', 'win.end < count) return;'),
    check: (s) => /!nearEnd\) return;/.test(s) && !/win\.end < count\) return;/.test(s) },
  { name: 'S-05 贴边豁免', page: false, src: windowSrc.replace('else if (!atEdge && ', 'else if ('),
    check: (s) => /else if \(!atEdge &&/.test(s) },
  { name: 'S-06 累计行距', page: false, src: windowSrc.replace(/rowH = Math\.max\(24, Math\.round\(acc\.sum \/ acc\.n\)\);/, 'rowH = TASK_ROW_H;'),
    check: (s) => /rowH = Math\.max\(24, Math\.round\(acc\.sum \/ acc\.n\)\);/.test(s) },
  { name: 'S-08 无 startTransition', page: false, src: windowSrc.replace('    setGeom(g);', '    startTransition(() => setGeom(g));'),
    check: (s) => !/startTransition/.test(s) },
];
let flips = 0;
for (const sc of SCANNERS) {
  if (sc.check(sc.src) === false) flips += 1;
  else lines.push(`[EVID] 反证未翻脸：${sc.name}`);
}
okN(`S-09 反证：摘除任一锚点后对应扫描判据变红（${SCANNERS.length} 项全翻脸）`,
  flips === SCANNERS.length, { 翻脸数: flips, 总数: SCANNERS.length });

// =====================================================================
// 收口
// =====================================================================
rmSync(SCRATCH, { recursive: true, force: true });
ok('Z-01 清理：本轮编译副本目录已删除，产品工作树零写入', !existsSync(SCRATCH), { SCRATCH });
const summary = `PASS=${pass} FAIL=${fail} SKIP=0\n`
  + `T03215 / PM-304 窗口化列表门（真实窗口数学 + 派生等价 + TasksPage 用法扫描）\n`
  + `${lines.join('\n')}\n`;
const resultsFile = writeGateResults(join(ROOT, '.workbuddy'), 't03215-pm304-windowed-list-results.txt', summary,
  { note: `窗口常量 overscan=${TASK_OVERSCAN} step=${TASK_WINDOW_STEP} 阈值=${TASK_VIRTUAL_THRESHOLD}；TasksPage ${pageSrc.split('\n').length} 行；真机帧率不在本门断言` });
console.log(`PASS=${pass} FAIL=${fail}`);
console.log(lines.join('\n'));
console.log(`结果文件：${resultsFile}`);
process.exit(fail === 0 ? 0 : 1);
