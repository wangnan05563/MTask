/**
 * T02855（六期 S4）：阶段性总结汇报 PPT 的版式定义单源。
 *
 * PRD-阶段性项目总结汇报PPT §6.3 门禁 0 的硬要求：本卡片**不得沿用 'KICKOFF'** 的 layout 名——
 * deck 元数据与封面版式声明会因此带出启动会标识。尺寸仍与 `kickoff-layout.ts` 的 `CANVAS`
 * 同源（10×5.625"），断言层（`kickoff-layout.ts`）与装配层（`summaryPptBuilder.ts`）都从这里取。
 *
 * 本模块保持零依赖副作用（只 import 常量），门禁可单独断言「名字不是 KICKOFF、尺寸与画布一致」。
 */
import { CANVAS } from './kickoff-layout';

/** 交给 `pptx.defineLayout` 的登记参数（PRD §6.3 门禁 0：独立命名） */
export const SUMMARY_LAYOUT_DEF = { name: 'SUMMARY', width: CANVAS.width, height: CANVAS.height } as const;

/** 页脚带高度（底带 0.4" 之内），与 kickoff 装配器同口径 */
export const SUMMARY_FOOTER_H = 0.3;

/** 页脚顶部 y（画布高 - 页脚带 - 0.08" 间距） */
export const SUMMARY_FOOTER_Y = SUMMARY_LAYOUT_DEF.height - SUMMARY_FOOTER_H - 0.08;
