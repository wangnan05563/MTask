/**
 * Webhook 面板（T03196 / PRD PM-401）：项目级出站订阅的配置、停用/启用、测试投递与投递日志。
 *
 * 口径单源在 `server/src/services/WebhookService.ts`：本面板只做录入与展示，不做签名/重试计算；
 * 密钥只回掩码（明文仅在录入时经过前端一次），投递日志不含响应正文（服务端已脱敏）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { RefreshCw, Send, Trash2, Webhook } from 'lucide-react';
import { api } from '../api/client';
import { askConfirm } from '../ui/dialogs';

interface HookView {
  id: string;
  projectId: string;
  url: string;
  events: string[];
  enabled: boolean;
  allowIntranet: boolean;
  secretMasked: string;
  createdAt: string;
  updatedAt: string;
  stats: { pending: number; success: number; failed: number };
}

interface DeliveryView {
  id: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
}

export const WEBHOOK_EVENT_LABEL: Record<string, string> = {
  'task.created': '任务创建',
  'task.updated': '任务更新',
  'task.done': '任务完成',
  'plan.created': '计划创建',
  'plan.updated': '计划更新',
  'plan.done': '计划完成',
  'overdue.detected': '逾期检出',
};

const CARD = { border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 } as const;
const BTN = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 9px', fontSize: 'var(--fs-s)', border: '1px solid var(--border-strong)', borderRadius: 6, background: 'transparent', color: 'var(--text)', cursor: 'pointer' } as const;
const FIELD = { width: '100%', padding: 5, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--card-bg)', color: 'var(--text)', fontSize: 'var(--fs-s)' } as const;

interface Draft {
  editingId: string;
  url: string;
  secret: string;
  allowIntranet: boolean;
  events: string[];
}

const emptyDraft = (): Draft => ({ editingId: '', url: '', secret: '', allowIntranet: false, events: ['task.done', 'plan.done'] });

const STATUS_LABEL: Record<string, string> = { pending: '待重试', success: '成功', failed: '失败' };

export function WebhookPanel({ projectId, onClose }: {
  readonly projectId: string;
  readonly onClose: () => void;
}): ReactElement {
  const [hooks, setHooks] = useState<HookView[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [formOpen, setFormOpen] = useState(false);
  const [deliveriesFor, setDeliveriesFor] = useState('');
  const [deliveries, setDeliveries] = useState<DeliveryView[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const msgTimer = useRef<number | null>(null);

  const flash = useCallback((m: string) => {
    setMsg(m);
    if (msgTimer.current) window.clearTimeout(msgTimer.current);
    msgTimer.current = window.setTimeout(() => { setMsg(''); msgTimer.current = null; }, 5000);
  }, []);
  useEffect(() => () => { if (msgTimer.current) window.clearTimeout(msgTimer.current); }, []);

  const load = useCallback(async () => {
    setHooks(await api.get<HookView[]>(`/webhooks?projectId=${encodeURIComponent(projectId)}`));
  }, [projectId]);

  useEffect(() => {
    void load().catch((e) => flash(e instanceof Error ? e.message : String(e)));
  }, [load, flash]);

  async function openDeliveries(id: string): Promise<void> {
    if (deliveriesFor === id) { setDeliveriesFor(''); setDeliveries([]); return; }
    setDeliveriesFor(id);
    try { setDeliveries(await api.get<DeliveryView[]>(`/webhooks/${id}/deliveries?limit=20`)); }
    catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  }

  async function submit(): Promise<void> {
    const url = draft.url.trim();
    if (!url) { flash('请填写 HTTPS 接收地址'); return; }
    if (!draft.editingId && draft.secret.length < 16) { flash('密钥至少 16 个字符（接收方用它验签）'); return; }
    if (draft.events.length === 0) { flash('至少订阅一个事件'); return; }
    setBusy(true);
    try {
      const body = { url, events: draft.events, allowIntranet: draft.allowIntranet, ...(draft.secret ? { secret: draft.secret } : {}) };
      if (draft.editingId) await api.patch(`/webhooks/${draft.editingId}`, body);
      else await api.post('/webhooks', { projectId, ...body });
      flash(draft.editingId ? '已保存' : '已创建，密钥只保存在本机（请确认接收方使用同一密钥验签）');
      setFormOpen(false);
      setDraft(emptyDraft());
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function toggle(h: HookView): Promise<void> {
    setBusy(true);
    try {
      await api.patch(`/webhooks/${h.id}`, { enabled: !h.enabled });
      flash(!h.enabled ? '已启用' : '已停用，待重试投递已取消');
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function test(h: HookView): Promise<void> {
    setBusy(true);
    try {
      const r = await api.post<{ deliveryId: string }>(`/webhooks/${h.id}/test`);
      flash(`测试事件已入队（${r.deliveryId.slice(0, 8)}…），结果见投递日志`);
      setDeliveriesFor(h.id);
      setDeliveries(await api.get<DeliveryView[]>(`/webhooks/${h.id}/deliveries?limit=20`));
      // 首投是入队后的异步动作：立刻读会拿到 pending 快照，稍等一拍再刷一次（失败时也会补上原因与下次重试时间）
      await new Promise((resolve) => setTimeout(resolve, 1200));
      setDeliveries(await api.get<DeliveryView[]>(`/webhooks/${h.id}/deliveries?limit=20`));
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function remove(h: HookView): Promise<void> {
    if (!await askConfirm(`删除后不再投递，历史日志一并清除。\n${h.url}`)) return;
    setBusy(true);
    try {
      await api.del(`/webhooks/${h.id}`);
      flash('已删除');
      if (deliveriesFor === h.id) { setDeliveriesFor(''); setDeliveries([]); }
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const setDraftEvent = (name: string): void => {
    setDraft((d) => ({ ...d, events: d.events.includes(name) ? d.events.filter((x) => x !== name) : [...d.events, name] }));
  };

  return (
    <div data-t03196="panel" style={{ marginTop: 12, border: '1px solid var(--accent)', borderRadius: 10, background: 'var(--card-bg)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--fs-m)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Webhook size={14} style={{ color: 'var(--accent)' }} /> Webhook 订阅
        </span>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          仅 HTTPS；首投 5 秒超时，失败按 1/5/30 分钟重试，日志保留 30 天（PM-401）
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => { setDraft(emptyDraft()); setFormOpen((v) => !v); }} className="tbtn-anim" style={BTN}
          title="新建订阅 — 接收地址、订阅事件、验签密钥" aria-label="新建 Webhook" data-t03196="new"><Webhook size={12} />新建</button>
        <button onClick={() => { void load().catch((e) => flash(String(e))); }} className="tbtn-anim" style={BTN}
          title="刷新订阅与统计" aria-label="刷新 Webhook"><RefreshCw size={12} /></button>
        <button onClick={onClose} style={{ ...BTN, color: 'var(--text-muted)' }} title="关闭 Webhook 面板" aria-label="关闭 Webhook 面板">×</button>
      </div>
      {msg && <div role="status" data-t03196="toast" style={{ marginTop: 8, fontSize: 'var(--fs-s)', color: 'var(--accent)' }}>{msg}</div>}

      {formOpen && (
        <div data-t03196="form" style={{ ...CARD, marginTop: 10, borderColor: 'var(--accent)' }}>
          <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://example.com/mtask-hook"
            aria-label="Webhook 接收地址" data-t03196="url" style={FIELD} />
          <input value={draft.secret} onChange={(e) => setDraft({ ...draft, secret: e.target.value })} type="password"
            placeholder={draft.editingId ? '留空则沿用原密钥' : '验签密钥（至少 16 字符，接收方需相同）'}
            aria-label="Webhook 密钥" data-t03196="secret" style={FIELD} />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 'var(--fs-s)' }}>
            {Object.entries(WEBHOOK_EVENT_LABEL).map(([name, label]) => (
              <label key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={draft.events.includes(name)} onChange={() => setDraftEvent(name)} data-t03196={`event-${name}`} />
                {label}
              </label>
            ))}
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-s)' }}>
            <input type="checkbox" checked={draft.allowIntranet} onChange={(e) => setDraft({ ...draft, allowIntranet: e.target.checked })} data-t03196="allow-intranet" />
            允许内网/回环地址（需显式确认）
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setFormOpen(false); setDraft(emptyDraft()); }} disabled={busy} style={BTN}>取消</button>
            <button onClick={() => void submit()} disabled={busy} className="tbtn-anim" data-t03196="submit"
              style={{ ...BTN, background: 'var(--accent)', color: 'var(--accent-text)', borderColor: 'var(--accent)' }}>
              {draft.editingId ? '保存' : '创建'}
            </button>
          </div>
        </div>
      )}

      {hooks.length === 0 && (
        <div data-t03196="empty" style={{ ...CARD, marginTop: 10, color: 'var(--text-muted)', fontSize: 'var(--fs-s)' }}>
          还没有 Webhook。点「新建」配置一个接收地址，任务/计划完成后会自动外发（带 HMAC 签名与事件 ID）。
        </div>
      )}

      {hooks.map((h) => (
        <div key={h.id} data-t03196="row" data-enabled={h.enabled ? '1' : '0'} style={{ ...CARD, marginTop: 10, opacity: h.enabled ? 1 : 0.65 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 'var(--fs-s)' }}>
            <strong style={{ wordBreak: 'break-all' }}>{h.url}</strong>
            <span style={{ color: h.enabled ? 'var(--success)' : 'var(--text-muted)' }}>{h.enabled ? '启用中' : '已停用'}</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => void test(h)} disabled={busy || !h.enabled} className="tbtn-anim" style={{ ...BTN, opacity: h.enabled ? 1 : 0.5 }}
              title="发送一条测试事件，走同一签名/超时链路" aria-label="测试投递" data-t03196="test"><Send size={12} />测试</button>
            <button onClick={() => void openDeliveries(h.id)} className="tbtn-anim" style={BTN}
              aria-label="查看投递日志" data-t03196="logs">{deliveriesFor === h.id ? '收起日志' : '日志'}</button>
            <button onClick={() => { setDraft({ editingId: h.id, url: h.url, secret: '', allowIntranet: h.allowIntranet, events: h.events }); setFormOpen(true); }}
              className="tbtn-anim" style={BTN} aria-label="编辑 Webhook" data-t03196="edit">编辑</button>
            <button onClick={() => void toggle(h)} disabled={busy} className="tbtn-anim" style={BTN}
              aria-label={h.enabled ? '停用 Webhook' : '启用 Webhook'} data-t03196="toggle">{h.enabled ? '停用' : '启用'}</button>
            <button onClick={() => void remove(h)} disabled={busy} className="tbtn-anim" style={{ ...BTN, color: 'var(--danger)' }}
              aria-label="删除 Webhook" data-t03196="delete"><Trash2 size={12} /></button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            <span>事件：{h.events.map((e) => WEBHOOK_EVENT_LABEL[e] ?? e).join('、')}</span>
            <span>·</span>
            <span data-t03196="secret-masked">密钥 {h.secretMasked}</span>
            <span>·</span>
            <span data-t03196="stats">成功 {h.stats.success} / 待重试 {h.stats.pending} / 失败 {h.stats.failed}</span>
            {h.allowIntranet && <span>· 已允许内网地址</span>}
          </div>
          {deliveriesFor === h.id && (
            <div data-t03196="deliveries" style={{ marginTop: 4 }}>
              {deliveries.length === 0 ? (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>还没有投递记录。</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-xs)' }}>
                  <thead>
                    <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                      <th style={{ padding: '3px 4px' }}>事件</th>
                      <th style={{ padding: '3px 4px' }}>状态</th>
                      <th style={{ padding: '3px 4px' }}>尝试</th>
                      <th style={{ padding: '3px 4px' }}>响应</th>
                      <th style={{ padding: '3px 4px' }}>说明</th>
                      <th style={{ padding: '3px 4px' }}>时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliveries.map((d) => (
                      <tr key={d.id} data-t03196="delivery-row">
                        <td style={{ padding: '3px 4px' }}>{WEBHOOK_EVENT_LABEL[d.eventType] ?? d.eventType}</td>
                        <td style={{ padding: '3px 4px', color: d.status === 'success' ? 'var(--success)' : d.status === 'failed' ? 'var(--danger)' : 'var(--text-muted)' }}>
                          {STATUS_LABEL[d.status] ?? d.status}
                        </td>
                        <td style={{ padding: '3px 4px' }}>{d.attempts}</td>
                        <td style={{ padding: '3px 4px' }}>{d.responseStatus ?? '—'}</td>
                        <td style={{ padding: '3px 4px', maxWidth: 260, wordBreak: 'break-all' }}>
                          {d.error ?? (d.nextAttemptAt ? `下次重试 ${new Date(d.nextAttemptAt).toLocaleTimeString()}` : '')}
                        </td>
                        <td style={{ padding: '3px 4px', whiteSpace: 'nowrap' }}>{new Date(d.createdAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
