/**
 * T02857（六期 S6，PRD-阶段性项目总结汇报PPT §3.1/§3.2/§3.3/§3.4）：AI 工作台「阶段性项目总结汇报 PPT 生成」工作面板。
 *
 * 四段式（与 PRD §5.3 的界面设计一致，不可跳段）：
 *  ① 周期与范围（FR-2）：日报/周报/月报/自定义四档；范围默认消费页面顶部 `report.projects`，
 *     面板内「本卡片另选项目」只覆盖本次生成，不改顶部选区（A-6 的例外边界）。
 *  ② 资料齐备性校验（FR-3）：`GET /plans/summary-preflight` 只读聚合 S1~S9（零 AI 调用），
 *     ✓/⚠/✕ + 条数 + 「怎么补」+ 深链；S1/S2 任一 ✕ 即硬阻塞，禁止发起大纲与生成。
 *  ③ 大纲确认（FR-4 第 3 步）：`POST /plans/summary-ppt-outline` 出 12~16 页；标题/章节/版式/要点
 *     就地可改、可增删页与调序——内存态 + sessionStorage，不落库；周期或范围一变即要求重新生成。
 *  ④ 生成与下载（FR-4 第 5~7 步）：`POST /plans/summary-ppt-stream` 逐页 SSE `stage` → `done {token,fileName}`，
 *     进度条按「页 n/N」推进，warnings 原样列出；下载用服务端 fileName（洗名单源在服务端，前端不重组）。
 *
 * 与 `KickoffPptPanel` 同构的三点：streamEvents 调用范式、AbortController 登记进 store、
 * 编辑态落 sessionStorage（切页/刷新回来不丢正在进行的大纲）。确认一律走 `askConfirm`。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Project } from '../api/client';
import { streamEvents, GATE_BUSY_MSG } from '../api/sse';
import { summaryPptStore, useSummaryPpt, type SummaryOutlineItem, type SummaryStreamResult } from '../stores/summaryPptStore';
import { ProjectScopePicker, scopeSummary } from '../ui/projectScopePicker';
// T02857：纯规则（值域镜像 / 日期口径 / 大纲缺项）放 ui 层，门可直接 import 与服务端真常量对账
import {
  SUMMARY_SECTIONS, SUMMARY_LAYOUTS, MERGED_PER_PROJECT,
  SUMMARY_CUSTOM_MAX_DAYS, customRangeErrorOf, daysAgoYmd, outlineGapOf, rangeText, todayYmd,
} from '../ui/summaryPptRules';
import { FlowProgress } from '../ui/FlowProgress';
import { askConfirm } from '../ui/dialogs';
import { useSessionState } from '../ui/session';
import { CONSOLE_RESET_EVENT } from '../ui/consoleReset';
import { ChevronDown, ChevronUp, CircleAlert, CircleCheck, CircleX, Download, FileChartColumn, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react';

/** 服务端 `SummaryPreflightItem` 的前端镜像（单源：`server/src/services/summaryPptService.ts`） */
type PreflightStatus = 'ok' | 'warn' | 'fail';
interface PreflightItem {
  key: string;
  label: string;
  count: number;
  status: PreflightStatus;
  note: string;
  deepLink: string;
  hard: boolean;
}
interface PreflightResult {
  period: string;
  periodLabel: string;
  periodRange: { start: string; end: string };
  projectIds: string[];
  projectNames: string[];
  items: PreflightItem[];
  blocked: boolean;
  missingHard: string[];
  coverage: { ok: boolean; retentionDays: number; footnote: string };
}

/** 大纲接口返回（服务端 `SummaryOutlineResult`） */
interface OutlineResult {
  outline: SummaryOutlineItem[];
  warnings: string[];
  truncated: boolean;
  periodLabel: string;
  pageRange: { min: number; max: number };
  projects: Array<{ id: string; name: string }>;
}

/**
 * 章节 / 版式 / 数据块候选：值域单源在服务端 `summaryPptOutline.ts`
 * （`SUMMARY_SECTIONS` / `SUMMARY_LAYOUTS` / `SUMMARY_DATA_KEYS`，`validateSummaryOutline` 会按白名单拒绝越界值）；
 * 前端镜像在 `ui/summaryPptRules.ts`，两份清单的一致性由 `verify-t02857-summary-panel` 的常量对账锁住。
 */
const PERIOD_OPTIONS = [
  { key: 'day', label: '日报' },
  { key: 'week', label: '周报' },
  { key: 'month', label: '月报' },
  { key: 'custom', label: '自定义' },
] as const;
type PeriodKey = (typeof PERIOD_OPTIONS)[number]['key'];

/** 大纲编辑态会话键（重置入口在 consoleReset 的产物键清单里，与控制台重置等效） */
const OUTLINE_SESSION_KEY = 'summaryPpt.outline';
/** 大纲生成时的周期/范围签名：刷新/切页回来仍能判断草稿是否对应当前选区 */
const OUTLINE_SCOPE_SESSION_KEY = 'summaryPpt.outlineScope';

