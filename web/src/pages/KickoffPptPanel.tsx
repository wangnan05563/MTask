/**
 * T02109（PRD-项目启动会PPT生成 §3.1/§3.2/§3.3 · 技术方案 §6）：AI 工作台「项目启动会 PPT 生成」工作面板。
 *
 * 三段式（FR-3 的 outline-first 流程在 UI 上的投影，不可跳段）：
 *  ① 前置校验 checklist（FR-2.1/2.2/2.4）：`GET /plans/kickoff-preflight` 只读聚合（零 AI 调用），
 *     逐项 ✓/⚠/✕ + 条数 + 一句「怎么补」+ 深链；P1+P2+P3 同缺即 blocked，硬阻塞时禁止发起生成。
 *  ② 大纲确认（FR-3.3「人工确认」）：`POST /plans/kickoff-ppt-outline` 出 12~18 页，
 *     标题/要点/版式/章节就地可改、可增删页与调序——**内存态 + sessionStorage**，不落库。
 *  ③ 生成与下载（FR-3.5/FR-5）：`POST /plans/kickoff-ppt-stream` 逐页 SSE `stage` → `done {token,fileName}`，
 *     进度条按「页 n/N」推进，warnings 原样列出；下载用服务端 fileName（洗名单源在服务端，前端不重组）。
 *
 * 与 `TestCaseGenPanel` 同构的三点：streamEvents 调用范式、AbortController 登记进 store、
 * 编辑态落 sessionStorage（切页/刷新回来不丢正在进行的大纲）。
 * 确认一律走 `askConfirm`（Electron 下 window.confirm 不可用，仓内既有口径）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { streamEvents, GATE_BUSY_MSG } from '../api/sse';
import { kickoffPptStore, useKickoffPpt, type KickoffOutlineItem, type KickoffStreamResult } from '../stores/kickoffPptStore';
import { FlowProgress } from '../ui/FlowProgress';
import { askConfirm } from '../ui/dialogs';
import { CONSOLE_RESET_EVENT } from '../ui/consoleReset'; // T02109：工作台重置广播——面板本地大纲稿随重置归零
import { ChevronDown, ChevronUp, CircleAlert, CircleCheck, CircleX, Download, FileText, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react';

/** 服务端 `PreflightItem` 的前端镜像（单源：`server/src/services/kickoffService.ts`） */
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
  projectId: string;
  projectName: string;
  items: PreflightItem[];
  blocked: boolean;
  missingHard: string[];
  workloadSource: 'estimate' | 'duration';
}

/**
 * 章节与版式候选：值域单源在服务端 `KICKOFF_SECTIONS` / `KICKOFF_LAYOUTS`
 * （`assertOutlineShape` 会按白名单拒绝越界值），此处镜像一份供下拉选择。
 * 两份清单的一致性由 `verify-t02111` 的源码守卫断言，不靠人记。
 */
const SECTIONS = ['封面', '议程', '项目团队介绍', '项目背景', '项目需求', '项目范围', '项目计划', '工作量评估', '测试与质量策略', '项目风险', '沟通管理', '附录'];
const LAYOUTS = ['cover', 'toc', 'twoCol', 'table', 'chart', 'timeline', 'list', 'flow', 'chip', 'section', 'thanks'];

/** 大纲编辑态会话键（重置入口在 consoleReset 的产物键清单里，与控制台重置等效） */
const OUTLINE_SESSION_KEY = 'kickoff.outline';

/** 导出闸超限文案判定串见 `api/sse.ts` 的 GATE_BUSY_MSG（T02142 起与周报面板共用同一单源） */

