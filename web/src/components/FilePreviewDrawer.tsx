/**
 * T02389：任务正文文件超链接的右侧预览抽屉。
 * 复用 SlideOver 原语（遮罩/ESC/焦点归还/动画），一次只挂一个实例；
 * 路径由点击处传入，打开即请求 /files/preview，切换链接只替换 path 并重新拉取。
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, FileQuestion, Loader2 } from 'lucide-react';
import { api } from '../api/client';
import { Markdown } from '../ui/Markdown';
import { SlideOver } from './SlideOver';

type Source = 'workspace' | 'external';

export type FilePreviewData =
  | { kind: 'text'; path: string; name: string; source: Source; size: number; mtime: string; content: string; truncated: boolean }
  | { kind: 'markdown'; path: string; name: string; source: Source; size: number; mtime: string; content: string; truncated: boolean }
  | { kind: 'image'; path: string; name: string; source: Source; size: number; mtime: string; dataUrl: string; mime: string }
  | { kind: 'unsupported'; path: string; name: string; source: Source; size: number; mtime: string; reason: string };

function baseName(path: string): string {
  const segs = path.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未知时间';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const metaStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  wordBreak: 'break-all',
  marginBottom: 10,
  paddingBottom: 8,
  borderBottom: '1px solid var(--border)',
};

function renderBody(data: FilePreviewData) {
  if (data.kind === 'markdown') {
    return (
      <>
        {data.truncated && <TruncatedHint />}
        <Markdown content={data.content} style={{ fontSize: 13 }} />
      </>
    );
  }
  if (data.kind === 'text') {
    return (
      <>
        {data.truncated && <TruncatedHint />}
        <pre style={{
          margin: 0,
          padding: 10,
          background: 'var(--code-bg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          fontFamily: 'Consolas, Menlo, monospace',
          fontSize: 12,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {data.content}
        </pre>
      </>
    );
  }
  if (data.kind === 'image') {
    return (
      <img
        src={data.dataUrl}
        alt={data.name}
        style={{ maxWidth: '100%', height: 'auto', borderRadius: 6, border: '1px solid var(--border)', display: 'block' }}
      />
    );
  }
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '14px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
      <FileQuestion size={18} style={{ flex: '0 0 auto', color: 'var(--text-muted)', marginTop: 1 }} />
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>暂不支持预览</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>{data.reason}</div>
      </div>
    </div>
  );
}

function TruncatedHint() {
  return (
    <div style={{ fontSize: 11, color: 'var(--warn)', marginBottom: 8 }}>
      文件较大，仅展示前 256KB 内容。
    </div>
  );
}

export function FilePreviewDrawer({ open, projectId, path, onClose }: {
  readonly open: boolean;
  readonly projectId: string;
  readonly path: string;
  readonly onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<FilePreviewData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !path) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError('');
    api.get<FilePreviewData>(
      `/files/preview?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
      ctrl.signal,
    )
      .then((next) => { setData(next); })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setData(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [open, projectId, path]);

  const titlePath = data?.path ?? path;
  const titleName = data?.name ?? baseName(path);

  return (
    <SlideOver open={open} title={`文件预览 — ${titleName || '文件'}`} onClose={onClose} width={760} passthrough>
      <div style={metaStyle}>
        <span>{data?.source === 'external' ? '外部文件' : data ? '工作空间内' : '文件'}</span>
        {data && <span>· {fmtSize(data.size)}</span>}
        {data && <span>· 修改于 {fmtTime(data.mtime)}</span>}
        <span>· {titlePath || '未指定路径'}</span>
      </div>
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
          <Loader2 size={14} className="aispin" /> 正在读取文件…
        </div>
      )}
      {!loading && error && (
        <div role="alert" style={{ border: '1px solid var(--danger)', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--danger)', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            <AlertTriangle size={15} /> 无法打开文件
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.6, wordBreak: 'break-all' }}>{error}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginTop: 8 }}>
            提示：工作空间外文件请使用本机绝对路径；网络共享、设备路径与可执行/二进制类型不支持预览。
          </div>
        </div>
      )}
      {!loading && !error && data && renderBody(data)}
      {!loading && !error && !data && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>点击任务描述或处理结果中的文件链接以预览。</div>
      )}
    </SlideOver>
  );
}
