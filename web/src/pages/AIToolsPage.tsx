import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronUp, Code2, Cpu, Eye, EyeOff, Loader2, Pencil, PlugZap, Plus, Power, Save, Star, Trash2, X } from 'lucide-react';
import { api, type AITool } from '../api/client';
import { UsagePanel } from './UsagePanel';
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

// 表格单元格与表单样式提到模块级：拆分出的行/弹窗子组件与主组件共用同一对象，避免重复定义
const cellStyle: CSSProperties = { padding: 8, borderBottom: '1px solid var(--surface-2)', verticalAlign: 'top' };
const fieldStyle: CSSProperties = { width: '100%', padding: 8, border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };

function emptyForm(defaultType: string): ToolForm {
  return {
    name: '', type: defaultType, endpoint: '', apiKey: '',
    model: '', modelNotes: '', purpose: 'develop', enabled: true, remark: '', consoleUrl: '',
  };
}

/** 操作列 props：按钮运行状态收敛为单值/单条结果，回调由父组件注入（S3776/S2004 拆分：降低页面组件复杂度） */
interface ToolActionsCellProps {
  readonly tool: AITool;
  readonly testing: boolean;
  readonly fetchingModels: boolean;
  readonly testResult: { ok: boolean; msg: string } | undefined;
  readonly modelsResult: readonly string[] | undefined;
  readonly onOpenEdit: (t: AITool) => void;
  readonly onTest: (t: AITool) => void;
  readonly onFetchRowModels: (t: AITool) => void;
  readonly onSetDefault: (t: AITool, kind: 'organize' | 'develop') => void;
  readonly onRemove: (t: AITool) => void;
}