const opBtn = { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 7px' } as const;
const cellInput = { fontSize: 12, padding: '3px 6px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' } as const;

function statusIcon(status: PreflightStatus) {
  if (status === 'ok') return <CircleCheck size={13} style={{ color: 'var(--success, var(--accent))', flexShrink: 0 }} />;
  return status === 'warn'
    ? <CircleAlert size={13} style={{ color: 'var(--warn)', flexShrink: 0 }} />
    : <CircleX size={13} style={{ color: 'var(--danger)', flexShrink: 0 }} />;
}

/** 校验项深链落地：`tasks` / `plan?menu=*` / `report?card=*`；`settings` 与空串不跳（沿用既有导航口径） */
function goDeepLink(link: string, projectId: string, openCard?: (key: 'prd-import' | 'tc-gen') => void): void {
  try {
    if (!link) return;
    if (link.startsWith('report?card=')) {
      openCard?.(link.slice('report?card='.length) as 'prd-import' | 'tc-gen');
      return;
    }
    if (link === 'tasks') {
      globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'tasks' } }));
      return;
    }
    const [path, query] = link.split('?');
    if (path !== 'plan') return;
    if (projectId) sessionStorage.setItem('plan.projectId', JSON.stringify(projectId));
    const menu = new URLSearchParams(query ?? '').get('menu');
    if (menu === 'prd') sessionStorage.setItem('plan.showPrd', JSON.stringify(true));
    if (menu === 'matrix') sessionStorage.setItem('plan.showMatrix', JSON.stringify(true));
    globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'plan' } }));
  } catch { /* 跳转异常静默：校验结论本身已展示 */ }
}

/** 单条校验项卡片（✓/⚠/✕ + 条数 + 怎么补 + 深链按钮） */
function PreflightItemCard({ it, projectId, openCard }: {
  readonly it: PreflightItem;
  readonly projectId: string;
  readonly openCard?: (key: 'prd-import' | 'tc-gen') => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11, border: '1px solid var(--border)', borderRadius: 6, padding: '5px 7px' }}>
      {statusIcon(it.status)}
      <span style={{ flex: 1 }}>
        <span style={{ fontWeight: 600 }}>{it.key} {it.label}</span>
        <span style={{ color: 'var(--text-muted)' }}> · {it.count}{it.key === 'S9' ? ' 天' : ' 条'}{it.hard ? '（必需）' : ''}</span>
        <span style={{ display: 'block', color: 'var(--text-secondary)', marginTop: 2 }}>{it.note}</span>
      </span>
      {it.status !== 'ok' && !!it.deepLink && (
        <button onClick={() => goDeepLink(it.deepLink, projectId, openCard)} className="tbtn-anim"
          title={`去补充 — ${it.deepLink}`} aria-label={`去补充${it.label}`} style={opBtn}>去补充</button>
      )}
    </div>
  );
}

