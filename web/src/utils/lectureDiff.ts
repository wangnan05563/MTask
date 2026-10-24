/**
 * 代码评审会议讲稿 · 左栏 diff 视图纯函数（六期 3.1 / PRD §6.1 三区布局、§6.2 锚点交互）。
 *
 * 只放纯逻辑（diff 行展开、锚点解析与落点计算、文件按模块分组），组件与验收门共用同一份：
 * 锚点「点到哪一行」是这套功能最容易只在人眼里对、机器判不住的地方，
 * 收敛成无 DOM 依赖的函数后，门可以直接对返回值断言而不必先渲染。
 *
 * 口径与服务端同源：
 *  - 锚点形态 `[file#Lx-Ly]` 与 `lectureService.ts` 的 `ANCHOR_RE` 逐字一致（服务端已按 hunk
 *    new 侧行区间校验过，这里只负责把它落到具体渲染行）；
 *  - `moduleOf` 与 `lectureContext.ts` 的 `moduleOf` 同语义（最后一个 `/` 之前为模块）。
 */

/** 服务端 `GitHunk` 的前端镜像（POST /plans/code-review-lecture/diff 的 files[].hunks） */
export interface LectureDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** 行首保留 diff 前缀（空格 / 加号 / 减号） */
  lines: string[];
}

export interface LectureDiffFile {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: LectureDiffHunk[];
}

export interface LectureDiffProject {
  projectId: string;
  projectName: string;
  mode: 'git' | 'patch';
  rangeLabel: string;
  revision?: string;
  files: LectureDiffFile[];
  /** 采集统计（排除前）与 kept/budget 面，用于空态与降级 chip 文案 */
  stats: { commits: number; files: number; additions: number; deletions: number };
  kept: { files: number; additions: number; deletions: number; chars: number };
  budget: { dropped: number; partial: number; droppedNames: string[]; limit: number; truncated: boolean };
  excluded: { count: number; truncated: boolean };
  warnings: string[];
  blocked?: string;
}

export interface LectureDiffView {
  projects: LectureDiffProject[];
  totals: { projects: number; ready: number; commits: number; files: number; additions: number; deletions: number; excluded: number; keptFiles: number; keptChars: number };
  ok: boolean;
  warnings: string[];
}

