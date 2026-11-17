import { createHash } from 'node:crypto';
import { CASE_DEFAULTS, CASE_METHOD, CASE_PRIORITY, CASE_TYPE, pickEnum } from '../util/testCaseEnums';
import type { CaseMethod, CasePriority, CaseType } from '../util/testCaseEnums';
import { scanJsonArrays } from './prdIssues';
import { stripThinking } from '../util/thinking';
import { scalarText } from '../util/scalarText';

/**
 * T01490：测试用例生成「协议解析 + 草稿规整」的纯函数模块（仿 `prdIssues.ts` 抽出便于单测与复用）。
 *
 * 只做三件事，全部无副作用、不碰数据库/AI：
 *  1. 按 `<<<REQUIREMENTS>>>` / `<<<CASES>>>` / `<<<NOTES>>>` 标记切段，段内用 `scanJsonArrays` 配平扫描
 *     （`scanJsonArrays` 本身返回**全部**顶层数组、不区分语义，所以「切段」是区分哪段是需求、哪段是用例的前提）；
 *  2. 把裸对象规整为草稿条目，枚举经 `pickEnum` 收窄（脏值回落默认，与 `TestCaseService.create` 同口径）；
 *  3. 计算幂等去重键 `source_key` 与内容指纹 `source_hash`——**单源于此**，写库（T01492）逐字复现，否则去重失效。
 *
 * 标记识别容忍 `<<<X>>>` / `<<X>>` / `<X>` 变体与大小写（模型偶尔写歪），但要求标记独占一行由 SKILL.md 约束、解析按位置切。
 */

/** 需求优先级（prd_requirements 口径，非用例口径）：沿用 PlanService PRD 解析链路，不引入 medium（§5.4 历史漂移） */
export const REQ_PRIORITY = ['low', 'normal', 'high', 'urgent'] as const;
export const REQ_PRIORITY_DEFAULT = 'normal';

export const REQ_MARKER = /<{1,4}\s*REQUIREMENTS\s*>{1,4}/i;
export const CASE_MARKER = /<{1,4}\s*CASES\s*>{1,4}/i;
export const NOTE_MARKER = /<{1,4}\s*NOTES\s*>{1,4}/i;

/** 草稿需求条目（import 前用 reqNo 关联，落库时映射为 req_id——新拆分项此刻还没有 uuid） */
export interface DraftRequirement {
  reqNo: string;
  title: string;
  content: string;
  sourceRef: string;
  priority: string;
  /** true = 本次新拆分（矩阵里原本没有）；false = 复用已有 */
  isNew: boolean;
}

export interface DraftStep {
  action: string;
  expected: string;
}

/** 草稿用例条目（AI 输出经规整 + 枚举收窄；不携带 caseNo/id/status/lastResult 等服务端生成字段） */
export interface DraftCase {
  reqNo: string;
  module: string;
  title: string;
  preconditions: string;
  expected: string;
  testData: string;
  postconditions: string;
  priority: CasePriority;
  type: CaseType;
  method: CaseMethod;
  tags: string;
  steps: DraftStep[];
  sourceKey: string;
  sourceHash: string;
  /** 草稿视图默认勾选（不勾选不入库，§8.5） */
  include: boolean;
  /** 项目内已存在同 source_key → 标「已入库」，重复导入不产生重复用例（§2.2 P6 / §8.5） */
  alreadyImported: boolean;
}

export interface DraftCoverage {
  total: number;
  covered: number;
  uncovered: number;
  rate: number;
  byReq: Array<{ reqNo: string; title: string; caseCount: number; isNew: boolean }>;
}

function str(v: unknown): string {
  return v == null ? '' : scalarText(v).trim();
}

/**
 * 幂等去重键（§2.2 P6）：**单源于此**，T01492 写库时逐字复现，否则「生成期判定已入库」与「写库期查重」口径分裂。
 * key = `gen:<reqNo>:<规范化标题>`——reqNo 项目内唯一 + 标题措辞稳定（SKILL/coverage-rules 已要求幂等章）→ 二次生成命中同键。
 */
export function caseSourceKey(reqNo: string, title: string): string {
  const norm = title.trim().toLowerCase().replaceAll(/\s+/g, ' ');
  return `gen:${reqNo.trim()}:${norm}`;
}

/** 内容指纹：标题之外正文/步骤的变化留痕（source_key 定位「同一条」，hash 定位「是否有改动」） */
export function caseContentHash(c: Pick<DraftCase, 'reqNo' | 'module' | 'preconditions' | 'expected' | 'testData' | 'steps'>): string {
  return createHash('sha1').update(JSON.stringify([c.reqNo, c.module, c.preconditions, c.expected, c.testData, c.steps])).digest('hex');
}

