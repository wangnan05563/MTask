import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FILE_INPUT_SR_ONLY } from '../ui/fileInput'; // T01674：file input 视觉隐藏但保留键盘焦点
import { api } from '../api/client';
import { Eye, FileUp, Save, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { useSessionState } from '../ui/session';
import { ProjectListHint, projectListPlaceholder, useProjectList } from '../ui/projectList';
import { aiImportStore } from '../stores/aiImportStore';

/** T00662：PRD 解析结果（需求项 + WBS 计划草稿） */
interface PrdReq { reqNo: string; title: string; content: string; sourceRef: string; priority: string; include: boolean; key: string; }
/** T01001：kind 可选——AI 解析出的里程碑/普通任务类型（后端可能未返回时缺省），编辑也是普通任务 */
interface PrdPlan { title: string; description: string; durationDays: number; reqNos: string[]; kind?: 'milestone' | 'normal' | 'daily'; include: boolean; key: string; }

/**
 * T01001 二轮：里程碑工期 = 其下明细任务工期之和。
 * 口径与项目管理页「里程碑汇总」一致：本里程碑之后、下一个里程碑之前的非里程碑行即其明细；
 * 只统计勾选（include）的明细，正好等于最终会导入的那些行（未勾选不入计划表）。
 * 里程碑自身工期不可手工调整，改任一明细即联动重算——修复「M1 工期 4、子任务合计 5 不相等」。
 */
function isMilestoneRow(p: Pick<PrdPlan, 'kind'>): boolean {
  return p.kind === 'milestone';
}

/** 重算全部里程碑工期（返回新数组；无明细的里程碑保留原值） */
function recalcMilestoneDurations(list: PrdPlan[]): PrdPlan[] {
  const out = list.map((p) => ({ ...p }));
  for (let i = 0; i < out.length; i++) {
    if (!isMilestoneRow(out[i])) continue;
    let sum = 0;
    for (let j = i + 1; j < out.length; j++) {
      if (isMilestoneRow(out[j])) break;
      if (out[j].include) sum += Math.max(1, Math.round(Number(out[j].durationDays) || 1));
    }
    if (sum > 0) out[i] = { ...out[i], durationDays: sum };
  }
  return out;
}

/** /plans/import-prd 响应（S3776：doImport 的结果播报分支抽为 logImportResult，字段口径与原文案一字未改） */
interface ImportPrdResult {
  requirements: number; plans: number; tasks: number;
  unlinkedReqNos?: string[]; prdId?: string;
  reqNoMap?: Array<{ from: string; to: string }>;
  dupPlanTitles?: Array<{ title: string; existing: number; renamedTo?: string; reusedPlanId?: string }>;
  reusedPlans?: number; ambiguousReqNos?: string[];
  orphanRequirements?: Array<{ reqNo: string; title: string }>;
  /** T02303 甲：payload 条数之外，本次「真新建」与「复用存量」的需求行数 */
  requirementsCreated?: number; reusedRequirements?: number;
}

/** T02300：/plans/import-prd/preview 响应（只读预演，字段口径与 importPrd 同源） */
interface PrdPreviewResult {
  willCreatePlans: number; willReusePlans: number; willRenamePlans: number;
  dupPlanTitles: Array<{ title: string; existing: number; renamedTo?: string; reusedPlanId?: string }>;
  requirements: number; willCreateReqs: number; willReuseReqs: number;
  reqNoMap: Array<{ from: string; to: string }>;
  ambiguousReqNos: string[]; unlinkedReqNos: string[];
  orphanRequirements: Array<{ reqNo: string; title: string }>;
  prdDoc: { action: 'none' | 'reuse' | 'create'; id?: string; by?: 'hash' | 'name' };
  planRowsPreview: Array<{ title: string; reuseId: string | null }>;
  createTasks: boolean;
  readOnly: true;
}

/**
 * T02300：预演结果播报。放在导入按钮之前，让用户点「导入」**前**就看到连带影响——
 * T01869 的原始症状（重导后两行同名、一行被读成 todo/0）之所以被误判成「原有计划被回档」，
 * 正是因为导入前的连带影响完全不可见。文案必须写清两条事实（实测口径）：
 * ① 存量矩阵/计划行不会被删除或改写（importPrd 全文零 DELETE）；
 * ② reuse 模式下「同标题 + 同内容」的需求行会被复用（T02303 甲），只有内容变化的才新建并顺延编号。
 */
function logPreviewResult(p: PrdPreviewResult): void {
  const docPart = p.prdDoc.action === 'reuse'
    ? `PRD 原文命中存量文档（按${p.prdDoc.by === 'hash' ? '同内容' : '同文件名'}复用并覆盖其正文，不新建）`
    : p.prdDoc.action === 'create' ? 'PRD 原文将新建一条文档记录' : '本次未带 PRD 正文，不落文档';
  aiImportStore.log(
    `预演结果（只读，未改动任何数据）：需求 新建 ${p.willCreateReqs} 条 / 复用同标题同内容存量 ${p.willReuseReqs} 条；`
    + `计划 新建 ${p.willCreatePlans} 条（其中撞名让号 ${p.willRenamePlans} 条）/ 复用同名存量 ${p.willReusePlans} 条；${docPart}`
    + `${p.createTasks ? '；已勾选同步生成待办（只给新建的计划行派生待办）' : ''}`,
    'info',
  );
  aiImportStore.log('预演补充：以上计数不改存量行——导入只新增/补写，既有需求与计划的状态、进度、编号一律不被删除或改写', 'info');
  if (p.willReuseReqs) {
    aiImportStore.log(`需求侧复用：${p.willReuseReqs} 条与存量「同标题且同内容」的需求行命中，将复用原行不新建（内容有一字之差即视为新行）`, 'info');
  }
  if (p.reqNoMap?.length) {
    const pairs = p.reqNoMap.slice(0, 12).map((x) => `${x.from}→${x.to}`).join('、');
    aiImportStore.log(`编号让号预告：${p.reqNoMap.length} 条需求编号会与矩阵已有编号冲突，将改为项目内顺延号（${pairs}${p.reqNoMap.length > 12 ? ' 等' : ''}）`, 'info');
  }
  if (p.dupPlanTitles?.length) {
    const renamed = p.dupPlanTitles.filter((x) => x.renamedTo);
    const reused = p.dupPlanTitles.filter((x) => x.reusedPlanId);
    if (renamed.length) aiImportStore.log(`同名计划让号预告：${renamed.length} 个标题在项目内已存在（${renamed.slice(0, 8).map((x) => `${x.title}→「${x.renamedTo}」`).join('、')}${renamed.length > 8 ? ' 等' : ''}），原行不变、新行带后缀`, 'info');
    if (reused.length) aiImportStore.log(`同名计划复用预告：${reused.length} 个标题命中存量同名行，将补写到原行（status/progress 一字不动）`, 'info');
  }
  if (p.unlinkedReqNos?.length) {
    aiImportStore.log(`预演告警：${p.unlinkedReqNos.length} 个需求编号在本次导入里找不到对应需求行（${p.unlinkedReqNos.join('、')}），其计划/待办关联将被忽略——请核对编号或先补导对应需求`, 'error');
  }
  if (p.ambiguousReqNos?.length) {
    aiImportStore.log(`预演告警：${p.ambiguousReqNos.length} 个需求编号在本次 payload 的多个来源里重复（${p.ambiguousReqNos.join('、')}），关联只会挂到其中一行——多来源导入请先全局重排编号`, 'error');
  }
  if (p.orphanRequirements?.length) {
    aiImportStore.log(`预演提醒：本次要新建的 ${p.orphanRequirements.length} 条需求没有任何计划/待办引用（${p.orphanRequirements.slice(0, 12).map((x) => x.reqNo).join('、')}${p.orphanRequirements.length > 12 ? ' 等' : ''}）`, 'info');
  }
}

/** 导入结果明细播报（自 doImport 逐字搬出，判定顺序与日志级别不变） */
function logImportResult(r: ImportPrdResult): void {
  const taskPart = r.tasks ? `、待办任务 ${r.tasks} 条` : '';
  const prdPart = r.prdId ? '；源 PRD 已录入「PRD 管理」并关联本次需求矩阵记录' : '';
  const reusedPart = r.reusedPlans ? `（另复用同名计划 ${r.reusedPlans} 条）` : '';
  aiImportStore.log(`导入完成：需求 ${r.requirements} 条（已入需求跟踪矩阵）、新建计划 ${r.plans} 条${reusedPart}${taskPart}${prdPart}`, 'ok');
  // T02303 甲（文案随 T02300 同步）：reuse 口径下需求侧不再「整批新建」——同标题同内容的存量行会被复用，
  // 旧说法「需求行全部按新号新建」已不成立，按实回传的两条计数说清，否则用户看不出补写到底幂等了没有
  if (r.reusedRequirements) {
    aiImportStore.log(`需求侧复用：${r.reusedRequirements} 条命中存量「同标题且同内容」的需求行，已复用原行未新建（本次真新建 ${r.requirementsCreated ?? r.requirements - r.reusedRequirements} 条，原行状态/编号一字未动）`, 'info');
  }
  // T01867：与项目已有编号撞号的需求由服务端按最大编号顺延，明细必须可见——
  // 用户手里拿的是 PRD 原编号，静默改号会让后续按编号核对全部对不上
  if (r.reqNoMap?.length) {
    const reqNoPairs = r.reqNoMap.map((x) => `${x.from}→${x.to}`).join('、');
    aiImportStore.log(`编号顺延：${r.reqNoMap.length} 条需求与矩阵已有编号重复，已改为项目内顺延号（${reqNoPairs}），计划/待办关联按顺延后的编号建立`, 'error');
  }
  // T01869→T01875：撞名计划的新行落库时已带「（N）」区分后缀，不再是与原行无法分辨的同名行；
  // 明细点名哪个原号让成了哪个新标题，消除「原有任务被重置」的误读面
  if (r.dupPlanTitles?.length) {
    const renamed = r.dupPlanTitles.filter((x) => x.renamedTo);
    if (renamed.length) {
      const renamedDetail = renamed.map((x) => `${x.title} → 新行「${x.renamedTo}」，原有 ${x.existing} 条`).join('、');
      aiImportStore.log(`同名让号：本次有 ${renamed.length} 个计划标题在项目内已存在（${renamedDetail}）——原条目状态与进度一字未动，新增那条用后缀区分，不会与原计划混淆`, 'info');
    }
    if (r.reusedPlans) {
      aiImportStore.log(`同名复用：${r.reusedPlans} 条计划命中项目内已有同名行（未新建），仅补齐空描述/空复杂度与需求关联（只增不减），其状态与进度保持不变`, 'info');
    }
  }
  // T00712（D-5）：无效需求编号不再静默丢弃——服务端返回 unlinkedReqNos 时在控制台给出可感知告警
  if (r.unlinkedReqNos?.length) {
    aiImportStore.log(`告警：${r.unlinkedReqNos.length} 个需求编号未命中本次导入的需求（${r.unlinkedReqNos.join('、')}），其计划/待办关联已被忽略，请核对编号或先补导对应需求`, 'error');
  }
  // T01995：跨来源编号歧义——同一旧编号被本次导入的两行争用（多份 PRD 各自从 REQ-001 起号且调用方未重编号）。
  // 关联口径沿用既有「后登记者胜出」，所以先出现那份来源的行会整批零关联——必须当场点名，不能静默放过
  if (r.ambiguousReqNos?.length) {
    aiImportStore.log(`编号歧义：${r.ambiguousReqNos.length} 个需求编号在本次导入的多个来源中重复出现（${r.ambiguousReqNos.join('、')}），这些编号的计划/待办只挂到了其中一行（按最后出现的来源建立），先出现那份来源的行会整批零关联——多来源导入请确认各文件的需求编号已全局重排为连续号（REQ-001…）后再导入`, 'error');
  }
  // T01995：本次新建却零关联的需求行——错挂类缺陷的可见性补丁（编号存在性校验对此完全无感）。
  // 与解析阶段的「反向覆盖告警」同源，故用 info 级：需求本就无对应计划是合法场景，不能变成狼来了
  if (r.orphanRequirements?.length) {
    aiImportStore.log(`零关联提醒：本次新建的 ${r.orphanRequirements.length} 条需求没有任何计划/待办关联（${r.orphanRequirements.slice(0, 12).map((x) => x.reqNo).join('、')}${r.orphanRequirements.length > 12 ? ' 等' : ''}）——若为多来源合并导入，请核对是否把关联挂到了别的来源的行上`, 'info');
  }
}

/** T00982：解析结果落盘键（与 useSessionState 同键）——切页恢复靠它们，改键名需同步改面板的读取键 */
const PERSIST_KEYS = {
  reqs: 'prd-import.reqs',
  plans: 'prd-import.plans',
  sources: 'prd-import.sources',
} as const;

/**
 * T00982：解析结果同步落盘。
 * 解析期间切页会让本面板卸载：React 会丢弃卸载后的 setState，而 useSessionState 的持久化写在
 * useEffect 里（卸载后不再执行）→ 解析出的需求/计划整批丢失，控制台却仍显示「解析完成」
 * （store 是模块级的，日志不受影响）。这里在解析完成时同步写一次会话存储，切回即可恢复。
 */
function persistParseResult(
  reqs: PrdReq[],
  plans: PrdPlan[],
  sources: { readonly name: string; readonly text: string }[],
): void {
  try {
    sessionStorage.setItem(PERSIST_KEYS.reqs, JSON.stringify(reqs));
    sessionStorage.setItem(PERSIST_KEYS.plans, JSON.stringify(plans));
    sessionStorage.setItem(PERSIST_KEYS.sources, JSON.stringify(sources));
  } catch {
    /* 配额不足等写入失败静默忽略，不阻塞解析流程 */
  }
}

/**
 * T01995：PrdParseResult 与多文件合并逻辑挪到 prdMerge.ts（无依赖纯函数，脚本可逐字断言同一份实现）。
 * 缺陷本身在旧版 mergePrdResults：old→new 重编号表跨文件共用一张，后份文档的 REQ-001 覆盖前份的同名旧号，
 * 前份的 WBS 草稿因此整体偏移到后份的需求行上（实测 mtask四期 一次导 2 份 PRD，前 20 行零关联）。
 */
import { mergePrdResults, type PrdParseResult } from './prdMerge';

/**
 * 从 PRD 导入项目计划面板（T00662）：上传 PRD → AI 拆 WBS + 逐条提取需求 →
 * 预览确认（需求清单 + 计划草稿，可编辑/勾选）→ 导入（需求进矩阵、计划进甘特、可选同步待办）。
 * 与「AI 项目计划导入」共用控制台日志通道（tab 标题随导入类型切换）。
 */
export function PrdImportPanel({ toolId, onClose, onSaved }: {
  readonly toolId: string;
  readonly onClose?: () => void;
  readonly onSaved?: (n: { requirements: number; plans: number; tasks: number }) => void;
}) {
  const snap = useSyncExternalStore(aiImportStore.subscribe, aiImportStore.getSnapshot);
  // T02201：项目列表走统一容错层（加载中/失败可见 + 重试，失败不写缓存）
  const projectList = useProjectList();
  const { projects } = projectList;
  const [projectId, setProjectId] = useSessionState<string>('prd-import.project', '');
  const [createTasks, setCreateTasks] = useSessionState<boolean>('prd-import.createTasks', true);
  // T02076：同名计划处置开关——缺省新建让号，显式选 'reuse' 走幂等补写（不改原行 status/progress）
  const [onDuplicatePlan, setOnDuplicatePlan] = useSessionState<'rename' | 'reuse'>('prd-import.onDuplicatePlan', 'rename');
  const [reqs, setReqs] = useSessionState<PrdReq[]>('prd-import.reqs', []);
  const [plans, setPlans] = useSessionState<PrdPlan[]>('prd-import.plans', []);
  // T00841：待解析的已选 PRD 文件——选择仅追加到列表，用户点「确认」才触发 parseAll；确认前可增删
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  /** T03185（UX-07②）：解析进度（已完成文件数/总数）——只在面板内显示"跑到第几个文件"，取消入口据此可见 */
  const [parseProgress, setParseProgress] = useState<{ done: number; total: number } | null>(null);

  // T00907：跳转自动带入标记——一次消费（读取即清），避免每次展开面板都重复触发
  const autoPullDone = useRef<boolean>(false);

  /** T00907：从 PRD 管理视图「从PRD导入项目计划」跳转而来时，自动读取所选 PRD 文档内容，
   *  构造为 File 填充「已选文件」确认栏（不自动触发 AI 解析，沿用 T00841「确认才解析」） */
  const autoPullDoc = useCallback(async (docId: string) => {
    try {
      const d = await api.get<{ filename: string; content_md: string }>(`/plans/prd-docs/${docId}`);
      const ext = (/\.([a-z0-9]+)$/i.exec(d.filename)?.[1] ?? 'md').toLowerCase();
      const file = new File([d.content_md], d.filename || `PRD-${docId}.md`,
        { type: ext === 'md' || ext === 'markdown' ? 'text/markdown' : 'text/plain' });
      setPickedFiles((prev) => (prev.some((f) => f.name === file.name) ? prev : [...prev, file]));
      aiImportStore.log(`已自动带入所选 PRD：${file.name}——确认内容后点「确认」开始解析导入`, 'ok');
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      aiImportStore.patch({ error: `自动带入所选 PRD 失败：${msg}` });
      aiImportStore.log(`自动带入所选 PRD 失败（已中止，可在面板内手动选择文件）：${msg}`, 'error');
    }
  }, []);

  // T00908：各源文件的 PRD 全文（解析时从 textMd 暂存）——确认导入时拼为 prdMd 落库 PRD 管理视图并关联需求矩阵
  // T00982：改会话级持久化——切页后回来仍要带着源文入库，否则会导入成"无 PRD 关联"的需求
  const [prdSources, setPrdSources] = useSessionState<{ name: string; text: string }[]>(PERSIST_KEYS.sources, []);

  // S2004：行字段更新回调下沉为组件级函数，避免 JSX 深层嵌套箭头
  const patchReq = (i: number, patch: Partial<PrdReq>) => setReqs((p) => p.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  // T01001 二轮：任何行变更（工期/勾选/类型）后都重算里程碑工期，保证"里程碑 = 其下明细之和"
  const patchPlan = (i: number, patch: Partial<PrdPlan>) =>
    setPlans((prev) => recalcMilestoneDurations(prev.map((x, j) => (j === i ? { ...x, ...patch } : x))));
  // S2004：已选文件删除回调同样下沉，避免 JSX 内 setPickedFiles 回调嵌套过深
  const removePickedFile = (idx: number) => setPickedFiles((prev) => prev.filter((_, j) => j !== idx));
  const { busy, fileName, error } = snap;

  useEffect(() => {
    aiImportStore.patch({ kind: 'prd' });
    // T00907：消费「从 PRD 管理视图」跳转自动带入的文档标记（一次性，读取即清不重复触发）
    const docId = sessionStorage.getItem('prd-import.docId');
    if (docId && !autoPullDone.current) {
      autoPullDone.current = true;
      sessionStorage.removeItem('prd-import.docId');
      void autoPullDoc(docId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // T00982：解析完成戳变化 → 重新从会话存储载入结果。
  // 覆盖两类切页时序：① 解析在卸载期间完成（切回来时挂载读取已在存储里）；
  // ② 已切回页面、解析随后完成（旧实例的 setState 被丢弃，靠本戳把结果拉回当前实例）。
  const parseStamp = snap.parseStamp ?? 0;
  useEffect(() => {
    if (!parseStamp) return;
    try {
      const r: unknown = JSON.parse(sessionStorage.getItem(PERSIST_KEYS.reqs) ?? '[]');
      const p: unknown = JSON.parse(sessionStorage.getItem(PERSIST_KEYS.plans) ?? '[]');
      const s: unknown = JSON.parse(sessionStorage.getItem(PERSIST_KEYS.sources) ?? '[]');
      if (Array.isArray(r) && r.length > 0) setReqs(r as PrdReq[]);
      if (Array.isArray(p) && p.length > 0) setPlans(p as PrdPlan[]);
      if (Array.isArray(s) && s.length > 0) setPrdSources(s as { name: string; text: string }[]);
    } catch {
      /* 脏数据忽略：保留界面现有内容 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parseStamp]);

  /** T00824：多文件批量解析——逐文件调用单文件接口（串行避免激增 AI 并发），
   *  单文件失败记录日志并跳过其余继续；合并后统一重编号，供下方交互表格编辑/勾选 */
  const parseAll = useCallback(async (files: File[]) => {
    if (!projectId) { aiImportStore.patch({ error: '请先选择目标项目' }); aiImportStore.log('缺少目标项目，已中止', 'error'); return; }
    if (!toolId) { aiImportStore.patch({ error: '请先在控制台选择 AI 模型（顶部模型下拉）' }); aiImportStore.log('缺少 AI 模型（控制台未选择），已中止', 'error'); return; }
    if (files.length === 0) return;
    aiImportStore.reset('prd');
    setPrdSources([]); // T00908：重新解析即作废上一批暂存的 PRD 全文
    const total = files.length;
    // T03185（UX-07②）：本轮解析的取消闸门。句柄登记在模块级 store，切页卸载后仍能中断；
    // 控制台「停止」与本面板「取消解析」共用这一句柄，保证中断的是真实请求而不是只清前端日志。
    const ctrl = new AbortController();
    const release = () => { aiImportStore.setAbort(null); setParseProgress(null); };
    aiImportStore.setAbort(() => ctrl.abort());
    aiImportStore.patch({ fileName: total > 1 ? `${total} 个文件` : files[0].name, busy: true });
    aiImportStore.log(`已选择 ${total} 个 PRD 文件：${files.map((f) => f.name).join('、')}`);
    setParseProgress({ done: 0, total });
    const results: PrdParseResult[] = [];
    const sources: { name: string; text: string }[] = [];
    let firstError = '';
    let stopName = '';
    for (let i = 0; i < total; i++) {
      if (ctrl.signal.aborted) break; // 取消后剩余文件不再发起，避免"已取消却还在跑"
      const file = files[i];
      aiImportStore.log(`提取并解析（${i + 1}/${total}）：${file.name}…`);
      try {
        const buf = await file.arrayBuffer();
        const r = await api.postBinary<{ ok: boolean } & PrdParseResult>(
          `/plans/ai-parse-prd?projectId=${projectId}&toolId=${toolId}&filename=${encodeURIComponent(file.name)}`,
          buf,
          { signal: ctrl.signal },
        );
        results.push({ requirements: r.requirements ?? [], drafts: r.drafts ?? [], coverageWarn: r.coverageWarn, truncatedNote: r.truncatedNote });
        // T00908：暂存每份文件的 PRD 全文（供确认导入时落库 PRD 管理视图）
        if (r.textMd) sources.push({ name: file.name, text: r.textMd });
        aiImportStore.log(`✓ ${file.name}：需求 ${r.requirements?.length ?? 0} 条、WBS ${r.drafts?.length ?? 0} 条`, 'ok');
        if (r.coverageWarn) aiImportStore.log(r.coverageWarn, 'error');
        // T01156：首轮输出被截断、走了精简重试——需求可能被静默压缩，必须提示用户核对数量
        if (r.truncatedNote) aiImportStore.log(`⚠ ${r.truncatedNote}`, 'error');
        // T02270 复议：分片完整跑完是**无损**结果，按普通信息展示——不能混进上面的 ⚠，
        // 否则用户看到分片提示会误判成「又被砍到 20 条」。
        if (r.parseNote) aiImportStore.log(r.parseNote);
      } catch (e) {
        if (ctrl.signal.aborted) {
          // 用户中断不是解析失败，不能记进 firstError 让末尾报「全部文件解析失败」
          stopName = file.name;
          break;
        }
        const msg = String((e as Error).message ?? e);
        firstError ||= msg;
        aiImportStore.log(`✗ ${file.name} 解析失败（已跳过，其余文件继续）：${msg}`, 'error');
      }
      setParseProgress({ done: i + 1, total });
    }
    if (ctrl.signal.aborted) {
      // T03185（UX-07②）：取消即整轮作废——已完成的分片结果只活在局部变量里，这里直接返回，
      // 不 setReqs/setPlans、不 persistParseResult、不递增 parseStamp，因此界面与会话存储都不留半成品，
      // 也不会生成"需求 ↔ 计划"的关联（关联只在确认导入时建立）。
      aiImportStore.log(`已取消解析${stopName ? `（停在 ${stopName}）` : ''}：本次共 0 条需求 / 0 条计划进入面板，未产生任何半成品关联`, 'error');
      aiImportStore.patch({ error: '解析已取消，未生成任何条目' });
      release();
      aiImportStore.patch({ busy: false });
      return;
    }
    if (results.length === 0) {
      aiImportStore.patch({ error: firstError || '全部文件解析失败' });
      aiImportStore.log(`解析失败：${firstError || '全部文件解析失败'}`, 'error');
      release();
      aiImportStore.patch({ busy: false });
      return;
    }
    if (sources.length > 0) setPrdSources(sources);
    const { requirements, drafts } = mergePrdResults(results);
    const stamp = Date.now();
    const reqRows = requirements.map((x, i) => ({ ...x, include: true, key: `pr-${stamp}-${i}` }));
    // T01001 二轮：解析出来就先汇总一次里程碑工期（AI 给的里程碑工期与其明细合计常不相等）
    const planRows = recalcMilestoneDurations(drafts.map((x, i) => ({ ...x, include: true, key: `pp-${stamp}-${i}` })));
    setReqs(reqRows);
    setPlans(planRows);
    // T00982：同步落盘 + 递增完成戳（解析期间切页导致组件卸载时，这两处是结果不丢的关键）
    persistParseResult(reqRows, planRows, sources);
    aiImportStore.log(`解析完成（${results.length}/${total} 个文件）：合并需求 ${requirements.length} 条、WBS 计划 ${drafts.length} 条，编号已全局重排（REQ-001…），可编辑后导入`, 'ok');
    release();
    aiImportStore.patch({ busy: false, parseStamp: stamp });
  }, [projectId, toolId, setReqs, setPlans, setPrdSources]);

  /**
   * T02300：勾选过滤 + PRD 全文拼接 + 处置口径收成**同一个** payload 构造函数。
   * 预演与导入必须投同一份 payload——各拼一份的话预演计数与实落库必然分叉，本单红线。
   * 返回 null = 一条都没勾选（调用方各自给提示）。
   * 顺带把「被勾选过滤丢弃的 reqNos」原样交出（不改 payload，只供播报）：面板既有口径一直是静默丢弃，
   * 实测预演时暴露出「编号打错/漏勾」在界面里连一行提示都没有——预演的立项理由就是让连带影响可见，
   * 这条丢弃属于同一类影响，故在此点名；服务端 `unlinkedReqNos` 告警仍照常工作（它看到的是丢弃后的 payload）。
   */
  function composeImportPayload(): { payload: Record<string, unknown>; droppedReqNos: string[] } | null {
    const rq = reqs.filter((x) => x.include && x.title.trim());
    const pl = plans.filter((x) => x.include && x.title.trim());
    // T03185（UX-07③）：提交门槛由「需求或计划任一非空」收紧为「至少一条需求」——
    // 计划的需求关联以矩阵里的需求行为锚点，只勾计划会让关联悬空（事后无从回溯来源），故不放行。
    if (rq.length === 0) return null;
    // 勾选过滤：仅提交勾选项；reqNos 需与提交的需求编号保持一致（未勾选需求的引用自动丢弃）
    const keptNos = new Set(rq.map((x) => x.reqNo));
    const droppedReqNos = [...new Set(pl.flatMap((p) => p.reqNos.filter((n) => !keptNos.has(n))))];
    // T00908：把暂存的源文件 PRD 全文拼为 prdMd 一并入库——后端落库 prd_docs（PRD 管理视图）并为需求行回填 prd_id 建立关联
    const prdMd = prdSources.map((s) => `# 来源：${s.name}\n\n${s.text}`).join('\n\n---\n\n');
    const prdFilename = prdSources.length > 1 ? `${prdSources.length} 个来源文件` : prdSources[0]?.name;
    return {
      payload: {
        projectId,
        createTasks,
        requirements: rq.map(({ include: _inc, key: _key, ...rest }) => rest),
        plans: pl.map(({ include: _inc, key: _key, ...rest }) => ({ ...rest, reqNos: rest.reqNos.filter((n) => keptNos.has(n)) })),
        prdMd: prdMd || undefined,
        prdFilename: prdFilename || undefined,
        // T02076：同名计划处置——'reuse' 走幂等补写，缺省新建让号
        onDuplicatePlan: onDuplicatePlan === 'reuse' ? 'reuse' : undefined,
      },
      droppedReqNos,
    };
  }

  /** 勾选过滤丢弃的编号必须可见（实测：面板此前静默丢弃，导入后关联凭空少一条且无从追溯） */
  function logDroppedReqNos(dropped: string[], when: string): void {
    if (dropped.length === 0) return;
    aiImportStore.log(
      `${when}提示：${dropped.length} 个需求编号被已勾选的计划引用，但不在本次勾选的需求行里（${dropped.join('、')}）——`
      + '按既有口径这些引用会被丢弃，导入后对应关联不会建立；请核对是否漏勾了需求行或编号写错',
      'error',
    );
  }

  /** T02300：导入前预演——打只读端点 `/plans/import-prd/preview`，同一份 payload 先问清「这次会动什么」 */
  async function doPreview() {
    const composed = composeImportPayload();
    if (!composed) { aiImportStore.log('未勾选任何需求，无法预演（计划的需求关联需要需求行作锚点）', 'error'); return; }
    const { payload } = composed;
    aiImportStore.patch({ busy: true, error: '' });
    aiImportStore.log('预演中：只读统计本次导入的连带影响，不改动任何数据…');
    logDroppedReqNos(composed.droppedReqNos, '预演');
    try {
      const p = await api.post<PrdPreviewResult>('/plans/import-prd/preview', payload);
      logPreviewResult(p);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      aiImportStore.patch({ error: msg });
      aiImportStore.log(`预演失败：${msg}`, 'error');
    } finally {
      aiImportStore.patch({ busy: false });
    }
  }

  /** 确认导入：事务创建需求项（矩阵）+ 计划（关联需求）+ 可选待办任务 */
  async function doImport() {
    const composed = composeImportPayload();
    if (!composed) { aiImportStore.patch({ error: '请至少勾选一条需求（计划的需求关联需要需求行作锚点）' }); aiImportStore.log('未勾选任何需求，已中止导入', 'error'); return; }
    const payload = composed.payload;
    const rqCount = ((payload.requirements as unknown[]) ?? []).length;
    const plCount = ((payload.plans as unknown[]) ?? []).length;
    aiImportStore.patch({ busy: true, error: '' });
    aiImportStore.log(`导入中：需求 ${rqCount} 条、计划 ${plCount} 条${createTasks ? '，并同步生成待办任务' : ''}…`);
    logDroppedReqNos(composed.droppedReqNos, '导入');
    try {
      const r = await api.post<ImportPrdResult>('/plans/import-prd', payload);
      logImportResult(r);
      // T00982：导入成功即清空完成戳，避免后续再按旧戳把已导入的结果拉回界面
      aiImportStore.patch({ lastSaved: r.plans, parseStamp: 0 });
      setReqs([]); setPlans([]); setPrdSources([]);
      onSaved?.(r);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      aiImportStore.patch({ error: msg });
      aiImportStore.log(`导入失败：${msg}`, 'error');
    } finally {
      aiImportStore.patch({ busy: false });
    }
  }

  const includedPlans = useMemo(() => plans.filter((x) => x.include).length, [plans]);
  const includedReqs = useMemo(() => reqs.filter((x) => x.include).length, [reqs]);
  // T03185（UX-07③）：与 composeImportPayload 同口径的可提交需求数（勾选且标题非空）——
  // 按钮门槛若只看 include，会把「勾了但标题为空」的行算成可提交，点了仍被拦，等于禁用项不给真原因。
  const submittableReqs = useMemo(() => reqs.filter((x) => x.include && x.title.trim()).length, [reqs]);

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <FileUp size={15} style={{ color: 'var(--accent)' }} />
        <strong style={{ fontSize: 'var(--fs-l)' }}>从 PRD 导入项目计划</strong>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          上传 PRD（Word/Excel/Markdown/文本/PDF）→ AI 拆分 WBS 并逐条提取需求 → 预览确认 → 导入（需求进矩阵、计划进甘特，可同步生成待办）；执行输出见右侧控制台
        </span>
        <span style={{ flex: 1 }} />
        {onClose && (
          <button onClick={onClose} className="tbtn-anim" title="收起面板" aria-label="收起 PRD 导入面板"
            style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: '3px 6px' }}>
            <X size={13} />
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={busy || projectList.unusable}
          aria-label="目标项目" title="PRD 将导入到该项目（计划 + 需求矩阵 + 可选待办）"
          style={{ padding: 4, fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
          <option value="">{projectListPlaceholder(projectList, '选择目标项目…')}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <ProjectListHint view={projectList} />
        <label className="tbtn-anim" title="选择 PRD 文件（可多选 .docx/.md/.markdown/.txt/.xlsx/.csv/.pdf，将合并分析为单一需求矩阵与项目计划）"
          style={{ cursor: busy ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--accent)', color: 'var(--accent)', fontSize: 'var(--fs-s)' }}>
          <Upload size={13} /> 选择 PRD 文件{pickedFiles.length > 0 ? `（已选 ${pickedFiles.length}）` : ''}
          <input type="file" multiple accept=".docx,.md,.markdown,.txt,.xlsx,.csv,.pdf" style={FILE_INPUT_SR_ONLY}
            onChange={(e) => {
              const fs = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = '';
              if (fs.length === 0) return;
              // 选择仅追加到待解析列表、不立即解析；确认后统一走 parseAll（T00841）
              setPickedFiles((prev) => [...prev, ...fs]);
            }} />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', cursor: 'pointer' }}
          title="勾选后：WBS 节点同时生成待办任务（携带需求关联），便于 AI 推进执行">
          <input type="checkbox" checked={createTasks} onChange={(e) => setCreateTasks(e.target.checked)} style={{ cursor: 'pointer' }} />
          {' '}
          同步生成待办任务
        </label>
        {fileName && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{fileName}</span>}
        {busy && <span className="ai-shimmer" style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, ['--ai-shimmer-color' as never]: 'var(--accent)' }}>处理中…</span>}
        {/* T03185（UX-07②）：解析进度就地可见——此前只有一行「处理中…」，多文件时看不出跑到第几个、还要等多久 */}
        {parseProgress && (
          <span role="status" data-t03185="parse-progress" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)' }}>
            解析进度 {parseProgress.done}/{parseProgress.total}
          </span>
        )}
        {busy && snap.canCancel && (
          <button onClick={() => { if (aiImportStore.cancelByUser()) aiImportStore.log('已请求取消解析：正在中断当前 AI 请求，剩余文件不再发起…'); }}
            className="tbtn-anim" data-t03185="cancel-parse"
            title="取消解析 — 中断本轮 AI 解析请求；本轮结果整轮作废，不会留下半成的需求/计划行"
            aria-label="取消本轮 PRD 解析"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--fs-xs)', border: '1px solid var(--danger)', borderRadius: 6, background: 'transparent', color: 'var(--danger)', cursor: 'pointer', padding: '3px 8px' }}>
            <X size={12} /> 取消解析
          </button>
        )}
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          {snap.logs.length > 0 ? `控制台已输出 ${snap.logs.length} 条执行日志 →` : '执行过程将在右侧 AI 控制台逐行输出'}
        </span>
      </div>

      {error && <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-s)', marginBottom: 8 }}>{error}</div>}

      {/* T00841：已选文件列表——选择仅入列表不解析，用户点「确认」才触发 parseAll；确认前可增删 */}
      {pickedFiles.length > 0 && (
        <div style={{ marginBottom: 10, border: '1px solid var(--border-strong)', borderRadius: 8, padding: '8px 10px', background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <strong style={{ fontSize: 'var(--fs-s)' }}>已选文件（{pickedFiles.length}）</strong>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>确认后合并解析，可同步生成待办</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => { const fs = pickedFiles; setPickedFiles([]); void parseAll(fs); }} disabled={busy} className="tbtn-anim"
              title="确认 — 用已选文件开始解析并导入项目计划" aria-label="确认：开始解析并导入"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--fs-xs)', border: 'none', borderRadius: 6, background: 'var(--accent)', color: 'var(--accent-text)', cursor: busy ? 'default' : 'pointer', padding: '4px 10px' }}>
              <Sparkles size={12} /> 确认
            </button>
          </div>
          {pickedFiles.map((f, i) => (
            <div key={`${f.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
              <FileUp size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ fontSize: 'var(--fs-s)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={f.name}>{f.name}</span>
              <button onClick={() => removePickedFile(i)} className="tbtn-anim"
                title="删除 — 从已选列表中移除该文件，不再参与解析" aria-label="删除：移除已选文件"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px' }}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {(reqs.length > 0 || plans.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
          {/* 需求清单（矩阵行） */}
          <div>
            <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Sparkles size={12} style={{ color: 'var(--accent)' }} />
              需求清单 {reqs.length} 条（勾选 {includedReqs}）
              <button onClick={() => setReqs((p) => p.map((x) => ({ ...x, include: true })))} disabled={busy} title="全选需求" aria-label="全选需求"
                style={{ border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-xs)', padding: '1px 6px', cursor: 'pointer' }}>全选</button>
              <button onClick={() => setReqs((p) => p.map((x) => ({ ...x, include: false })))} disabled={busy} title="全不选需求" aria-label="全不选需求"
                style={{ border: '1px solid var(--border-strong)', borderRadius: 4, background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-xs)', padding: '1px 6px', cursor: 'pointer' }}>全不选</button>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-s)' }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: 4 }}>选</th>
                    <th style={{ padding: 4 }}>编号</th>
                    <th style={{ padding: 4 }}>需求标题</th>
                    <th style={{ padding: 4 }}>原文定位</th>
                  </tr>
                </thead>
                <tbody>
                  {reqs.map((r, i) => (
                    <tr key={r.key} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: 4 }}>
                        <input type="checkbox" checked={r.include} aria-label={`选中需求 ${r.title}`}
                          onChange={(e) => patchReq(i, { include: e.target.checked })} />
                      </td>
                      <td style={{ padding: 4, width: 88 }}>
                        <input value={r.reqNo} aria-label="需求编号" title={r.content || '（无详细描述）'}
                          onChange={(e) => patchReq(i, { reqNo: e.target.value })}
                          style={{ width: 80, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-xs)', padding: '1px 4px' }} />
                      </td>
                      <td style={{ padding: 4 }}>
                        <input value={r.title} aria-label="需求标题" title={r.content}
                          onChange={(e) => patchReq(i, { title: e.target.value })}
                          style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)' }} />
                      </td>
                      <td style={{ padding: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.sourceRef}>{r.sourceRef || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* WBS 计划草稿（含需求关联） */}
          <div>
            <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-secondary)', marginBottom: 6 }}>
              WBS 计划 {plans.length} 条（勾选 {includedPlans}，其中里程碑 {plans.filter((x) => isMilestoneRow(x)).length} 条）——
              关联需求编号显示在标题后；里程碑工期为其下任务工期汇总，改任务即联动，不可手工调整
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-s)' }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: 4 }}>选</th>
                    <th style={{ padding: 4 }}>WBS 任务</th>
                    <th style={{ padding: 4 }}>类型</th>
                    <th style={{ padding: 4 }}>工期</th>
                    <th style={{ padding: 4 }}>关联需求</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p, i) => {
                    const ms = isMilestoneRow(p);
                    return (
                    <tr key={p.key} style={{ borderTop: '1px solid var(--border)', background: ms ? 'var(--border-weak, rgba(0,0,0,.03))' : undefined }}>
                      <td style={{ padding: 4 }}>
                        <input type="checkbox" checked={p.include} aria-label={`选中计划 ${p.title}`}
                          onChange={(e) => patchPlan(i, { include: e.target.checked })} />
                      </td>
                      <td style={{ padding: 4 }}>
                        <input value={p.title} aria-label="WBS 标题" title={p.description}
                          onChange={(e) => patchPlan(i, { title: e.target.value })}
                          style={{ width: '100%', border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)', fontWeight: ms ? 700 : undefined }} />
                      </td>
                      {/* T01001 二轮：草稿表单标注任务类型（里程碑/任务），可手动纠正 AI 判定 */}
                      <td style={{ padding: 4, width: 78 }}>
                        <select value={p.kind ?? 'normal'} aria-label={`计划类型 ${p.title}`}
                          title={ms ? '里程碑 — 工期由其下任务汇总，不可手工调整' : '普通任务 — 工期可手工调整'}
                          onChange={(e) => patchPlan(i, { kind: e.target.value as PrdPlan['kind'] })}
                          style={{ width: 72, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card-bg)', color: ms ? 'var(--accent)' : 'var(--text)', fontSize: 'var(--fs-xs)', padding: '1px 2px' }}>
                          <option value="normal">任务</option>
                          <option value="milestone">里程碑</option>
                        </select>
                      </td>
                      <td style={{ padding: 4, width: 70 }}>
                        <input type="number" min={1} value={p.durationDays} aria-label="工期" readOnly={ms}
                          title={ms ? '里程碑工期 = 其下任务工期汇总（不可手工调整，改子任务即联动）' : '工期（天）'}
                          onChange={(e) => patchPlan(i, { durationDays: Number(e.target.value) || 1 })}
                          style={{ width: 50, border: '1px solid var(--border)', borderRadius: 4, background: ms ? 'transparent' : 'var(--card-bg)', color: ms ? 'var(--text-muted)' : 'var(--text)', fontSize: 'var(--fs-s)', padding: '1px 4px', fontWeight: ms ? 700 : undefined }} />
                      </td>
                      <td style={{ padding: 4, fontSize: 'var(--fs-xs)', color: 'var(--accent)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.reqNos.join('、')}>
                        {p.reqNos.length > 0 ? p.reqNos.join('、') : '—'}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {(reqs.length > 0 || plans.length > 0) && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* T02076：同名计划处置开关——缺省新建让号，显式选 reuse 走幂等补写 */}
          <label style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span>同名计划处置：</span>
            <select value={onDuplicatePlan} onChange={(e) => setOnDuplicatePlan(e.target.value as 'rename' | 'reuse')} disabled={busy}
              title="新建让号 = 撞名时加「（N）」后缀并建为新行；幂等复用 = 撞名时补写到原计划行（不改 status/progress），并连带复用「同标题+同内容」的存量需求行（T02303 甲）"
              style={{ padding: '2px 4px', fontSize: 'var(--fs-xs)', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--card-bg)', color: 'var(--text)' }}>
              <option value="rename">新建让号（默认）</option>
              <option value="reuse">幂等复用原行</option>
            </select>
          </label>
          {/* T02300：导入前预演（只读端点）——把「这次会新建/复用/让号多少行」摊在点导入之前，
              T01869 那类「重导后两行同名被读成回档」的误判就没了生长空间 */}
          <button onClick={() => void doPreview()} disabled={busy || submittableReqs === 0}
            title={submittableReqs === 0 ? '需先勾选至少一条需求 — 计划的需求关联以需求行为锚点，未勾选需求时预演/导入都不放行' : '只读预演：按当前勾选项与处置口径，算出本次导入将新建/复用/让号多少行，零写库（不改任何数据）'}
            aria-label="预演本次 PRD 导入的连带影响"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 'var(--fs-s)', cursor: (busy || submittableReqs === 0) ? 'default' : 'pointer' }}>
            <Eye size={13} /> 预演（只读）
          </button>
          <button onClick={() => void doImport()} disabled={busy || submittableReqs === 0} className="tbtn-anim"
            title={submittableReqs === 0 ? '需先勾选至少一条需求 — 计划的需求关联以需求行为锚点，只勾计划会留下悬空关联' : '导入勾选的条目——需求进矩阵、计划进甘特（含需求关联）、可选生成待办任务'}
            aria-label="导入 PRD 解析结果"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 'var(--fs-s)', cursor: (busy || submittableReqs === 0) ? 'default' : 'pointer' }}>
            <Save size={13} /> 导入（需求 {includedReqs} 条 / 计划 {includedPlans} 条{createTasks ? ' + 待办' : ''}）
          </button>
          {/* T03185（UX-07③）：门槛原因就地说明，不靠点击后弹提示（禁用项须说明原因） */}
          {submittableReqs === 0 && (
            <span role="alert" data-t03185="need-req" style={{ fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>
              至少勾选一条需求才能预演或导入：计划的需求关联需要需求行作锚点，只勾计划会产生悬空关联。
            </span>
          )}
        </div>
      )}
    </div>
  );
}
