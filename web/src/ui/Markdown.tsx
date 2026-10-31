import { useEffect, useMemo, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { Check, Code, Copy, Eye } from 'lucide-react';

/**
 * Markdown 渲染组件。
 * 采用 markdown-it 默认 html:false 关闭原始 HTML 直通，从源头规避 XSS 注入；
 * 仅将受信 Markdown 语法（标题/加粗/列表/代码/链接等）转换为白名单范围的安全标签。
 * 链接统一加 rel/noopener，避免新窗口打开时泄露 window.opener。
 */
const md = new MarkdownIt({ html: false, linkify: true });

// 外部链接新窗口打开并阻止 opener 泄露，兼顾可用性与安全。
// `#` 开头的应用内锚点（讲稿 `[file#Lx-Ly]` 跳转等）例外：新窗口打开等于把本页链接甩到空白页，
// 交给调用方的 onAnchorClick 处理（T02872 三区布局的锚点定位）。
const defaultRender =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href');
  if (typeof href !== 'string' || !href.startsWith('#')) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
  }
  return defaultRender(tokens, idx, options, env, self);
};

// 作用域样式：命名空间 .mdv，避免破坏应用现有的紧凑布局与全局样式（颜色用变量，随主题适配）
const scopedCss = `
.mdv { word-break: break-word; line-height: 1.6; }
.mdv > :first-child { margin-top: 0; }
.mdv > :last-child { margin-bottom: 0; }
.mdv h1, .mdv h2, .mdv h3, .mdv h4, .mdv h5, .mdv h6 {
  margin: 0.5em 0 0.25em; font-weight: 600; line-height: 1.3;
}
.mdv p { margin: 0.3em 0; }
.mdv ul, .mdv ol { margin: 0.3em 0; padding-left: 1.4em; }
.mdv li { margin: 0.15em 0; }
.mdv code { font-family: Consolas, Menlo, monospace; font-size: 0.9em;
  background: var(--code-bg); padding: 0.1em 0.3em; border-radius: 3px; color: var(--text); }
.mdv pre { margin: 0.4em 0; padding: 0.5em 0.7em; background: var(--code-bg);
  border: 1px solid var(--border); border-radius: 6px; overflow: auto; max-height: 360px; color: var(--text); }
.mdv pre code { background: transparent; padding: 0; }
.mdv blockquote { margin: 0.4em 0; padding-left: 0.6em; border-left: 3px solid var(--border-strong);
  color: var(--text-muted); }
.mdv a { color: var(--accent); text-decoration-line: none; }
.mdv a:hover { text-decoration-line: underline; }
`;

export function Markdown({
  content,
  style,
  className,
  onAnchorClick,
}: {
  readonly content: string;
  readonly style?: React.CSSProperties;
  readonly className?: string;
  /** `#` 开头的链接点击回调（传入即接管应用内锚点，不再触发 URL hash 跳转） */
  readonly onAnchorClick?: (href: string) => void;
}) {
  const html = useMemo(() => md.render(content || ''), [content]);
  const hostRef = useRef<HTMLDivElement>(null);
  /*
   * 锚点事件委托：真正可点的是正文里渲染出的原生 <a>（自带键盘可达），容器只承担委托，
   * 所以监听挂在 DOM 上而不是容器的 on* 属性上——非交互容器上挂 on* 会被判成「伪控件」。
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !onAnchorClick) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const link = target.closest('a');
      if (!link) return;
      const href = link.getAttribute('href') ?? '';
      if (!href.startsWith('#')) return;
      e.preventDefault();
      onAnchorClick(href);
    };
    host.addEventListener('click', onClick);
    return () => host.removeEventListener('click', onClick);
  }, [onAnchorClick]);
  return (
    <div
      ref={hostRef}
      className={className ? `mdv ${className}` : 'mdv'}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

Markdown.displayName = 'Markdown';
export const MarkdownStyles = () => <style>{scopedCss}</style>;

/** 复制失败的可见提示文案（S1874：不再保留已废弃的 execCommand 兜底） */
const COPY_FAILED_TEXT = '复制失败：当前环境不允许访问剪贴板，请手动选择文本复制';

// 右上角切换按钮：active 态用蓝色底反向色，与全局主色一致且便于区分当前视图
const switchBtnStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 'var(--fs-s)',
  padding: '2px 8px',
  borderRadius: 5,
  cursor: 'pointer',
  background: active ? 'var(--accent)' : 'var(--card-bg)',
  color: active ? 'var(--accent-text)' : 'var(--text)',
});

