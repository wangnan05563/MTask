import type { CSSProperties } from 'react';

/**
 * T01674：文件选择框「视觉隐藏但保留键盘焦点」统一样式。
 *
 * 旧写法 `display:'none'` 会让 `<input type="file">` 退出 Tab 序列与辅助树——
 * 「点 label 触发文件框」只剩鼠标能走通（T01619 键盘实测：导入 Excel 永远无法 Tab 达）。
 * 本样式保持 input 可聚焦：Tab 到达后 Enter 原生打开文件选择器；
 * 配合容器（label）的 :focus-within 规则（App.tsx 全局样式）显示焦点环。
 */
export const FILE_INPUT_SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  opacity: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};
