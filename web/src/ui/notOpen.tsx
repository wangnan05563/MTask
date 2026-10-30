import type { CSSProperties, ReactNode } from 'react';

/**
 * T03185（UX-05⑤）：未开放能力的入口口径。
 *
 * 治理的是「按钮看着能点，点下去只弹一句『XX 功能开发中』」——它把死路伪装成入口，
 * 用户按下才知道不通，且提示读完即消失。PRD 要求主界面不存在这种可用态占位按钮，
 * 禁用项必须说明开放时间或范围。这里沿用 T03176（D-14）「可见但禁用 + 原因」的语言：
 * 入口保留可见（便于知道产品有此方向），但置为 disabled，原因写进 title 与 aria-label，
 * 读屏与悬浮都能拿到，不靠一次性 toast。
 */

/** 未排期能力的范围说明（单源，避免同一能力在多个菜单各写一套口径） */
export const NOT_OPEN_SCOPE = {
  /** 正文润色已在编辑态提供，缺的是「标题级」改写 */
  polishTitle: '标题级 AI 改写未排期；正文润色已在条目编辑态提供',
  /** 摘要起标题依赖整条正文归纳，与标题编辑是两套链路 */
  summarizeTitle: '按正文摘要起标题未排期；可先编辑正文再手工精简标题',
  /** T03685 之后需求侧只补了「通用需求条目」的归档列；矩阵需求行（prd_requirements）仍无归档模型，
   *  硬造状态会污染矩阵统计与需求编号口径，故矩阵入口维持禁用 */
  archiveMatrixRow: '项目需求矩阵行（prd_requirements）无归档列，本期不引入新状态位；通用需求条目的归档已随 T03685 上线',
} as const;

export type NotOpenScope = keyof typeof NOT_OPEN_SCOPE;

/**
 * 未开放入口按钮：disabled + 「未开放：范围说明」。
 * `label` 是可见文案（同时进 aria-label），`scope` 从 NOT_OPEN_SCOPE 取，保证口径一致。
 */
export function NotOpenButton({ label, scope, icon, style, className }: {
  readonly label: string;
  readonly scope: NotOpenScope;
  readonly icon: ReactNode;
  readonly style?: CSSProperties;
  readonly className?: string;
}) {
  const reason = `${label} — 未开放：${NOT_OPEN_SCOPE[scope]}`;
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      data-t03185="not-open"
      className={className}
      title={reason}
      aria-label={reason}
      style={{ ...style, cursor: 'default' }}
    >
      {icon}
    </button>
  );
}
