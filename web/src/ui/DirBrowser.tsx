import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, Check, Folder, HardDrive, Loader2, Home, X } from 'lucide-react';
import { api } from '../api/client';

/**
 * T00771 二轮：服务端目录浏览器（Promise 风格模态）。
 *
 * 使用场景：纯浏览器 / 无桌面壳环境下，「打开本地文件夹」既调不到原生目录对话框、
 * 也拿不到 File.path（绝对路径），此前该入口实际不可用。这里经 `GET /api/fs/dirs`
 * 让服务端枚举本机目录（只列目录、不读文件），逐层进入后选定。
 *
 * 定位：Electron 壳内优先走原生对话框，本组件是其降级通道（也可用于远程/受限环境）。
 */

interface DirListing {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
  truncated: boolean;
  roots: string[];
  home: string;
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};

const panel: React.CSSProperties = {
  background: 'var(--card-bg)', color: 'var(--text)', borderRadius: 8, width: 'min(640px, 94vw)',
  maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 30px rgba(0,0,0,.18)',
};

function DirBrowser({ onDone }: { readonly onDone: (path: string | null) => void }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError('');
    try {
      const q = path ? `?path=${encodeURIComponent(path)}` : '';
      setListing(await api.get<DirListing>(`/fs/dirs${q}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 初始落在根列表（列盘符 + 主目录），用户不必先手输路径
  useEffect(() => { void load(''); }, [load]);

  // Escape 取消；遮罩点击关闭（与控制台其它弹窗同款：文档级委托 + 包含性判断）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDone(null); };
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) onDone(null);
    };
    globalThis.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDoc);
    return () => {
      globalThis.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [onDone]);

  const btn = 'tbtn-anim';
  return (
    <div style={overlay}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="选择工作空间文件夹" style={panel}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
          <Folder size={14} style={{ color: 'var(--accent)' }} /> 选择工作空间文件夹
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>（服务端目录浏览 — 无桌面壳环境的降级通道）</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => onDone(null)} title="关闭" aria-label="关闭目录浏览器" className={btn}
            style={{ display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
            <X size={14} />
          </button>
        </div>

        {/* 导航条：上级 / 当前位置 / 快捷跳转 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <button onClick={() => void load(listing?.parent ?? '')} disabled={!listing?.path} title="上级目录" aria-label="返回上级目录" className={btn}
            style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 6px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: listing?.path ? 'pointer' : 'default', opacity: listing?.path ? 1 : 0.45 }}>
            <ArrowUp size={12} />
          </button>
          <button onClick={() => void load('')} title="回到磁盘/主目录列表" aria-label="回到根列表" className={btn}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
            <HardDrive size={12} /> 根目录
          </button>
          <button onClick={() => void load(listing?.home ?? '')} title="跳到用户主目录" aria-label="跳到用户主目录" className={btn}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>
            <Home size={12} /> 主目录
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}
            title={listing?.path || '未选择（根列表）'}>
            当前位置：{listing?.path || '（根列表）'}
          </span>
        </div>

        {/* 目录列表 */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 }}>
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>
              <Loader2 size={13} className="aispin" /> 读取目录…
            </div>
          )}
          {!loading && error && <div style={{ fontSize: 12, color: 'var(--danger)', padding: 8 }}>{error}</div>}
          {!loading && !error && listing?.entries.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>该目录下没有子文件夹 — 可直接选择当前目录，或返回上级。</div>
          )}
          {!loading && !error && listing?.entries.map((d) => (
            <button key={d.path} onClick={() => void load(d.path)} title={d.path} className={btn}
              style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 6, padding: '5px 8px', fontSize: 12, border: 'none', borderRadius: 5, cursor: 'pointer', textAlign: 'left', background: 'transparent', color: 'var(--text)' }}>
              <Folder size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
            </button>
          ))}
          {!loading && listing?.truncated && (
            <div style={{ fontSize: 11, color: 'var(--warning, #c80)', padding: '4px 8px' }}>子目录过多，仅显示前 500 项 — 可先进入下一层再继续查找。</div>
          )}
        </div>

        {/* 底部：确认当前目录 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {listing?.path ? `将绑定：${listing.path}` : '请先进入一个文件夹'}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={() => onDone(null)} className={btn} title="取消 — 关闭目录浏览器"
            style={{ padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text)', fontSize: 12 }}>
            取消
          </button>
          <button onClick={() => listing?.path && onDone(listing.path)} disabled={!listing?.path} className={btn}
            title="选择此文件夹 — 绑定当前所在目录为工作空间" aria-label="选择当前文件夹"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 6, border: 'none', cursor: listing?.path ? 'pointer' : 'default', background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 12, opacity: listing?.path ? 1 : 0.5 }}>
            <Check size={12} /> 选择此文件夹
          </button>
        </div>
      </div>
    </div>
  );
}

/** 打开服务端目录浏览器；选定返回绝对路径，取消返回 null。
 *  挂载方式与 ui/dialogs.tsx 的弹窗一致（独立 root 挂到 body，关闭即卸载）。 */
export function pickServerDirectory(): Promise<string | null> {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const close = (path: string | null) => { root.unmount(); container.remove(); resolve(path); };
    root.render(<DirBrowser onDone={close} />);
  });
}
