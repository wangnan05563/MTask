/**
 * 代码评审会议讲稿 · 生成核心（六期 2.5 / PRD FR-4.1~FR-4.5）。
 *
 * 两段式：大纲先行（1 次 askJson，产出八段固定骨架 + 讨论问题，可二次提交修订），
 * 再逐组展开（每个「项目/模块」组 1 次 askStream，段落内逐文件四段式）。
 *
 * 纪律：
 *  - 八段骨架顺序固定，大纲校验不通过由 askJson 自带重试 1 次后失败；
 *  - 讲稿条目必须带锚点 `[file#Lx-Ly]`，锚点落点须命中该文件的变更行区间；
 *  - 「为什么」只取 commit message，证据不足写「意图不明，需会上确认」，禁止编造；
 *  - 锚点记录 blob SHA 与采集终点 commit，生成后可用 verifyLectureAnchors 复核是否失准；
 *  - 多项目走总-分-总：开场归并跨项目主题、每项目独立章、结语收「跨项目关联与不一致点」。
 */
import { createHash } from 'node:crypto';
import { AIService } from './AIService';
import { parseAiJson } from './kickoffService';
import { collectFileAtRevision, type GitCommitEntry, type GitFileChange } from './gitCollect';
import { trimMiddle } from './lectureContext';

export const LECTURE_SECTIONS = [
  { key: 'opening', label: '开场白' },
  { key: 'summary', label: '变更摘要' },
  { key: 'walkthrough', label: '逐项目-逐模块讲解' },
  { key: 'risks', label: '风险清单' },
  { key: 'standards', label: '规范检查' },
  { key: 'improvements', label: '改进建议' },
  { key: 'questions', label: '讨论问题' },
  { key: 'closing', label: '结语' },
] as const;

export type LectureSectionKey = (typeof LECTURE_SECTIONS)[number]['key'];
export const LECTURE_SECTION_KEYS = LECTURE_SECTIONS.map((s) => s.key) as LectureSectionKey[];

export function lectureSectionLabel(key: LectureSectionKey): string {
  return LECTURE_SECTIONS.find((s) => s.key === key)?.label ?? key;
}

/** 大纲阶段预算：只给文件清单/stat/commit 主题，不给整份 diff */
export const LECTURE_OUTLINE_BUDGET = 8_000;
const LECTURE_COMMIT_BUDGET = 2_000;
const OUTLINE_TITLE_MAX = 30;
const OUTLINE_BULLET_MAX = 5;
const OUTLINE_BULLET_CHARS = 40;
const OUTLINE_QUESTION_MIN = 1;
const OUTLINE_QUESTION_MAX = 8;
const OUTLINE_QUESTION_CHARS = 80;
const COMMIT_MAX = 50;
const ANCHOR_SPAN_MAX = 200;

export interface LectureOutlineSection {
  key: LectureSectionKey;
  title: string;
  bullets: string[];
  /** 多项目时「逐项目讲解」必须覆盖全部项目 id；单项目可省略 */
  projectIds?: string[];
}

export interface LectureOutline {
  sections: LectureOutlineSection[];
  discussion_questions: string[];
}

export interface LectureProjectRef {
  id: string;
  name: string;
}

export interface OutlinePromptInput {
  projects: readonly LectureProjectRef[];
  /** T02868 的 manifestText（全量文件清单+stat） */
  manifestText: string;
  /** 已分好的组（项目/模块/文件数），供大纲决定逐项目章结构 */
  groups?: ReadonlyArray<{ projectName: string; module: string; files: number }>;
  commits?: readonly GitCommitEntry[];
  style?: string;
  extraNote?: string;
}

export interface OutlinePrompt {
  system: string;
  user: string;
  truncated: boolean;
}

const asText = (v: unknown): string => (v == null ? '' : String(v)).trim();
const clipText = (text: string, limit: number): { text: string; truncated: boolean } => {
  const r = trimMiddle(text, limit, '大纲输入');
  return { text: r.text, truncated: r.truncated };
};

