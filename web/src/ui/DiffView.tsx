/**
 * 八期 评审 #8（批次 0 前置重构）：把原先内联在「代码评审讲稿」面板里的 unified diff 渲染
 * 抽成共享组件，供讲稿面板与任务抽屉 Git 页（§3.2.1 文件清单点行展开）共用同一套口径：
 *  hunk 头可折叠、行号双列、增删主题色（`--success` / `--danger`）、等宽字体、锚点行可高亮。
 *
 * 折叠状态由调用方持有（讲稿面板需要按 projectId+path 门控并支持锚点程序展开），
 * 本组件只负责渲染与回抛展开/折叠事件——这样两端各自的键空间互不干扰。
 */
import { hunkToRows, type LectureDiffHunk } from '../utils/lectureDiff';

const FONT_MONO = 'Consolas, Menlo, monospace';

export interface DiffFileViewProps {
  readonly path: string;
  readonly binary: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly LectureDiffHunk[];
  /** 该文件是否展开（`▾`/`▸`） */
  readonly open: boolean;
  readonly onToggleFile: () => void;
  /** 已折叠的 hunk 键集合；键由 `hunkKeyPrefix|hunkIndex` 组成 */
  readonly foldedHunks: ReadonlySet<string>;
  readonly onToggleHunk: (key: string) => void;
  readonly hunkKeyPrefix: string;
  /** 行 DOM 标识——讲稿侧用于锚点定位，Git 页侧用作测试钩子 */
  readonly rowDomId: (hunkIndex: number, rowIndex: number) => string;
  /** 行上挂的测试/锚点属性名（讲稿侧 `data-lck-row`，Git 页侧 `data-t03362-row`） */
  readonly rowAttr?: string;
  readonly flashRowIds?: ReadonlySet<string>;
  readonly flashSeq?: number;
  readonly hoverRowIds?: ReadonlySet<string>;
  /** 文件按钮上的属性值（讲稿侧 `file-${path}` 供门脚本定位） */
  readonly fileAttrValue?: string;
  /** 重命名前的路径（`R` 状态时显示 `old → new`，§3.2.1） */
  readonly oldPath?: string;
  /** 单文件超 2MB 保头保尾截断时的说明文案（§3.2.1） */
  readonly truncatedNote?: string;
}

export function DiffFileView(props: DiffFileViewProps) {
  const {
    path, binary, additions, deletions, hunks, open, onToggleFile,
    foldedHunks, onToggleHunk, hunkKeyPrefix, rowDomId, rowAttr = 'data-lck-row',
    flashRowIds, flashSeq, hoverRowIds, fileAttrValue, oldPath, truncatedNote,
  } = props;
  return (
    <div style={{ marginTop: 4 }}>
      <button type="button" data-lck={fileAttrValue} onClick={onToggleFile} aria-expanded={open}
        style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 'var(--fs-s)', padding: 0, textAlign: 'left', fontFamily: FONT_MONO }}>
        {open ? '▾' : '▸'} {oldPath ? `${oldPath} → ${path}` : path}{' '}
        <span style={{ color: 'var(--success)' }}>+{additions}</span>{' '}
        <span style={{ color: 'var(--danger)' }}>-{deletions}</span>
      </button>
      {!open || !truncatedNote ? null : (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--warn)', marginLeft: 14 }}>{truncatedNote}</div>
      )}
      {open && binary ? (
        <div style={{ fontSize: 'var(--fs-s)', color: 'var(--text-muted)', marginLeft: 14 }}>二进制文件，无文本 diff。</div>
      ) : null}
      {open && !binary
        ? hunks.map((h, hunkIndex) => {
          const hk = `${hunkKeyPrefix}|${hunkIndex}`;
          if (foldedHunks.has(hk)) {
            return (
              <div key={hk} style={{ marginLeft: 14, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                hunk @{h.newStart} 已折叠{' '}
                <button type="button" onClick={() => onToggleHunk(hk)}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 'var(--fs-xs)' }}>展开</button>
              </div>
            );
          }
          const rows = hunkToRows(h);
          return (
            <div key={hk} style={{ marginLeft: 14, marginTop: 2 }}>
              <button type="button" onClick={() => onToggleHunk(hk)} title="折叠该 hunk"
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--fs-xs)', padding: 0, fontFamily: FONT_MONO }}>
                {rows[0].text}
              </button>
              {rows.slice(1).map((r, offset) => {
                const rowIndex = offset + 1; // rows[0] 是 hunk 头，行号口径与 utils 的展开结果一致
                const id = rowDomId(hunkIndex, rowIndex);
                const flashed = flashRowIds?.has(id);
                return (
                  <div key={flashed ? `${id}-${flashSeq}` : id} {...{ [rowAttr]: id }}
                    className={flashed ? 'locate-flash' : undefined}
                    style={{
                      display: 'flex', gap: 6, fontSize: 'var(--fs-s)', lineHeight: 1.45, fontFamily: FONT_MONO,
                      background: hoverRowIds?.has(id) ? 'var(--accent-soft)' : undefined,
                      color: r.kind === 'del' ? 'var(--danger)' : r.kind === 'add' ? 'var(--success)' : 'var(--text)',
                    }}>
                    <span style={{ width: 34, textAlign: 'right', color: 'var(--text-muted)', flexShrink: 0 }}>{r.oldLine ?? ''}</span>
                    <span style={{ width: 34, textAlign: 'right', color: 'var(--text-muted)', flexShrink: 0 }}>{r.newLine ?? ''}</span>
                    <span style={{ width: 10, flexShrink: 0 }}>{r.kind === 'add' ? '＋' : r.kind === 'del' ? '−' : ' '}</span>
                    <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{r.text}</span>
                  </div>
                );
              })}
            </div>
          );
        })
        : null}
    </div>
  );
}
