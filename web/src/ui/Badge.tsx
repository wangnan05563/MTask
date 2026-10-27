/**
 * PM-302 ①：徽标（badge/pill）的桌面单源实现。
 *
 * 整改前桌面端没有共享徽标：移动端有一套 `Badge`（mobile/ui.tsx），桌面端各页自写
 * `borderRadius` 4/8/10/999 + 各自 padding 的小标签（TaskDetailDrawer 私有 Badge、
 * ExecSessionsPage 的 999 胶囊、TasksPage 行内的 4 角标……）。
 * 本组件把样式全部交给 ui/primitives.ts 的 BADGE / BADGE_TONE，
 * mobile/ui.tsx 的 Badge 亦改为包裹本组件——两端由此同一实现，暗色跟随令牌自动生效。
 */
import type { CSSProperties, ReactNode } from 'react';
import { BADGE, BADGE_TONE, type BadgeTone } from './primitives';

export type { BadgeTone };

export function Badge({ tone = 'neutral', children, style }: Readonly<{
  tone?: BadgeTone;
  children: ReactNode;
  style?: CSSProperties;
}>) {
  return <span style={{ ...BADGE, ...BADGE_TONE[tone], ...style }}>{children}</span>;
}