// 源码视图使用等宽字体 + 浅灰底，保留原始换行与缩进，不截断内容
const sourcePreStyle: React.CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  background: 'var(--code-bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontFamily: 'Consolas, Menlo, monospace',
  fontSize: 'var(--fs-m)',
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 320,
  overflowY: 'auto',
  minHeight: 44, // 为右上角复制按钮留出空间，避免覆盖短内容第一行
};

/**
 * 带「渲染 / 源码」切换的 Markdown 内容展示组件。
 * 默认渲染格式化视图；右上角可切到源码视图查看原始 Markdown 符号，并提供一键复制。
 * 切换只改 view 状态，html 由 useMemo 缓存，因此无闪烁、不重复解析。
 * showCopy 开启时，预览视图右上角也常驻「复制」按钮，便于一键复制完整内容（含换行，源码视图另行自带复制）。
 */
export function MarkdownContent({
  content,
  style,
  className,
  showCopy,
}: {
  readonly content: string;
  readonly style?: React.CSSProperties;
  readonly className?: string;
  /** 是否在预览视图右上角显示「复制」按钮（默认关闭，避免与源码视图自带复制重复） */
  readonly showCopy?: boolean;
}) {
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const copySource = async () => {
    const text = content;
    // 无内容直接返回，避免"复制成功"但剪贴板为空造成误导
    if (!text) return;
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // 权限/环境受限：给出可见降级提示，由用户手动选择文本
      setCopyError(true);
    }
  };

  return (
    <div style={{ position: 'relative', ...style }}>
      {/* 视图切换按钮常驻覆盖在右上角，始终可被找到，不随视图变化移位造成闪烁
          （.mdv 样式已由应用根 MarkdownStyles 统一注入，不在此重复） */}
      <div style={{ position: 'absolute', top: 0, right: 0, display: 'flex', gap: 6, zIndex: 1 }}>
        <button
          onClick={() => { setCopied(false); setView('preview'); }}
          title="渲染视图 — 以排版后的富文本形式查看内容"
          aria-label="渲染视图：以排版后的富文本形式查看内容"
          style={switchBtnStyle(view === 'preview')}
        >
          <Eye size={13} />
        </button>
        <button
          onClick={() => { setCopied(false); setView('source'); }}
          title="源码视图 — 查看原始 Markdown 源码"
          aria-label="源码视图：查看原始 Markdown 源码"
          style={switchBtnStyle(view === 'source')}
        >
          <Code size={13} />
        </button>
        {showCopy && view === 'preview' && (
          // 预览视图追加复制：与源码视图共享 copySource/copied，复制原始内容（含换行符与特殊字符）
          <button
            onClick={copySource}
            title={copied ? '已复制' : '复制 — 复制完整描述内容到剪贴板'}
            aria-label={copied ? '已复制：复制完整描述内容' : '复制：复制完整描述内容到剪贴板'}
            style={switchBtnStyle(false)}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
      </div>

      {copyError && (
        <output
          style={{
            position: 'absolute', top: 28, right: 0, zIndex: 2, padding: '3px 8px', borderRadius: 6,
            background: 'var(--card-bg)', border: '1px solid var(--danger, #dc2626)',
            color: 'var(--danger, #dc2626)', fontSize: 'var(--fs-xs)', maxWidth: 320,
          }}
        >
          {COPY_FAILED_TEXT}
        </output>
      )}

      {view === 'preview' ? (
        // paddingTop 让出右上角按钮，避免首行标题被遮挡
        <Markdown content={content} className={className} style={{ paddingTop: 30, minHeight: 32 }} />
      ) : (
        <div style={{ position: 'relative', marginTop: 30 }}>
          <pre style={sourcePreStyle}>{content || ''}</pre>
          {/* 复制按钮定位在源码块右上角内侧，不与滚动条重叠 */}
          <button
            onClick={copySource}
            title={copied ? '已复制' : '复制 — 复制原始 Markdown 源码到剪贴板'}
            aria-label="复制：复制原始 Markdown 源码到剪贴板"
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 'var(--fs-s)',
              padding: '2px 8px',
              borderRadius: 5,
              cursor: 'pointer',
              background: 'var(--card-bg)',
              color: copied ? 'var(--success)' : 'var(--text)',
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      )}
    </div>
  );
}

MarkdownContent.displayName = 'MarkdownContent';