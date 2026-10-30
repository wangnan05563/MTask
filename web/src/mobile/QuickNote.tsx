/**
 * 移动端核心：随手记（§3）。快速新建任务，路径 ≤3 步：点入口 → 输入标题 → 完成。
 * 录入方式：文本（主）/ 语音（Web Speech API，不支持则隐藏）/ 快捷模板（提示词预填）/ 图片贴图。
 * 提交复用 POST /api/tasks；离线时落本地草稿，联网后由 MobileShell 自动补提。
 */
import { Badge, EmptyState, pageStyle as page, headerStyle as header, wideHintStyle } from './ui';
import { FILE_INPUT_SR_ONLY } from '../ui/fileInput'; // T01674：file input 视觉隐藏但保留键盘焦点
import { useEffect, useRef, useState } from 'react';
import { api, type Task, type TaskCategory, type Prompt } from '../api/client';
import { ProjectListHint, getProjectListSnapshot, loadProjectList, projectListPlaceholder, useProjectList } from '../ui/projectList'; // T02212
import { addDraft, submitQuickNote } from './offline';
import { Mic, FileText, ImagePlus, Paperclip, Check, X, ChevronUp, ChevronDown, Clock } from 'lucide-react';
import { PRIORITY_COLOR, normalizePriority } from '../ui/priority'; // T03655：优先级色点的唯一色源（下拉框不再嵌 emoji）

// Web Speech API 最小类型（浏览器原生，TS 未内置）
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechCtor = new () => SpeechRecognitionLike;

const PRIORITIES = [
  { value: 'low', label: '低' },
  { value: 'normal', label: '中' },
  { value: 'high', label: '高' },
  { value: 'urgent', label: '紧急' },
];

interface Props {
  readonly onDone: (task: Task) => void;
  readonly onCancel: () => void;
  readonly notify: (msg: string, isErr?: boolean) => void;
}

const LAST_KEY = 'mtask.quicknote.last'; // T01426：上次选择的优先级/分类

/** T01431：随手记短语法解析。
 *  支持前缀标记与时间词：`!high/!紧急` 优先级、`#项目名` 项目、`@分类名` 分类、
 *  `今天/明天/后天/大后天/周X` 时间词（转为描述尾注，任务无独立截止字段不丢失信息）。
 *  返回清洗后的标题与解析结果（未命中字段为 undefined，不覆盖既有选择）。 */
export function parseQuickSyntax(raw: string, projects: { id: string; name: string }[], categories: { id: string; name: string }[]): {
  title: string; priority?: string; projectId?: string; categoryId?: string; dueNote?: string;
} {
  let text = raw;
  let priority: string | undefined;
  let projectId: string | undefined;
  let categoryId: string | undefined;
  let dueNote: string | undefined;

  const prioMap: Record<string, string> = { urgent: 'urgent', high: 'high', normal: 'normal', low: 'low', 紧急: 'urgent', 高: 'high', 普通: 'normal', 低: 'low' };
  text = text.replaceAll(/(^|\s)!([a-zA-Z一-龥]{2,6})(?=\s|$)/g, (m, pre, word) => {
    const key = word.toLowerCase();
    if (prioMap[key]) { priority = prioMap[key]; return pre; }
    return m;
  });
  text = text.replaceAll(/(^|\s)#([^\s#@!]+)(?=\s|$)/g, (m, pre, name) => {
    const p = projects.find((x) => x.name === name);
    if (p) { projectId = p.id; return pre; }
    return m;
  });
  text = text.replaceAll(/(^|\s)@([^\s#@!]+)(?=\s|$)/g, (m, pre, name) => {
    const c = categories.find((x) => x.name === name);
    if (c) { categoryId = c.id; return pre; }
    return m;
  });
  const dueMatch = /(^|\s)(今天|明天|后天|大后天|周[一二三四五六日天])(?=\s|$)/.exec(text);
  if (dueMatch) { dueNote = dueMatch[2]; text = text.replace(dueMatch[0], dueMatch[1]); }

  return { title: text.replaceAll(/\s{2,}/g, ' ').trim(), priority, projectId, categoryId, dueNote };
}