/** ② 前置校验 checklist 段（S1~S9 网格 + 硬阻塞横幅 + ⚠ 级提示） */
function PreflightChecklist({ pre, loading, error, projectId, missingItems, openCard }: {
  readonly pre: PreflightResult | null;
  readonly loading: boolean;
  readonly error: string;
  readonly projectId: string;
  readonly missingItems: PreflightItem[];
  readonly openCard?: (key: 'prd-import' | 'tc-gen') => void;
}) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        资料齐备性校验 S1~S9（只读，不调用 AI）
        {loading && <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>校验中…</span>}
      </div>
      {error && <div style={{ fontSize: 11, color: 'var(--danger)' }}>校验失败：{error}</div>}
      {pre && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 6 }}>
            {pre.items.map((it) => <PreflightItemCard key={it.key} it={it} projectId={projectId} openCard={openCard} />)}
          </div>
          {pre.blocked && (
            <div style={{ marginTop: 8, border: '1px solid var(--danger)', borderRadius: 6, padding: '6px 8px', fontSize: 11, color: 'var(--danger)' }}>
              硬阻塞：{missingItems.map((i) => `${i.key} ${i.label}`).join('、')} 未达标，生成只会得到空壳稿——已禁止发起。
              <span style={{ display: 'inline-flex', gap: 6, marginLeft: 6, flexWrap: 'wrap' }}>
                {missingItems.filter((i) => i.deepLink).map((i) => (
                  <button key={i.key} onClick={() => goDeepLink(i.deepLink, projectId, openCard)} className="tbtn-anim"
                    title={`去补充 — ${i.deepLink}`} aria-label={`去补充${i.label}`} style={opBtn}>{i.label}</button>
                ))}
              </span>
            </div>
          )}
          {!pre.blocked && pre.items.some((i) => i.status === 'warn') && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--warn)' }}>
              ⚠ 级项可继续生成，但降级会在对应 PPT 页面页脚留痕（客户会上追问时页面上要有依据）。
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** ① 周期与范围段（四档周期 + 自定义区间 + 顶部范围/卡片覆盖） */
function PeriodScopeSection({ period, onPeriod, start, end, onStart, onEnd, customError, overrideOn, onOverrideOn, overrideIds, onOverrideIds, topIds, projects, scopeText }: {
  readonly period: PeriodKey;
  readonly onPeriod: (p: PeriodKey) => void;
  readonly start: string;
  readonly end: string;
  readonly onStart: (v: string) => void;
  readonly onEnd: (v: string) => void;
  readonly customError: string;
  readonly overrideOn: boolean;
  readonly onOverrideOn: (v: boolean) => void;
  readonly overrideIds: string[];
  readonly onOverrideIds: (ids: string[]) => void;
  readonly topIds: string[];
  readonly projects: Project[];
  readonly scopeText: string;
}) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>汇报周期（默认周报）</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {PERIOD_OPTIONS.map((p) => (
              <button key={p.key} onClick={() => onPeriod(p.key)} title={`生成${p.label}`} aria-label={`汇报周期 ${p.label}`}
                style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13, border: '1px solid var(--border-strong)', background: period === p.key ? 'var(--accent)' : 'var(--card-bg)', color: period === p.key ? 'var(--accent-text)' : 'var(--text)' }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {period === 'custom' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              起始日
              <input type="date" value={start} max={end || todayYmd()} onChange={(e) => onStart(e.target.value)}
                aria-label="自定义周期起始日" style={{ ...cellInput, display: 'block', marginTop: 3 }} />
            </label>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              结束日（含）
              <input type="date" value={end} min={start || undefined} max={todayYmd()} onChange={(e) => onEnd(e.target.value)}
                aria-label="自定义周期结束日" style={{ ...cellInput, display: 'block', marginTop: 3 }} />
            </label>
            <span style={{ fontSize: 11, color: customError ? 'var(--danger)' : 'var(--text-muted)', maxWidth: 320 }}>
              {customError || `最长 ${SUMMARY_CUSTOM_MAX_DAYS} 天；结束日不得晚于今天`}
            </span>
          </div>
        )}
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={overrideOn} onChange={(e) => onOverrideOn(e.target.checked)}
            aria-label="本卡片另选项目（仅本次生成生效，不改顶部选区）" style={{ cursor: 'pointer' }} />
          本卡片另选项目
        </label>
        {overrideOn ? (
          <div style={{ width: 240, maxWidth: '100%' }}>
            <ProjectScopePicker projects={projects} value={overrideIds} onChange={onOverrideIds} />
          </div>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>跟随顶部范围：<strong>{scopeSummary(topIds.map((id) => projects.find((p) => p.id === id)?.name ?? id))}</strong></span>
        )}
        {overrideOn && <span style={{ fontSize: 11, color: 'var(--warn)' }}>本次不跟随顶部范围（顶部选区不受影响）</span>}
      </div>

      {scopeText && <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>{scopeText}</div>}
    </div>
  );
}

/** ③ 大纲工具条（补充说明 + 生成/重新生成 + 清空 + 页数提示） */
function OutlineToolbar({ extraNote, onExtraNoteChange, streaming, outlineBusy, blockedReason, rowCount, onGenOutline, onClear }: {
  readonly extraNote: string;
  readonly onExtraNoteChange: (value: string) => void;
  readonly streaming: boolean;
  readonly outlineBusy: boolean;
  readonly blockedReason: string;
  readonly rowCount: number;
  readonly onGenOutline: () => void;
  readonly onClear: () => void;
}) {
  const disabled = streaming || outlineBusy || !!blockedReason;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
      <input value={extraNote} onChange={(e) => onExtraNoteChange(e.target.value)} placeholder="补充说明（可选，会拼进大纲提示词）" aria-label="大纲补充说明"
        style={{ ...cellInput, flex: '1 1 220px', minWidth: 180 }} disabled={streaming} />
      <button onClick={onGenOutline} disabled={disabled} className={`tbtn-anim${outlineBusy ? ' task-breathe' : ''}`}
        title={blockedReason || '调用 AI 生成分页大纲（1 次模型调用）'} aria-label="生成大纲"
        style={{ ...opBtn, background: disabled ? 'var(--border-strong)' : 'var(--accent)', color: disabled ? 'var(--text-muted)' : 'var(--accent-text)', border: 'none', padding: '5px 12px' }}>
        {outlineBusy ? <Loader2 size={12} className="aispin" /> : <Sparkles size={12} />} {rowCount ? '重新生成大纲' : '生成大纲'}
      </button>
      {rowCount > 0 && <button onClick={onClear} disabled={streaming} className="tbtn-anim" title="清空大纲稿" aria-label="清空大纲" style={opBtn}><Trash2 size={11} /> 清空</button>}
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{rowCount ? `共 ${rowCount} 页` : '大纲 12~16 页（单项目）/ 合并版 8+4N 页，可改标题/要点/版式'}</span>
    </div>
  );
}

