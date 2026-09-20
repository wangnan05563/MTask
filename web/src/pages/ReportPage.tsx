import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { api, type Project, type AITool } from '../api/client';
import { streamEvents } from '../api/sse';
import { reportStream, useReportStream } from '../reportStream';
import { ReportConsole } from './ReportConsole';
import { AiPlanImportPanel } from './AiPlanImportPanel';
import { PrdImportPanel } from './PrdImportPanel'; // T00662：从 PRD 导入项目计划
import { useSessionState } from '../ui/session';
import { Download, Plus, Trash2, Upload, Sparkles, PanelLeftClose, PanelLeftOpen, FileSpreadsheet, FileUp } from 'lucide-react';

interface ReportTemplate {
  id: string;
  filename: string;
  format: string;
  size: number;
}

const PERIODS = [
  { key: 'day', label: '日报' },
  { key: 'week', label: '周报' },
  { key: 'month', label: '月报' },
] as const;

const FORMATS = [
  { key: 'xlsx', label: 'Excel (.xlsx)' },
  { key: 'docx', label: 'Word (.docx)' },
  { key: 'pdf', label: 'PDF (.pdf)' },
  { key: 'pptx', label: 'PPT (.pptx)' },
] as const;

type ReportFormat = 'xlsx' | 'docx' | 'pdf' | 'pptx';
/** 标准版式按输出格式对应的内置 skill 生成 */
const SKILL_BY_FORMAT: Record<ReportFormat, string> = { xlsx: 'xlsx-trae', docx: 'docx-trae', pdf: 'pdf-trae', pptx: 'pptx-trae' };

/** 内置技能：标准版式生成所依据的 office skill（已随应用内置） */
const BUILTIN_SKILLS = [
  { id: 'xlsx-trae', name: 'xlsx-trae', format: 'xlsx', desc: 'Excel 版式规范：浅表头填充、斑马纹、细浅边框、合计加粗强调' },
  { id: 'docx-trae', name: 'docx-trae', format: 'docx', desc: 'Word 文档规范：结构化标题、汇总表加粗表头' },
  { id: 'pdf-trae', name: 'pdf-trae', format: 'pdf', desc: 'PDF 处理技能（内置资源，供参考）' },
  { id: 'pptx-trae', name: 'pptx-trae', format: 'pptx', desc: '演示文稿技能（内置资源，供参考）' },
] as const;

