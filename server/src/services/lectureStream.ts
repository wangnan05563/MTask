/**
 * 代码评审会议讲稿 · 流式编排（六期 2.6 / PRD FR-5.1、FR-5.2）。
 *
 * 阶段：collecting → preflight → outline → section:<n>；事件由路由层映射为 SSE 的
 * stage/chunk/done/error，客户端断开即 abort（与既有 AI 流式端点同构，零新范式）。
 *
 * 生成策略（与 T02869 生成核心对齐）：
 *  - 大纲先行 1 次 askJson；用户已确认大纲时直接沿用，跳过该次 AI；
 *  - 「逐项目-逐模块讲解」按上下文分组逐组 askStream，组间失败互不拖累；
 *  - 风险/规范/改进按项目汇总，开场/摘要/讨论/结语为跨项目汇总（总-分-总）；
 *  - 汇总节只在超预算时保头保尾截断并显式告警，不静默丢文件。
 */
import {
  LECTURE_SECTIONS,
  LECTURE_SECTION_KEYS,
  assembleLectureMarkdown,
  attachLectureAnchorBlobs,
  generateLectureSection,
  lectureSectionLabel,
  outlineLecture,
  parseLectureOutline,
  type AnchorIssue,
  type LectureAnchor,
  type LectureOutline,
  type LectureOutlineSection,
  type LectureSectionKey,
} from './lectureService';
import {
  collectLectureScope,
  parseLectureScopeRequest,
  LectureScopeError,
  type LectureCollectedProject,
  type LectureProjectScopeInput,
} from './lectureScope';
import {
  buildLectureContext,
  expandLectureSymbols,
  resolveLectureContextBudget,
  trimMiddle,
  type LectureContextResult,
} from './lectureContext';
import type { GitCommitEntry, GitFileChange } from './gitCollect';
import { estimateLectureRun, type LecturePreflightEstimate } from './lecturePreflight';
import { assessAiRunDeviation, type RunUsageDeviation } from './preflightEstimate';

export class LectureStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LectureStreamError';
  }
}

export interface LectureStreamRequest {
  toolId: string;
  projects: LectureProjectScopeInput[];
  excludes: string[];
  style?: string;
  extraNote?: string;
  title?: string;
  /** 用户在「大纲确认」后回传的修订稿；提供时跳过大纲 AI 调用 */
  outline?: LectureOutline;
  /** FR-4.1 两段式第一段：只要大纲、不生成正文（同一端点收口，避免第二套采集/上下文口径） */
  outlineOnly?: boolean;
  /** PRD §6.2「从第 n 节继续」：从该节开始往后生成，之前的节由前端用已保留正文补齐 */
  resumeFrom?: LectureSectionKey;
  /** PRD §7.4 单节失败重试：只跑点名的节（与 resumeFrom 互斥时以点名为准） */
  sectionKeys?: LectureSectionKey[];
  contextBudget?: number;
  maxTokens?: number;
}

export interface LectureStageEvent {
  /** collecting | preflight | outline | section:<n> */
  phase: string;
  msg: string;
  /** 0~100 */
  progress: number;
  data?: Record<string, unknown>;
}

export interface LectureChunkEvent {
  section: LectureSectionKey;
  projectId: string;
  projectName: string;
  module: string;
  text: string;
}

export interface LectureStreamHooks {
  signal?: AbortSignal;
  onStage?: (event: LectureStageEvent) => void;
  onChunk?: (event: LectureChunkEvent) => void;
}

export interface LectureSegmentResult {
  projectId: string;
  projectName: string;
  module: string;
  heading: string;
  ok: boolean;
  text: string;
  error?: string;
  anchors: LectureAnchor[];
  anchorIssues: AnchorIssue[];
}

export interface LectureSectionResult {
  key: LectureSectionKey;
  label: string;
  ok: boolean;
  text: string;
  error?: string;
  segments: LectureSegmentResult[];
}

export interface LectureStreamStats {
  projects: number;
  readyProjects: number;
  files: number;
  groups: number;
  chars: number;
  contextBudget: number;
  sections: number;
  segments: number;
  calls: number;
  anchors: number;
  anchorIssues: number;
}

