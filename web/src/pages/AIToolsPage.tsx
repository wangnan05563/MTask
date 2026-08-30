import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronUp, Code2, Cpu, Eye, EyeOff, Loader2, Pencil, PlugZap, Plus, Power, Save, Star, Trash2, X } from 'lucide-react';
import { api, type AITool } from '../api/client';
import { askConfirm } from '../ui/dialogs';
import { PinToggle } from '../ui/PinToggle';

/** 配置记录表单草稿（apiKey 留空 = 编辑时保留原密钥） */
interface ToolForm {
  name: string;
  type: string;
  endpoint: string;
  apiKey: string;
  model: string;
  modelNotes: string;
  purpose: 'organize' | 'develop';
  enabled: boolean;
  remark: string;
  /** 厂商官方控制台页面 URL（仅用于跳转展示） */
  consoleUrl: string;
}

const PURPOSE_LABEL: Record<string, string> = { organize: '整理', develop: '开发' };

function emptyForm(defaultType: string): ToolForm {
  return {
    name: '', type: defaultType, endpoint: '', apiKey: '',
    model: '', modelNotes: '', purpose: 'develop', enabled: true, remark: '', consoleUrl: '',
  };
}

/** 模型管理：集中记录各 AI 厂商的 API Key、模型配置等连接信息（复用 ai_tools 体系） */
export function AIToolsPage() {
  const [tools, setTools] = useState<AITool[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({});
  // 连接测试 / 模型获取 的运行中状态（列表行按工具 id，用于按钮加载动画）
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [fetchingModels, setFetchingModels] = useState<Record<string, boolean>>({});
  // 表单草稿内「测试连接 / 获取模型」的运行中状态
  const [formTesting, setFormTesting] = useState(false);
  const [formFetching, setFormFetching] = useState(false);
  // 记录高亮：保存更新成功后对目标行打标记，flashAt 值变化触发行动画重放
  const [flashAt, setFlashAt] = useState<Record<string, number>>({});
  // 列表行「可用模型」拉取结果（按工具 id）
  const [modelsResult, setModelsResult] = useState<Record<string, string[]>>({});
  // API Key 查看原文：仅点击后按需拉取明文，隐藏时立即从状态移除（仅内存保留）
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  // 备注展开状态：默认收缩（同提示词页交互），点击标题行箭头展开查看
  const [remarkExpanded, setRemarkExpanded] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState('');
  // 筛选
  const [keyword, setKeyword] = useState('');
  const [filterPurpose, setFilterPurpose] = useState('');
  const [filterType, setFilterType] = useState('');
  // 表单弹窗：form 为 null 表示未打开；editingId 为被编辑记录 id
  const [form, setForm] = useState<ToolForm | null>(null);
  const [editingId, setEditingId] = useState('');
  const [saving, setSaving] = useState(false);
  // 表单内草稿测试/模型拉取结果（不落库，用当前表单值提前验证）
  const [formTest, setFormTest] = useState<{ msg: string; ok: boolean } | null>(null);
  const [formModels, setFormModels] = useState<string[]>([]);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2500);
  };

  const load = useCallback(async () => {
    try {
      setTools(await api.get<AITool[]>('/aitools'));
      setTypes(await api.get<string[]>('/aitools/types'));
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // ---------- 增删改 ----------
  function openCreate() {
    setForm(emptyForm(types[0] ?? 'openai-compatible'));
    setEditingId('');
    setFormTest(null);
    setFormModels([]);
  }

  function openEdit(t: AITool) {
    setForm({
      name: t.name, type: t.type, endpoint: t.endpoint, apiKey: '',
      model: t.model ?? '', modelNotes: t.model_notes ?? '',
      purpose: t.purpose === 'organize' ? 'organize' : 'develop',
      enabled: t.enabled, remark: t.remark ?? '', consoleUrl: t.console_url ?? '',
    });
    setEditingId(t.id);
    setFormTest(null);
    setFormModels([]);
  }

  function closeForm() {
    setForm(null);
    setEditingId('');
  }

  async function saveForm() {
    if (!form || saving) return;
    if (!form.name.trim()) return flash('名称必填');
    if (!form.endpoint.trim()) return flash('Endpoint 必填');
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      type: form.type,
      endpoint: form.endpoint.trim(),
      model: form.model.trim() || undefined,
      modelNotes: form.modelNotes,
      purpose: form.purpose,
      enabled: form.enabled,
      remark: form.remark,
      consoleUrl: form.consoleUrl,
      // API Key 留空 → 不传该字段，后端保留原密文
      apiKey: form.apiKey ? form.apiKey : undefined,
    };
    setSaving(true);
    try {
      if (editingId) {
        await api.patch(`/aitools/${editingId}`, payload);
        setFlashAt((prev) => ({ ...prev, [editingId]: Date.now() }));
        flash('配置已更新');
      } else {
        await api.post('/aitools', payload);
        flash('配置已新增');
      }
      closeForm();
      setRevealed({});
      void load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(t: AITool) {
    if (!(await askConfirm(`删除配置记录「${t.name}」？此操作不可恢复。`))) return;
    try {
      await api.del(`/aitools/${t.id}`);
      void load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** 启用/停用快捷切换 */
  async function toggleEnabled(t: AITool) {
    try {
      await api.patch(`/aitools/${t.id}`, { enabled: !t.enabled });
      void load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  async function test(t: AITool) {
    setTesting((prev) => ({ ...prev, [t.id]: true }));
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/aitools/${t.id}/test`);
      setTestResult((prev) => ({ ...prev, [t.id]: { ok: r.ok, msg: r.message } }));
    } catch (e) {
      setTestResult((prev) => ({ ...prev, [t.id]: { ok: false, msg: e instanceof Error ? e.message : String(e) } }));
    } finally {
      setTesting((prev) => ({ ...prev, [t.id]: false }));
    }
  }

  /** 查看原文/隐藏：明文按需从服务端拉取，隐藏时立即从内存状态移除 */
  async function toggleReveal(t: AITool) {
    if (revealed[t.id]) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[t.id];
        return next;
      });
      return;
    }
    try {
      const r = await api.get<{ hasApiKey: boolean; apiKey: string | null }>(`/aitools/${t.id}/api-key`);
      if (r.apiKey) {
        setRevealed((prev) => ({ ...prev, [t.id]: r.apiKey as string }));
      } else {
        flash('该配置未设置 API Key');
      }
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** 拉取已保存工具的可用模型列表，展示在操作列下方 */
  async function fetchRowModels(t: AITool) {
    setFetchingModels((prev) => ({ ...prev, [t.id]: true }));
    try {
      const r = await api.post<{ ok: boolean; models?: string[]; message?: string }>(`/aitools/${t.id}/models`);
      if (r.ok && r.models) {
        setModelsResult((prev) => ({ ...prev, [t.id]: r.models! }));
        flash(`获取到 ${r.models.length} 个可用模型`);
      } else {
        flash(r.message ?? '获取模型列表失败');
      }
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setFetchingModels((prev) => ({ ...prev, [t.id]: false }));
    }
  }

  /** 表单内草稿连接测试：用未保存的当前表单值提前验证，避免保存后才发现配置错误 */
  async function testDraftFromForm() {
    if (!form) return;
    if (!form.endpoint.trim()) return flash('请先填写 Endpoint');
    setFormTesting(true);
    setFormTest({ msg: '测试中…', ok: true });
    try {
      const r = await api.post<{ ok: boolean; message: string }>('/aitools/test', {
        type: form.type,
        endpoint: form.endpoint.trim(),
        apiKey: form.apiKey || undefined,
        model: form.model.trim() || undefined,
      });
      setFormTest({ msg: r.message, ok: r.ok });
    } catch (e) {
      setFormTest({ msg: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setFormTesting(false);
    }
  }

  /** 表单内拉取可用模型：编辑中走已保存记录（服务端用存量密钥），新建走草稿参数，结果填入 datalist 供选择 */
  async function fetchFormModels() {
    if (!form) return;
    if (!form.endpoint.trim()) return flash('请先填写 Endpoint');
    setFormFetching(true);
    try {
      const r = editingId
        ? await api.post<{ ok: boolean; models?: string[]; message?: string }>(`/aitools/${editingId}/models`)
        : await api.post<{ ok: boolean; models?: string[]; message?: string }>('/aitools/models', {
            type: form.type,
            endpoint: form.endpoint.trim(),
            apiKey: form.apiKey || undefined,
          });
      if (r.ok && r.models) {
        setFormModels(r.models);
        flash(`获取到 ${r.models.length} 个可用模型，可直接在默认模型框中选择`);
      } else {
        flash(r.message ?? '获取模型列表失败，可手工填写模型名');
      }
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setFormFetching(false);
    }
  }

  /** 置顶/取消置顶：切换后重新拉取，置顶项排到列表顶部 */
  async function togglePin(t: AITool) {
    try {
      await api.patch(`/aitools/${t.id}`, { pinned: !t.pinned });
      void load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  /** FR3.4 设为默认整理/开发工具 */
  async function setDefault(t: AITool, kind: 'organize' | 'develop') {
    try {
      await api.post(`/aitools/${t.id}/set-default`, { kind });
      void load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  // ---------- 筛选 ----------
  const filtered = tools.filter((t) => {
    if (filterPurpose && t.purpose !== filterPurpose) return false;
    if (filterType && t.type !== filterType) return false;
    const kw = keyword.trim().toLowerCase();
    if (kw) {
      const hit = [t.name, t.type, t.endpoint, t.model ?? '', t.remark ?? '']
        .some((s) => s.toLowerCase().includes(kw));
      if (!hit) return false;
    }
    return true;
  });

  const fieldStyle: CSSProperties = { width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
  const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
  const cellStyle: CSSProperties = { padding: 8, borderBottom: '1px solid var(--surface-2)', verticalAlign: 'top' };

  return (
    <section>
      {/* 按钮加载旋转动画：供连接测试 / 模型获取等按钮 loading 图标使用 */}
      <style>{`@keyframes aispin{to{transform:rotate(360deg)}}.aispin{animation:aispin .8s linear infinite;display:inline-block}
        .arena-row:hover td { background: var(--surface-2); }
        .abtn { opacity: 0; visibility: hidden; transition: opacity .15s ease, visibility 0s linear .15s; }
        .arena-row:hover .abtn, .arena-row:focus-within .abtn { opacity: 1; visibility: visible; transition: opacity .15s ease, visibility 0s; }
        @keyframes rowflush { 0% { background: var(--accent-soft); } 100% { background: transparent; } }
        .arena-row.flush td { animation: rowflush 1.4s ease; }`}</style>
      {/* 工具栏 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <h3 style={{ fontSize: 15, margin: 0 }}>配置记录（{filtered.length}/{tools.length}）</h3>
        <select value={filterType} onChange={(e) => setFilterType(e.target.value)} style={{ padding: 6 }}>
          <option value="">全部厂商类型</option>
          {types.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
        </select>
        <select value={filterPurpose} onChange={(e) => setFilterPurpose(e.target.value)} style={{ padding: 6 }}>
          <option value="">全部用途</option>
          <option value="organize">整理</option>
          <option value="develop">开发</option>
        </select>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索名称/厂商/Endpoint/备注…"
          style={{ padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 12, flex: 1, minWidth: 180 }}
        />
        {notice && <span style={{ fontSize: 13, color: 'var(--accent)' }}>{notice}</span>}
        <button
          onClick={openCreate}
          title="新增配置 — 新增一条 AI 厂商配置记录"
          aria-label="新增配置：新增一条 AI 厂商配置记录"
          style={{ background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', padding: '6px 14px', borderRadius: 6, cursor: 'pointer' }}
        >
          <Plus size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
        </button>
      </div>

      {/* 列表 */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
            <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>名称</th>
            <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>厂商类型</th>
            <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>用途</th>
            <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>Endpoint</th>
            <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>默认模型</th>
            <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>API Key</th>
            <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>状态</th>
            <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>默认</th>
            <th style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((t) => (
            <tr key={flashAt[t.id] ? `f${flashAt[t.id]}-${t.id}` : t.id} className={`arena-row${flashAt[t.id] ? ' flush' : ''}`}>
              <td style={cellStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <PinToggle pinned={t.pinned} onToggle={() => void togglePin(t)} />
                  <span style={{ fontWeight: 600 }}>{t.name}</span>
                  {/* 备注展开/收起箭头：与提示词页一致用 lucide 图标，蓝色 13px；有备注才显示 */}
                  {t.remark && (
                    <button
                      onClick={() => setRemarkExpanded((prev) => ({ ...prev, [t.id]: !prev[t.id] }))}
                      title={remarkExpanded[t.id] ? '收起备注 — 收起备注内容' : '展开备注 — 展开查看备注内容'}
                      aria-label={remarkExpanded[t.id] ? '收起：收起备注内容' : '展开：展开查看备注内容'}
                      style={{ color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px', cursor: 'pointer' }}
                    >
                      {remarkExpanded[t.id] ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </button>
                  )}
                </div>
                {/* 备注默认收缩，仅展开时显示完整内容 */}
                {t.remark && remarkExpanded[t.id] && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{t.remark}</div>}
              </td>
              <td style={cellStyle}>{t.type}</td>
              <td style={cellStyle}>{PURPOSE_LABEL[t.purpose] ?? t.purpose}</td>
              <td style={{ ...cellStyle, wordBreak: 'break-all', maxWidth: 220 }}>{t.endpoint}</td>
              <td style={cellStyle}>
                <div>{t.model ?? '-'}</div>
                {t.model_notes && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{t.model_notes}</div>}
              </td>
              {/* 默认仅展示掩码；点击「查看原文」按需拉取明文，再点隐藏即从内存移除（FR3.5） */}
              <td style={cellStyle}>
                <div style={revealed[t.id] ? { fontFamily: 'monospace', wordBreak: 'break-all', maxWidth: 200 } : undefined}>
                  {revealed[t.id] ?? (t.apiKeyMasked ?? '未配置')}
                </div>
                {t.hasApiKey && (
                  <button
                    onClick={() => void toggleReveal(t)}
                    title={revealed[t.id] ? '隐藏 — 隐藏 API Key 明文' : '查看原文 — 查看 API Key 明文'}
                    aria-label={revealed[t.id] ? '隐藏：隐藏 API Key 明文' : '查看原文：查看 API Key 明文'}
                    style={{ fontSize: 11, marginTop: 2, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                  >
                    {revealed[t.id]
                      ? <EyeOff size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                      : <Eye size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
                  </button>
                )}
              </td>
              <td style={cellStyle}>
                <button
                  onClick={() => void toggleEnabled(t)}
                  title={t.enabled ? '停用 — 停用该配置文件' : '启用 — 启用该配置文件'}
                  aria-label={t.enabled ? '停用：停用该配置文件' : '启用：启用该配置文件'}
                  style={{ fontSize: 12, color: t.enabled ? 'var(--success)' : 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                >
                  <Power size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                </button>
              </td>
              <td style={cellStyle}>
                {t.isDefaultOrganize && <span style={{ fontSize: 11, color: 'var(--accent)', marginRight: 4 }}>整理✓</span>}
                {t.isDefaultDevelop && <span style={{ fontSize: 11, color: 'var(--success)' }}>开发✓</span>}
                {!t.isDefaultOrganize && !t.isDefaultDevelop && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>-</span>}
              </td>
              <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                {t.console_url ? (
                  <a
                    href={t.console_url}
                    target="_blank"
                    rel="noreferrer"
                    className="abtn"
                    style={{ fontSize: 12, marginRight: 6, color: 'var(--accent)' }}
                  >控制台</a>
                ) : null}
                <button
                  className="abtn" onClick={() => openEdit(t)}
                  title="编辑 — 编辑该配置，保留原 API Key"
                  aria-label="编辑：编辑该配置，保留原 API Key"
                  style={{ fontSize: 12, marginRight: 6, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                >
                  <Pencil size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                </button>
                <button
                  className="abtn" onClick={() => void test(t)}
                  disabled={testing[t.id]}
                  title={testing[t.id] ? '测试中…' : '测试 — 测试该配置的连通性'}
                  aria-label={testing[t.id] ? '测试中：正在测试连通性' : '测试：测试该配置的连通性'}
                  style={{ fontSize: 12, marginRight: 6, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                >
                  {testing[t.id] ? <Loader2 size={13} className="aispin" /> : <PlugZap size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
                </button>
                <button
                  className="abtn" onClick={() => void fetchRowModels(t)}
                  disabled={fetchingModels[t.id]}
                  title={fetchingModels[t.id] ? '获取模型列表中…' : '模型 — 拉取该配置可用的模型列表'}
                  aria-label={fetchingModels[t.id] ? '获取中：拉取可用模型列表' : '模型：拉取该配置可用的模型列表'}
                  style={{ fontSize: 12, marginRight: 6, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                >
                  {fetchingModels[t.id] ? <Loader2 size={13} className="aispin" /> : <Cpu size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
                </button>
                {!t.isDefaultOrganize && (
                  <button
                    className="abtn" onClick={() => void setDefault(t, 'organize')}
                    title="默认整理 — 将该配置设为默认整理工具"
                    aria-label="默认整理：将该配置设为默认整理工具"
                    style={{ fontSize: 12, marginRight: 6, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                  >
                    <Star size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                  </button>
                )}
                {!t.isDefaultDevelop && (
                  <button
                    className="abtn" onClick={() => void setDefault(t, 'develop')}
                    title="默认开发 — 将该配置设为默认开发工具"
                    aria-label="默认开发：将该配置设为默认开发工具"
                    style={{ fontSize: 12, marginRight: 6, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                  >
                    <Code2 size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                  </button>
                )}
                <button
                  className="abtn" onClick={() => void remove(t)}
                  title="删除 — 删除该配置，此操作不可恢复"
                  aria-label="删除：删除该配置，此操作不可恢复"
                  style={{ fontSize: 12, color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
                >
                  <Trash2 size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
                </button>
                {testResult[t.id] && (
                  <div style={{ fontSize: 11, color: testResult[t.id].ok ? 'var(--success)' : 'var(--danger)', marginTop: 4, whiteSpace: 'normal', maxWidth: 200 }}>
                    {testResult[t.id].ok ? '✓ 连接成功：' : '✗ '}{testResult[t.id].msg}
                  </div>
                )}
                {modelsResult[t.id] && (
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, whiteSpace: 'normal', maxWidth: 220 }}>
                    可用模型：{modelsResult[t.id].slice(0, 15).join('、')}{modelsResult[t.id].length > 15 ? `…共 ${modelsResult[t.id].length} 个` : ''}
                  </div>
                )}
              </td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr><td colSpan={9} style={{ padding: 16, color: 'var(--text-muted)', textAlign: 'center' }}>{tools.length === 0 ? '暂无配置记录，点击「+ 新增配置」接入你的 AI 厂商' : '没有符合筛选条件的配置记录'}</td></tr>
          )}
        </tbody>
      </table>

      {/* 新增/编辑弹窗 */}
      {form && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onMouseDown={(e) => e.target === e.currentTarget && closeForm()}
        >
          <div style={{ background: 'var(--card-bg)', borderRadius: 8, padding: 20, width: 520, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,0.18)' }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>{editingId ? '编辑配置记录' : '新增配置记录'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={labelStyle}>名称（厂商/工具名）*</label>
                <input style={fieldStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如 DeepSeek 官方" />
              </div>
              <div>
                <label style={labelStyle}>厂商类型 *</label>
                <select style={fieldStyle} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {types.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
                </select>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={labelStyle}>Endpoint / Base URL *</label>
                <input style={fieldStyle} value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder="例如 https://api.deepseek.com/v1" />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={labelStyle}>厂商控制台 URL（可选）</label>
                <input style={fieldStyle} value={form.consoleUrl} onChange={(e) => setForm({ ...form, consoleUrl: e.target.value })} placeholder="例如 https://platform.deepseek.com" />
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>填写后，列表「控制台」按钮可直接打开该厂商官方控制台页面</div>
              </div>
              {/* 草稿连接测试：未保存即可验证 Endpoint + Key 连通性 */}
              <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => void testDraftFromForm()} disabled={formTesting} title={formTesting ? '测试中…' : '测试连接 — 用当前表单值验证连通性'} aria-label={formTesting ? '测试中：验证连通性' : '测试连接：用当前表单值验证连通性'} style={{ fontSize: 12, padding: '4px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
                  {formTesting ? <Loader2 size={13} className="aispin" /> : <PlugZap size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
                </button>
                {formTest && <span style={{ fontSize: 12, color: formTest.ok ? 'var(--success)' : 'var(--danger)' }}>{formTest.msg}</span>}
              </div>
              <div>
                <label style={labelStyle}>API Key{editingId ? '（留空保留原值）' : '（可留空）'}</label>
                <input
                  style={fieldStyle}
                  type="password"
                  autoComplete="new-password"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder={editingId ? '留空 = 保留原密钥' : 'sk-…'}
                />
              </div>
              <div>
                <label style={labelStyle}>默认模型</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input list="aitool-model-options" style={fieldStyle} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="例如 deepseek-chat" />
                  <button onClick={() => void fetchFormModels()} disabled={formFetching} title={formFetching ? '获取中…' : '获取模型 — 拉取服务商可用模型清单'} aria-label={formFetching ? '获取中：拉取可用模型清单' : '获取模型：拉取服务商可用模型清单'} style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center' }}>
                    {formFetching ? <Loader2 size={13} className="aispin" /> : <Cpu size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
                  </button>
                </div>
                <datalist id="aitool-model-options">
                  {formModels.map((m) => <option key={m} value={m} />)}
                </datalist>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={labelStyle}>模型配置说明</label>
                <input style={fieldStyle} value={form.modelNotes} onChange={(e) => setForm({ ...form, modelNotes: e.target.value })} placeholder="例如 上下文 64K，建议 temperature 0.2" />
              </div>
              <div>
                <label style={labelStyle}>用途</label>
                <select style={fieldStyle} value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value as ToolForm['purpose'] })}>
                  <option value="organize">整理</option>
                  <option value="develop">开发</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 8 }}>
                <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
                  启用
                </label>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={labelStyle}>备注</label>
                <textarea style={{ ...fieldStyle, fontFamily: 'inherit' }} rows={2} value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} placeholder="内部备注，不会发送给 AI 厂商" />
              </div>
            </div>
            <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={closeForm} title="取消 — 关闭弹窗，放弃未保存的修改" aria-label="取消：关闭弹窗，放弃未保存的修改" style={{ padding: '6px 14px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
                <X size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
              </button>
              <button
                onClick={() => void saveForm()}
                disabled={saving}
                title="保存 — 保存该配置记录"
                aria-label="保存：保存该配置记录"
                style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
              >
                <Save size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