export function buildLectureOutlinePrompt(input: OutlinePromptInput): OutlinePrompt {
  const manifest = clipText(input.manifestText, LECTURE_OUTLINE_BUDGET);
  const groupText = clipText((input.groups ?? [])
    .map((g) => `- ${g.projectName} / ${g.module}：${g.files} 个文件`)
    .join('\n'), 2_000);
  const commitText = clipText((input.commits ?? [])
    .slice(0, COMMIT_MAX)
    .map((c) => `- ${c.sha.slice(0, 8)} ${c.subject}`.trim())
    .join('\n'), LECTURE_COMMIT_BUDGET);
  const truncated = manifest.truncated || groupText.truncated || commitText.truncated;
  const multi = input.projects.length > 1;
  const labels = LECTURE_SECTIONS.map((s) => `${s.key}=${s.label}`).join(' / ');

  const system = `你是「代码评审会议讲稿」的大纲编排器。只输出一个 JSON 对象，不要解释文字，不要代码围栏。
对象形如 {"sections":[{"key":"","title":"","bullets":[""],"projectIds":[""]}],"discussion_questions":[""]}，约束逐条遵守：
1. sections 必须且只能有 8 项，key 按固定顺序：${LECTURE_SECTION_KEYS.join(' → ')}（${labels}）；
2. title ≤${OUTLINE_TITLE_MAX} 字；bullets ≤${OUTLINE_BULLET_MAX} 条、每条 ≤${OUTLINE_BULLET_CHARS} 字；
3. discussion_questions ${OUTLINE_QUESTION_MIN}~${OUTLINE_QUESTION_MAX} 条、每条 ≤${OUTLINE_QUESTION_CHARS} 字，是会上要问的具体问题，不是泛泛而谈；
4. 大纲只描述「讲什么」，不写代码细节、不写数字、不编造文件或结论；
5. ${multi
    ? '多项目走总-分-总：开场白归并跨项目变更主题，逐项目-逐模块讲解按项目分章（projectIds 必须覆盖全部项目），结语收「跨项目关联与不一致点」；'
    : '单项目完整稿：按变更模块组织逐项目-逐模块讲解，projectIds 可省略；'}
6. bullets 只能引用【文件清单】【分组】【commit 主题】里出现过的项目名/模块/文件名，不得自造；
7. 「风险清单」按 高/中/低 组织，「规范检查」只列可从本仓配置/代码事实判断的项目，「改进建议」必须可执行；
8. 讲稿是「可照念」的口语句式，大纲 bullets 也写成短句，不要术语堆叠。`;

  const user = [
    `【项目数】${input.projects.length}${multi ? '（多项目：总-分-总）' : '（单项目）'}`,
    `【项目清单】${input.projects.map((p) => `${p.name}（id=${p.id}）`).join('；')}`,
    `【文件清单】\n${manifest.text}`,
    groupText.text ? `【分组】\n${groupText.text}` : '',
    commitText.text ? `【commit 主题】（「为什么改」的证据源）\n${commitText.text}` : '',
    input.style ? `【讲稿风格】${input.style}` : '',
    input.extraNote ? `【用户补充要求】${input.extraNote}` : '',
    '请输出上述 JSON 对象（8 段固定骨架 + 讨论问题）。',
  ].filter(Boolean).join('\n\n');

  return { system, user, truncated };
}

export interface ParseOutlineOptions {
  /** 重试轮：可自愈的超限项截断并记 warning，不再整稿判废 */
  lenient?: boolean;
}

