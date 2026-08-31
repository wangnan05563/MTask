/**
 * 移动端核心：随手记（§3）。快速新建任务，路径 ≤3 步：点入口 → 输入标题 → 完成。
 * 录入方式：文本（主）/ 语音（Web Speech API，不支持则隐藏）/ 快捷模板（提示词预填）/ 图片贴图。
 * 提交复用 POST /api/tasks；离线时落本地草稿，联网后由 MobileShell 自动补提。
 */
import { useEffect, useRef, useState } from 'react';
import { api, type Project, type Task, type TaskCategory, type Prompt } from '../api/client';
import { addDraft, submitQuickNote } from './offline';
import { Mic, FileText, ImagePlus, Paperclip, Check } from 'lucide-react';

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
  readonly notify: (msg: string) => void;
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [categories, setCategories] = useState<TaskCategory[]>([]);
  const [busy, setBusy] = useState(false);

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
      try { setProjects(await api.get<Project[]>('/projects')); } catch { /* 忽略 */ }
      try { setCategories(await api.get<TaskCategory[]>('/task-categories')); } catch { /* 忽略 */ }
      try {
        const np = await api.get<{ projectId: string }>('/settings/note-project');
        setProjectId(np.projectId);
        const p = projects.find((x) => x.id === np.projectId);
        setProjectName(p?.name ?? '收件箱');
      } catch { /* 忽略，回退收件箱 */ }
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
    const payload = {
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      categoryId: categoryId || undefined,
      projectId: projectId || undefined,
      images,
    };
    try {
      const task = await submitQuickNote(payload);
      notify('已记录');
      onDone(task);
    } catch {
      // 任何提交失败（离线 / 网络抖动 / 服务器暂不可达）均落本地草稿，联网后自动补提（§3.4），避免内容丢失
      // 异常对象本身无需使用，统一按「已存草稿」反馈，不区分失败原因
      addDraft(payload);
      notify('提交失败，已存为草稿（联网后自动补提）');
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
        <div style={{ fontWeight: 600, fontSize: 15 }}>随手记</div>
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
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }}
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
          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple style={{ display: 'none' }} onChange={(e) => { onPickImages(e.target.files); e.target.value = ''; }} />
        </div>

        {/* 模板面板 */}
        {tplOpen && (
          <div style={sheet}>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>从提示词模板预填</div>
            {templates.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>暂无可用模板</div>}
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
              <div key={url} style={{ position: 'relative' }}>
                <img src={url} alt="待上传" style={{ height: 64, borderRadius: 6, border: '1px dashed var(--accent)' }} />
                <button onClick={() => removeImageAt(i)} title="移除图片" aria-label="移除图片"
                  style={{ position: 'absolute', top: -6, right: -6, fontSize: 10, lineHeight: '16px', padding: '0 4px', background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>✕</button>
              </div>
            ))}
          </div>
        )}

        {/* 描述（可折叠） */}
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setDescOpen((o) => !o)} style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Paperclip size={14} /> 描述{!description && '（可选）'}{descOpen ? ' ▲' : ' ▼'}
          </button>
          {descOpen && (
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="补充说明（可选）"
              style={{ width: '100%', marginTop: 8, padding: 10, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
            />
          )}
        </div>

        {/* 优先级 */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>优先级</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {PRIORITIES.map((p) => (
              <button key={p.value} onClick={() => setPriority(p.value)}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                  background: priority === p.value ? 'var(--accent)' : 'var(--surface-2)',
                  color: priority === p.value ? 'var(--accent-text)' : 'var(--text)', border: 'none' }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 分类 */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>分类（可选）</div>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={selectFull}>
            <option value="">未分类</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        {/* 项目归属（默认记事项目，可展开改） */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>归属项目</div>
          <select value={projectId} onChange={(e) => { setProjectId(e.target.value); const p = projects.find((x) => x.id === e.target.value); setProjectName(p?.name ?? '收件箱'); }} style={selectFull}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>默认记事项目：{projectName}（随手记缺省落入，可在「更多→设置」更改）</div>
        </div>
      </div>
    </div>
  );
}

// ---------- 复用样式 ----------
const page: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--app-bg)', color: 'var(--text)' };
const header: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--border)', background: 'var(--card-bg)' };
const hdrBtn: React.CSSProperties = { fontSize: 14, padding: '6px 8px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)' };
const titleInput: React.CSSProperties = { width: '100%', marginTop: 4, padding: 12, border: '1px solid var(--border-strong)', borderRadius: 10, fontSize: 16, boxSizing: 'border-box', resize: 'none', fontFamily: 'inherit' };
const quickBar: React.CSSProperties = { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' };
const quickChip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 12px', borderRadius: 20, fontSize: 13, cursor: 'pointer', border: 'none' };
const sheet: React.CSSProperties = { marginTop: 10, padding: 12, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 10 };
const tplItem: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '10px 8px', fontSize: 14, border: 'none', borderBottom: '1px solid var(--surface-2)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' };
const selectFull: React.CSSProperties = { width: '100%', padding: 10, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 14, background: 'var(--card-bg)', color: 'var(--text)', boxSizing: 'border-box' };
