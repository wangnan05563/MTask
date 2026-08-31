import { useMemo, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { Check, Code, Copy, Eye } from 'lucide-react';

/**
 * Markdown 渲染组件。
 * 采用 markdown-it 默认 html:false 关闭原始 HTML 直通，从源头规避 XSS 注入；
 * 仅将受信 Markdown 语法（标题/加粗/列表/代码/链接等）转换为白名单范围的安全标签。
 * 链接统一加 rel/noopener，避免新窗口打开时泄露 window.opener。
 */
const md = new MarkdownIt({ html: false, linkify: true });

// 外部链接新窗口打开并阻止 opener 泄露，兼顾可用性与安全
const defaultRender =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
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
  border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; color: var(--text); }
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
}: {
  readonly content: string;
  readonly style?: React.CSSProperties;
  readonly className?: string;
}) {
  const html = useMemo(() => md.render(content || ''), [content]);
  return (
    <div
      className={className ? `mdv ${className}` : 'mdv'}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

Markdown.displayName = 'Markdown';
export const MarkdownStyles = () => <style>{scopedCss}</style>;

/** 无环境限制的文本复制：优先 Clipboard API，Electron/低版本 Chromium 无权限时降级到隐藏 textarea + execCommand */
function copyText(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 移出可视区避免滚动条跳动，select() 需要元素可见属性但不要求视觉呈现
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy'); // NOSONAR - Clipboard API 受限环境（Electron/file://）的降级路径无未废弃替代 API
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// 右上角切换按钮：active 态用蓝色底反向色，与全局主色一致且便于区分当前视图
const switchBtnStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
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
  fontSize: 13,
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

  const copySource = async () => {
    const text = content;
    // 无内容直接返回，避免"复制成功"但剪贴板为空造成误导
    if (!text) return;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    };
    // 优先 Clipboard API，权限/环境受限时降级到 textarea+execCommand；两者都失败则保持静默
    try {
      await navigator.clipboard.writeText(text);
      done();
    } catch {
      if (copyText(text)) done();
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
              fontSize: 12,
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