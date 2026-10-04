/**
 * T01486：需求跟踪矩阵的「用例」列单元格（PRD-测试用例管理 §4.3 / §7.3 列 4 / 验收 A4）。
 *
 * 从 `ReqMatrixPanel` 拆出有两个原因：
 * 1. 矩阵面板已 560+ 行，再加下钻列与覆盖度取数会破「单文件 ≤600 行」的红线（§14 风险表）；
 * 2. 这一列是矩阵 ⇄ 用例 双向跳转的矩阵侧唯一入口，与用例侧的 `TestCaseTable` 同属用例模块，
 *    集中一处便于后续（T01487 导出范围、T01492 生成入口）复用同一套 chip 语义。
 *
 * 样式对齐矩阵自身的关联计划/待办 chip（字号 11、圆角 4、`var(--border-strong)`），
 * 只是可点击态改用 accent 描边——一眼能看出「这格能点」，但不至于抢过相邻两列。
 */
import { FlaskConical } from 'lucide-react';

/** 需求编号 + 标题摘要（chip 悬浮提示用，缺任一段自动省略） */
export const caseCellTitle = (reqNo: string, title: string, count: number): string => {
  const seg = [reqNo, title].filter(Boolean).join(' ');
  return `用例 ${count} 条 — 点击在测试用例视图中只看该需求${seg ? `\n${seg}` : ''}`;
};

/**
 * 「用例」列单元格：显示该需求关联的用例条数，点击下钻用例视图。
 * `count === 0` 时不给可点击态——需求未被覆盖是矩阵要暴露的信息，
 * 点进去看一个空列表只会让人以为界面坏了（未覆盖的补生成入口在 §7.2 的「未覆盖的需求」视图里）。
 */
export function MatrixCaseCell({ reqId, reqNo, title, count, onDrill }: {
  readonly reqId: string;
  readonly reqNo: string;
  readonly title: string;
  readonly count: number;
  readonly onDrill: (reqId: string) => void;
}) {
  return (
    <td style={{ padding: '4px 6px', width: 88 }}>
      {count > 0 ? (
        <button onClick={() => onDrill(reqId)} className="tbtn-anim"
          title={caseCellTitle(reqNo, title, count)}
          aria-label={`下钻查看需求 ${reqNo || title} 的 ${count} 条测试用例`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, border: '1px solid var(--accent)', borderRadius: 4, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: '0 5px', maxWidth: '100%' }}>
          <FlaskConical size={10} style={{ flexShrink: 0 }} />
          用例 {count}
        </button>
      ) : (
        <span title="该需求暂无关联测试用例（未覆盖）——可在测试用例视图的「未覆盖的需求」中补写"
          aria-label={`需求 ${reqNo || title} 未覆盖用例`}
          style={{ fontSize: 11, color: 'var(--text-muted)', border: '1px dashed var(--border-strong)', borderRadius: 4, padding: '0 5px' }}>
          未覆盖
        </span>
      )}
    </td>
  );
}
