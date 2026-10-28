/**
 * T03247（PRD AI-104①②）：提示词模板变量（前端侧）。
 *
 * 与服务端 server/src/services/PromptTemplate.ts **同一条正则、同一套去重口径**——前端解析变量只为
 * 生成输入框，最终正文仍由服务端渲染（绕过弹窗直接调接口也拦得住）。两侧一致性由门逐例对拍。
 * 变量写法 `{{变量名}}`；空名忽略；按首次出现顺序去重。
 */
const VAR_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** 模板里的变量名（按首次出现顺序去重；忽略空名） */
export function parsePromptVars(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(VAR_RE)) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 已填但仅空白的变量按未填处理（与必填口径一致） */
export function missingPromptVars(content: string, values: Record<string, string>): string[] {
  return parsePromptVars(content).filter((name) => !String(values[name] ?? '').trim());
}