function normalizeBullets(raw: unknown, at: string, opts: ParseOutlineOptions, warnings: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${at} bullets 不是数组`);
  const out: string[] = [];
  for (const b of raw) {
    const text = asText(b);
    if (!text) continue;
    const pts = [...text];
    if (pts.length > OUTLINE_BULLET_CHARS) {
      if (!opts.lenient) throw new Error(`${at} 第 ${out.length + 1} 条 bullet 超出 ${OUTLINE_BULLET_CHARS} 字：${pts.slice(0, 20).join('')}…`);
      out.push(`${pts.slice(0, OUTLINE_BULLET_CHARS - 1).join('')}…`);
      warnings.push(`${at} 第 ${out.length} 条 bullet 超长，已截断`);
    } else {
      out.push(text);
    }
  }
  if (out.length > OUTLINE_BULLET_MAX) {
    if (!opts.lenient) throw new Error(`${at} bullets ${out.length} 条超出 ${OUTLINE_BULLET_MAX} 条上限`);
    warnings.push(`${at} bullets ${out.length} 条超出 ${OUTLINE_BULLET_MAX} 条，已截断`);
    out.length = OUTLINE_BULLET_MAX;
  }
  return out;
}

export function parseLectureOutline(
  raw: unknown,
  projectIds: readonly string[],
  opts: ParseOutlineOptions = {},
  warnings: string[] = [],
): LectureOutline {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('大纲必须是 JSON 对象');
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.sections)) throw new Error('大纲缺少 sections 数组');
  const seen = new Set<string>();
  const sections: LectureOutlineSection[] = [];
  o.sections.forEach((v, i) => {
    const at = `第 ${i + 1} 段`;
    if (!v || typeof v !== 'object') throw new Error(`${at} 不是对象`);
    const s = v as Record<string, unknown>;
    const key = asText(s.key);
    if (!(LECTURE_SECTION_KEYS as string[]).includes(key)) throw new Error(`${at} key「${key || '空'}」不在八段骨架（${LECTURE_SECTION_KEYS.join(' / ')}）`);
    if (seen.has(key)) throw new Error(`${at} key「${key}」重复`);
    seen.add(key);
    const rawTitle = asText(s.title);
    if (!rawTitle) throw new Error(`${at}（${lectureSectionLabel(key as LectureSectionKey)}）缺少标题`);
    const title = [...rawTitle].length > OUTLINE_TITLE_MAX ? [...rawTitle].slice(0, OUTLINE_TITLE_MAX).join('') : rawTitle;
    if (title !== rawTitle) {
      if (!opts.lenient) throw new Error(`${at} 标题超出 ${OUTLINE_TITLE_MAX} 字`);
      warnings.push(`${at} 标题超长，已截断`);
    }
    const bullets = normalizeBullets(s.bullets, at, opts, warnings);
    let ids: string[] | undefined;
    if (s.projectIds !== undefined) {
      if (!Array.isArray(s.projectIds)) throw new Error(`${at} projectIds 不是数组`);
      ids = [...new Set(s.projectIds.map(asText).filter(Boolean))];
      const unknown = ids.filter((id) => !projectIds.includes(id));
      if (unknown.length) throw new Error(`${at} projectIds 含未知项目：${unknown.join('、')}`);
    }
    sections.push({ key: key as LectureSectionKey, title, bullets, ...(ids ? { projectIds: ids } : {}) });
  });

  const orderOk = sections.length === LECTURE_SECTION_KEYS.length
    && sections.every((s, i) => s.key === LECTURE_SECTION_KEYS[i]);
  if (!orderOk) {
    throw new Error(`sections 必须恰好 ${LECTURE_SECTION_KEYS.length} 段且按 ${LECTURE_SECTION_KEYS.join(' → ')} 排列（当前 ${sections.map((s) => s.key).join(' → ') || '空'}）`);
  }

  if (projectIds.length > 1) {
    const walk = sections.find((s) => s.key === 'walkthrough')!;
    const covered = new Set(walk.projectIds ?? []);
    const missing = projectIds.filter((id) => !covered.has(id));
    if (missing.length) {
      if (!opts.lenient) throw new Error(`多项目大纲的「逐项目-逐模块讲解」未覆盖项目：${missing.join('、')}`);
      walk.projectIds = [...projectIds];
      warnings.push('多项目大纲未覆盖全部项目，已按请求范围补齐 projectIds');
    }
  }

  const rawQ = o.discussion_questions;
  if (!Array.isArray(rawQ)) throw new Error('大纲缺少 discussion_questions 数组');
  const questions = [...new Set(rawQ.map(asText).filter(Boolean))];
  if (questions.length < OUTLINE_QUESTION_MIN) throw new Error(`discussion_questions 至少 ${OUTLINE_QUESTION_MIN} 条`);
  if (questions.length > OUTLINE_QUESTION_MAX) {
    if (!opts.lenient) throw new Error(`discussion_questions 超出 ${OUTLINE_QUESTION_MAX} 条`);
    warnings.push(`discussion_questions 超出 ${OUTLINE_QUESTION_MAX} 条，已截断`);
    questions.length = OUTLINE_QUESTION_MAX;
  }
  for (let i = 0; i < questions.length; i++) {
    if ([...questions[i]].length <= OUTLINE_QUESTION_CHARS) continue;
    if (!opts.lenient) throw new Error(`第 ${i + 1} 条讨论问题超出 ${OUTLINE_QUESTION_CHARS} 字`);
    questions[i] = `${[...questions[i]].slice(0, OUTLINE_QUESTION_CHARS - 1).join('')}…`;
    warnings.push(`第 ${i + 1} 条讨论问题超长，已截断`);
  }

  return { sections, discussion_questions: questions };
}

export type LectureOutlineEvent = { type: 'outline_ready'; outline: LectureOutline };

export interface OutlineRunOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  onEvent?: (event: LectureOutlineEvent) => void;
}

export interface OutlineRunResult {
  ok: boolean;
  outline?: LectureOutline;
  prompt: OutlinePrompt;
  error?: string;
}

export async function outlineLecture(
  toolId: string,
  input: OutlinePromptInput,
  opts: OutlineRunOptions = {},
): Promise<OutlineRunResult> {
  if (input.projects.length === 0) throw new Error('没有可讲解的项目');
  if (!input.manifestText.trim()) throw new Error('区间内没有可讲解的变更，已阻止空壳大纲');
  const prompt = buildLectureOutlinePrompt(input);
  const projectIds = input.projects.map((p) => p.id);
  const res = await AIService.askJson<LectureOutline>(
    toolId,
    prompt.system,
    prompt.user,
    (content) => parseLectureOutline(parseAiJson(content), projectIds),
    {
      temperature: 0,
      signal: opts.signal,
      maxTokens: opts.maxTokens,
      retrySystemFromError: (lastError) => `${prompt.system}\n\n【上次输出不合格原因】${lastError}\n请只输出修正后的 JSON 对象。`,
    },
  );
  if (!res.ok || !res.data) return { ok: false, prompt, error: res.error ?? '大纲生成失败' };
  opts.onEvent?.({ type: 'outline_ready', outline: res.data });
  return { ok: true, outline: res.data, prompt };
}

// ---------- 逐节展开 ----------

export interface LectureSectionGroup {
  projectId: string;
  projectName: string;
  module: string;
  /** T02868 的组文本（≤ LECTURE_CONTEXT_BUDGET） */
  content: string;
  files: readonly GitFileChange[];
}

export interface SectionPromptInput {
  section: LectureOutlineSection;
  outline?: LectureOutline;
  project: LectureProjectRef;
  group: Pick<LectureSectionGroup, 'module' | 'content'>;
  files: readonly GitFileChange[];
  commits?: readonly GitCommitEntry[];
  style?: string;
  extraNote?: string;
}

/** 每文件「新增行」区间（锚点允许落点，1-based，含端点） */
export function changedLineRanges(files: readonly GitFileChange[], limit = 200): Array<{ path: string; ranges: Array<[number, number]> }> {
  const out: Array<{ path: string; ranges: Array<[number, number]> }> = [];
  for (const f of files.slice(0, limit)) {
    const ranges: Array<[number, number]> = [];
    for (const h of f.hunks) {
      if (h.newLines <= 0) continue;
      ranges.push([h.newStart, h.newStart + h.newLines - 1]);
    }
    out.push({ path: f.path, ranges });
  }
  return out;
}

function rangesText(files: readonly GitFileChange[]): string {
  return changedLineRanges(files)
    .map((f) => `- ${f.path}：${f.ranges.length ? f.ranges.map(([a, b]) => (a === b ? `L${a}` : `L${a}-L${b}`)).join('、') : '仅删除/二进制，无新增行'}`)
    .join('\n');
}

export function buildSectionPrompt(input: SectionPromptInput): { system: string; user: string } {
  const fourPart = input.section.key === 'walkthrough';
  const commitText = clipText((input.commits ?? [])
    .slice(0, COMMIT_MAX)
    .map((c) => `- ${c.sha.slice(0, 8)} ${c.subject}`.trim())
    .join('\n'), LECTURE_COMMIT_BUDGET).text;
  const outlineText = (input.outline?.sections ?? []).map((s) => `- ${lectureSectionLabel(s.key)}：${s.title}`).join('\n');

  const system = `你是代码评审会议的讲稿撰写人。只输出「${lectureSectionLabel(input.section.key)}」这一节的 Markdown 正文，不要其他章节、不要代码围栏、不要解释你的做法。
硬性要求：
1. 讲稿是给主持人照念的口语，每段 ≤3 句，句子短、可朗读；不要写成分点报告体。
2. 每条结论、风险、建议都必须带锚点，格式 \`[相对路径#L起始-L结束]\`；行号必须落在【可用锚点行】列出的该文件新增行区间内，不得指向未变更行。
3. 「为什么改」只以【commit 主题】与给定上下文为证据；证据不足时原样写「意图不明，需会上确认」，禁止编造动机、需求、数字或规范条文。
4. 只使用给定上下文；不要引入外部知识，不要虚构文件、函数或调用关系。
5. 不重复其他章节的内容（八段结构已由大纲锁定）${outlineText ? `：\n${outlineText}` : ''}。
${fourPart
    ? `6. 逐文件讲解固定四段式：**要点**（改了什么+为什么）/ **潜在风险** / **规范检查** / **改进建议**；每个变更文件都要有这四段。`
    : `6. 风险按「高/中/低」标注并带锚点；规范检查只写能从本仓配置或代码事实确认的项；改进建议必须具体可执行。`}
${input.section.key === 'opening' || input.section.key === 'closing'
    ? '7. 多项目时按总-分-总：开场归并跨项目变更主题，结语点出「跨项目关联与不一致点」；单项目就聚焦本项目的整体脉络。'
    : '7. 本节只覆盖给定的项目/模块范围，不要越界讲其他模块。'}`;

  const user = [
    `【本节】${lectureSectionLabel(input.section.key)} — ${input.section.title}`,
    input.section.bullets.length ? `【大纲要点】\n${input.section.bullets.map((b) => `- ${b}`).join('\n')}` : '',
    `【项目】${input.project.name}（id=${input.project.id}）`,
    `【模块】${input.group.module}`,
    commitText ? `【commit 主题】\n${commitText}` : '【commit 主题】（无）',
    `【可用锚点行】\n${rangesText(input.files)}`,
    `【变更上下文】\n${input.group.content}`,
    input.style ? `【讲稿风格】${input.style}` : '',
    input.extraNote ? `【用户补充要求】${input.extraNote}` : '',
    `请只输出「${lectureSectionLabel(input.section.key)}」这一节的讲稿正文。`,
  ].filter(Boolean).join('\n\n');

  return { system, user };
}

