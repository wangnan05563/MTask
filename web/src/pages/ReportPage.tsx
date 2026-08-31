import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { api, type Project, type AITool } from '../api/client';
import { streamEvents } from '../api/sse';
import { reportStream, useReportStream } from '../reportStream';
import { ReportConsole } from './ReportConsole';
import { useSessionState } from '../ui/session';
import { Download, Plus, RefreshCw, Trash2, Upload, Sparkles } from 'lucide-react';

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
  const fileRef = useRef<HTMLInputElement>(null);

  // AI 周报：AI 工具选择会话级保留；生成运行态打入模块级 store（useReportStream），
  // 以便切页期间 SSE 照常写入、返回后立即恢复进度（见 reportStream.ts 设计说明）
  const [aiTools, setAiTools] = useState<AITool[]>([]);
  const [aiToolId, setAiToolId] = useSessionState('report.aiTool', '');
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
      if (valid.length) setAiToolId((cur) => (valid.some((t) => t.id === cur) ? cur : valid[0].id));
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
      {/* 左主区 + 右侧 AI 控制台：两栏布局，参考企业对比工具 AI 分析栏 */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>周报 / 报表</h2>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>按周期聚合任务数据生成 Excel / Word 报表</span>
      </div>

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

      {/* 离线 / AI 两个独立生成入口 */}
      <div style={{ display: 'flex', gap: 16, margin: '12px 0', flexWrap: 'wrap' }}>
        {/* 离线周报生成：保留原有离线逻辑，本地聚合并按模板/标准版式合成文件 */}
        <div style={{ flex: '1 1 300px', border: '1px solid var(--border)', borderRadius: 8, padding: 14, background: 'var(--card-bg)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>离线周报生成</div>
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

        {/* AI 周报生成：真实周期任务数据 + AI 洞察，按匹配的内置 skill 版式智能合成 */}
        <div style={{ flex: '1 1 300px', border: '1px solid var(--border)', borderRadius: 8, padding: 14, background: 'var(--card-bg)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>AI 周报生成</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
            结合真实任务数据调用 AI 生成洞察，按内置 skill「{SKILL_BY_FORMAT[format]}」版式智能合成。
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>AI 工具</div>
            <select value={aiToolId} onChange={(e) => setAiToolId(e.target.value)} style={{ ...fieldStyle, width: '100%' }}>
              {aiTools.length === 0 && <option value="">（未配置可用工具）</option>}
              {aiTools.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.type}）· {t.model}</option>)}
            </select>
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
      </div>

      {notice && <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--accent)' }}>{notice}</div>}

      {/* 内置技能：标准版式生成的依据 */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, background: 'var(--card-bg)', marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>内置技能</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {BUILTIN_SKILLS.map((s) => (
            <span key={s.id} title={s.desc} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontWeight: 600 }}>{s.name}</span>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>.{s.format}</span>
            </span>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
          标准模板按对应内置 skill 的版式规范生成（xlsx→xlsx-trae，docx→docx-trae）；pdf/pptx 技能作为内置资源随应用提供。
        </div>
      </div>

      {/* 模板管理 */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, background: 'var(--card-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>模板管理</span>
          <button onClick={() => fileRef.current?.click()} title="导入模板 — 上传 .xlsx / .docx 模板文件" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', padding: '4px 10px', borderRadius: 6, background: 'var(--card-bg)', border: '1px solid var(--border-strong)' }}>
            <Upload size={13} /> 导入模板
          </button>
          <button onClick={() => void loadTemplates()} title="刷新模板列表" aria-label="刷新模板列表" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', cursor: 'pointer', padding: '4px 8px', borderRadius: 6 }}>
            <RefreshCw size={13} />
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.docx" style={{ display: 'none' }} onChange={(e) => void onUpload(e)} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>仅支持 .xlsx / .docx（≤10MB）。Word 模板中可用 {'{period}'}、{'{tasks}'} 等占位符。</span>
        </div>
        {templates.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>暂无导入模板，系统将使用标准版式生成报表。</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {templates.map((t) => (
              <li key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--surface-2)' }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.filename}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{(t.size / 1024).toFixed(1)} KB</span>
                <button
                  onClick={() => { setTemplateId(t.id); }}
                  title="选用模板 — 生成时可参考该模板结构"
                  style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: templateId === t.id ? 'var(--accent)' : 'var(--text)' }}
                >
                  <Plus size={12} /> {templateId === t.id ? '已选用' : '选用'}
                </button>
                <button onClick={() => void removeTemplate(t.id, t.filename)} title="删除模板" aria-label="删除模板" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', cursor: 'pointer', color: 'var(--danger)' }}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
        说明：报表按本周期内更新过的任务（未归档）聚合，包含各项目汇总与任务明细；选用 Word 模板时以 {`{period}`}、{`{periodLabel}`}、{`{startDate}`}、{`{endDate}`}、{`{projects}`}、{`{tasks}`} 占位符渲染。
      </div>
        </div>
        <aside style={{ flex: '0 0 360px', maxWidth: '44vw', alignSelf: 'stretch' }}>
          <ReportConsole tools={aiTools} toolId={aiToolId} onToolIdChange={setAiToolId} period={period} streaming={aiStreaming} logs={aiLogs} streamText={aiStreamText} />
        </aside>
      </div>
    </section>
  );
}