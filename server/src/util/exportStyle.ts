/**
 * T01487：导出版式「规范 A」单源（PRD-测试用例管理 §10.2）。
 *
 * 抽出来的理由：规范 A 的参数此前在一个文件里就有三份拷贝——`prdExport.ts` 的 `buildMatrixXlsx`
 * 内联了 `HEAD_FILL` / `ZEBRA_FILL` / `THIN`（首次建表头与 `insertRow` 后重刷表头各写一遍），
 * `mdTable` 又硬编码了一次 docx 表头底色 `EAF2FF`。本期用例导出是第四个使用者，
 * 再抄一遍就成了 PRD §14 风险表点名的「导出样式第四份拷贝」。
 *
 * 约束：
 * - 只有常量与无状态应用函数，不 import 数据库层，也不在顶层引入 exceljs/docx 运行时
 *   （exceljs 类型走 `import type`，编译期即擦除）——重依赖仍由各构建器按需 `await import`。
 * - 颜色一律 6 位 hex：exceljs 的 `argb` 允许省略 alpha 前缀（既往矩阵导出就是这么用的），
 *   docx 的 `shading.fill` 只要 6 位，两边共用同一个字面量才不会漂移。
 */
import type { Cell, Row } from 'exceljs';

/** 表头填充色（浅靛蓝，与 xlsx-trae 报表、需求跟踪矩阵同口径） */
export const HEAD_FILL = 'EAF2FF';

/** 斑马纹填充色（奇数行的浅灰蓝） */
export const ZEBRA_FILL = 'F7F9FC';

/** 边框色（浅灰） */
export const BORDER_ARGB = 'D9DEE7';

/** 未覆盖/缺口类提示字色（xlsx font.color 与 docx TextRun color 同值，避免两套红） */
export const WARN_FONT = 'B42318';

/** 细边框单侧描述（四边共用同一个对象，样式语义不可变） */
export const THIN = { style: 'thin', color: { argb: BORDER_ARGB } } as const;

/** docx 表格表头底纹（与 xlsx 表头同一个色值，两张表成对流转时视觉一致） */
export const DOCX_HEAD_SHADING = HEAD_FILL;

/** docx 未覆盖行的提示字色（docx 用 6 位 hex，与 xlsx 的 ARGB 同值） */
export const DOCX_WARN_FONT = WARN_FONT;