/** Uint8Array 转 base64（分段避免栈溢出），供模板上传 JSON 承载 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCodePoint(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 };
const fieldStyle: CSSProperties = { padding: 6, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 13 };

/** 周报/报表页面：按周期与格式生成报表，支持模板导入与管理 */
export function ReportPage() {
  // 用户选项与已产生结果改为会话级持久化（useSessionState）：切换页面返回后仍保留选择与上次分析结果
  const [period, setPeriod] = useSessionState<'day' | 'week' | 'month'>('report.period', 'week');
  const [format, setFormat] = useSessionState<ReportFormat>('report.format', 'xlsx');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useSessionState('report.project', '');
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [templateId, setTemplateId] = useSessionState('report.template', '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // 文档区收起态：为让 AI 控制台全屏浏览，提供收起/展开动态按钮切换左侧文档区显隐
  const [splitCollapsed, setSplitCollapsed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // AI 周报：AI 工具选择会话级保留；生成运行态打入模块级 store（useReportStream），
  // 以便切页期间 SSE 照常写入、返回后立即恢复进度（见 reportStream.ts 设计说明）
  // T00769 二轮：工作面板展开态改为会话级持久化 —— 反馈「点击展开工作面板需要页面切换状态保持」，
  // 此前 useState 在切页卸载组件后丢失，切回即收起（生成/填写中途切页回到面板会看不到内容与进度）。
  // T00569 二轮：AI 项目计划导入面板展开态
  const [showAiImport, setShowAiImport] = useSessionState('report.showAiImport', false);
  // T00621：三卡片各自的工作面板展开态（互斥，保持左侧简洁）
  const [showOffline, setShowOffline] = useSessionState('report.showOffline', false);
  const [showAiLive, setShowAiLive] = useSessionState('report.showAiLive', false);
  // T00662：从 PRD 导入面板展开态（与其余三卡互斥）
  const [showPrdImport, setShowPrdImport] = useSessionState('report.showPrdImport', false);
  const [aiTools, setAiTools] = useState<AITool[]>([]);
  const [aiToolId, setAiToolId] = useSessionState('report.aiTool', '');
  // T00558 / PRD AI-5：周报摘要写入收件箱开关（服务端 report.aiSummaryToInbox）——开关状态持久于服务端
  const [summaryToInbox, setSummaryToInbox] = useState(false);
  useEffect(() => {
    void api.get<{ enabled: boolean }>('/settings/ai-summary-inbox').then((r) => setSummaryToInbox(r.enabled)).catch(() => undefined);
  }, []);
  const { streaming: aiStreaming, logs: aiLogs, streamText: aiStreamText, result: aiResult } = useReportStream();

  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice(''), 3200);
  };

  const loadTemplates = useCallback(async () => {
    try {
      setTemplates(await api.get<ReportTemplate[]>('/report/templates'));
    } catch {
      setTemplates([]);
    }
  }, []);

  // 加载已配置模型的 AI 工具，默认选中第一个，供 AI 周报生成使用。
  // 提取为组件级函数：避免 then 回调内再嵌套 setState 回调导致函数嵌套过深
  const loadAiTools = useCallback(async () => {
    try {
      const list = await api.get<AITool[]>('/aitools');
      const valid = list.filter((t) => t.model);
      setAiTools(valid);
      // T00534：统一以模型菜单配置为准——固定默认整理工具，不再由本页选择
      if (valid.length) setAiToolId(valid[0].id);
    } catch { /* 工具列表加载失败静默：aiToolId 为空时由 UI 提示先配置模型 */ }
  }, [setAiToolId]);

  useEffect(() => {
    void api.get<Project[]>('/projects').then(setProjects).catch(() => {});
    void loadTemplates();
    void loadAiTools();
  }, [loadTemplates, loadAiTools]);

  /** 生成报表并下载（后端按周期聚合任务数据，xlsx/docx） */
  async function generate() {
    setBusy(true);
    try {
      const { blob, filename } = await api.download('/report/generate', {
        period,
        format,
        projectId: projectId || undefined,
        templateId: templateId || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      flash(`已生成 ${filename} 并开始下载`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** AI 周报生成（流式）：SSE 实时推送阶段日志与洞察正文到右侧控制台，完成后获得下载令牌。
   * 状态直接写入模块级 store，切换页面期间生成照常推进，返回后恢复进度。 */
  async function aiGenerate() {
    if (!aiToolId) {
      flash('请先在「模型管理」配置并选择 AI 工具');
      return;
    }
    reportStream.begin();
    let errMsg = '';
    try {
      await streamEvents(
        '/report/ai-generate-stream',
        { period, format, projectId: projectId || undefined, toolId: aiToolId },
        (name, payload) => {
          switch (name) {
            case 'stage':
              reportStream.pushLog((payload as { msg: string }).msg);
              break;
            case 'chunk':
              reportStream.appendText((payload as { text: string }).text);
              break;
            case 'done': {
              const { token, filename } = payload as { token: string; filename: string };
              reportStream.setResult({ token, filename });
              break;
            }
            case 'error':
              errMsg = (payload as { error: string }).error;
              break;
          }
        },
      );
      if (errMsg) throw new Error(errMsg);
      reportStream.finish();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      flash(msg);
      reportStream.finish(`生成失败：${msg}`);
    }
  }

  /** 下载 AI 生成的周报：经临时令牌从后台取回（下载即删） */
  async function aiDownload() {
    if (!aiResult) return;
    try {
      const { blob, filename } = await api.download('/report/ai-download', { token: aiResult.token, filename: aiResult.filename });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      reportStream.setResult(null);
      flash(`已下载 AI 周报 ${filename}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** 选择本地 .xlsx/.docx 模板，转 base64 上传 */
  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!/(\.xlsx|\.docx)$/i.test(f.name)) {
      flash('仅支持 .xlsx / .docx 模板文件');
      return;
    }
    const buf = await f.arrayBuffer();
    try {
      await api.post<{ ok: boolean }>('/report/templates', { filename: f.name, data: bytesToBase64(new Uint8Array(buf)) });
      await loadTemplates();
      flash(`已导入模板「${f.name}」`);
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    }
  }

  /** 删除已导入模板 */
  async function removeTemplate(id: string, name: string) {
    try {
      await api.del(`/report/templates/${encodeURIComponent(id)}`);
      if (templateId === id) setTemplateId('');
      await loadTemplates();
      flash(`已删除模板「${name}」`);
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    }
  }

  /** 覆盖全部项目或指定单项目 */
  const scoped = projectId ? ({ label: '当前项目', value: projects.find((p) => p.id === projectId)?.name ?? projectId }) : ({ label: '范围', value: '全部项目' });

  return (
    <section>
      {/* 左主区 + 右侧 AI 控制台：两栏布局，参考企业对比工具 AI 分析栏。
          收起文档区后左侧主区隐藏，控制台 flex 自动占满整行，实现全屏浏览 AI 洞察 */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, display: splitCollapsed ? 'none' : 'block' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>AI 工作台</h2>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>AI 能力入口与报表生成（按周期聚合任务数据生成 Excel / Word 报表）</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setSplitCollapsed(true)}
          title="收起文档区 — 全屏显示 AI 控制台"
          aria-label="收起文档区：全屏显示 AI 控制台"
          style={{ display: 'inline-flex', alignItems: 'center', padding: 4, borderRadius: 6, cursor: 'pointer', background: 'var(--card-bg)', color: 'var(--text)' }}
        >
          <PanelLeftClose size={14} />
        </button>
      </div>

      {/* T00621：AI 能力入口**三卡片同行**（统一风格：图标 + 标题 + 描述 + 底部展开提示） */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, margin: '14px 0 0' }}>
        {/* 卡片 1：AI 项目计划导入 */}
        <button
          onClick={() => { setShowAiImport((v) => !v); setShowOffline(false); setShowAiLive(false); }}
          className="tbtn-anim"
          title="AI 项目计划导入 — 上传 Excel/需求文档，AI 解析为计划草稿并批量入库（本页直接执行）"
          aria-label="AI 项目计划导入"
          style={{ textAlign: 'left', padding: 14, border: showAiImport ? '1px solid var(--accent)' : '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start' }}
        >
          <FileUp size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>AI 项目计划导入</span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              上传 Excel/需求文档，AI 解析为项目计划草稿（工期/依赖/负责人），确认后批量入库
            </span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--accent)', marginTop: 8 }}>{showAiImport ? '收起工作面板 ↑' : '点击展开工作面板 ↓'}</span>
          </span>
        </button>

        {/* 卡片 2：离线周报生成（点击展开工作面板：含模板管理） */}
        <button
          onClick={() => { setShowOffline((v) => !v); setShowAiImport(false); setShowAiLive(false); }}
          className="tbtn-anim"
          title="离线周报生成 — 本地聚合数据按模板合成报表（工作面板内含模板管理）"
          aria-label="离线周报生成"
          style={{ textAlign: 'left', padding: 14, border: showOffline ? '1px solid var(--accent)' : '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start' }}
        >
          <FileSpreadsheet size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>离线周报生成</span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              本地聚合本周期任务数据，按模板或标准版式直接合成文件（无需联网）；含模板管理与导入
            </span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--accent)', marginTop: 8 }}>{showOffline ? '收起工作面板 ↑' : '点击展开工作面板 ↓'}</span>
          </span>
        </button>

        {/* 卡片 3：AI 周报生成（点击展开工作面板：含内置技能说明） */}
        <button
          onClick={() => { setShowAiLive((v) => !v); setShowAiImport(false); setShowOffline(false); }}
          className="tbtn-anim"
          title="AI 周报生成 — 结合真实数据由 AI 撰写洞察并按内置 skill 版式合成"
          aria-label="AI 周报生成"
          style={{ textAlign: 'left', padding: 14, border: showAiLive ? '1px solid var(--accent)' : '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start' }}
        >
          <Sparkles size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>AI 周报生成</span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              结合真实任务数据调用 AI 生成洞察，按内置 skill「{SKILL_BY_FORMAT[format]}」版式智能合成
            </span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--accent)', marginTop: 8 }}>{showAiLive ? '收起工作面板 ↑' : '点击展开工作面板 ↓'}</span>
          </span>
        </button>

        {/* 卡片 4：从 PRD 导入项目计划（T00662）——AI 拆 WBS + 需求跟踪矩阵 */}
        <button
          onClick={() => { setShowPrdImport((v) => !v); setShowAiImport(false); setShowOffline(false); setShowAiLive(false); }}
          className="tbtn-anim"
          title="从 PRD 导入项目计划 — 上传 PRD（Word/Excel/Markdown/文本/PDF），AI 拆分 WBS 并逐条提取需求，确认后导入计划与需求跟踪矩阵"
          aria-label="从 PRD 导入项目计划"
          style={{ textAlign: 'left', padding: 14, border: showPrdImport ? '1px solid var(--accent)' : '1px solid var(--border)', borderRadius: 10, background: 'var(--card-bg)', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'flex-start' }}
        >
          <FileUp size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>从 PRD 导入项目计划</span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              AI 拆分 WBS + 逐条提取需求 → 生成计划与需求跟踪矩阵（可选同步待办任务）
            </span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--accent)', marginTop: 8 }}>{showPrdImport ? '收起工作面板 ↑' : '点击展开工作面板 ↓'}</span>
          </span>
        </button>
      </div>

      {/* T00662：从 PRD 导入面板——AI 拆 WBS + 需求跟踪矩阵（日志同走控制台） */}
      {showPrdImport && (
        <PrdImportPanel toolId={aiToolId} onClose={() => setShowPrdImport(false)}
          onSaved={(r) => flash(`PRD 导入完成：需求 ${r.requirements} 条、计划 ${r.plans} 条${r.tasks ? `、待办任务 ${r.tasks} 条` : ''}（矩阵见项目计划页「需求跟踪矩阵」）`)} />
      )}

      {/* T00569 二轮：AI 项目计划导入面板——功能完整迁移至本页内联执行（含控制台滚动输出） */}
      {showAiImport && (
        <AiPlanImportPanel toolId={aiToolId} onClose={() => setShowAiImport(false)} onSaved={(n) => flash(`AI 导入完成：已创建 ${n} 条计划（可在「项目计划」查看）`)} />
      )}

      {/* 公共配置：周期 / 格式 / 项目范围，离线与 AI 两条路径共用 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, margin: '14px 0 0', padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)' }}>
        <div>
          <div style={labelStyle}>报表周期</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {PERIODS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                title={`生成${p.label}`}
                style={{
                  padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                  background: period === p.key ? 'var(--accent)' : 'var(--card-bg)',
                  color: period === p.key ? 'var(--accent-text)' : 'var(--text)',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div style={labelStyle}>输出格式</div>
          <select value={format} onChange={(e) => setFormat(e.target.value as ReportFormat)} style={fieldStyle}>
            {FORMATS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
        <div>
          <div style={labelStyle}>项目范围</div>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={fieldStyle}>
            <option value="">全部项目</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      {/* T00621：工作面板区——由上方三卡片点击展开（互斥，默认收起保持页面简洁） */}
      <div style={{ display: 'flex', gap: 16, margin: '12px 0', flexWrap: 'wrap' }}>
        {/* 离线周报生成工作面板：本地聚合 + 模板管理（模板列表/导入整合于此） */}
        {showOffline && (
        <div style={{ flex: '1 1 320px', border: '1px solid var(--accent)', borderRadius: 10, padding: 14, background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            <FileSpreadsheet size={15} style={{ color: 'var(--accent)' }} /> 离线周报生成 · 工作面板
            <span style={{ flex: 1 }} />
            <button onClick={() => setShowOffline(false)} className="tbtn-anim" title="收起工作面板" aria-label="收起离线周报工作面板"
              style={{ border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 11, padding: '1px 6px' }}>收起 ↑</button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>本地聚合本周期任务数据，按模板或标准版式直接合成文件，无需联网。</div>
          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>模板</div>
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={{ ...fieldStyle, width: '100%' }}>
              <option value="">标准模板（内置 skill）</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.filename}</option>)}
            </select>
            {templateId === '' && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                使用内置 skill「{SKILL_BY_FORMAT[format]}」生成标准版式
              </div>
            )}
          </div>
          {/* T00621：模板管理整合到离线周报工作面板（导入 / 列表 / 删除） */}
          <div style={{ marginBottom: 12, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2, transparent)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>模板管理（{templates.length}）</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => fileRef.current?.click()} className="tbtn-anim"
                title="导入模板 — 选择 .xlsx / .docx 模板文件上传" aria-label="导入模板"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                <Upload size={11} /> 导入模板
              </button>
            </div>
            {templates.length === 0
              ? <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>暂无自定义模板，可导入 .xlsx/.docx 模板文件后在上方「模板」下拉中选择。</div>
              : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 120, overflowY: 'auto' }}>
                  {templates.map((t) => (
                    <li key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '2px 0', borderBottom: '1px solid var(--border)' }}>
                      <FileSpreadsheet size={11} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.filename}</span>
                      <button onClick={() => void removeTemplate(t.id, t.filename)} className="tbtn-anim"
                        title="删除该模板" aria-label={`删除模板 ${t.filename}`}
                        style={{ border: 'none', background: 'transparent', color: 'var(--danger)', cursor: 'pointer', display: 'inline-flex', padding: 0 }}>
                        <Trash2 size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </div>
          <button
            onClick={() => void generate()}
            disabled={busy}
            title="离线周报生成 — 本地聚合数据生成报表"
            aria-label="离线周报生成：本地聚合数据生成报表"
            style={{ padding: '6px 16px', background: 'var(--accent)', color: 'var(--accent-text)', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Download size={14} /> {busy ? '生成中…' : `离线生成${scoped.label} ${PERIODS.find((p) => p.key === period)?.label}（${scoped.value}）`}
          </button>
        </div>
        )}

        {/* AI 周报生成工作面板：AI 洞察 + 内置技能说明（技能依据整合于此） */}
        {showAiLive && (
        <div style={{ flex: '1 1 320px', border: '1px solid var(--accent)', borderRadius: 10, padding: 14, background: 'var(--card-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            <Sparkles size={15} style={{ color: 'var(--accent)' }} /> AI 周报生成 · 工作面板
            <span style={{ flex: 1 }} />
            <button onClick={() => setShowAiLive(false)} className="tbtn-anim" title="收起工作面板" aria-label="收起 AI 周报工作面板"
              style={{ border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 11, padding: '1px 6px' }}>收起 ↑</button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
            结合真实任务数据调用 AI 生成洞察，按内置 skill 版式智能合成；洞察生成过程在右侧 AI 控制台实时滚动展示。
          </div>
          {/* T00621：内置技能整合到 AI 周报工作面板 */}
          <div style={{ marginBottom: 12, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2, transparent)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>内置技能（标准版式依据）</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text)' }}>
              <Sparkles size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <code style={{ fontSize: 12, color: 'var(--accent)' }}>{SKILL_BY_FORMAT[format]}</code>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                — 当前报表格式 {format.toUpperCase()} 对应的内置版式技能；AI 生成时按该 skill 的标准结构组织内容
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              切换上方「报表格式」即自动匹配对应技能：xlsx-trae / docx-trae / pdf-trae / pptx-trae
            </div>
          </div>
          <div style={{ marginBottom: 12, fontSize: 11, color: 'var(--text-muted)' }}>
            AI 工具统一使用「模型菜单」的默认整理工具（无需在此重复选择）。
          </div>
          <button
            onClick={() => void aiGenerate()}
            disabled={aiStreaming}
            title="AI 周报生成 — 结合任务数据调用 AI 生成周报"
            aria-label="AI 周报生成：结合任务数据调用 AI 生成周报"
            style={{ padding: '6px 16px', background: 'var(--accent)', color: 'var(--accent-text)', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Sparkles size={14} /> {aiStreaming ? 'AI 生成中…' : 'AI 周报生成'}
          </button>
          {/* T00558 / PRD AI-5：生成后把 AI 洞察摘要写入收件箱任务 */}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}
            title="勾选后，AI 周报生成时会把洞察摘要写入「收件箱」项目的一条待办任务（便于后续跟进）">
            <input type="checkbox" checked={summaryToInbox} style={{ cursor: 'pointer' }}
              onChange={(e) => {
                const v = e.target.checked;
                setSummaryToInbox(v);
                void api.post('/settings/ai-summary-inbox', { enabled: v }).catch(() => setSummaryToInbox(!v));
              }} />
            生成后把摘要写入收件箱任务
          </label>
          {/* AI 洞察已移至右侧控制台流式展示，左侧仅在生成成功后保留下载入口 */}
          {aiResult && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--surface-2)', paddingTop: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                «{aiResult.filename}» 已生成，洞察过程见右侧控制台。
              </div>
              <button
                onClick={() => void aiDownload()}
                title="下载 AI 周报 — 经令牌从后台取回（下载即删）"
                aria-label="下载 AI 周报"
                style={{ padding: '6px 16px', background: 'var(--accent)', color: 'var(--accent-text)', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <Download size={14} /> 下载 AI 周报
              </button>
            </div>
          )}
        </div>
        )}
      </div>

      {notice && <span className="flash-toast" role="status">{notice}</span>}

      {/* T00621：原「内置技能」「模板管理」独立区块已整合进各自工作面板（AI 周报面板=内置技能；离线周报面板=模板管理），此处仅保留隐藏的上传入口与占位符说明 */}
      <input ref={fileRef} type="file" accept=".xlsx,.docx" style={{ display: 'none' }} onChange={(e) => void onUpload(e)} />

      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
        说明：报表按本周期内更新过的任务（未归档）聚合，包含各项目汇总与任务明细；选用 Word 模板时以 {`{period}`}、{`{periodLabel}`}、{`{startDate}`}、{`{endDate}`}、{`{projects}`}、{`{tasks}`} 占位符渲染。模板导入入口在「离线周报生成」工作面板内（仅支持 .xlsx / .docx，≤10MB）。
      </div>
        </div>
        <aside style={{ boxSizing: 'border-box', alignSelf: 'stretch', ...(splitCollapsed ? { width: '100%' } : { flex: '0 0 360px', maxWidth: '44vw' }) }}>
          {/* 收起态下提供恢复入口：在控制台上方显示「展开文档区」，避免收起后无路可回 */}
          {splitCollapsed && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 6 }}>
              <button
                onClick={() => setSplitCollapsed(false)}
                title="展开文档区 — 恢复展示周报 / 报表配置面板"
                aria-label="展开文档区：恢复展示周报/报表配置面板"
                style={{ display: 'inline-flex', alignItems: 'center', padding: 4, borderRadius: 6, cursor: 'pointer', background: 'var(--card-bg)', color: 'var(--text)' }}
              >
                <PanelLeftOpen size={14} />
              </button>
            </div>
          )}
          <ReportConsole tools={aiTools} toolId={aiToolId} onToolIdChange={setAiToolId} period={period} streaming={aiStreaming} logs={aiLogs} streamText={aiStreamText} />
        </aside>
      </div>
    </section>
  );
}