/** 锚点原文形态（与服务端 ANCHOR_RE 同一条正则，含全局标志故每次新建 lastIndex） */
export const LECTURE_ANCHOR_RE = /\[([^\[\]#\s]+)#L(\d+)(?:-L(\d+))?\]/g;

/** 讲稿内锚点跳转的 href 前缀（`#` 开头 → 由 Markdown 组件拦成应用内事件，不开新窗口） */
export const LECTURE_ANCHOR_PREFIX = '#lck:';

export interface LectureAnchorRef {
  path: string;
  start: number;
  end: number;
}

/**
 * 把讲稿正文里的 `[file#Lx-Ly]` 转成 Markdown 链接 `[file#Lx-Ly](#lck:<编码>)`，供渲染后可点击。
 *
 * 已处在链接文本里的锚点不重复包（`[..](..)` 内出现锚点极少，但 AI 偶发写 `[a#L1](x)` 时
 * 二次包链接会让 markdown-it 把整串当嵌套链接渲染成不可点文本）。
 */
export function linkifyLectureAnchors(text: string): string {
  if (!text) return '';
  return text.replace(LECTURE_ANCHOR_RE, (raw, path: string, from: string, to?: string) => {
    const start = Number(from);
    const end = to ? Number(to) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return raw;
    const href = encodeAnchorHref({ path, start, end });
    return `[${raw}](${href})`;
  });
}

export function encodeAnchorHref(anchor: LectureAnchorRef): string {
  return `${LECTURE_ANCHOR_PREFIX}${encodeURIComponent(`${anchor.path}|${anchor.start}|${anchor.end}`)}`;
}

/** href 解析：非 `#lck:` 前缀或编码畸形一律回 null（调用方按「不可定位」处理，不抛错） */
export function parseAnchorHref(href: string): LectureAnchorRef | null {
  if (!href.startsWith(LECTURE_ANCHOR_PREFIX)) return null;
  let decoded = href.slice(LECTURE_ANCHOR_PREFIX.length);
  try { decoded = decodeURIComponent(decoded); } catch { return null; }
  const [path, start, end] = decoded.split('|');
  if (!path || !start) return null;
  const s = Number(start);
  const e = Number(end ?? start);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s <= 0 || e < s) return null;
  return { path, start: s, end: e };
}

export type LectureDiffRowKind = 'hunk' | 'ctx' | 'add' | 'del';

export interface LectureDiffRow {
  kind: LectureDiffRowKind;
  /** 旧文件行号（add 行无） */
  oldLine?: number;
  /** 新文件行号（del 行无）——锚点按这一侧落点 */
  newLine?: number;
  text: string;
}

/** hunk 展开为带双列行号的渲染行（行号按 hunk 头起算，前缀剥离后只留正文） */
export function hunkToRows(hunk: LectureDiffHunk): LectureDiffRow[] {
  const rows: LectureDiffRow[] = [{
    kind: 'hunk',
    text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
  }];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of hunk.lines) {
    const mark = line[0];
    if (mark === '+') {
      rows.push({ kind: 'add', newLine, text: line.slice(1) });
      newLine += 1;
    } else if (mark === '-') {
      rows.push({ kind: 'del', oldLine, text: line.slice(1) });
      oldLine += 1;
    } else {
      rows.push({ kind: 'ctx', oldLine, newLine, text: line.startsWith(' ') ? line.slice(1) : line });
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
}

/** hunk 的新侧行区间 [newStart, newStart + newLines - 1] */
export function hunkNewRange(hunk: LectureDiffHunk): { start: number; end: number } {
  return { start: hunk.newStart, end: hunk.newStart + Math.max(0, hunk.newLines - 1) };
}

/**
 * 锚点落在哪个 hunk：优先「区间包含 start」；都不包含时取最近的一个（行号是生成时点快照，
 * 采集后有新提交会让区间错开——PRD FR-4.3 的时效声明），仍无 hunk 则 -1。
 */
export function findAnchorHunkIndex(hunks: readonly LectureDiffHunk[], start: number): number {
  let nearest = -1;
  let nearestGap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < hunks.length; i += 1) {
    const { start: s, end: e } = hunkNewRange(hunks[i]);
    if (start >= s && start <= e) return i;
    const gap = start < s ? s - start : start - e;
    if (gap < nearestGap) {
      nearest = i;
      nearestGap = gap;
    }
  }
  return nearest;
}

/** 在已展开的渲染行里定位锚点首行：命中 newLine===start 的行，否则回区间内首个 new 侧行，否则 -1 */
export function findAnchorRowIndex(rows: readonly LectureDiffRow[], start: number, end: number): number {
  const exact = rows.findIndex((r) => r.newLine === start);
  if (exact >= 0) return exact;
  return rows.findIndex((r) => r.newLine !== undefined && r.newLine >= start && r.newLine <= end);
}

/** 锚点高亮的行范围：从首行起把连续的 new 侧行（ctx/add）一并标出，最多到 end */
export function anchorRowIndexes(rows: readonly LectureDiffRow[], anchor: LectureAnchorRef): number[] {
  const first = findAnchorRowIndex(rows, anchor.start, anchor.end);
  if (first < 0) return [];
  const out: number[] = [];
  for (let i = first; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.kind === 'hunk') break;
    if (r.newLine === undefined) continue; // del 行不属于新侧区间
    if (r.newLine > anchor.end) break;
    out.push(i);
    if (r.newLine === anchor.end) break;
  }
  return out.length ? out : [first];
}

/** 与服务端 lectureContext.moduleOf 同语义：最后一个 `/` 之前为模块，无目录归「(根目录)」 */
export function moduleOfPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '(根目录)' : path.slice(0, i);
}

export interface LectureFileGroup {
  module: string;
  files: LectureDiffFile[];
}

