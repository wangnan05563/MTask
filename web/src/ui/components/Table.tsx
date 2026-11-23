/**
 * T06287：Design System Table 原语。
 *
 * 只负责表格骨架、列宽/对齐、密度、行 hover/选中、loading 与 empty 展示；
 * 不包含排序、分页、筛选、行内编辑等业务逻辑。
 */
import type { KeyboardEvent, ReactNode } from 'react';

export type TableDensity = 'compact' | 'comfortable' | 'loose';

export interface TableColumn<T> {
  readonly key: string;
  readonly title: ReactNode;
  readonly render: (row: T, rowIndex: number) => ReactNode;
  readonly width?: number | string;
  readonly align?: 'left' | 'center' | 'right';
  readonly className?: string;
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
}: Readonly<TableProps<T>>) {
  const columnCount = columns.length;
  const clickable = Boolean(onRowClick);

  function activate(row: T, event: KeyboardEvent<HTMLTableRowElement>) {
    if (!onRowClick) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onRowClick(row);
    }
  }

  return (
    <div className={['mt-table-wrap', className].filter(Boolean).join(' ')}>
      <table
        className="mt-table"
        data-density={density}
        aria-label={ariaLabel}
        aria-busy={loading || undefined}
      >
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.className}
                style={{ width: column.width, textAlign: column.align }}
              >
                {column.title}
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