/** ③ 大纲编辑列表：就地改章节/标题/版式/要点 + 上移下移删除 + 追加一页 */
function OutlinePageList({ rows, streaming, merged, onPatch, onRemove, onMove, onAdd }: {
  readonly rows: SummaryOutlineItem[];
  readonly streaming: boolean;
  readonly merged: boolean;
  readonly onPatch: (idx: number, patch: Partial<SummaryOutlineItem>) => void;
  readonly onRemove: (idx: number) => void;
  readonly onMove: (idx: number, dir: -1 | 1) => void;
  readonly onAdd: () => void;
}) {
  return (
    <div style={{ maxHeight: 380, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 10 }}>
      {rows.map((r, idx) => (
        <div key={`${r.section}-${idx}`} style={{ borderBottom: '1px solid var(--border)', padding: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 22, textAlign: 'right', marginTop: 6 }}>{idx + 1}</span>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <select value={r.section} onChange={(e) => onPatch(idx, { section: e.target.value })} disabled={streaming}
                title="章节" aria-label={`第${idx + 1}页章节`} style={cellInput}>
                {/* 服务端允许保留非标准章节（只告警不拒绝），故不在候选里时补一个当前值，避免受控 select 静默改成第一项 */}
                {!SUMMARY_SECTIONS.includes(r.section) && <option value={r.section}>{r.section}</option>}
                {SUMMARY_SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input value={r.title} onChange={(e) => onPatch(idx, { title: e.target.value })} disabled={streaming}
                placeholder="页标题（≤30 字）" aria-label={`第${idx + 1}页标题`} style={{ ...cellInput, flex: 1, minWidth: 160 }} />
              <select value={r.layout} onChange={(e) => onPatch(idx, { layout: e.target.value })} disabled={streaming}
                title="版式" aria-label={`第${idx + 1}页版式`} style={cellInput}>
                {SUMMARY_LAYOUTS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', alignSelf: 'center' }}>
                取数：{r.dataKeys.length ? r.dataKeys.join('、') : '无'}
              </span>
              {merged && r.projectId && (
                <span title="合并版分区：该页归属的项目" style={{ fontSize: 10, color: 'var(--accent)', alignSelf: 'center' }}>项目页</span>
              )}
            </div>
            <textarea value={r.bullets.join('\n')} onChange={(e) => onPatch(idx, { bullets: e.target.value.split('\n') })}
              disabled={streaming} rows={Math.min(6, Math.max(2, r.bullets.length))}
              placeholder="每行一条要点（每条 ≤42 字，每页 ≤6 条）" aria-label={`第${idx + 1}页要点`}
              style={{ ...cellInput, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <button onClick={() => onMove(idx, -1)} disabled={streaming || idx === 0} className="tbtn-anim" title="上移" aria-label="上移" style={{ ...opBtn, padding: '1px 5px' }}><ChevronUp size={11} /></button>
            <button onClick={() => onMove(idx, 1)} disabled={streaming || idx === rows.length - 1} className="tbtn-anim" title="下移" aria-label="下移" style={{ ...opBtn, padding: '1px 5px' }}><ChevronDown size={11} /></button>
            <button onClick={() => onRemove(idx)} disabled={streaming || merged} className="tbtn-anim" title={merged ? '合并版每项目固定 4 页，不支持删页' : '删除该页'} aria-label="删除该页"
              style={{ ...opBtn, padding: '1px 5px', color: 'var(--danger)', border: 'none', background: 'transparent', opacity: merged ? 0.4 : 1 }}><Trash2 size={11} /></button>
          </div>
        </div>
      ))}
      <div style={{ padding: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onAdd} disabled={streaming || merged} className="tbtn-anim" title={merged ? '合并版每项目固定 4 页，不支持加页' : '追加一页'} aria-label="追加一页"
          style={{ ...opBtn, opacity: merged ? 0.4 : 1 }}><Plus size={11} /> 加一页</button>
        {merged && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>合并版：每项目恰好 {MERGED_PER_PROJECT} 页小结，可改文字与顺序，不支持增删页</span>}
      </div>
    </div>
  );
}

/** ④ 生成与下载条 */
function GenerateBar({ streaming, canGenerate, blockReason, result, downloading, onGenerate, onDownload }: {
  readonly streaming: boolean;
  readonly canGenerate: boolean;
  readonly blockReason: string;
  readonly result: SummaryStreamResult | null;
  readonly downloading: boolean;
  readonly onGenerate: () => void;
  readonly onDownload: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <button onClick={onGenerate} disabled={!canGenerate} className={`tbtn-anim${streaming ? ' task-breathe' : ''}`}
        title={blockReason || '逐页装配 .pptx 并落盘换下载令牌'} aria-label="开始生成阶段性总结汇报 PPT"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, border: 'none', borderRadius: 6,
          background: canGenerate ? 'var(--accent)' : 'var(--border-strong)', color: canGenerate ? 'var(--accent-text)' : 'var(--text-muted)',
          cursor: canGenerate ? 'pointer' : 'default', padding: '5px 12px' }}>
        {streaming ? <Loader2 size={12} className="aispin" /> : <Sparkles size={12} />} 开始生成
      </button>
      {!!blockReason && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{blockReason}</span>}
      {streaming && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>点右侧控制台「停止」可中断（服务端不留半成品）</span>}
      {result && !streaming && (
        <button onClick={onDownload} disabled={downloading} className={`tbtn-anim${downloading ? ' task-breathe' : ''}`}
          title={`下载 ${result.fileName}`} aria-label="下载阶段性总结汇报 PPT"
          style={{ ...opBtn, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', padding: '5px 12px' }}>
          {downloading ? <Loader2 size={12} className="aispin" /> : <Download size={12} />} 下载 .pptx（{result.pageCount} 页）
        </button>
      )}
    </div>
  );
}

/** ④ 装配进度、产物摘要与降级提示区 */
function BuildProgressPanel({ streaming, pageDone, pageTotal, result }: {
  readonly streaming: boolean;
  readonly pageDone: number;
  readonly pageTotal: number;
  readonly result: SummaryStreamResult | null;
}) {
  return (
    <>
      {(streaming || pageTotal > 0) && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
            {streaming ? `装配中 ${pageDone}/${pageTotal} 页` : `已装配 ${pageDone}/${pageTotal} 页`}
          </div>
          <FlowProgress value={pageTotal ? (pageDone / pageTotal) * 100 : 0} aria-label="逐页装配进度" />
        </div>
      )}
      {result && result.projects.length > 1 && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
          合并版分区：{result.projects.map((p) => `${p.name}（${p.pages} 页）`).join(' · ')}
        </div>
      )}
      {result && result.warnings.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--warn)' }}>
          版式/降级提示 {result.warnings.length} 条（已如实写进稿内，未静默改数）：
          {result.warnings.map((w, i) => <div key={`${w}-${i}`}>• {w}</div>)}
        </div>
      )}
      {result && result.degradedPages.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--warn)' }}>
          降级安全版式的页码：{result.degradedPages.join('、')}（其余页为原生版式）
        </div>
      )}
    </>
  );
}