/** 文件树分组：按模块聚簇，模块与模块内文件均按路径升序（确定性，供门逐字比对） */
export function groupFilesByModule(files: readonly LectureDiffFile[]): LectureFileGroup[] {
  const map = new Map<string, LectureDiffFile[]>();
  for (const f of files) {
    const m = moduleOfPath(f.path);
    const list = map.get(m);
    if (list) list.push(f);
    else map.set(m, [f]);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([module, list]) => ({
      module,
      files: [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    }));
}

/** 渲染行在左栏的 DOM 标识（门按同一串查元素，避免依赖样式类名）；行号是 hunk 内的下标，故必须带 hunk 序号 */
export function diffRowDomId(projectId: string, path: string, hunkIndex: number, rowIndex: number): string {
  return `lck-${projectId}-${path}-h${hunkIndex}-r${rowIndex}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 锚点在左栏的落点（一个文件、一个 hunk、若干应高亮的行） */
export interface LectureAnchorHit {
  projectId: string;
  path: string;
  hunkIndex: number;
  /** 该 hunk 展开后的渲染行（下标 0 是 hunk 头） */
  rows: LectureDiffRow[];
  /** 应高亮的行在 `rows` 中的下标（升序，至少 1 个） */
  rowIndexes: number[];
  /** 锚点行号是否真落在该 hunk 的新侧区间内；false=记录行号已被后续提交推走，给的是最近 hunk 的首行 */
  exact: boolean;
}

/**
 * 在某个项目的 diff 里解析锚点落点：文件名匹配 → 选 hunk → 展开行 → 求高亮行下标。
 * 任一环节失配回 null（调用方给「定位失败 + 出路」文案，不静默）。
 *
 * 记录行号没被任何 hunk 覆盖时不判死（FR-4.3：行号是生成时点快照，采集后新提交会让区间错开），
 * 按最近 hunk 的首个新侧行给出近似落点；连一个新增侧行都没有（纯删除 hunk）才回 null。
 */
export function locateAnchorInProject(project: LectureDiffProject, anchor: LectureAnchorRef): LectureAnchorHit | null {
  const file = project.files.find((f) => f.path === anchor.path);
  if (!file || file.binary || file.hunks.length === 0) return null;
  const hunkIndex = findAnchorHunkIndex(file.hunks, anchor.start);
  if (hunkIndex < 0) return null;
  const rows = hunkToRows(file.hunks[hunkIndex]);
  const rowIndexes = anchorRowIndexes(rows, anchor);
  if (rowIndexes.length > 0) {
    return { projectId: project.projectId, path: file.path, hunkIndex, rows, rowIndexes, exact: true };
  }
  const firstNewSide = rows.findIndex((r) => r.newLine !== undefined);
  if (firstNewSide < 0) return null;
  return { projectId: project.projectId, path: file.path, hunkIndex, rows, rowIndexes: [firstNewSide], exact: false };
}

/** 跨项目解析锚点（按项目顺序首个命中；patch 模式与 git 模式同一条路径） */
export function locateAnchor(projects: readonly LectureDiffProject[], anchor: LectureAnchorRef): LectureAnchorHit | null {
  for (const p of projects) {
    const hit = locateAnchorInProject(p, anchor);
    if (hit) return hit;
  }
  return null;
}

/** 高亮行的 DOM 标识集合（第一个即滚动目标） */
export function anchorHitRowIds(hit: LectureAnchorHit): { ids: string[]; primary: string } {
  const ids = hit.rowIndexes.map((i) => diffRowDomId(hit.projectId, hit.path, hit.hunkIndex, i));
  return { ids, primary: ids[0] };
}

/** 锚点跳转结果的文案口径：命中给「已定位」，未命中给出路（不静默） */
export function anchorLocateMessage(anchor: LectureAnchorRef, hit: LectureAnchorHit | null, projects: readonly LectureDiffProject[]): string {
  const shown = `L${anchor.start}${anchor.end > anchor.start ? `-${anchor.end}` : ''}`;
  if (hit?.exact) return `已定位 ${anchor.path} ${shown}（hunk ${hit.hunkIndex + 1}/${hit.rows.length > 1 ? hit.rows.length - 1 : 1} 行）`;
  if (hit) {
    return `已按最近 hunk 定位 ${anchor.path}（记录行号 ${shown} 未被采集区间覆盖，代码可能在生成后变动）`;
  }
  const file = projects.flatMap((p) => p.files).find((f) => f.path === anchor.path);
  const reason = !file
    ? '左栏未找到该文件（可能被排除规则或 2MB 预算移出）'
    : file.binary
      ? '二进制文件无文本行可定位'
      : `该文件 ${file.hunks.length} 个 hunk 均不覆盖 ${shown}`;
  return `锚点 ${anchor.path}#${shown} 定位失败：${reason}（代码可能已在生成后变动）`;
}