export interface LectureStreamResult {
  ok: boolean;
  aborted: boolean;
  title: string;
  markdown: string;
  outline?: LectureOutline;
  sections: LectureSectionResult[];
  warnings: string[];
  stats: LectureStreamStats;
  anchors: Array<LectureAnchor & { section: LectureSectionKey; projectId: string }>;
  /** T03174（AI-102①）：本次运行所依据的三项预估（含模型版本） */
  estimate?: LecturePreflightEstimate;
  /** T03174（AI-102②）：整轮（非续作/单节重试）完成后的用量偏差复算；中止轮不附 */
  deviation?: RunUsageDeviation;
}

const optionString = (v: unknown, name: string): string | undefined => {
  if (v == null) return undefined;
  if (typeof v !== 'string') throw new LectureStreamError(`${name} 必须是字符串`);
  const text = v.trim();
  return text || undefined;
};

/** SSE 之前的同步校验：参数错直接结构化 400，不让前端在流里猜「是参数还是模型」 */
export function validateLectureStreamBody(body: unknown): LectureStreamRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LectureStreamError('请求体必须是 JSON 对象');
  const b = body as Record<string, unknown>;
  const toolId = typeof b.toolId === 'string' ? b.toolId.trim() : '';
  if (!toolId) throw new LectureStreamError('toolId 必填（生成需要模型工具）');
  const { projects, excludes } = parseLectureScopeRequest(body);
  const style = optionString(b.style, 'style');
  const extraNote = optionString(b.extraNote, 'extraNote');
  const title = optionString(b.title, 'title');

  let outline: LectureOutline | undefined;
  if (b.outline !== undefined) {
    if (!b.outline || typeof b.outline !== 'object' || Array.isArray(b.outline)) throw new LectureStreamError('outline 必须是 JSON 对象');
    try {
      // 回传的大纲只覆盖「可讲解项目」，而这里的项目列表是用户选中的全量范围（含被阻塞/无变更的）：
      // 覆盖度规则是给模型的，不能拿来判废服务端自己产出的大纲，否则「只出大纲 → 按大纲生成正文」必然 400
      outline = parseLectureOutline(b.outline, projects.map((p) => p.projectId), { requireFullCoverage: false });
    } catch (e) {
      // 用户回传的修订稿不合规是入参问题，不能让一次编辑错误变成 500
      throw new LectureStreamError(`outline 校验失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let contextBudget: number | undefined;
  if (b.contextBudget !== undefined) {
    try {
      contextBudget = resolveLectureContextBudget(b.contextBudget);
    } catch (e) {
      throw new LectureStreamError(e instanceof Error ? e.message : String(e));
    }
  }

  let maxTokens: number | undefined;
  if (b.maxTokens !== undefined) {
    const n = Number(b.maxTokens);
    if (!Number.isInteger(n) || n < 256 || n > 32_768) throw new LectureStreamError('maxTokens 必须是 256~32768 的整数');
    maxTokens = n;
  }

  const outlineOnly = b.outlineOnly === true;
  if (b.outlineOnly !== undefined && typeof b.outlineOnly !== 'boolean') throw new LectureStreamError('outlineOnly 必须是布尔值');

  // 「从第 n 节继续」/「单节重试」只决定跑哪几节，不改采集与上下文口径
  const rawResume = optionString(b.resumeFrom, 'resumeFrom');
  if (rawResume && !(LECTURE_SECTION_KEYS as string[]).includes(rawResume)) {
    throw new LectureStreamError(`resumeFrom 必须是八段 key 之一（${LECTURE_SECTION_KEYS.join('/')}）`);
  }
  let sectionKeys: LectureSectionKey[] | undefined;
  if (b.sectionKeys !== undefined) {
    if (!Array.isArray(b.sectionKeys) || b.sectionKeys.length === 0) throw new LectureStreamError('sectionKeys 必须是非空数组');
    const keys = b.sectionKeys.map((v) => {
      if (typeof v !== 'string' || !(LECTURE_SECTION_KEYS as string[]).includes(v)) {
        throw new LectureStreamError(`sectionKeys 含非八段 key：${String(v)}`);
      }
      return v as LectureSectionKey;
    });
    sectionKeys = [...new Set(keys)];
  }
  if (rawResume && sectionKeys) throw new LectureStreamError('resumeFrom 与 sectionKeys 不能同时传');

  return { toolId, projects, excludes, ...(style ? { style } : {}), ...(extraNote ? { extraNote } : {}), ...(title ? { title } : {}), ...(outline ? { outline } : {}), ...(outlineOnly ? { outlineOnly } : {}), ...(rawResume ? { resumeFrom: rawResume as LectureSectionKey } : {}), ...(sectionKeys ? { sectionKeys } : {}), ...(contextBudget ? { contextBudget } : {}), ...(maxTokens ? { maxTokens } : {}) };
}

/** raw(30mb) 的 Buffer 或全局 express.json 的 object 都接受（与 prd-generate-stream 同构） */
export function parseLectureStreamBody(raw: unknown): unknown {
  if (raw == null) return raw;
  if (Buffer.isBuffer(raw)) {
    if (!raw.length) throw new LectureStreamError('请求体为空');
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw new LectureStreamError('请求体必须是 JSON');
    }
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new LectureStreamError('请求体必须是 JSON');
    }
  }
  return raw;
}

interface SectionUnit {
  projectId: string;
  projectName: string;
  module: string;
  content: string;
  files: GitFileChange[];
  commits: GitCommitEntry[];
  heading: string;
}

const commitsWithProject = (project: LectureCollectedProject): GitCommitEntry[] =>
  project.commits.map((c) => ({ ...c, subject: `[${project.projectName}] ${c.subject}` }));

function unitFiles(project: LectureCollectedProject, paths: readonly string[]): GitFileChange[] {
  const byPath = new Map(project.files.map((f) => [f.path, f]));
  return paths.map((p) => byPath.get(p)).filter((f): f is GitFileChange => f !== undefined);
}

/** 每节的分段策略：walkthrough 逐模块；风险/规范/改进按项目；开场/摘要/讨论/结语跨项目 */
function buildUnits(
  sectionKey: LectureSectionKey,
  context: LectureContextResult,
  projects: readonly LectureCollectedProject[],
  warnings: string[],
): SectionUnit[] {
  if (sectionKey === 'walkthrough') {
    const byId = new Map(projects.map((p) => [p.projectId, p]));
    return context.groups.map((g) => {
      const project = byId.get(g.projectId)!;
      return {
        projectId: g.projectId,
        projectName: g.projectName,
        module: g.module,
        content: g.content,
        files: unitFiles(project, g.files),
        commits: project.commits,
        heading: `### 项目「${g.projectName}」/ 模块 ${g.module}`,
      };
    });
  }

  if (sectionKey === 'risks' || sectionKey === 'standards' || sectionKey === 'improvements') {
    return projects.map((project) => {
      const groups = context.groups.filter((g) => g.projectId === project.projectId);
      const raw = groups.map((g) => g.content).join('\n\n');
      const trimmed = trimMiddle(raw, context.totals.budget, `项目「${project.projectName}」上下文`);
      if (trimmed.truncated) warnings.push(`项目「${project.projectName}」的模块上下文合计超出 ${context.totals.budget} 字符，本节已保头保尾截断`);
      return {
        projectId: project.projectId,
        projectName: project.projectName,
        module: '全部模块',
        content: trimmed.text,
        files: project.files,
        commits: project.commits,
        heading: `### 项目「${project.projectName}」`,
      };
    });
  }

  const raw = context.groups.map((g) => g.content).join('\n\n');
  const trimmed = trimMiddle(raw, context.totals.budget, '全部项目上下文');
  if (trimmed.truncated) warnings.push(`跨项目汇总节的上下文合计超出 ${context.totals.budget} 字符，已保头保尾截断`);
  const single = projects.length === 1 ? projects[0] : undefined;
  return [{
    projectId: single ? single.projectId : 'all',
    projectName: single ? single.projectName : '全部项目',
    module: '全部模块',
    content: trimmed.text,
    files: projects.flatMap((p) => p.files),
    commits: projects.flatMap(commitsWithProject),
    heading: '',
  }];
}