const opBtn = { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 7px' } as const;
const cellInput = { fontSize: 12, padding: '3px 6px', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' } as const;

function statusIcon(status: PreflightStatus) {
  if (status === 'ok') return <CircleCheck size={13} style={{ color: 'var(--success, var(--accent))', flexShrink: 0 }} />;
  return status === 'warn'
    ? <CircleAlert size={13} style={{ color: 'var(--warn)', flexShrink: 0 }} />
    : <CircleX size={13} style={{ color: 'var(--danger)', flexShrink: 0 }} />;
}

/**
 * 校验项深链落地（沿用 PrdGenPanel T00821 的会话键 + mtaskNavigate 口径，不新建第三套导航机制）：
 * `plan?menu=*` 写 PlanPage 的展开态再切 Tab；`report?card=*` 回本页展开对应卡片（互斥自动收起本面板）。
 */
function goDeepLink(link: string, projectId: string, openCard?: (key: 'prd-import' | 'tc-gen') => void): void {
  try {
    if (link.startsWith('report?card=')) {
      openCard?.(link.slice('report?card='.length) as 'prd-import' | 'tc-gen');
      return;
    }
    const [path, query] = link.split('?');
    if (path !== 'plan') return;
    sessionStorage.setItem('plan.projectId', JSON.stringify(projectId));
    const menu = new URLSearchParams(query ?? '').get('menu');
    if (menu === 'prd') sessionStorage.setItem('plan.showPrd', JSON.stringify(true));
    if (menu === 'matrix') sessionStorage.setItem('plan.showMatrix', JSON.stringify(true));
    globalThis.dispatchEvent(new CustomEvent('mtaskNavigate', { detail: { tab: 'plan' } }));
  } catch { /* 跳转异常静默：校验结论本身已展示 */ }
}

/**
 * 「开始生成」按钮的禁用原因：正向条件逐级早返回，空串=可以生成。
 * 从面板主体的四段取反嵌套三元拆出（渲染文案不变）。
 */
function generateBlockReasonOf(projectId: string, toolId: string, blocked: boolean, rowCount: number): string {
  if (!projectId) return '先在页面顶部选择项目范围';
  if (!toolId) return '请先在右侧控制台选择 AI 模型工具';
  if (blocked) return '资料不足（PRD/需求矩阵/计划三项均缺），请先补齐后重开校验';
  if (rowCount === 0) return '请先生成并确认大纲';
  return '';
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
        <span style={{ fontWeight: 600 }}>{it.label}</span>
        <span style={{ color: 'var(--text-muted)' }}> · {it.count} 条{it.hard ? '（必需）' : ''}</span>
        <span style={{ display: 'block', color: 'var(--text-secondary)', marginTop: 2 }}>{it.note}</span>
      </span>
      {it.status !== 'ok' && (
        <button onClick={() => goDeepLink(it.deepLink, projectId, openCard)} className="tbtn-anim"
          title={`去补充 — ${it.deepLink}`} aria-label={`去补充${it.label}`} style={opBtn}>去补充</button>
      )}
    </div>
  );
}

/** ① 前置校验 checklist 段（网格 + 硬阻塞横幅 + ⚠ 级提示） */
function PreflightChecklist({ pre, preLoading, preError, projectId, blocked, missingItems, openCard }: {
  readonly pre: PreflightResult | null;
  readonly preLoading: boolean;
  readonly preError: string;
  readonly projectId: string;
  readonly blocked: boolean;
  readonly missingItems: PreflightItem[];
  readonly openCard?: (key: 'prd-import' | 'tc-gen') => void;
}) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        资料齐备性校验（只读，不调用 AI）
        {preLoading && <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>校验中…</span>}
      </div>
      {!projectId && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>先在页面顶部选择项目范围，校验与生成都以该项目为准。</div>}
      {projectId && preError && <div style={{ fontSize: 11, color: 'var(--danger)' }}>校验失败：{preError}</div>}
      {pre && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 6 }}>
            {pre.items.map((it) => <PreflightItemCard key={it.key} it={it} projectId={projectId} openCard={openCard} />)}
          </div>
          {blocked && (
            <div style={{ marginTop: 8, border: '1px solid var(--danger)', borderRadius: 6, padding: '6px 8px', fontSize: 11, color: 'var(--danger)' }}>
              硬阻塞：{missingItems.map((i) => i.label).join('、')} 均无数据，生成只会得到空壳稿——已禁止发起。
              <span style={{ display: 'inline-flex', gap: 6, marginLeft: 6, flexWrap: 'wrap' }}>
                {missingItems.map((i) => (
                  <button key={i.key} onClick={() => goDeepLink(i.deepLink, projectId, openCard)} className="tbtn-anim"
                    title={`去补充 — ${i.deepLink}`} aria-label={`去补充${i.label}`} style={opBtn}>{i.label}</button>
                ))}
              </span>
            </div>
          )}
          {!blocked && pre.items.some((i) => i.status === 'warn') && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--warn)' }}>
              ⚠ 级项可继续生成，但降级会在对应 PPT 页面页脚留痕（客户会上追问时页面上要有依据）。
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** ② 大纲段工具条（补充说明 + 生成/重新生成 + 清空 + 页数提示） */
function OutlineToolbar({ extraNote, onExtraNoteChange, streaming, outlineBusy, blocked, genDisabled, rowCount, onGenOutline, onClear }: {
  readonly extraNote: string;
  readonly onExtraNoteChange: (value: string) => void;
  readonly streaming: boolean;
  readonly outlineBusy: boolean;
  readonly blocked: boolean;
  readonly genDisabled: boolean;
  readonly rowCount: number;
  readonly onGenOutline: () => void;
  readonly onClear: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
      <input value={extraNote} onChange={(e) => onExtraNoteChange(e.target.value)} placeholder="补充说明（可选，会拼进大纲提示词）" aria-label="大纲补充说明"
        style={{ ...cellInput, flex: '1 1 220px', minWidth: 180 }} disabled={streaming} />
      {/* FR-2.4 硬阻塞时同时禁掉大纲发起：否则一次 AI 调用只换来一份空壳大纲，与「禁止生成空壳稿」同义 */}
      <button onClick={onGenOutline} disabled={genDisabled} className="tbtn-anim"
        title={blocked ? '资料不足（PRD/需求矩阵/计划三项均缺），补齐后再生成大纲' : '调用 AI 生成分页大纲（1 次模型调用）'} aria-label="生成大纲"
        style={{ ...opBtn, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', padding: '5px 12px' }}>
        {outlineBusy ? <Loader2 size={12} className="task-breathe" /> : <Sparkles size={12} />} {rowCount ? '重新生成大纲' : '生成大纲'}
      </button>
      {rowCount > 0 && <button onClick={onClear} disabled={streaming} className="tbtn-anim" title="清空大纲稿" aria-label="清空大纲" style={opBtn}><Trash2 size={11} /> 清空</button>}
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{rowCount ? `共 ${rowCount} 页（建议 12~18）` : '大纲 12~18 页，可改标题/要点/版式，可增删页与调序'}</span>
    </div>
  );
}

/** ② 大纲编辑列表：就地改章节/标题/版式/要点 + 上移下移删除 + 追加一页 */
function OutlinePageList({ rows, streaming, onPatch, onRemove, onMove, onAdd }: {
  readonly rows: KickoffOutlineItem[];
  readonly streaming: boolean;
  readonly onPatch: (idx: number, patch: Partial<KickoffOutlineItem>) => void;
  readonly onRemove: (idx: number) => void;
  readonly onMove: (idx: number, dir: -1 | 1) => void;
  readonly onAdd: () => void;
}) {
  return (
    <div style={{ maxHeight: 340, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 10 }}>
      {rows.map((r, idx) => (
        <div key={`${r.section}-${idx}`} style={{ borderBottom: '1px solid var(--border)', padding: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 22, textAlign: 'right', marginTop: 6 }}>{idx + 1}</span>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <select value={r.section} onChange={(e) => onPatch(idx, { section: e.target.value })} disabled={streaming}
                title="章节" aria-label={`第${idx + 1}页章节`} style={cellInput}>
                {SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <input value={r.title} onChange={(e) => onPatch(idx, { title: e.target.value })} disabled={streaming}
                placeholder="页标题（≤30 字）" aria-label={`第${idx + 1}页标题`} style={{ ...cellInput, flex: 1, minWidth: 160 }} />
              <select value={r.layout} onChange={(e) => onPatch(idx, { layout: e.target.value })} disabled={streaming}
                title="版式" aria-label={`第${idx + 1}页版式`} style={cellInput}>
                {LAYOUTS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', alignSelf: 'center' }}>
                取数：{r.dataKeys.length ? r.dataKeys.join('、') : '无'}
              </span>
            </div>
            <textarea value={r.bullets.join('\n')} onChange={(e) => onPatch(idx, { bullets: e.target.value.split('\n') })}
              disabled={streaming} rows={Math.min(6, Math.max(2, r.bullets.length))}
              placeholder="每行一条要点（每条 ≤42 字，每页 ≤6 条）" aria-label={`第${idx + 1}页要点`}
              style={{ ...cellInput, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <button onClick={() => onMove(idx, -1)} disabled={streaming || idx === 0} className="tbtn-anim" title="上移" aria-label="上移" style={{ ...opBtn, padding: '1px 5px' }}><ChevronUp size={11} /></button>
            <button onClick={() => onMove(idx, 1)} disabled={streaming || idx === rows.length - 1} className="tbtn-anim" title="下移" aria-label="下移" style={{ ...opBtn, padding: '1px 5px' }}><ChevronDown size={11} /></button>
            <button onClick={() => onRemove(idx)} disabled={streaming} className="tbtn-anim" title="删除该页" aria-label="删除该页"
              style={{ ...opBtn, padding: '1px 5px', color: 'var(--danger)', border: 'none', background: 'transparent' }}><Trash2 size={11} /></button>
          </div>
        </div>
      ))}
      <div style={{ padding: 6 }}>
        <button onClick={onAdd} disabled={streaming} className="tbtn-anim" title="追加一页" aria-label="追加一页" style={opBtn}><Plus size={11} /> 加一页</button>
      </div>
    </div>
  );
}

/** ③ 生成与下载条 */
function GenerateBar({ streaming, canGenerate, blockReason, result, downloading, onGenerate, onDownload }: {
  readonly streaming: boolean;
  readonly canGenerate: boolean;
  readonly blockReason: string;
  readonly result: KickoffStreamResult | null;
  readonly downloading: boolean;
  readonly onGenerate: () => void;
  readonly onDownload: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <button onClick={onGenerate} disabled={!canGenerate} className="tbtn-anim"
        title={blockReason || '逐页装配 .pptx 并落盘换下载令牌'} aria-label="开始生成启动会 PPT"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, border: 'none', borderRadius: 6,
          background: canGenerate ? 'var(--accent)' : 'var(--border-strong)', color: canGenerate ? 'var(--accent-text)' : 'var(--text-muted)',
          cursor: canGenerate ? 'pointer' : 'default', padding: '5px 12px' }}>
        {streaming ? <Loader2 size={12} className="task-breathe" /> : <Sparkles size={12} />} 开始生成
      </button>
      {!!blockReason && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{blockReason}</span>}
      {streaming && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>点右侧控制台「停止」可中断（服务端不留半成品）</span>}
      {result && !streaming && (
        <button onClick={onDownload} disabled={downloading} className="tbtn-anim"
          title={`下载 ${result.fileName}`} aria-label="下载启动会 PPT"
          style={{ ...opBtn, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', padding: '5px 12px' }}>
          {downloading ? <Loader2 size={12} className="task-breathe" /> : <Download size={12} />} 下载 .pptx（{result.pageCount} 页）
        </button>
      )}
    </div>
  );
}

/** ③ 装配进度与降级提示区 */
function BuildProgressPanel({ streaming, pageDone, pageTotal, result }: {
  readonly streaming: boolean;
  readonly pageDone: number;
  readonly pageTotal: number;
  readonly result: KickoffStreamResult | null;
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
      {result && result.warnings.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--warn)' }}>
          版式/降级提示 {result.warnings.length} 条（已如实写进稿内，未静默改数）：
          {result.warnings.map((w, i) => <div key={`${w}-${i}`}>• {w}</div>)}
        </div>
      )}
    </>
  );
}

export function KickoffPptPanel({ projectId, toolId, onClose, openCard }: {
  readonly projectId: string;
  readonly toolId: string;
  readonly onClose?: () => void;
  readonly openCard?: (key: 'prd-import' | 'tc-gen') => void;
}) {
  const snap = useKickoffPpt();
  // store 快照里的 outline 本面板从不读取（大纲编辑态一律用本地 rows + store），故不解构它
  const { streaming, result } = snap;
  const [pre, setPre] = useState<PreflightResult | null>(null);
  const [preLoading, setPreLoading] = useState(false);
  const [preError, setPreError] = useState('');
  const [rows, setRows] = useState<KickoffOutlineItem[]>([]);
  const [extraNote, setExtraNote] = useState('');
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [outlineWarnings, setOutlineWarnings] = useState<string[]>([]);
  const [pageDone, setPageDone] = useState(0);
  const [pageTotal, setPageTotal] = useState(0);
  const [notice, setNotice] = useState('');
  const [downloading, setDownloading] = useState(false);

  const flash = useCallback((m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3500); }, []);

  // ① 校验：项目变更即重拉（只读、零配额，FR-2.3——切来切去不烧模型）
  useEffect(() => {
    if (!projectId) { setPre(null); return; }
    setPreLoading(true); setPreError('');
    void api.get<PreflightResult>(`/plans/kickoff-preflight?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => setPre(r))
      .catch((e) => { setPre(null); setPreError(e instanceof Error ? e.message : String(e)); })
      .finally(() => setPreLoading(false));
  }, [projectId]);

  // ② 大纲挂载恢复：store 无大纲但会话里有编辑稿 → 灌回（切页/刷新不丢正在进行的大纲）
  useEffect(() => {
    if (kickoffPptStore.get().outline.length > 0) { setRows(kickoffPptStore.get().outline); return; }
    try {
      const raw = sessionStorage.getItem(OUTLINE_SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as KickoffOutlineItem[];
      if (Array.isArray(saved) && saved.length > 0) {
        setRows(saved);
        kickoffPptStore.setOutline(saved);
      }
    } catch { /* 恢复失败静默，不影响新生成 */ }
  }, []);

  // 编辑稿随变化落会话（与 TestCaseGenPanel §8.7 同法：组件卸载后仍能恢复）
  useEffect(() => {
    if (rows.length === 0) return;
    try { sessionStorage.setItem(OUTLINE_SESSION_KEY, JSON.stringify(rows)); } catch { /* 忽略存储异常 */ }
  }, [rows]);

  // ③ 重置联动：控制台/卡片侧 resetWorkbenchArtifacts 会清 store 与会话稿，
  //    但组件本地 rows 不随之消失——不监听就会出现「重置后界面仍显示旧大纲、下次编辑又把它写回会话」的假重置
  useEffect(() => {
    const onReset = () => {
      setRows([]);
      setOutlineWarnings([]);
      setExtraNote('');
      setPageDone(0);
      setPageTotal(0);
    };
    globalThis.addEventListener(CONSOLE_RESET_EVENT, onReset);
    return () => { globalThis.removeEventListener(CONSOLE_RESET_EVENT, onReset); };
  }, []);

  const blocked = pre?.blocked ?? false;
  const missingItems = useMemo(
    () => (pre && blocked ? pre.items.filter((i) => pre.missingHard.includes(i.key)) : []),
    [pre, blocked],
  );

  const update = (idx: number, patch: Partial<KickoffOutlineItem>) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const remove = (idx: number) => setRows((prev) => prev.filter((_, i) => i !== idx));
  const move = (idx: number, dir: -1 | 1) => setRows((prev) => {
    const to = idx + dir;
    if (to < 0 || to >= prev.length) return prev;
    const next = [...prev];
    [next[idx], next[to]] = [next[to], next[idx]];
    return next;
  });
  const addPage = () => {
    const next: KickoffOutlineItem[] = [...rows, { section: '附录', title: '新页面', bullets: ['待补充'], dataKeys: ['preflight'], layout: 'list' }];
    setRows(next);
    kickoffPptStore.setOutline(next);
  };

  /** ② 发起大纲段（1 次 askJson，不合规则服务端自带重试 1 次后 400） */
  async function genOutline(): Promise<void> {
    if (!projectId) { flash('请先在页面顶部选择项目范围'); return; }
    if (!toolId) { flash('请先在右侧控制台选择 AI 模型工具'); return; }
    if (rows.length > 0 && !(await askConfirm('已有大纲稿，重新生成会覆盖当前编辑内容。继续？'))) return;
    setOutlineBusy(true);
    kickoffPptStore.pushLog(`大纲段：项目 ${pre?.projectName ?? projectId}，补充说明 ${extraNote ? '已附加' : '无'}…`);
    try {
      const r = await api.post<{ outline: KickoffOutlineItem[]; warnings: string[]; truncated: boolean; projectName: string }>(
        '/plans/kickoff-ppt-outline', { projectId, toolId, extraNote: extraNote || undefined },
      );
      setRows(r.outline);
      setOutlineWarnings(r.warnings ?? []);
      kickoffPptStore.setOutline(r.outline, r.warnings ?? []);
      // 嵌套模板串拆成中间变量：拼接结果与原实现逐字一致
      const truncatedMark = r.truncated ? '（已按 18 页上限裁剪）' : '';
      const warnCount = (r.warnings ?? []).length;
      const warnMark = warnCount ? `，降级提示 ${warnCount} 条` : '';
      kickoffPptStore.pushLog(`大纲就绪：${r.outline.length} 页${truncatedMark}${warnMark}`);
      flash(`大纲已生成 ${r.outline.length} 页——请确认后开始装配`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setOutlineBusy(false);
      kickoffPptStore.pushLog(`大纲生成失败：${msg}`);
      flash(`大纲生成失败：${msg}`);
      return;
    }
    setOutlineBusy(false);
  }

  /** ③ 逐页装配：SSE stage 驱动进度，done 换下载令牌；断连即 abort（服务端不留半成品） */
  async function generate(): Promise<void> {
    if (!projectId || !toolId || rows.length === 0) return;
    const ac = new AbortController();
    kickoffPptStore.setAbortCtrl(ac);
    kickoffPptStore.begin();
    kickoffPptStore.setResult(null);
    setPageDone(0);
    setPageTotal(rows.length);
    kickoffPptStore.pushLog(`启动会稿：${rows.length} 页大纲、目标模型已选，开始装配…`);
    let errMsg = '';
    try {
      await streamEvents(
        '/plans/kickoff-ppt-stream',
        { projectId, toolId, outline: rows },
        (name, payload) => {
          if (name === 'stage') {
            const msg = (payload as { msg: string }).msg;
            kickoffPptStore.pushLog(msg);
            const m = /页 (\d+)\/(\d+)/.exec(msg);
            if (m) { setPageDone(Number(m[1])); setPageTotal(Number(m[2])); }
          } else if (name === 'done') {
            kickoffPptStore.setResult(payload as KickoffStreamResult);
          } else if (name === 'error') {
            errMsg = (payload as { error: string }).error;
          }
        },
        ac.signal,
      );
      if (errMsg) throw new Error(errMsg);
      const done = kickoffPptStore.get().result;
      kickoffPptStore.finish();
      if (done) {
        setPageTotal(done.pageCount);
        setPageDone(done.pageCount);
        // 嵌套模板串拆成中间变量：拼接结果与原实现逐字一致
        const degradedMark = done.warnings.length ? ` · 降级 ${done.warnings.length} 条` : '';
        kickoffPptStore.pushLog(`装配完成：${done.pageCount} 页 · ${done.fileName}${degradedMark}`);
        flash('已生成，点「下载 .pptx」取回（下载即删令牌）');
      }
    } catch (e) {
      if (ac.signal.aborted) return; // 用户主动「停止」：store 已清空，不再补失败日志
      const msg = e instanceof Error ? e.message : String(e);
      const queued = msg.includes(GATE_BUSY_MSG);
      kickoffPptStore.finish(queued ? `并发闸排队：${msg}` : `生成失败：${msg}`);
      flash(queued ? `${msg}——前面有周报/启动会稿在装配，稍后重试即可（不是失败）` : msg);
    } finally {
      kickoffPptStore.setAbortCtrl(null);
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
    kickoffPptStore.setOutline([]);
    try { sessionStorage.removeItem(OUTLINE_SESSION_KEY); } catch { /* 忽略 */ }
  }

  const canGenerate = !streaming && !outlineBusy && !!projectId && !!toolId && rows.length > 0 && !blocked;
  const generateBlockReason = generateBlockReasonOf(projectId, toolId, blocked, rows.length);

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <FileText size={15} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 14 }}>项目启动会 PPT 生成</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          校验资料齐备性 → AI 出大纲（人工确认）→ 本地按真实条数逐页装配原生可编辑 .pptx，过程见右侧控制台
        </span>
        <span style={{ flex: 1 }} />
        {pre && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>项目：{pre.projectName} · 工作量口径：{pre.workloadSource === 'estimate' ? '估算引擎' : '工期推导'}</span>}
        {onClose && <button onClick={onClose} className="tbtn-anim" title="收起面板" aria-label="收起启动会 PPT 面板" style={opBtn}><X size={12} /></button>}
      </div>

      {/* ① 前置校验 checklist */}
      <PreflightChecklist pre={pre} preLoading={preLoading} preError={preError} projectId={projectId}
        blocked={blocked} missingItems={missingItems} openCard={openCard} />

      {/* ② 大纲编辑 */}
      <OutlineToolbar extraNote={extraNote} onExtraNoteChange={setExtraNote} streaming={streaming} outlineBusy={outlineBusy}
        blocked={blocked} genDisabled={streaming || outlineBusy || !projectId || !toolId || blocked} rowCount={rows.length}
        onGenOutline={() => void genOutline()} onClear={() => void clearOutline()} />

      {outlineWarnings.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--warn)', marginBottom: 8 }}>
          {outlineWarnings.map((w, i) => <div key={`${w}-${i}`}>⚠ {w}</div>)}
        </div>
      )}

      {rows.length > 0 && (
        <OutlinePageList rows={rows} streaming={streaming} onPatch={update} onRemove={remove} onMove={move} onAdd={addPage} />
      )}

      {/* ③ 生成与下载 */}
      <GenerateBar streaming={streaming} canGenerate={canGenerate} blockReason={generateBlockReason} result={result}
        downloading={downloading} onGenerate={() => void generate()} onDownload={() => void download()} />

      <BuildProgressPanel streaming={streaming} pageDone={pageDone} pageTotal={pageTotal} result={result} />

      {notice && <output className="flash-toast">{notice}</output>}
    </div>
  );
}
