/**
 * T06287：Design System Table 原语。
 *
 * 只负责表格骨架、列宽/对齐、密度、行 hover/选中、loading 与 empty 展示；
 * 不包含排序、分页、筛选、行内编辑等业务逻辑。
 */
import { useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

export type TableDensity = 'compact' | 'comfortable' | 'loose';

export interface TableColumn<T> {
  readonly key: string;
  readonly title: ReactNode;
  readonly render: (row: T, rowIndex: number) => ReactNode;
  readonly width?: number | string;
  readonly minWidth?: number;
  readonly align?: 'left' | 'center' | 'right';
  readonly className?: string;
  readonly ariaLabel?: string;
}

export interface TableProps<T> {
  readonly columns: readonly TableColumn<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly loading?: boolean;
  readonly loadingRows?: number;
  readonly emptyText?: ReactNode;
  readonly density?: TableDensity;
  readonly selectedKey?: string;
  readonly onRowClick?: (row: T) => void;
  readonly ariaLabel?: string;
  readonly className?: string;
  /** T06301：表格最大高度；配合粘性表头形成「表头冻结 + 内容区滚动」。 */
  readonly maxHeight?: number | string;
  readonly minHeight?: number | string;
  /** T06301：列宽拖拽（pointer + 方向键），默认关闭，避免影响既有表格。 */
  readonly resizable?: boolean;
  readonly minColumnWidth?: number;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  loadingRows = 4,
  emptyText = '暂无数据',
  density = 'comfortable',
  selectedKey,
  onRowClick,
  ariaLabel,
  className,
  maxHeight,
  minHeight,
  resizable = false,
  minColumnWidth = 72,
}: Readonly<TableProps<T>>) {
  const columnCount = columns.length;
  const clickable = Boolean(onRowClick);
  const [widths, setWidths] = useState<Record<string, number>>({});

  const resolvedWidth = (column: TableColumn<T>): number | string | undefined => {
    const dragged = widths[column.key];
    if (dragged !== undefined) return dragged;
    return column.width;
  };
  const minTableWidth = columns.reduce((sum, column) => {
    const width = resolvedWidth(column);
    if (typeof width === 'number') return sum + width;
    return sum + 160;
  }, 0);

  function activate(row: T, event: KeyboardEvent<HTMLTableRowElement>) {
    if (!onRowClick) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onRowClick(row);
    }
  }

  function columnFloor(column: TableColumn<T>): number {
    return Math.max(24, column.minWidth ?? minColumnWidth);
  }

  function currentWidth(column: TableColumn<T>, element?: HTMLElement | null): number {
    const dragged = widths[column.key];
    if (dragged !== undefined) return dragged;
    if (typeof column.width === 'number') return column.width;
    return element?.getBoundingClientRect().width || 160;
  }

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>, column: TableColumn<T>) {
    if (!resizable) return;
    event.preventDefault();
    event.stopPropagation();
    const key = column.key;
    const startX = event.clientX;
    const startWidth = currentWidth(column, event.currentTarget.parentElement);
    const floor = columnFloor(column);
    const move = (moveEvent: PointerEvent) => {
      const next = Math.max(floor, Math.round(startWidth + moveEvent.clientX - startX));
      setWidths((prev) => ({ ...prev, [key]: next }));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }

  function nudgeWidth(event: KeyboardEvent<HTMLButtonElement>, column: TableColumn<T>) {
    if (!resizable) return;
    const floor = columnFloor(column);
    const key = column.key;
    if (event.key === 'Home') {
      event.preventDefault();
      setWidths((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 8 : -8;
    setWidths((prev) => {
      const base = prev[key] ?? (typeof column.width === 'number' ? column.width : 160);
      return { ...prev, [key]: Math.max(floor, base + delta) };
    });
  }

  return (
    <div
      className={['mt-table-wrap', className].filter(Boolean).join(' ')}
      style={{ maxHeight, minHeight }}
    >
      <table
        className="mt-table"
        data-density={density}
        aria-label={ariaLabel}
        aria-busy={loading || undefined}
        style={resizable ? { minWidth: minTableWidth } : undefined}
      >
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={{ width: resolvedWidth(column) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.className}
                data-column-key={column.key}
                data-resizable={resizable || undefined}
                style={{ width: resolvedWidth(column), textAlign: column.align }}
              >
                <span className="mt-table__th-text">{column.title}</span>
                {resizable && (
                  <button
                    type="button"
                    className="mt-table__resize"
                    aria-label={`调整「${column.ariaLabel ?? column.key}」列宽：左右方向键每次 8px，Home 恢复默认`}
                    title="拖拽调整列宽；聚焦后可用左右方向键微调，Home 恢复默认"
                    onPointerDown={(event) => beginResize(event, column)}
                    onKeyDown={(event) => nudgeWidth(event, column)}
                  />
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: Math.max(1, loadingRows) }, (_, rowIndex) => (
                <tr key={`skeleton-${rowIndex}`} aria-hidden="true">
                  {columns.map((column) => (
                    <td key={column.key} className={column.className} style={{ textAlign: column.align }}>
                      <span className="mt-table__skeleton" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.length === 0
              ? (
                  <tr>
                    <td className="mt-table__empty" colSpan={Math.max(1, columnCount)}>
                      {emptyText}
                    </td>
                  </tr>
                )
              : rows.map((row, rowIndex) => {
                  const key = rowKey(row);
                  const selected = selectedKey === key;
                  return (
                    <tr
                      key={key}
                      data-selected={selected || undefined}
                      data-clickable={clickable || undefined}
                      aria-selected={selected || undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onClick={clickable ? () => onRowClick?.(row) : undefined}
                      onKeyDown={clickable ? (event) => activate(row, event) : undefined}
                    >
                      {columns.map((column) => (
                        <td key={column.key} className={column.className} style={{ textAlign: column.align }}>
                          {column.render(row, rowIndex)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
        </tbody>
      </table>
    </div>
  );
}