export function SummaryPptPanel({ projectIds: topIds, projects, toolId, onClose, openCard }: {
  /** 页面顶部 `report.projects` 的选区（空=全部项目）；默认跟随，覆盖开关只影响本卡片 */
  readonly projectIds: string[];
  readonly projects: Project[];
  readonly toolId: string;
  readonly onClose?: () => void;
  /** 校验项深链落到本页能力卡片（report?card=prd-import / tc-gen） */
  readonly openCard?: (key: 'prd-import' | 'tc-gen') => void;
}) {
  const snap = useSummaryPpt();
  // store 快照里的 outline 本面板从不读取（编辑态用本地 rows + store 镜像），故不解构它
  const { streaming, result } = snap;

  const [period, setPeriod] = useSessionState<PeriodKey>('report.summaryPpt.period', 'week');
  const [start, setStart] = useSessionState('report.summaryPpt.start', daysAgoYmd(29));
  const [end, setEnd] = useSessionState('report.summaryPpt.end', todayYmd());
  const [overrideOn, setOverrideOn] = useSessionState('report.summaryPpt.override', false);
  const [overrideIds, setOverrideIds] = useSessionState<string[]>('report.summaryPpt.projects', []);

  const [pre, setPre] = useState<PreflightResult | null>(null);
  /** 当前 pre 对应的周期/范围签名：异步返回时若用户已改档，这份 pre 不能拿来发起调用 */
  const [preSig, setPreSig] = useState('');
  const [preLoading, setPreLoading] = useState(false);
  const [preError, setPreError] = useState('');
  const [rows, setRows] = useState<SummaryOutlineItem[]>([]);
  const [extraNote, setExtraNote] = useState('');
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [outlineWarnings, setOutlineWarnings] = useState<string[]>([]);
  /** 生成本稿时的周期/范围签名：与当前不一致即要求重新生成，避免「A 范围的大纲 + B 范围的数据」 */
  const [outlineScope, setOutlineScope] = useState('');
  const [pageDone, setPageDone] = useState(0);
  const [pageTotal, setPageTotal] = useState(0);
  const [notice, setNotice] = useState('');
  const [downloading, setDownloading] = useState(false);

  const flash = useCallback((m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3500); }, []);

  const effectiveIds = overrideOn ? overrideIds : topIds;
  const scopeSignature = `${period}|${period === 'custom' ? `${start}|${end}` : ''}|${effectiveIds.join(',')}`;
  const customError = period === 'custom' ? customRangeErrorOf(start, end) : '';

  // ① 校验：周期/范围/自定义区间变更即重拉（只读、零配额——切来切去不烧模型）
  const scopeKey = effectiveIds.join(',');
  useEffect(() => {
    if (customError) { setPre(null); setPreSig(''); setPreError(''); return; }
    let alive = true;
    const sig = scopeSignature;
    setPreLoading(true); setPreError('');
    const qs = new URLSearchParams({ period });
    if (scopeKey) qs.set('projectIds', scopeKey);
    if (period === 'custom') { qs.set('start', start); qs.set('end', end); }
    void api.get<PreflightResult>(`/plans/summary-preflight?${qs.toString()}`)
      .then((r) => { if (alive) { setPre(r); setPreSig(sig); } })
      .catch((e) => { if (alive) { setPre(null); setPreSig(''); setPreError(e instanceof Error ? e.message : String(e)); } })
      .finally(() => { if (alive) setPreLoading(false); });
    return () => { alive = false; };
  }, [period, scopeKey, start, end, customError, scopeSignature]);

  // ② 大纲挂载恢复：store 无大纲但会话里有编辑稿 → 灌回（切页/刷新不丢正在进行的大纲）
  useEffect(() => {
    if (summaryPptStore.get().outline.length > 0) {
      setRows(summaryPptStore.get().outline);
      try { setOutlineScope(sessionStorage.getItem(OUTLINE_SCOPE_SESSION_KEY) ?? ''); } catch { /* 忽略 */ }
      return;
    }
    try {
      const raw = sessionStorage.getItem(OUTLINE_SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as SummaryOutlineItem[];
      if (Array.isArray(saved) && saved.length > 0) {
        setRows(saved);
        setOutlineScope(sessionStorage.getItem(OUTLINE_SCOPE_SESSION_KEY) ?? '');
        summaryPptStore.setOutline(saved);
      }
    } catch { /* 恢复失败静默，不影响新生成 */ }
  }, []);

  // 编辑稿随变化落会话（与 KickoffPptPanel 同法：组件卸载后仍能恢复）
  useEffect(() => {
    if (rows.length === 0) return;
    try { sessionStorage.setItem(OUTLINE_SESSION_KEY, JSON.stringify(rows)); } catch { /* 忽略存储异常 */ }
  }, [rows]);

  // ③ 重置联动：控制台/卡片侧 resetWorkbenchArtifacts 会清 store 与会话稿，
  //    组件本地 rows 不随之消失——不监听就会出现「重置后界面仍显示旧大纲、下次编辑又把它写回会话」的假重置
  useEffect(() => {
    const onReset = () => {
      setRows([]);
      setOutlineWarnings([]);
      setExtraNote('');
      setOutlineScope('');
      setPageDone(0);
      setPageTotal(0);
    };
    globalThis.addEventListener(CONSOLE_RESET_EVENT, onReset);
    return () => { globalThis.removeEventListener(CONSOLE_RESET_EVENT, onReset); };
  }, []);

  const preReady = !!pre && preSig === scopeSignature;
  const activePre = preReady ? pre : null;
  const resolvedIds = activePre?.projectIds ?? [];
  const isMerged = resolvedIds.length > 1;
  const blocked = activePre?.blocked ?? false;
  const missingItems = useMemo(
    () => (activePre && blocked ? activePre.items.filter((i) => activePre.missingHard.includes(i.key)) : []),
    [activePre, blocked],
  );
  const outlineGap = rows.length ? outlineGapOf(rows, activePre?.projectIds ?? []) : '';
  const outlineStale = rows.length > 0 && outlineScope !== scopeSignature;

  const update = (idx: number, patch: Partial<SummaryOutlineItem>) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  /** 结构性变更同步进 store（控制台 tab 的页数提示用）；纯文字编辑不必逐键 emit */
  const commitRows = (next: SummaryOutlineItem[]) => {
    setRows(next);
    summaryPptStore.setOutline(next, outlineWarnings);
  };
  const remove = (idx: number) => commitRows(rows.filter((_, i) => i !== idx));
  const move = (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    [next[idx], next[to]] = [next[to], next[idx]];
    commitRows(next);
  };
  const addPage = () => {
    // 合并版不允许加页（每项目固定 4 页）；单项目默认挂附录数据块，避免新页无取数
    commitRows([...rows, { section: '附录', title: '新页面', bullets: ['待补充'], dataKeys: ['appendix'], layout: 'list' }]);
  };

  /** ③ 发起大纲段（1 次 askJson，不合规则服务端自带重试 1 次后 400） */
  async function genOutline(): Promise<void> {
    if (!toolId) { flash('请先在右侧控制台选择 AI 模型工具'); return; }
    if (blocked) { flash('资料不足（S1/S2 硬阻塞），补齐后再生成大纲'); return; }
    if (!activePre) { flash('前置校验尚未完成，稍候再试'); return; }
    if (rows.length > 0 && !(await askConfirm('已有大纲稿，重新生成会覆盖当前编辑内容。继续？'))) return;
    setOutlineBusy(true);
    const scope = activePre.projectIds.length ? activePre.projectIds : undefined;
    summaryPptStore.pushLog(`大纲段：${activePre.periodLabel} · ${activePre.projectNames.join('、') || '全部项目'}，补充说明 ${extraNote ? '已附加' : '无'}…`);
    try {
      const r = await api.post<OutlineResult>('/plans/summary-ppt-outline', {
        period,
        projectIds: scope,
        ...(period === 'custom' ? { start, end } : {}),
        toolId,
        extraNote: extraNote || undefined,
      });
      setRows(r.outline);
      setOutlineWarnings(r.warnings ?? []);
      setOutlineScope(scopeSignature);
      try { sessionStorage.setItem(OUTLINE_SCOPE_SESSION_KEY, scopeSignature); } catch { /* 忽略 */ }
      summaryPptStore.setOutline(r.outline, r.warnings ?? []);
      const truncatedMark = r.truncated ? '（已按预算裁剪）' : '';
      const warnCount = (r.warnings ?? []).length;
      const warnMark = warnCount ? `，降级提示 ${warnCount} 条` : '';
      const rangeMark = `${r.pageRange.min}~${r.pageRange.max} 页`;
      summaryPptStore.pushLog(`大纲就绪：${r.outline.length} 页（目标 ${rangeMark}）${truncatedMark}${warnMark}`);
      flash(`大纲已生成 ${r.outline.length} 页——请确认后开始生成`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setOutlineBusy(false);
      summaryPptStore.pushLog(`大纲生成失败：${msg}`);
      flash(`大纲生成失败：${msg}`);
      return;
    }
    setOutlineBusy(false);
  }

  /** ④ 逐页装配：SSE stage 驱动进度，done 换下载令牌；断连即 abort（服务端不留半成品） */
  async function generate(): Promise<void> {
    if (!activePre || rows.length === 0) return;
    const ac = new AbortController();
    summaryPptStore.setAbortCtrl(ac);
    summaryPptStore.begin();
    summaryPptStore.setResult(null);
    setPageDone(0);
    setPageTotal(rows.length);
    const modeText = isMerged ? `合并版 ${activePre.projectIds.length} 个项目` : '单项目';
    summaryPptStore.pushLog(`总结汇报稿：${activePre.periodLabel}（${rangeText(activePre.periodRange)}）· ${modeText} · ${rows.length} 页大纲，开始装配…`);
    let errMsg = '';
    try {
      await streamEvents(
        '/plans/summary-ppt-stream',
        {
          period,
          projectIds: activePre.projectIds.length ? activePre.projectIds : undefined,
          ...(period === 'custom' ? { start, end } : {}),
          outline: rows,
          mode: 'merged',
        },
        (name, payload) => {
          if (name === 'stage') {
            const msg = (payload as { msg: string }).msg;
            summaryPptStore.pushLog(msg);
            const m = /页 (\d+)\/(\d+)/.exec(msg);
            if (m) { setPageDone(Number(m[1])); setPageTotal(Number(m[2])); }
          } else if (name === 'done') {
            summaryPptStore.setResult(payload as SummaryStreamResult);
          } else if (name === 'error') {
            errMsg = (payload as { error: string }).error;
          }
        },
        ac.signal,
      );
      if (errMsg) throw new Error(errMsg);
      const done = summaryPptStore.get().result;
      summaryPptStore.finish();
      if (done) {
        setPageTotal(done.pageCount);
        setPageDone(done.pageCount);
        const degradedMark = done.warnings.length ? ` · 降级 ${done.warnings.length} 条` : '';
        summaryPptStore.pushLog(`装配完成：${done.pageCount} 页 · ${done.fileName}${degradedMark}`);
        flash('已生成，点「下载 .pptx」取回（下载即删令牌）');
      }
    } catch (e) {
      if (ac.signal.aborted) return; // 用户主动「停止」：store 已清空，不再补失败日志
      const msg = e instanceof Error ? e.message : String(e);
      const queued = msg.includes(GATE_BUSY_MSG);
      summaryPptStore.finish(queued ? `并发闸排队：${msg}` : `生成失败：${msg}`);
      flash(queued ? `${msg}——前面有周报/启动会稿在装配，稍后重试即可（不是失败）` : msg);
    } finally {
      summaryPptStore.setAbortCtrl(null);
    }
  }

  /** 下载：文件名用服务端 done.fileName 原值——洗名口径单源在服务端，前端重组会绕过白名单 */
  async function download(): Promise<void> {
    if (!result) return;
    setDownloading(true);
    try {
      const { blob, filename } = await api.download('/report/ai-download', { token: result.token, filename: result.fileName });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      flash(`已下载 ${filename}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

  async function clearOutline(): Promise<void> {
    if (rows.length === 0) return;
    if (!(await askConfirm('清空当前大纲稿？（不影响已生成的文件）'))) return;
    setRows([]);
    setOutlineWarnings([]);
    setOutlineScope('');
    summaryPptStore.setOutline([]);
    try { sessionStorage.removeItem(OUTLINE_SESSION_KEY); sessionStorage.removeItem(OUTLINE_SCOPE_SESSION_KEY); } catch { /* 忽略 */ }
  }

  const outlineBlockReason = ((): string => {
    if (!toolId) return '请先在右侧控制台选择 AI 模型工具';
    if (customError) return customError;
    if (!activePre) return preLoading ? '前置校验进行中…' : (preError ? '前置校验失败，无法发起大纲' : '前置校验尚未完成');
    if (blocked) return '资料不足（S1/S2 硬阻塞），请先补齐后重开校验';
    return '';
  })();

  const generateBlockReason = ((): string => {
    if (outlineBlockReason) return outlineBlockReason;
    if (outlineStale) return '周期或项目范围已变更，请重新生成大纲';
    if (rows.length === 0) return '请先生成并确认大纲';
    if (outlineGap) return outlineGap;
    return '';
  })();

  const canGenerate = !streaming && !outlineBusy && !generateBlockReason;
  const scopeText = activePre
    ? `本周期：${rangeText(activePre.periodRange)} ｜ 项目 ${activePre.projectIds.length} 个 ｜ 预计 2 次 AI 调用（大纲 + 逐页装配）`
    : '';

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <FileChartColumn size={15} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 14 }}>阶段性项目总结汇报 PPT 生成</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          周期与范围 → 校验 S1~S9（只读）→ AI 出大纲（人工确认）→ 本地逐页装配原生可编辑 .pptx，过程见右侧控制台
        </span>
        <span style={{ flex: 1 }} />
        {onClose && <button onClick={onClose} className="tbtn-anim" title="收起面板" aria-label="收起总结汇报 PPT 面板" style={opBtn}><X size={12} /></button>}
      </div>

      {/* ① 周期与范围 */}
      <PeriodScopeSection period={period} onPeriod={setPeriod} start={start} end={end} onStart={setStart} onEnd={setEnd}
        customError={customError} overrideOn={overrideOn} onOverrideOn={setOverrideOn}
        overrideIds={overrideIds} onOverrideIds={setOverrideIds} topIds={topIds} projects={projects} scopeText={scopeText} />

      {/* ② 前置校验 checklist */}
      <PreflightChecklist pre={pre} loading={preLoading} error={preError} projectId={resolvedIds[0] ?? ''}
        missingItems={missingItems} openCard={openCard} />

      {/* ③ 大纲编辑 */}
      <OutlineToolbar extraNote={extraNote} onExtraNoteChange={setExtraNote} streaming={streaming} outlineBusy={outlineBusy}
        blockedReason={outlineBlockReason} rowCount={rows.length} onGenOutline={() => void genOutline()} onClear={() => void clearOutline()} />

      {outlineStale && (
        <div style={{ fontSize: 11, color: 'var(--warn)', marginBottom: 8 }}>
          ⚠ 周期或项目范围已变更——当前大纲是按旧范围生成的，请重新生成大纲后再装配。
        </div>
      )}
      {outlineWarnings.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--warn)', marginBottom: 8 }}>
          {outlineWarnings.map((w, i) => <div key={`${w}-${i}`}>⚠ {w}</div>)}
        </div>
      )}
      {!!outlineGap && rows.length > 0 && !outlineStale && (
        <div style={{ fontSize: 11, color: 'var(--warn)', marginBottom: 8 }}>⚠ {outlineGap}</div>
      )}

      {rows.length > 0 && (
        <OutlinePageList rows={rows} streaming={streaming} merged={isMerged}
          onPatch={update} onRemove={remove} onMove={move} onAdd={addPage} />
      )}

      {/* ④ 生成与下载 */}
      <GenerateBar streaming={streaming} canGenerate={canGenerate} blockReason={generateBlockReason} result={result}
        downloading={downloading} onGenerate={() => void generate()} onDownload={() => void download()} />

      <BuildProgressPanel streaming={streaming} pageDone={pageDone} pageTotal={pageTotal} result={result} />

      {notice && <output className="flash-toast">{notice}</output>}
    </div>
  );
}
