/**
 * HTML 版演示稿的面板内预览（2026-11-06）。
 *
 * 为什么用 blob URL 而不是直接把 `<iframe src="/api/report/ai-preview?token=…">`：
 * 桌面形态走 `api://mtask` 代理、裸浏览器走 `http://127.0.0.1:PORT`，两条 base 不同；
 * 走 `api.getBinary` 统一取字节再 `createObjectURL`，两种形态同一份代码，
 * 也不会把令牌暴露在 iframe 地址栏里。
 *
 * 令牌是**只读**的（服务端 ai-preview 不删文件）：预览之后用户仍能点「下载 .html」。
 */
import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { api } from '../api/client';

export interface DeckHtmlPreviewProps {
  readonly token: string;
  readonly fileName: string;
  readonly onClose: () => void;
  /** 下载成功后回调（面板据此统一 flash 提示）；缺省由本组件自行静默 */
  readonly onDownloaded?: (filename: string) => void;
}

export function DeckHtmlPreview({ token, fileName, onClose, onDownloaded }: DeckHtmlPreviewProps) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let revoked = '';
    let cancelled = false;
    setError('');
    void api.getBinary(`/report/ai-preview?token=${encodeURIComponent(token)}`)
      .then((buf) => {
        if (cancelled) return;
        const blob = new Blob([buf], { type: 'text/html;charset=utf-8' });
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [token]);

  // Esc 关闭：预览是全屏遮罩，没有显式关闭键会让人以为卡住了
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const download = useCallback(async () => {
    setDownloading(true);
    try {
      const { blob, filename } = await api.download('/report/ai-download', { token, filename: fileName });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(href);
      onDownloaded?.(filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }, [token, fileName, onDownloaded]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(15,18,24,.72)', display: 'flex', flexDirection: 'column' }}
      role="dialog" aria-modal="true" aria-label="HTML 版演示稿预览">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', color: '#fff' }}>
        <span style={{ fontSize: 'var(--fs-s)', fontWeight: 600 }}>HTML 版预览</span>
        <span style={{ fontSize: 'var(--fs-xs)', opacity: .75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
          <button onClick={() => void download()} disabled={downloading} className="tbtn-anim"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', padding: '4px 10px', borderRadius: 6,
              border: '1px solid rgba(255,255,255,.35)', background: 'rgba(255,255,255,.12)', color: '#fff', cursor: 'pointer' }}>
            {downloading ? <Loader2 size={12} className="aispin" /> : <Download size={12} />} 下载 .html
          </button>
          <button onClick={onClose} aria-label="关闭预览" className="tbtn-anim"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 26, borderRadius: 6,
              border: '1px solid rgba(255,255,255,.35)', background: 'rgba(255,255,255,.12)', color: '#fff', cursor: 'pointer' }}>
            <X size={14} />
          </button>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, margin: '0 14px 14px', borderRadius: 8, overflow: 'hidden', background: '#E8E8EC', position: 'relative' }}>
        {error && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', fontSize: 'var(--fs-s)', color: 'var(--danger)' }}>
            预览加载失败：{error}
          </div>
        )}
        {!error && !url && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 'var(--fs-s)', color: 'var(--text-muted)' }}>
            <Loader2 size={16} className="aispin" /> 正在载入演示稿…
          </div>
        )}
        {url && <iframe title="HTML 版演示稿" src={url} sandbox="allow-scripts"
          style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} />}
      </div>
    </div>
  );
}
