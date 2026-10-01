/**
 * 移动端外壳：底部 5 Tab 导航（任务 / 随手记 / 队列 / 提示词 / 更多，§2.2）。
 * - 中央「随手记」突出，一键新建；首页亦含悬浮「+」入口。
 * - 隧道鉴权：首访/令牌失效时显示访问口令输入（§4.3）。
 * - 顶部常驻连接状态与「待同步」草稿角标；恢复联网自动补提离线草稿（§3.4）。
 */
import { useEffect, useRef, useState } from 'react';
import { api, setAccessToken, type Task } from '../api/client';
import { ListTodo, Plus, ListOrdered, ScrollText, MoreHorizontal, KeyRound, Wifi, WifiOff } from 'lucide-react';
import { MobileHome } from './MobileHome';
import { QuickNote } from './QuickNote';
import { MobileQueue } from './MobileQueue';
import { MobilePrompts } from './MobilePrompts';
import { MobileMore } from './MobileMore';
import { flushDrafts, loadDrafts, useOnlineStatus } from './offline';

type Tab = 'home' | 'note' | 'queue' | 'prompts' | 'more';

const TABS: { key: Tab; label: string; icon: typeof ListTodo; center?: boolean }[] = [
  { key: 'home', label: '任务', icon: ListTodo },
  { key: 'note', label: '随手记', icon: Plus, center: true },
  { key: 'queue', label: '队列', icon: ListOrdered },
  { key: 'prompts', label: '提示词', icon: ScrollText },
  { key: 'more', label: '更多', icon: MoreHorizontal },
];