/** 操作列（S3776 拆分）：集中放置悬停显现按钮与测试/模型结果，独立成组件后行组件与页面组件复杂度均降至阈值内 */
function ToolActionsCell({ tool, testing, fetchingModels, testResult, modelsResult, onOpenEdit, onTest, onFetchRowModels, onSetDefault, onRemove }: ToolActionsCellProps) {
  return (
    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
      {tool.console_url ? (
        <a
          href={tool.console_url}
          target="_blank"
          rel="noreferrer"
          className="abtn"
          style={{ fontSize: 12, marginRight: 6, color: 'var(--accent)' }}
        >控制台</a>
      ) : null}
      <button
        className="abtn" onClick={() => onOpenEdit(tool)}
        title="编辑 — 编辑该配置，保留原 API Key"
        aria-label="编辑：编辑该配置，保留原 API Key"
        style={{ fontSize: 12, marginRight: 6, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
      >
        <Pencil size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
      </button>
      <button
        className="abtn" onClick={() => onTest(tool)}
        disabled={testing}
        title={testing ? '测试中…' : '测试 — 测试该配置的连通性'}
        aria-label={testing ? '测试中：正在测试连通性' : '测试：测试该配置的连通性'}
        style={{ fontSize: 12, marginRight: 6, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
      >
        {testing ? <Loader2 size={13} className="aispin" /> : <PlugZap size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
      </button>
      <button
        className="abtn" onClick={() => onFetchRowModels(tool)}
        disabled={fetchingModels}
        title={fetchingModels ? '获取模型列表中…' : '模型 — 拉取该配置可用的模型列表'}
        aria-label={fetchingModels ? '获取中：拉取可用模型列表' : '模型：拉取该配置可用的模型列表'}
        style={{ fontSize: 12, marginRight: 6, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
      >
        {fetchingModels ? <Loader2 size={13} className="aispin" /> : <Cpu size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
      </button>
      {!tool.isDefaultOrganize && (
        <button
          className="abtn" onClick={() => onSetDefault(tool, 'organize')}
          title="默认整理 — 将该配置设为默认整理工具"
          aria-label="默认整理：将该配置设为默认整理工具"
          style={{ fontSize: 12, marginRight: 6, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
        >
          <Star size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
        </button>
      )}
      {!tool.isDefaultDevelop && (
        <button
          className="abtn" onClick={() => onSetDefault(tool, 'develop')}
          title="默认开发 — 将该配置设为默认开发工具"
          aria-label="默认开发：将该配置设为默认开发工具"
          style={{ fontSize: 12, marginRight: 6, display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
        >
          <Code2 size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
        </button>
      )}
      <button
        className="abtn" onClick={() => onRemove(tool)}
        title="删除 — 删除该配置，此操作不可恢复"
        aria-label="删除：删除该配置，此操作不可恢复"
        style={{ fontSize: 12, color: 'var(--danger)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
      >
        <Trash2 size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
      </button>
      {testResult && (
        <div style={{ fontSize: 11, color: testResult.ok ? 'var(--success)' : 'var(--danger)', marginTop: 4, whiteSpace: 'normal', maxWidth: 200 }}>
          {testResult.ok ? '✓ 连接成功：' : '✗ '}{testResult.msg}
        </div>
      )}
      {modelsResult && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, whiteSpace: 'normal', maxWidth: 220 }}>
          可用模型：{modelsResult.slice(0, 15).join('、')}{modelsResult.length > 15 ? `…共 ${modelsResult.length} 个` : ''}
        </div>
      )}
    </td>
  );
}

/** API Key 列 props（S3776 拆分：掩码展示与明文切换独立成单元格组件） */
interface ToolKeyCellProps {
  readonly tool: AITool;
  readonly revealed: string | undefined;
  readonly onToggleReveal: (t: AITool) => void;
}

/** API Key 列（S3776 拆分）：默认仅展示掩码，点击按钮按需拉取明文 */
function ToolKeyCell({ tool, revealed, onToggleReveal }: ToolKeyCellProps) {
  return (
    <td style={cellStyle}>
      <div style={revealed ? { fontFamily: 'monospace', wordBreak: 'break-all', maxWidth: 200 } : undefined}>
        {revealed ?? (tool.apiKeyMasked ?? '未配置')}
      </div>
      {tool.hasApiKey && (
        <button
          onClick={() => onToggleReveal(tool)}
          title={revealed ? '隐藏 — 隐藏 API Key 明文' : '查看原文 — 查看 API Key 明文'}
          aria-label={revealed ? '隐藏：隐藏 API Key 明文' : '查看原文：查看 API Key 明文'}
          style={{ fontSize: 11, marginTop: 2, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
        >
          {revealed
            ? <EyeOff size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
            : <Eye size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
        </button>
      )}
    </td>
  );
}

/** 表格行 props：各状态按工具 id 记录在父组件，行组件只做展示与回调上报；readonly 声明防止子组件意外改写父状态（S6759 同规范） */
interface ToolRowProps {
  readonly tool: AITool;
  readonly testing: Record<string, boolean>;
  readonly fetchingModels: Record<string, boolean>;
  readonly testResult: Record<string, { ok: boolean; msg: string }>;
  readonly modelsResult: Record<string, string[]>;
  readonly revealed: Record<string, string>;
  readonly remarkExpanded: Record<string, boolean>;
  readonly flushed: boolean;
  readonly onTogglePin: (t: AITool) => void;
  readonly onToggleReveal: (t: AITool) => void;
  readonly onToggleEnabled: (t: AITool) => void;
  readonly onToggleRemark: (id: string) => void;
  readonly onOpenEdit: (t: AITool) => void;
  readonly onTest: (t: AITool) => void;
  readonly onFetchRowModels: (t: AITool) => void;
  readonly onSetDefault: (t: AITool, kind: 'organize' | 'develop') => void;
  readonly onRemove: (t: AITool) => void;
  /** T00446：拖拽排序回调 */
  readonly onDragStart?: (id: string) => void;
  readonly onDragOver?: (id: string) => void;
  readonly onDrop?: (id: string) => void;
  readonly onDragEnd?: () => void;
  readonly dragId?: string;
  readonly overId?: string;
}

/** 表格行（S3776 拆分）：单行渲染逻辑从页面组件抽出，API Key 列与操作列再下沉到单元格组件 */
function ToolRow(props: ToolRowProps) {
  const { tool } = props;
  const flushClass = props.flushed ? ' flush' : '';
  let dragClass = '';
  if (props.dragId === tool.id) dragClass = ' tool-dragging';
  else if (props.overId === tool.id) dragClass = ' tool-over';
  return (
    <tr
      className={`arena-row${flushClass}${dragClass}`}
      draggable
      onDragStart={() => props.onDragStart?.(tool.id)}
      onDragEnd={() => { props.onDragEnd?.(); }}
      onDragOver={(e) => { e.preventDefault(); props.onDragOver?.(tool.id); }}
      onDrop={() => props.onDrop?.(tool.id)}
    >
      <td style={cellStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <PinToggle pinned={tool.pinned} onToggle={() => props.onTogglePin(tool)} />
          <span style={{ fontWeight: 600 }}>{tool.name}</span>
          {/* 备注展开/收起箭头：与提示词页一致用 lucide 图标，蓝色 13px；有备注才显示 */}
          {tool.remark && (
            <button
              onClick={() => props.onToggleRemark(tool.id)}
              title={props.remarkExpanded[tool.id] ? '收起备注 — 收起备注内容' : '展开备注 — 展开查看备注内容'}
              aria-label={props.remarkExpanded[tool.id] ? '收起：收起备注内容' : '展开：展开查看备注内容'}
              style={{ color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px', cursor: 'pointer' }}
            >
              {props.remarkExpanded[tool.id] ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
          )}
        </div>
        {/* 备注默认收缩，仅展开时显示完整内容 */}
        {tool.remark && props.remarkExpanded[tool.id] && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{tool.remark}</div>}
      </td>
      <td style={cellStyle}>{tool.type}</td>
      <td style={cellStyle}>{PURPOSE_LABEL[tool.purpose] ?? tool.purpose}</td>
      <td style={{ ...cellStyle, wordBreak: 'break-all', maxWidth: 220 }}>{tool.endpoint}</td>
      <td style={cellStyle}>
        <div>{tool.model ?? '-'}</div>
        {tool.model_notes && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{tool.model_notes}</div>}
      </td>
      {/* 默认仅展示掩码；点击「查看原文」按需拉取明文，再点隐藏即从内存移除（FR3.5） */}
      <ToolKeyCell tool={tool} revealed={props.revealed[tool.id]} onToggleReveal={props.onToggleReveal} />
      <td style={cellStyle}>
        <button
          onClick={() => props.onToggleEnabled(tool)}
          title={tool.enabled ? '停用 — 停用该配置文件' : '启用 — 启用该配置文件'}
          aria-label={tool.enabled ? '停用：停用该配置文件' : '启用：启用该配置文件'}
          style={{ fontSize: 12, color: tool.enabled ? 'var(--success)' : 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', padding: '2px 4px' }}
        >
          <Power size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
        </button>
      </td>
      <td style={cellStyle}>
        {tool.isDefaultOrganize && <span style={{ fontSize: 11, color: 'var(--accent)', marginRight: 4 }}>整理✓</span>}
        {tool.isDefaultDevelop && <span style={{ fontSize: 11, color: 'var(--success)' }}>开发✓</span>}
        {!tool.isDefaultOrganize && !tool.isDefaultDevelop && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>-</span>}
      </td>
      <ToolActionsCell
        tool={tool}
        testing={props.testing[tool.id] ?? false}
        fetchingModels={props.fetchingModels[tool.id] ?? false}
        testResult={props.testResult[tool.id]}
        modelsResult={props.modelsResult[tool.id]}
        onOpenEdit={props.onOpenEdit}
        onTest={props.onTest}
        onFetchRowModels={props.onFetchRowModels}
        onSetDefault={props.onSetDefault}
        onRemove={props.onRemove}
      />
    </tr>
  );
}

/** 表单弹窗 props：字段变更收敛为 patch 合并，减少回调数量；readonly 保证弹窗不直接改父状态 */
interface ToolFormDialogProps {
  readonly form: ToolForm;
  readonly types: readonly string[];
  readonly editingId: string;
  readonly saving: boolean;
  readonly formTesting: boolean;
  readonly formFetching: boolean;
  readonly formTest: { msg: string; ok: boolean } | null;
  readonly formModels: readonly string[];
  readonly onFieldChange: (patch: Partial<ToolForm>) => void;
  readonly onClose: () => void;
  readonly onSave: () => void;
  readonly onTestDraft: () => void;
  readonly onFetchModels: () => void;
}

/** 新增/编辑弹窗（S3776/S6848/S6853 拆分修复）：label 通过 htmlFor 显式关联控件 */
function ToolFormDialog(props: ToolFormDialogProps) {
  const { form } = props;
  const panelRef = useRef<HTMLDivElement>(null);

  // 遮罩点击关闭改为文档级事件委托：点击目标在面板外即视为点遮罩（与原 e.target === e.currentTarget 等价），
  // 这样全屏遮罩 div 本身无需挂鼠标事件，避免非交互元素挂交互 handler（S6848）
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) props.onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [props.onClose]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div ref={panelRef} style={{ background: 'var(--card-bg)', borderRadius: 8, padding: 20, width: 520, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,0.18)' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>{props.editingId ? '编辑配置记录' : '新增配置记录'}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label htmlFor="aitool-name" style={labelStyle}>名称（厂商/工具名）*</label>
            <input id="aitool-name" style={fieldStyle} value={form.name} onChange={(e) => props.onFieldChange({ name: e.target.value })} placeholder="例如 DeepSeek 官方" />
          </div>
          <div>
            <label htmlFor="aitool-type" style={labelStyle}>厂商类型 *</label>
            <select id="aitool-type" style={fieldStyle} value={form.type} onChange={(e) => props.onFieldChange({ type: e.target.value })}>
              {props.types.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="aitool-endpoint" style={labelStyle}>Endpoint / Base URL *</label>
            <input id="aitool-endpoint" style={fieldStyle} value={form.endpoint} onChange={(e) => props.onFieldChange({ endpoint: e.target.value })} placeholder="例如 https://api.deepseek.com/v1" />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="aitool-console-url" style={labelStyle}>厂商控制台 URL（可选）</label>
            <input id="aitool-console-url" style={fieldStyle} value={form.consoleUrl} onChange={(e) => props.onFieldChange({ consoleUrl: e.target.value })} placeholder="例如 https://platform.deepseek.com" />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>填写后，列表「控制台」按钮可直接打开该厂商官方控制台页面</div>
          </div>
          {/* 草稿连接测试：未保存即可验证 Endpoint + Key 连通性 */}
          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={props.onTestDraft} disabled={props.formTesting} title={props.formTesting ? '测试中…' : '测试连接 — 用当前表单值验证连通性'} aria-label={props.formTesting ? '测试中：验证连通性' : '测试连接：用当前表单值验证连通性'} style={{ fontSize: 12, padding: '4px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
              {props.formTesting ? <Loader2 size={13} className="aispin" /> : <PlugZap size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
            </button>
            {props.formTest && <span style={{ fontSize: 12, color: props.formTest.ok ? 'var(--success)' : 'var(--danger)' }}>{props.formTest.msg}</span>}
          </div>
          <div>
            <label style={labelStyle}>API Key{props.editingId ? '（留空保留原值）' : '（可留空）'}</label>
            <input
              style={fieldStyle}
              type="password"
              autoComplete="new-password"
              value={form.apiKey}
              onChange={(e) => props.onFieldChange({ apiKey: e.target.value })}
              placeholder={props.editingId ? '留空 = 保留原密钥' : 'sk-…'}
            />
          </div>
          <div>
            <label htmlFor="aitool-model" style={labelStyle}>默认模型</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input id="aitool-model" list="aitool-model-options" style={fieldStyle} value={form.model} onChange={(e) => props.onFieldChange({ model: e.target.value })} placeholder="例如 deepseek-chat" />
              <button onClick={props.onFetchModels} disabled={props.formFetching} title={props.formFetching ? '获取中…' : '获取模型 — 拉取服务商可用模型清单'} aria-label={props.formFetching ? '获取中：拉取可用模型清单' : '获取模型：拉取服务商可用模型清单'} style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center' }}>
                {props.formFetching ? <Loader2 size={13} className="aispin" /> : <Cpu size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
              </button>
            </div>
            <datalist id="aitool-model-options">
              {props.formModels.map((m) => <option key={m} value={m} />)}
            </datalist>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="aitool-model-notes" style={labelStyle}>模型配置说明</label>
            <input id="aitool-model-notes" style={fieldStyle} value={form.modelNotes} onChange={(e) => props.onFieldChange({ modelNotes: e.target.value })} placeholder="例如 上下文 64K，建议 temperature 0.2" />
          </div>
          <div>
            <label htmlFor="aitool-purpose" style={labelStyle}>用途</label>
            <select id="aitool-purpose" style={fieldStyle} value={form.purpose} onChange={(e) => props.onFieldChange({ purpose: e.target.value as ToolForm['purpose'] })}>
              <option value="organize">整理</option>
              <option value="develop">开发</option>
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 8 }}>
            {/* 「启用」文本包一层 span：label 内 input 与裸文本之间的换行空白属于歧义间距（S6772），间距交给 flex gap 控制 */}
            <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.enabled} onChange={(e) => props.onFieldChange({ enabled: e.target.checked })} />
              <span>启用</span>
            </label>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="aitool-remark" style={labelStyle}>备注</label>
            <textarea id="aitool-remark" style={{ ...fieldStyle, fontFamily: 'inherit' }} rows={2} value={form.remark} onChange={(e) => props.onFieldChange({ remark: e.target.value })} placeholder="内部备注，不会发送给 AI 厂商" />
          </div>
        </div>
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={props.onClose} title="取消 — 关闭弹窗，放弃未保存的修改" aria-label="取消：关闭弹窗，放弃未保存的修改" style={{ padding: '6px 14px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
            <X size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
          </button>
          <button
            onClick={props.onSave}
            disabled={props.saving}
            title="保存 — 保存该配置记录"
            aria-label="保存：保存该配置记录"
            style={{ padding: '6px 14px', background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
          >
            <Save size={13} style={{ display: 'inline-block', verticalAlign: '-2px' }} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** 模型管理：集中记录各 AI 厂商的 API Key、模型配置等连接信息（复用 ai_tools 体系） */
export function AIToolsPage() {
  // T00446：模型拖拽排序状态
  const [toolDragId, setToolDragId] = useState('');
  const [toolOverId, setToolOverId] = useState('');
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

  // 表单字段统一以 patch 合并：弹窗组件只上报变更，不持有 setForm，保持状态单向流动
  const patchForm = (patch: Partial<ToolForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

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

  return (
    <section>
      {/* 按钮加载旋转动画：供连接测试 / 模型获取等按钮 loading 图标使用 */}
      <style>{`@keyframes aispin{to{transform:rotate(360deg)}}.aispin{animation:aispin .8s linear infinite;display:inline-block}
        .arena-row { transition: transform .12s ease; }
        .arena-row:active { transform: scale(.985); }
        .arena-row:hover td { background: var(--surface-2); }
        .abtn { opacity: 0; visibility: hidden; transition: opacity .15s ease, visibility 0s linear .15s; }
        .arena-row:hover .abtn, .arena-row:focus-within .abtn { opacity: 1; visibility: visible; transition: opacity .15s ease, visibility 0s; }
        @keyframes rowflush { 0% { background: var(--accent-soft); } 100% { background: transparent; } }
        .arena-row.flush td { animation: rowflush 1.4s ease; }
        .tool-dragging { opacity: .5; transform: scale(1.01); box-shadow: 0 6px 18px rgba(0,0,0,.22); background: var(--surface-2); }
        .tool-over { box-shadow: inset 0 3px 0 var(--accent); background: var(--accent-soft, rgba(9,105,218,.08)); }`}</style>
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
            <ToolRow
              // key 携带 flashAt 时间戳：保存高亮时强制 React 重建该行，重放 flush 动画
              key={flashAt[t.id] ? `f${flashAt[t.id]}-${t.id}` : t.id}
              tool={t}
              dragId={toolDragId}
              overId={toolOverId}
              onDragStart={setToolDragId}
              onDragOver={setToolOverId}
              onDragEnd={() => { setToolDragId(''); setToolOverId(''); }}
              onDrop={(targetId) => {
                if (!toolDragId || toolDragId === targetId) { setToolDragId(''); setToolOverId(''); return; }
                const ids = filtered.map((x) => x.id);
                const from = ids.indexOf(toolDragId);
                const to = ids.indexOf(targetId);
                if (from < 0 || to < 0) return;
                ids.splice(to, 0, ids.splice(from, 1)[0]);
                void api.post('/aitools/reorder', { orderedIds: ids }).then(() => { void load(); });
                setToolDragId(''); setToolOverId('');
              }}
              testing={testing}
              fetchingModels={fetchingModels}
              testResult={testResult}
              modelsResult={modelsResult}
              revealed={revealed}
              remarkExpanded={remarkExpanded}
              flushed={Boolean(flashAt[t.id])}
              onTogglePin={(tool) => void togglePin(tool)}
              onToggleReveal={(tool) => void toggleReveal(tool)}
              onToggleEnabled={(tool) => void toggleEnabled(tool)}
              onToggleRemark={(id) => setRemarkExpanded((prev) => ({ ...prev, [id]: !prev[id] }))}
              onOpenEdit={openEdit}
              onTest={(tool) => void test(tool)}
              onFetchRowModels={(tool) => void fetchRowModels(tool)}
              onSetDefault={(tool, kind) => void setDefault(tool, kind)}
              onRemove={(tool) => void remove(tool)}
            />
          ))}
          {filtered.length === 0 && (
            <tr><td colSpan={9} style={{ padding: 16, color: 'var(--text-muted)', textAlign: 'center' }}>{tools.length === 0 ? '暂无配置记录，点击「+ 新增配置」接入你的 AI 厂商' : '没有符合筛选条件的配置记录'}</td></tr>
          )}
        </tbody>
      </table>

      {/* 新增/编辑弹窗：渲染与遮罩关闭逻辑封装在 ToolFormDialog 内 */}
      {form && (
        <ToolFormDialog
          form={form}
          types={types}
          editingId={editingId}
          saving={saving}
          formTesting={formTesting}
          formFetching={formFetching}
          formTest={formTest}
          formModels={formModels}
          onFieldChange={patchForm}
          onClose={closeForm}
          onSave={() => void saveForm()}
          onTestDraft={() => void testDraftFromForm()}
          onFetchModels={() => void fetchFormModels()}
        />
      )}

      {/* T00448 / PRD AI-1：AI 用量统计面板（近 N 天概览+按工具分组+最近明细） */}
      <UsagePanel />
    </section>
  );
}