const sectionPhase = (index: number): string => `section:${index + 1}`;
const sectionStartProgress = (index: number): number => 20 + Math.round((70 * index) / LECTURE_SECTIONS.length);
const sectionDoneProgress = (index: number): number => 20 + Math.round((70 * (index + 1)) / LECTURE_SECTIONS.length);

async function attachAnchors(
  sections: readonly LectureSectionResult[],
  projects: readonly LectureCollectedProject[],
  warnings: string[],
): Promise<Array<LectureAnchor & { section: LectureSectionKey; projectId: string }>> {
  const owners = new Map<string, LectureCollectedProject[]>();
  for (const project of projects) {
    for (const file of project.files) {
      const list = owners.get(file.path) ?? [];
      list.push(project);
      owners.set(file.path, list);
    }
  }
  const flat = sections.flatMap((section) => section.segments.flatMap((segment) => segment.anchors.map((a) => ({
    ...a,
    section: section.key,
    projectId: segment.projectId === 'all' ? (owners.get(a.file)?.[0]?.projectId ?? 'all') : segment.projectId,
  }))));

  const byProject = new Map<string, Array<(typeof flat)[number]>>();
  for (const anchor of flat) {
    const list = byProject.get(anchor.projectId) ?? [];
    list.push(anchor);
    byProject.set(anchor.projectId, list);
  }
  for (const [projectId, list] of byProject) {
    const project = projects.find((p) => p.projectId === projectId);
    if (!project) continue;
    if (!project.revision) {
      warnings.push(`项目「${project.projectName}」为粘贴 patch 模式，锚点未记录 blob SHA（代码变动后无法复核）`);
      continue;
    }
    const attached = await attachLectureAnchorBlobs(project.workspacePath, list, project.revision);
    warnings.push(...attached.warnings.map((w) => `项目「${project.projectName}」：${w}`));
    attached.anchors.forEach((a, i) => {
      list[i].blobSha = a.blobSha;
      list[i].baseCommit = a.baseCommit;
    });
  }
  return flat;
}