export interface LectureAnchor {
  file: string;
  startLine: number;
  endLine: number;
  /** 生成时点该文件 blob SHA（sha1 of `blob <len>\\0<content>`） */
  blobSha?: string;
  /** 采集终点的 commit SHA（锚点快照时刻） */
  baseCommit?: string;
}

export interface AnchorIssue {
  anchor: LectureAnchor;
  reason: string;
}

const ANCHOR_RE = /\[([^\[\]#\s]+)#L(\d+)(?:-L(\d+))?\]/g;

export function extractLectureAnchors(text: string): LectureAnchor[] {
  const out: LectureAnchor[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(ANCHOR_RE)) {
    const file = m[1].trim();
    const startLine = Number(m[2]);
    const endLine = m[3] ? Number(m[3]) : startLine;
    const key = `${file}#${startLine}-${endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, startLine, endLine });
  }
  return out;
}

/** 锚点落点校验：文件必须在本次变更里，行号非空且与某个新增行区间重叠 */
export function validateLectureAnchors(text: string, files: readonly GitFileChange[]): { anchors: LectureAnchor[]; issues: AnchorIssue[] } {
  const anchors = extractLectureAnchors(text);
  const byPath = new Map<string, GitFileChange>();
  for (const f of files) {
    byPath.set(f.path, f);
    if (f.oldPath) byPath.set(f.oldPath, f);
  }
  const ranges = new Map<string, Array<[number, number]>>();
  for (const f of files) {
    const list: Array<[number, number]> = [];
    for (const h of f.hunks) {
      if (h.newLines > 0) list.push([h.newStart, h.newStart + h.newLines - 1]);
    }
    ranges.set(f.path, list);
  }
  const issues: AnchorIssue[] = [];
  for (const a of anchors) {
    const f = byPath.get(a.file);
    if (!f) { issues.push({ anchor: a, reason: `文件不在本次变更：${a.file}` }); continue; }
    if (!Number.isInteger(a.startLine) || !Number.isInteger(a.endLine) || a.startLine < 1 || a.endLine < a.startLine) {
      issues.push({ anchor: a, reason: `行号区间非法：L${a.startLine}-L${a.endLine}` }); continue;
    }
    if (a.endLine - a.startLine + 1 > ANCHOR_SPAN_MAX) {
      issues.push({ anchor: a, reason: `锚点跨度过大（>${ANCHOR_SPAN_MAX} 行）` }); continue;
    }
    const changed = ranges.get(f.path) ?? [];
    const hit = changed.some(([s, e]) => a.startLine <= e && a.endLine >= s);
    if (!hit) issues.push({ anchor: a, reason: '锚点未落在该文件的新增行区间' });
  }
  return { anchors, issues };
}

/** git blob SHA-1：与 `git hash-object` 同口径 */
export function hashGitBlob(content: string): string {
  const buf = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

export interface AnchorBlobResult {
  anchors: LectureAnchor[];
  warnings: string[];
}

/** 给锚点补 blob SHA/base commit（生成时点快照）；读不到的文件只告警不阻断 */
export async function attachLectureAnchorBlobs(
  workspacePath: string,
  anchors: readonly LectureAnchor[],
  revision: string,
): Promise<AnchorBlobResult> {
  const hashes = new Map<string, string | null>();
  const warnings: string[] = [];
  const out: LectureAnchor[] = [];
  for (const a of anchors) {
    if (!hashes.has(a.file)) {
      try {
        hashes.set(a.file, hashGitBlob(await collectFileAtRevision(workspacePath, revision, a.file)));
      } catch (e) {
        hashes.set(a.file, null);
        warnings.push(`锚点文件读取失败（${a.file}）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const sha = hashes.get(a.file);
    out.push({ ...a, ...(sha ? { blobSha: sha } : {}), baseCommit: revision });
  }
  return { anchors: out, warnings };
}

export interface AnchorVerifyResult {
  ok: boolean;
  checked: number;
  /** 失准锚点：blob 变化或文件已不可读 */
  stale: AnchorIssue[];
}

/** 复核锚点：当前版本 blob 与生成时记录不一致 → 代码已变动，锚点可能失准 */
export async function verifyLectureAnchors(
  workspacePath: string,
  anchors: readonly LectureAnchor[],
  revision: string,
): Promise<AnchorVerifyResult> {
  const stale: AnchorIssue[] = [];
  const hashes = new Map<string, string | null>();
  let checked = 0;
  for (const a of anchors) {
    if (!a.blobSha) {
      stale.push({ anchor: a, reason: '锚点未记录 blob SHA，无法复核' });
      continue;
    }
    if (!hashes.has(a.file)) {
      try {
        hashes.set(a.file, hashGitBlob(await collectFileAtRevision(workspacePath, revision, a.file)));
      } catch {
        hashes.set(a.file, null);
      }
    }
    const sha = hashes.get(a.file);
    if (!sha) { stale.push({ anchor: a, reason: '文件在当前版本不可读（已删除或移动），锚点可能失准' }); continue; }
    checked += 1;
    if (sha !== a.blobSha) stale.push({ anchor: a, reason: '代码已变动，锚点可能失准（blob 不一致）' });
  }
  return { ok: stale.length === 0, checked, stale };
}

export interface SectionRunOptions {
  onDelta?: (text: string, meta: { projectName: string; module: string }) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SectionGroupResult {
  projectId: string;
  projectName: string;
  module: string;
  ok: boolean;
  text: string;
  error?: string;
  anchors: LectureAnchor[];
  anchorIssues: AnchorIssue[];
}

export interface SectionRunResult {
  ok: boolean;
  text: string;
  groups: SectionGroupResult[];
  error?: string;
  aborted: boolean;
}

export interface SectionRunInput {
  toolId: string;
  section: LectureOutlineSection;
  outline?: LectureOutline;
  groups: readonly LectureSectionGroup[];
  commits?: readonly GitCommitEntry[];
  style?: string;
  extraNote?: string;
}

/** 每个项目/模块组一次 askStream；单组失败只标该组，不拖垮已成功组 */
export async function generateLectureSection(input: SectionRunInput, opts: SectionRunOptions = {}): Promise<SectionRunResult> {
  if (input.groups.length === 0) return { ok: false, text: '', groups: [], error: '没有可生成的分组', aborted: false };
  const results: SectionGroupResult[] = [];
  let aborted = false;
  for (const group of input.groups) {
    if (opts.signal?.aborted) { aborted = true; break; }
    const prompt = buildSectionPrompt({
      section: input.section,
      outline: input.outline,
      project: { id: group.projectId, name: group.projectName },
      group: { module: group.module, content: group.content },
      files: group.files,
      commits: input.commits,
      style: input.style,
      extraNote: input.extraNote,
    });
    const meta = { projectName: group.projectName, module: group.module };
    const res = await AIService.askStream(
      input.toolId,
      prompt.system,
      prompt.user,
      (delta) => opts.onDelta?.(delta, meta),
      opts.timeoutMs,
      opts.signal,
    );
    const text = res.ok ? (res.content ?? '') : '';
    const { anchors, issues } = res.ok ? validateLectureAnchors(text, group.files) : { anchors: [], issues: [] };
    results.push({
      projectId: group.projectId,
      projectName: group.projectName,
      module: group.module,
      ok: res.ok,
      text,
      ...(res.ok ? {} : { error: res.error ?? '生成失败' }),
      anchors,
      anchorIssues: issues,
    });
    if (opts.signal?.aborted) { aborted = true; break; }
  }
  const okGroups = results.filter((r) => r.ok && r.text.trim());
  const failed = results.filter((r) => !r.ok);
  const text = okGroups
    .map((r) => `### 项目「${r.projectName}」/ 模块 ${r.module}\n\n${r.text.trim()}`)
    .join('\n\n');
  return {
    ok: failed.length === 0 && !aborted,
    text,
    groups: results,
    ...(failed.length ? { error: failed.map((r) => `${r.projectName}/${r.module}：${r.error}`).join('；') } : {}),
    aborted,
  };
}

// ---------- 装配 ----------

export interface AssembledSection {
  key: LectureSectionKey;
  text: string;
}

export interface AssembleLectureInput {
  title: string;
  projectNames: readonly string[];
  sections: readonly AssembledSection[];
  generatedAt?: string;
}

/** 按八段固定顺序拼装成最终 md；缺节显式占位，不 silently 丢结构 */
export function assembleLectureMarkdown(input: AssembleLectureInput): string {
  const head = [
    `# ${input.title}`,
    '',
    `- 项目：${input.projectNames.join('、')}`,
    ...(input.generatedAt ? [`- 生成时间：${input.generatedAt}`] : []),
    '',
  ];
  const body: string[] = [];
  for (const meta of LECTURE_SECTIONS) {
    const found = input.sections.find((s) => s.key === meta.key);
    body.push(`## ${meta.label}`, '', found && found.text.trim() ? found.text.trim() : '（本节未生成）', '');
  }
  return `${head.join('\n')}\n${body.join('\n')}`.trimEnd() + '\n';
}