export function QuickNote({ onDone, onCancel, notify }: Props) {
  const [title, setTitle] = useState('');
  const [descOpen, setDescOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [categoryId, setCategoryId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [projectName, setProjectName] = useState('收件箱');
  const [images, setImages] = useState<string[]>([]);
  const projectList = useProjectList(); // T02212：项目列表由统一容错层供给（失败可见 + 重试，离线时仍给上次数据）
  const projects = projectList.projects;
  const [categories, setCategories] = useState<TaskCategory[]>([]);
  const [busy, setBusy] = useState(false);
  const [syntax, setSyntax] = useState<ReturnType<typeof parseQuickSyntax> | null>(null); // T01431：短语法解析预览

  // 语音录入
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  // 模板面板
  const [tplOpen, setTplOpen] = useState(false);
  const [templates, setTemplates] = useState<Prompt[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      await loadProjectList(); // T02212：项目取数交统一容错层（原 `catch { /* 忽略 */ }` 会让下拉静默空）
      try { setCategories(await api.get<TaskCategory[]>('/task-categories')); } catch { /* 忽略 */ }
      try {
        const np = await api.get<{ projectId: string }>('/settings/note-project');
        setProjectId(np.projectId);
        // 评审修复：用本次拉取的项目列表匹配（原闭包读 projects state，恒为 [] 永远回退收件箱）
        // T02212：同一份列表改由容错层快照给出（原来这里为取一个名字又发一次 /projects）
        setProjectName(getProjectListSnapshot().find((x) => x.id === np.projectId)?.name ?? '收件箱');
      } catch { /* 忽略，回退收件箱 */ }
      // T01426：记忆上次——优先级/分类默认带出上次选择（项目仍以「默认记事项目」设置优先）
      try {
        const last = JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}') as { priority?: string; categoryId?: string };
        if (last.priority) setPriority(last.priority);
        if (last.categoryId) setCategoryId(last.categoryId);
      } catch { /* 忽略 */ }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 初始化语音识别（不支持则隐藏入口）
  useEffect(() => {
    const Ctor = (globalThis as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor }).SpeechRecognition
      || (globalThis as unknown as { webkitSpeechRecognition?: SpeechCtor }).webkitSpeechRecognition;
    if (!Ctor) return;
    setSpeechSupported(true);
    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript ?? '';
      if (text) setTitle((prev) => (prev ? prev + text : text));
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recRef.current = rec;
  }, []);

  function toggleVoice() {
    const rec = recRef.current;
    if (!rec) return;
    if (listening) { rec.stop(); setListening(false); }
    else { setListening(true); rec.start(); }
  }

  function onPickImages(files: FileList | null) {
    if (!files) return;
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => { if (typeof reader.result === 'string') setImages((prev) => [...prev, reader.result as string]); };
      reader.readAsDataURL(f);
    }
  }

  async function openTemplates() {
    if (!tplOpen) {
      try { setTemplates(await api.get<Prompt[]>('/prompts?keyword=')); } catch { setTemplates([]); }
    }
    setTplOpen((o) => !o);
  }

  function applyTemplate(p: Prompt) {
    setTitle(p.title);
    setDescription(p.content);
    setDescOpen(true);
    setTplOpen(false);
  }

  // 移除图片：提出为具名函数，避免 JSX 内 map → onClick → setState → filter 多层嵌套回调
  function removeImageAt(i: number) {
    setImages((prev) => prev.filter((_, j) => j !== i));
  }

  async function submit() {
    if (!title.trim() || busy) return;
    setBusy(true);
    // T01431：提交前应用短语法清洗（标题剥离标记，时间词转描述尾注）
    const parsed = parseQuickSyntax(title, projects, categories);
    const payload = {
      title: parsed.title,
      description: [description.trim(), parsed.dueNote ? `⏰ ${parsed.dueNote}` : ''].filter(Boolean).join('\n') || undefined,
      priority,
      categoryId: categoryId || undefined,
      projectId: projectId || undefined,
      images,
    };
    try {
      const task = await submitQuickNote(payload);
      try { localStorage.setItem(LAST_KEY, JSON.stringify({ priority: payload.priority, categoryId: payload.categoryId })); } catch { /* 忽略 */ }
      notify('已记录');
      onDone(task);
    } catch {
      // 任何提交失败（离线 / 网络抖动 / 服务器暂不可达）均落本地草稿，联网后自动补提（§3.4），避免内容丢失
      // 异常对象本身无需使用，统一按「已存草稿」反馈，不区分失败原因
      const d = addDraft(payload);
      // 评审修复：配额溢出（如大图）不再静默丢内容
      notify(d.saved ? '提交失败，已存为草稿（联网后自动补提）' : '提交失败且本地空间不足——请移除截图后重试', !d.saved);
      onDone(null as unknown as Task);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = title.trim().length > 0 && !busy;

  return (
    <div style={page}>
      {/* 顶部栏：取消 / 标题 / 完成 */}
      <header style={header}>
        <button onClick={onCancel} title="取消 — 放弃本次记录" aria-label="取消" style={hdrBtn}>取消</button>
        <div style={{ fontWeight: 600, fontSize: 'var(--fs-xl)' }}>随手记</div>
        <button
          onClick={() => void submit()}
          disabled={!canSubmit}
          title="完成 — 提交这条随手记"
          aria-label="完成"
          style={{ ...hdrBtn, color: canSubmit ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <Check size={16} />完成
        </button>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
        {/* 标题（必填，自动聚焦） */}
        <textarea
          autoFocus
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            // T01431：实时短语法解析——命中即同步到属性行（预览可修正），不覆盖时间词
            const r = parseQuickSyntax(e.target.value, projects, categories);
            setSyntax(r);
            if (r.priority) setPriority(r.priority);
            if (r.projectId) setProjectId(r.projectId);
            if (r.categoryId) setCategoryId(r.categoryId);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }}
          aria-label="随手记标题"
          placeholder="记点什么…（标题必填，回车提交）"
          rows={2}
          style={titleInput}
        />

        {/* 辅助录入快捷条 */}
        <div style={quickBar}>
          {speechSupported && (
            <button onClick={toggleVoice} title="语音 — 口述转文字填入标题" aria-label="语音输入"
              style={{ ...quickChip, background: listening ? 'var(--accent)' : 'var(--surface-2)', color: listening ? 'var(--accent-text)' : 'var(--text)' }}>
              <Mic size={15} />{listening ? '聆听中…' : '语音'}
            </button>
          )}
          <button onClick={() => void openTemplates()} title="模板 — 用提示词预填" aria-label="快捷模板"
            style={{ ...quickChip, background: tplOpen ? 'var(--accent)' : 'var(--surface-2)', color: tplOpen ? 'var(--accent-text)' : 'var(--text)' }}>
            <FileText size={15} />模板
          </button>
          <button onClick={() => fileRef.current?.click()} title="贴图 — 添加任务截图" aria-label="添加图片" style={quickChip}>
            <ImagePlus size={15} />贴图{images.length > 0 ? `(${images.length})` : ''}
          </button>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple aria-label="选择要贴入任务的截图" style={FILE_INPUT_SR_ONLY} onChange={(e) => { onPickImages(e.target.files); e.target.value = ''; }} />
        </div>

        {/* T01426：可选属性行——优先级/分类/项目，默认记忆上次；全部可选，不增必填 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 10 }}>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="优先级"
            style={{ ...attrSelect, color: PRIORITY_COLOR[normalizePriority(priority) || 'normal'] }}>
            {/* T03655：原生 <option> 无法承载 svg，故优先级只留文字，紧迫度改由选中值本身的颜色表达 */}
            <option value="urgent">紧急</option>
            <option value="high">高</option>
            <option value="normal">普通</option>
            <option value="low">低</option>
          </select>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="分类" style={attrSelect}>
            <option value="">分类：未设</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setProjectName(projects.find((x) => x.id === e.target.value)?.name ?? ''); }} aria-label="项目" style={attrSelect}>
            {projects.length === 0 && !projectId && <option value="">{projectListPlaceholder(projectList)}</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            {!projects.some((x) => x.id === projectId) && <option value={projectId}>{projectName}</option>}
          </select>
        </div>

        {/* T02212：项目取数失败/加载中的可见提示（附「上次数据可能过期」与重试入口），不再静默落成空下拉 */}
        <ProjectListHint view={projectList} style={{ ...wideHintStyle, marginTop: 8 }} />

        {/* T01431：短语法解析预览条——提交前展示命中结果，属性行可修正 */}
        {syntax && (syntax.priority || syntax.projectId || syntax.categoryId || syntax.dueNote) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, padding: '6px 10px', borderRadius: 8, background: 'var(--surface-2)', fontSize: 'var(--fs-s)', color: 'var(--text-secondary)' }}>
            <span style={{ color: 'var(--text-muted)' }}>短语法解析：</span>
            {syntax.priority && <Badge tone="accent">优先级 {{ urgent: '紧急', high: '高', normal: '普通', low: '低' }[syntax.priority]}</Badge>}
            {syntax.projectId && <Badge>项目 {projects.find((x) => x.id === syntax.projectId)?.name}</Badge>}
            {syntax.categoryId && <Badge>分类 {categories.find((x) => x.id === syntax.categoryId)?.name}</Badge>}
            {syntax.dueNote && <Badge tone="success"><Clock size={10} aria-hidden /> {syntax.dueNote}</Badge>}
          </div>
        )}

        {/* 模板面板 */}
        {tplOpen && (
          <div style={sheet}>
            <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 8 }}>从提示词模板预填</div>
            {templates.length === 0 && <EmptyState icon={<FileText size={32} />} message="暂无可用模板" />}
            <div style={{ maxHeight: 240, overflowY: 'auto' }}>
              {templates.map((p) => (
                <button key={p.id} onClick={() => applyTemplate(p)} style={tplItem}>{p.title}</button>
              ))}
            </div>
          </div>
        )}

        {/* 图片缩略 */}
        {images.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
            {images.map((url, i) => (
              <div key={`${url.slice(-24)}-${i}`} style={{ position: 'relative' }}>
                <img src={url} alt="待上传" style={{ height: 64, borderRadius: 6, border: '1px dashed var(--accent)' }} />
                <button onClick={() => removeImageAt(i)} title="移除图片" aria-label="移除图片"
                  style={{ position: 'absolute', top: -6, right: -6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--fs-2xs)', lineHeight: '16px', padding: '0 4px', background: 'var(--danger)', color: 'var(--on-solid)', border: 'none', borderRadius: 8, cursor: 'pointer' }}><X size={10} aria-hidden /></button>
              </div>
            ))}
          </div>
        )}

        {/* 描述（可折叠） */}
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setDescOpen((o) => !o)} style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Paperclip size={14} /> 描述{!description && '（可选）'}{descOpen ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
          </button>
          {descOpen && (
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-label="随手记描述（可选）"
              rows={4}
              placeholder="补充说明（可选）"
              style={{ width: '100%', marginTop: 8, padding: 10, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 'var(--fs-l)', boxSizing: 'border-box' }}
            />
          )}
        </div>

        {/* 优先级 */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 6 }}>优先级</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {PRIORITIES.map((p) => (
              <button key={p.value} onClick={() => setPriority(p.value)}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 'var(--fs-m)', cursor: 'pointer',
                  background: priority === p.value ? 'var(--accent)' : 'var(--surface-2)',
                  color: priority === p.value ? 'var(--accent-text)' : 'var(--text)', border: 'none' }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 分类 */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 6 }}>分类（可选）</div>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="随手记分类（可选）" style={selectFull}>
            <option value="">未分类</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        {/* 项目归属（默认记事项目，可展开改） */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 6 }}>归属项目</div>
          <select value={projectId} onChange={(e) => { setProjectId(e.target.value); const p = projects.find((x) => x.id === e.target.value); setProjectName(p?.name ?? '收件箱'); }} aria-label="随手记归属项目" style={selectFull}>
            {projects.length === 0 && !projectId && <option value="">{projectListPlaceholder(projectList)}</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', marginTop: 4 }}>默认记事项目：{projectName}（随手记缺省落入，可在「更多→设置」更改）</div>
        </div>
      </div>
    </div>
  );
}

// ---------- 复用样式 ----------
const hdrBtn: React.CSSProperties = { fontSize: 'var(--fs-l)', padding: '6px 8px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)' };
const titleInput: React.CSSProperties = { width: '100%', marginTop: 4, padding: 12, border: '1px solid var(--border-strong)', borderRadius: 10, fontSize: 'var(--fs-2xl)', boxSizing: 'border-box', resize: 'none', fontFamily: 'inherit' };
const quickBar: React.CSSProperties = { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' };
const quickChip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 12px', borderRadius: 20, fontSize: 'var(--fs-m)', cursor: 'pointer', border: 'none' };
const sheet: React.CSSProperties = { marginTop: 10, padding: 12, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10 };
const tplItem: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '10px 8px', fontSize: 'var(--fs-l)', border: 'none', borderBottom: '1px solid var(--surface-2)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' };
const attrSelect: React.CSSProperties = { width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 'var(--fs-m)', background: 'var(--card-bg)', color: 'var(--text)', boxSizing: 'border-box' };
const selectFull: React.CSSProperties = { width: '100%', padding: 10, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 'var(--fs-l)', background: 'var(--card-bg)', color: 'var(--text)', boxSizing: 'border-box' };