function emptyResult(title: string, outline: LectureOutline | undefined, warnings: string[], stats: LectureStreamStats): LectureStreamResult {
  return { ok: false, aborted: true, title, markdown: '', ...(outline ? { outline } : {}), sections: [], warnings, stats, anchors: [] };
}

/**
 * 跑完整条流。调用方负责把 hooks 映射为 SSE；本函数不写响应、不落盘（E-4 不落库）。
 * 致命错误抛 LectureStreamError/其他 Error（路由出 error 事件）；用户中止返回 aborted=true。
 */
export async function runLectureStream(body: unknown, hooks: LectureStreamHooks = {}): Promise<LectureStreamResult> {
  const request = validateLectureStreamBody(body);
  const startedAtMs = Date.now();
  const warnings: string[] = [];
  const signal = hooks.signal;
  const stats: LectureStreamStats = {
    projects: request.projects.length, readyProjects: 0, files: 0, groups: 0, chars: 0,
    contextBudget: 0, sections: 0, segments: 0, calls: 0, anchors: 0, anchorIssues: 0,
  };

  hooks.onStage?.({ phase: 'collecting', msg: `采集 ${request.projects.length} 个项目的变更…`, progress: 3 });
  const collection = await collectLectureScope(body);
  const usable = collection.projects.filter((p) => !p.blocked && p.stats.files > 0);
  for (const project of collection.projects) {
    for (const w of project.warnings) warnings.push(`${project.projectName}：${w}`);
    if (project.blocked) warnings.push(`${project.projectName}：${project.blocked}（已跳过）`);
  }
  if (usable.length === 0) {
    throw new LectureStreamError(`没有可生成讲稿的项目：${warnings.join('；') || '请检查范围与排除规则'}`);
  }

  hooks.onStage?.({
    phase: 'preflight',
    msg: `范围预检完成：${collection.preview.totals.ready} 个项目 / ${collection.preview.totals.files} 个变更文件 / +${collection.preview.totals.additions} -${collection.preview.totals.deletions}`,
    progress: 12,
    data: { type: 'preflight', totals: collection.preview.totals, projects: collection.preview.projects },
  });

  const contextProjects = usable.map((p) => ({ projectId: p.projectId, projectName: p.projectName, files: p.files }));
  const symbols = expandLectureSymbols(contextProjects);
  warnings.push(...symbols.warnings);
  let context: LectureContextResult;
  try {
    context = buildLectureContext(contextProjects, { ...(request.contextBudget ? { budget: request.contextBudget } : {}), symbolHints: symbols.hints });
  } catch (e) {
    throw new LectureStreamError(e instanceof Error ? e.message : String(e));
  }
  warnings.push(...context.warnings);
  stats.readyProjects = usable.length;
  stats.files = context.totals.files;
  stats.groups = context.totals.groups;
  stats.chars = context.totals.chars;
  stats.contextBudget = context.totals.budget;
  // T03174（AI-102①）：结果随附本次运行所依据的三项预估——与预检面板同源，避免「面板一个数、结果另一个数」
  const estimate = estimateLectureRun(collection.preview);

  const projectRefs = usable.map((p) => ({ id: p.projectId, name: p.projectName }));
  const allCommits = usable.flatMap(commitsWithProject);
  let outline: LectureOutline | undefined;

  if (request.outline) {
    outline = request.outline;
    hooks.onStage?.({
      phase: 'outline', msg: '沿用已确认的大纲，跳过 AI 大纲生成', progress: 20,
      data: { type: 'outline_ready', outline, reused: true },
    });
  } else {
    const outlineRun = await outlineLecture(request.toolId, {
      projects: projectRefs,
      manifestText: context.manifestText,
      groups: context.groups.map((g) => ({ projectName: g.projectName, module: g.module, files: g.files.length })),
      commits: allCommits,
      ...(request.style ? { style: request.style } : {}),
      ...(request.extraNote ? { extraNote: request.extraNote } : {}),
    }, {
      ...(signal ? { signal } : {}),
      ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
      onEvent: (event) => hooks.onStage?.({
        phase: 'outline', msg: `大纲已就绪：${event.outline.sections.length} 节 / ${event.outline.discussion_questions.length} 个讨论问题（可修订后二次提交）`, progress: 20,
        data: { type: 'outline_ready', outline: event.outline },
      }),
    });
    stats.calls += 1;
    if (!outlineRun.ok) {
      if (signal?.aborted) return emptyResult(request.title ?? '代码评审会议讲稿', undefined, warnings, stats);
      throw new LectureStreamError(`大纲生成失败：${outlineRun.error ?? '未知错误'}`);
    }
    outline = outlineRun.outline!;
  }
  if (signal?.aborted) return emptyResult(request.title ?? '代码评审会议讲稿', outline, warnings, stats);
  if (!outline) throw new LectureStreamError('大纲生成失败：结果为空');

  // FR-4.1 第一段收口：只交大纲，正文留给用户修订后二次提交（stats 保持在采集/上下文口径上）
  if (request.outlineOnly) {
    hooks.onStage?.({
      phase: 'outline', msg: '仅大纲模式：正文未生成，修订后二次提交即可展开八段', progress: 20,
      data: { type: 'outline_only', outline },
    });
    return {
      ok: true,
      aborted: false,
      title: request.title ?? `代码评审会议讲稿 · ${usable.map((p) => p.projectName).join('、')}`,
      markdown: '',
      outline,
      sections: [],
      warnings,
      stats,
      anchors: [],
      estimate,
    };
  }

  const resumeIndex = request.resumeFrom ? LECTURE_SECTION_KEYS.indexOf(request.resumeFrom) : 0;
  const only = request.sectionKeys ? new Set<LectureSectionKey>(request.sectionKeys) : null;
  if (resumeIndex > 0 || only) {
    hooks.onStage?.({
      phase: 'resume',
      progress: sectionStartProgress(resumeIndex),
      msg: only
        ? `单节重试：${[...only].map((k) => lectureSectionLabel(k)).join('、')}`
        : `从第 ${resumeIndex + 1} 节「${lectureSectionLabel(LECTURE_SECTION_KEYS[resumeIndex])}」继续（前 ${resumeIndex} 节沿用已生成正文）`,
      data: { type: 'resume', from: resumeIndex, total: LECTURE_SECTIONS.length, ...(only ? { sections: [...only] } : {}) },
    });
  }
  const sections: LectureSectionResult[] = [];
  let aborted = false;
  for (const [index, meta] of LECTURE_SECTIONS.entries()) {
    if (index < resumeIndex) continue;
    if (only && !only.has(meta.key)) continue;
    if (signal?.aborted) { aborted = true; break; }
    const section: LectureOutlineSection = outline.sections.find((s) => s.key === meta.key) ?? {
      key: meta.key, title: lectureSectionLabel(meta.key), bullets: [],
    };
    const units = buildUnits(meta.key, context, usable, warnings);
    hooks.onStage?.({
      phase: sectionPhase(index),
      msg: `装配第 ${index + 1}/${LECTURE_SECTIONS.length} 节「${meta.label}」（${units.length} 段）`,
      progress: sectionStartProgress(index),
      data: { type: 'section_start', section: meta.key, label: meta.label, index, total: LECTURE_SECTIONS.length, units: units.length },
    });
    const segments: LectureSegmentResult[] = [];
    for (const unit of units) {
      if (signal?.aborted) { aborted = true; break; }
      stats.calls += 1;
      const run = await generateLectureSection({
        toolId: request.toolId,
        section,
        outline,
        groups: [unit],
        commits: unit.commits,
        ...(request.style ? { style: request.style } : {}),
        ...(request.extraNote ? { extraNote: request.extraNote } : {}),
      }, {
        ...(signal ? { signal } : {}),
        onDelta: (text) => hooks.onChunk?.({
          section: meta.key, projectId: unit.projectId, projectName: unit.projectName, module: unit.module, text,
        }),
      });
      const group = run.groups[0];
      const segment: LectureSegmentResult = group
        ? {
          projectId: unit.projectId, projectName: unit.projectName, module: unit.module, heading: unit.heading,
          ok: group.ok, text: group.text, ...(group.error ? { error: group.error } : {}),
          anchors: group.anchors, anchorIssues: group.anchorIssues,
        }
        : {
          projectId: unit.projectId, projectName: unit.projectName, module: unit.module, heading: unit.heading,
          ok: false, text: '', error: '已中止', anchors: [], anchorIssues: [],
        };
      segments.push(segment);
      stats.segments += 1;
      stats.anchors += segment.anchors.length;
      stats.anchorIssues += segment.anchorIssues.length;
      hooks.onStage?.({
        phase: sectionPhase(index),
        msg: `${segment.ok ? '完成' : '失败'}：${unit.projectName} / ${unit.module}`,
        progress: sectionStartProgress(index),
        data: {
          type: 'segment_done', section: meta.key, projectId: unit.projectId, projectName: unit.projectName,
          module: unit.module, ok: segment.ok, ...(segment.error ? { error: segment.error } : {}),
          anchors: segment.anchors.length, anchorIssues: segment.anchorIssues.length,
        },
      });
      if (run.aborted) { aborted = true; break; }
    }
    const failed = segments.filter((s) => !s.ok);
    const kept = segments.filter((s) => s.ok && s.text.trim());
    const text = kept
      .map((s) => `${s.heading ? `${s.heading}\n\n` : ''}${s.text.trim()}`)
      .join('\n\n')
      // 部分失败要在成稿里留痕：只把成功段拼进去的话，读者无法分辨「这段没变更」与「这段生成失败了」
      + (failed.length && kept.length
        ? `\n\n> ⚠️ 本节部分内容未生成：${failed.map((s) => `${s.projectName}/${s.module}（${s.error ?? '生成失败'}）`).join('、')}`
        : '');
    sections.push({
      key: meta.key,
      label: meta.label,
      ok: failed.length === 0 && text.length > 0,
      text,
      ...(failed.length ? { error: failed.map((s) => `${s.projectName}/${s.module}：${s.error ?? '生成失败'}`).join('；') } : {}),
      segments,
    });
    hooks.onStage?.({
      phase: sectionPhase(index),
      msg: `第 ${index + 1}/${LECTURE_SECTIONS.length} 节「${meta.label}」${failed.length ? `部分失败（${failed.length}/${segments.length}）` : '完成'}`,
      progress: sectionDoneProgress(index),
      data: { type: 'section_done', section: meta.key, ok: failed.length === 0 && text.length > 0, segments: segments.length, failed: failed.length },
    });
    if (aborted) break;
  }
  stats.sections = sections.length;

  const projectNames = usable.map((p) => p.projectName);
  const title = request.title ?? `代码评审会议讲稿 · ${projectNames.join('、')}`;
  const anchors = await attachAnchors(sections, usable, warnings);
  const generatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const markdown = assembleLectureMarkdown({
    title,
    projectNames,
    sections: sections.map((s) => ({ key: s.key, text: s.text })),
    generatedAt,
  });
  const fullRun = !request.resumeFrom && !request.sectionKeys;
  const ok = !aborted && sections.every((s) => s.ok) && (!fullRun || sections.length === LECTURE_SECTIONS.length);
  // T03174（AI-102②③④）：整轮完成（非续作/单节重试、非中止）后复算偏差——续作轮调用数天然少于整轮预估，硬比会假红
  const deviation = fullRun && !aborted
    ? assessAiRunDeviation(estimate, {
      calls: stats.calls,
      chars: sections.reduce((n, s) => n + s.text.length, 0),
      seconds: (Date.now() - startedAtMs) / 1000,
    })
    : undefined;
  return { ok, aborted, title, markdown, ...(outline ? { outline } : {}), sections, warnings, stats, anchors, estimate, ...(deviation ? { deviation } : {}) };
}

/** 路由层统一的 400 文案：范围/流式参数校验错误都走这里 */
export function lectureStreamErrorStatus(e: unknown): number {
  return e instanceof LectureScopeError || e instanceof LectureStreamError ? 400 : 500;
}