/** 实色填充对象。每次新建——exceljs 的样式对象会被就地改写，共享实例会跨行串色 */
export function solidFill(argb: string): { type: 'pattern'; pattern: 'solid'; fgColor: { argb: string } } {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

/** 四边细框（同 `solidFill`，返回新对象） */
export function boxBorder(): { top: typeof THIN; left: typeof THIN; bottom: typeof THIN; right: typeof THIN } {
  return { top: THIN, left: THIN, bottom: THIN, right: THIN };
}

/**
 * 表头行：加粗 + 表头底色 + 全边框。
 * `insertRow` 之后必须再调一次——矩阵导出既往就是靠重刷第二遍保住表头观感，本函数把那段复制收进来。
 */
export function paintHeaderRow(row: Row): void {
  row.font = { bold: true };
  row.eachCell((cell: Cell) => {
    cell.fill = solidFill(HEAD_FILL);
    cell.border = boxBorder();
  });
}

/**
 * 数据行：全边框，`zebra` 为真时补斑马底。
 * 调用方按行号传 `i % 2 === 1`，与既往矩阵导出的「奇数行上色」保持同一相位。
 * 刻意不管对齐：矩阵导出既往就没设过 alignment，本函数被它复用后不能顺手改它的观感
 * （迁移不等于换行为）；需要换行顶端对齐的调用方自己设。
 */
export function paintDataRow(row: Row, zebra: boolean): void {
  row.eachCell((cell: Cell) => {
    cell.border = boxBorder();
    if (zebra) cell.fill = solidFill(ZEBRA_FILL);
  });
}

/** 单格提示色（未覆盖需求之类的缺口标注） */
export function markWarnCell(cell: Cell): void {
  cell.font = { color: { argb: WARN_FONT } };
}

/**
 * T02098：正文深色墨值（PPT/导出共用的「近黑」，不用纯 000000——纯黑在浅靛蓝表头上偏硬）。
 * 纳入本文件的原因：PRD-项目启动会PPT生成 §6.3 门禁 6 要求「色值单源」，
 * 而规范 A 此前只有浅色底与提示红，缺一个可对白底过 WCAG 4.5 的正文色。
 */
export const INK_FONT = '1F2937';

/** T02098：PPT 页背景（纯白，与 INK_FONT 的对比度由 kickoff-layout 断言把关） */
export const PAPER_BG = 'FFFFFF';

/** T02098：强调色（与表头同色系的深靛蓝，用于时间线轴、图例描边） */
export const ACCENT_FONT = '3B5BDB';

/**
 * T02156：恒生品牌色（来源：`2023恒生PPT模板.pptx` 各 slideLayout 的 shape 取色，
 * 深蓝 08409C / 亮蓝 0059E9 是该模板唯二的品牌实色）。
 * 落地背景：PRD §7 非目标 N1「不做 .pptx 母版/模板文件套用」的根因是装机版无 Python
 * 运行时读模板母版；本次 E-1 需求（T02156 用户硬要求）用 pptxgenjs 原生背景图 +
 * 品牌色常量绕过，不走母版套用、不引 Python。色值仍按 §6.3 门禁 6 纳入本单源。
 */
export const BRAND_DEEP = '08409C';

/** 品牌亮蓝：图形（时间线条/图表首色/强调）与次强调文本 */
export const BRAND_BRIGHT = '0059E9';

/** 品牌浅蓝：与模板浅蓝背景同族的装饰线/弱提示底（门禁 6 下只作形状色，不作正文底） */
export const BRAND_PALE = 'C9DCF6';

/** 品牌深底上的正文色（表格表头白字，对 08409C 对比度 ≈9.5） */
export const ON_BRAND = 'FFFFFF';

// ---------- T02960（方案 A）：阶段性总结汇报 PPT 的版式预设三档 ----------

/** 版式预设键。英文键名是对外契约（SSE 入参持久化后不随中文改版漂移），中文名放 `label` 给面板展示。 */
export type DeckStyleKey = 'standard' | 'ink' | 'evergreen';

export interface DeckStylePreset {
  key: DeckStyleKey;
  /** 面板与 400 提示展示的中文名（不参与产物渲染） */
  label: string;
  /**
   * 装配器唯一消费的色值（页标题/章节编号/页脚）。
   * 只定义被消费的色值：三档差异必须落在真实渲染的属性上，
   * 否则「配了色但产物一样」会成为又一处置空的单源。
   */
  brandDeep: string;
}

/** 合法键清单：SSE 校验、前端选择器、错误提示共用，避免三处各列一遍 */
export const DECK_STYLE_KEYS = ['standard', 'ink', 'evergreen'] as const;

/**
 * 三档预设。`standard` 与既有品牌常量**逐字相同**——T02960 验收要求
 * 「未传 style 与显式传 standard 的产物逐字节等价」，故本档只做别名，不引入新色值/背景元素。
 */
export const DECK_STYLES: Record<DeckStyleKey, DeckStylePreset> = {
  standard: { key: 'standard', label: '商务蓝', brandDeep: BRAND_DEEP },
  /** 墨灰：中性灰档，适合偏正式的客户汇报；对白底对比度 ≈10.3（过 WCAG 4.5） */
  ink: { key: 'ink', label: '墨灰', brandDeep: '374151' },
  /** 常青：深绿档，适合经营/述职类汇报；对白底对比度 ≈7.7（过 WCAG 4.5） */
  evergreen: { key: 'evergreen', label: '常青', brandDeep: '0B5F4A' },
};

/** 解析版式预设：空值回落 standard（与未传字段等价），非法值抛错并点名可选值 */
export function deckStylePreset(raw: unknown): DeckStylePreset {
  const key = String(raw ?? '').trim();
  if (!key) return DECK_STYLES.standard;
  if (!(DECK_STYLE_KEYS as readonly string[]).includes(key)) {
    const options = DECK_STYLE_KEYS.map((k) => `${k}(${DECK_STYLES[k].label})`).join(' / ');
    throw new Error(`版式预设仅支持 ${options}，当前为「${key}」`);
  }
  return DECK_STYLES[key as DeckStyleKey];
}
