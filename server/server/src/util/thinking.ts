/**
 * 剥离模型输出里的思考过程块（T00814 抽为公共 util）。
 *
 * 部分思考型模型会把「内心推理」写进 content，常见形态是 ```thinking / ```reasoning 围栏
 * 或 <thinking>/<reasoning> 标签。解析结构化产物（JSON 清单等）前必须先剔除，
 * 否则会从推理内容里扫到示例 JSON，误当成真实结果。
 * 原先该逻辑仅存在于 AIService（标题美化/简化用），PRD 问题清单解析也需要同一口径，故上移共享。
 */
export function stripThinking(text: string): string {
  // 依次剔除常见思考分界标记的内层（支持 中文/英文 与 反引号 变体），提纯后剩正文
  // 注：以下均为跨度未知内容的全局正则替换，String#replaceAll 只能按字面字符串替换无法表达通配，属 S7781 误报
  return text
    .replace(/\s*```\s*(?:thinking|reasoning|thought)\s*[\s\S]*?```\s*/gi, '') // NOSONAR - 通配跨行正则，无法用 replaceAll
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '') // NOSONAR - 通配跨行正则，无法用 replaceAll
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '') // NOSONAR - 通配跨行正则，无法用 replaceAll
    .trim();
}