/** 取 startRe 命中之后、stopRe（若有）命中之前的片段 */
export function segment(text: string, startRe: RegExp, stopRe?: RegExp): string {
  const s = startRe.exec(text);
  if (!s) return '';
  const rest = text.slice(s.index + s[0].length);
  const stop = stopRe ? stopRe.exec(rest) : null;
  return stop ? rest.slice(0, stop.index) : rest;
}

function isRequirementObj(o: Record<string, unknown>): boolean {
  return typeof o.reqNo === 'string' && typeof o.title === 'string' && o.expected === undefined;
}
function isCaseObj(o: Record<string, unknown>): boolean {
  return typeof o.reqNo === 'string' && typeof o.title === 'string';
}

export { isRequirementObj, isCaseObj };

/**
 * 从一段文本里取出目标数组：优先「标记段内首个能规整出条目（经 classify 判定）的数组」；
 * 标记缺失/写歪（模型输出 `<CASES>` 或漏标记、或把 JSON 写到标记之前）时回退「全文扫描 + 按元素结构分类」——
 * 这是 `prdIssues` 三级容错的同款思路（模型不守协议时不整轮作废）。
 */
export function extractArray(
  text: string,
  startRe: RegExp,
  stopRe: RegExp | undefined,
  classify: (o: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  const cleaned = stripThinking(text).replaceAll(/```[a-zA-Z]*/g, '');
  const scoped = segment(cleaned, startRe, stopRe);
  const pick = (source: string): Record<string, unknown>[] | null => {
    for (const arr of scanJsonArrays(source)) {
      if (Array.isArray(arr)) {
        const objs = arr.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && classify(x));
        if (objs.length > 0) return objs;
      }
    }
    return null;
  };
  return (scoped ? pick(scoped) : null) ?? pick(cleaned) ?? [];
}

/** 规整需求条目：reqNo/title 必填否则丢弃；priority 收敛到 PRD 解析口径（脏值回落 normal） */
export function normRequirement(o: Record<string, unknown>, existingReqNos: Set<string>): DraftRequirement | null {
  const reqNo = str(o.reqNo);
  const title = str(o.title);
  if (!reqNo || !title) return null;
  const pr = str(o.priority).toLowerCase();
  return {
    reqNo,
    title,
    content: str(o.content),
    sourceRef: str(o.sourceRef),
    priority: (REQ_PRIORITY as readonly string[]).includes(pr) ? pr : REQ_PRIORITY_DEFAULT,
    isNew: !existingReqNos.has(reqNo),
  };
}

/** 规整用例条目：枚举经 pickEnum 收窄（脏值回落默认，与 TestCaseService.create 同口径），剔除服务端生成字段 */
export function normCase(o: Record<string, unknown>, existingKeys: Set<string>): DraftCase | null {
  const reqNo = str(o.reqNo);
  const title = str(o.title);
  if (!reqNo || !title) return null;
  const steps = (Array.isArray(o.steps) ? o.steps : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({ action: str(s.action), expected: str(s.expected) }))
    .filter((s) => s.action || s.expected);
  const draft: DraftCase = {
    reqNo,
    module: str(o.module),
    title,
    preconditions: str(o.preconditions),
    expected: str(o.expected),
    testData: str(o.testData),
    postconditions: str(o.postconditions),
    priority: pickEnum(o.priority, CASE_PRIORITY, CASE_DEFAULTS.priority) ?? CASE_DEFAULTS.priority,
    type: pickEnum(o.type, CASE_TYPE, CASE_DEFAULTS.type) ?? CASE_DEFAULTS.type,
    method: pickEnum(o.method, CASE_METHOD, CASE_DEFAULTS.method) ?? CASE_DEFAULTS.method,
    tags: str(o.tags),
    steps,
    sourceKey: caseSourceKey(reqNo, title),
    sourceHash: '',
    include: true,
    alreadyImported: existingKeys.has(caseSourceKey(reqNo, title)),
  };
  draft.sourceHash = caseContentHash(draft);
  return draft;
}

/** 解析 NOTES 段（字符串数组，容忍模型写成对象数组时的 note/question/text/content 字段） */
export function parseNotes(text: string): string[] {
  const seg = segment(stripThinking(text), NOTE_MARKER);
  const out: string[] = [];
  for (const arr of scanJsonArrays(seg)) {
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      if (typeof x === 'string' && x.trim()) out.push(x.trim());
      else if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        const s = str(o.note) || str(o.text) || str(o.question) || str(o.content);
        if (s) out.push(s);
      }
    }
  }
  return out;
}