export function MobileShell() {
  const [tab, setTab] = useState<Tab>('home');
  const [needToken, setNeedToken] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [toast, setToast] = useState('');
  const [draftCount, setDraftCount] = useState(() => loadDrafts().length);
  const online = useOnlineStatus();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  };

  // 鉴权探测：无令牌配置则直接放行；已配置则需携带令牌
  useEffect(() => {
    api.get('/health').then(() => setNeedToken(false)).catch((e) => {
      if (e instanceof Error && e.message === 'unauthorized') setNeedToken(true);
    });
  }, []);

  // T01441：PWA 添加到主屏一次性引导——仅隧道/公网（https）访问且未看过时弹出
  const [pwaGuide, setPwaGuide] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem('mtask.pwaGuide.seen')) return;
      if (location.protocol !== 'https:') return; // 本地 http 访问不打扰
      const t = setTimeout(() => setPwaGuide(true), 1200);
      return () => clearTimeout(t);
    } catch { /* 忽略 */ }
  }, []);

  // 恢复联网后自动补提离线草稿
  useEffect(() => {
    if (!online) return;
    flushDrafts().then((n) => {
      if (n > 0) { notify(`已补提 ${n} 条离线草稿`); setDraftCount(loadDrafts().length); }
    }).catch(() => { /* 忽略 */ });
  }, [online]); // eslint-disable-line react-hooks/exhaustive-deps

  const openDesktop = () => {
    try { localStorage.setItem('mtask.uiMode', 'desktop'); } catch { /* 忽略 */ }
    location.href = location.pathname + '?m=0';
  };

  async function submitToken() {
    if (!tokenInput.trim()) return;
    setAccessToken(tokenInput.trim());
    try {
      await api.get('/health');
      setNeedToken(false);
    } catch (e) {
      setAccessToken('');
      notify(e instanceof Error ? e.message : '令牌校验失败');
    }
  }

  if (needToken) {
    return (
      <div style={tokenScreen}>
        <div style={tokenCard}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 16, fontWeight: 700, marginBottom: 6 }}><KeyRound size={18} /> 访问口令</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
            通过公网访问需输入访问口令（在桌面端「设置 → 内网穿透 → 访问令牌」查看并复制）。
          </div>
          <input
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitToken(); }}
            placeholder="粘贴访问口令"
            style={{ width: '100%', padding: 12, border: '1px solid var(--border-strong)', borderRadius: 8, fontSize: 15, boxSizing: 'border-box' }}
          />
          <button onClick={() => void submitToken()} style={tokenBtn}>进入</button>
        </div>
      </div>
    );
  }

  return (
    <div style={shell}>
      {/* T01445：Zen 极简阅读全局样式——data-zen=1 时隐藏徽标/计数、放大正文字号 */}
      <style>{"[data-zen='1'] .zen-hide { display: none !important; } [data-zen='1'] li span[style*='fontSize: 15'], [data-zen='1'] li span[style*='fontSize: 15px'] { font-size: 17px !important; } [data-zen='1'] div[style*='fontSize: 12'] { font-size: 14px !important; }"}</style>
      {/* T01441：PWA 添加到主屏一次性引导卡（fixed 覆盖层） */}
      {pwaGuide && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div role="dialog" aria-modal="true" aria-label="添加到主屏幕" style={{ background: 'var(--card-bg)', color: 'var(--text)', borderRadius: 14, padding: 16, maxWidth: 340, width: '100%' }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>📱 添加到主屏幕</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              把 MTask 装到手机桌面，像 App 一样全屏使用：<br />
              <b>iPhone：</b>Safari 底部「分享」→「添加到主屏幕」<br />
              <b>Android：</b>浏览器菜单 →「添加到主屏幕 / 安装应用」
            </div>
            <button
              onClick={() => { try { localStorage.setItem('mtask.pwaGuide.seen', '1'); } catch { /* 忽略 */ } setPwaGuide(false); }}
              style={{ marginTop: 12, width: '100%', padding: '10px 0', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 14, cursor: 'pointer' }}
            >
              我知道了
            </button>
          </div>
        </div>
      )}
      {/* 顶部常驻：连接状态 + 待同步草稿角标 */}
      <div style={topbar}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: online ? 'var(--success)' : 'var(--danger)' }}>
          {online ? <><Wifi size={13} /> 在线</> : <><WifiOff size={13} /> 离线</>}
        </span>
        {draftCount > 0 && (
          <span style={{ fontSize: 12, color: 'var(--warn)', background: 'var(--accent-soft)', borderRadius: 10, padding: '2px 8px' }}>
            待同步 {draftCount}
          </span>
        )}
      </div>
      {/* T01425：离线横幅强化——醒目条替代仅顶栏小字，说明降级行为 */}
      {!online && (
        <div role="status" style={{ margin: '0 12px', padding: '8px 12px', borderRadius: 10, background: 'var(--danger)', color: '#fff', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
          <WifiOff size={14} style={{ flexShrink: 0 }} />
          <span>离线中——正在浏览缓存数据；新建内容将离线暂存，联网后自动补提</span>
        </div>
      )}

      {/* 页面区 */}
      <div style={content}>
        {tab === 'home' && <MobileHome onQuickNote={() => setTab('note')} notify={notify} />}
        {tab === 'note' && (
          <QuickNote
            onDone={(t: Task | null) => { setTab('home'); if (t) setDraftCount(loadDrafts().length); }}
            onCancel={() => setTab('home')}
            notify={notify}
          />
        )}
        {tab === 'queue' && <MobileQueue notify={notify} openDesktop={openDesktop} />}
        {tab === 'prompts' && <MobilePrompts notify={notify} />}
        {tab === 'more' && <MobileMore notify={notify} openDesktop={openDesktop} />}
      </div>

      {/* 底部导航 */}
      <nav style={nav}>
        {TABS.map((t) => {
          const Icon = t.icon;
          if (t.center) {
            return (
              <button key={t.key} onClick={() => setTab('note')} title="随手记 — 快速新建任务" aria-label="随手记" style={centerBtn}>
                <Icon size={24} />
              </button>
            );
          }
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} title={t.label} aria-label={t.label} style={navBtn(active)}>
              <Icon size={20} />
              <span style={{ fontSize: 11, marginTop: 2 }}>{t.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Toast */}
      {toast && <div style={toastBox}>{toast}</div>}
    </div>
  );
}

// ---------- 样式 ----------
const shell: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100vh', maxWidth: 480, margin: '0 auto', background: 'var(--app-bg)', color: 'var(--text)', position: 'relative' };
const topbar: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px', background: 'var(--card-bg)', borderBottom: '1px solid var(--border)', fontSize: 12 };
const content: React.CSSProperties = { flex: 1, overflow: 'hidden', position: 'relative' };
const nav: React.CSSProperties = { display: 'flex', alignItems: 'stretch', justifyContent: 'space-around', background: 'var(--card-bg)', borderTop: '1px solid var(--border)', paddingBottom: 'env(safe-area-inset-bottom, 0)' };
const navBtn = (active: boolean): React.CSSProperties => ({
  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
  padding: '8px 0', background: 'transparent', border: 'none', cursor: 'pointer',
  color: active ? 'var(--accent)' : 'var(--text-secondary)', fontSize: 11,
});
const centerBtn: React.CSSProperties = {
  flex: '0 0 auto', transform: 'translateY(-14px)', width: 54, height: 54, borderRadius: '50%',
  background: 'var(--accent)', color: 'var(--accent-text)', border: '3px solid var(--card-bg)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(0,0,0,.2)',
};
const toastBox: React.CSSProperties = { position: 'absolute', left: '50%', bottom: 80, transform: 'translateX(-50%)', background: 'rgba(0,0,0,.8)', color: '#fff', fontSize: 13, padding: '8px 16px', borderRadius: 20, zIndex: 50, maxWidth: '80%', textAlign: 'center' };
const tokenScreen: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 20, background: 'var(--app-bg)' };
const tokenCard: React.CSSProperties = { width: '100%', maxWidth: 360, padding: 20, background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,.12)' };
const tokenBtn: React.CSSProperties = { marginTop: 14, width: '100%', padding: 12, borderRadius: 8, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: 600 };
