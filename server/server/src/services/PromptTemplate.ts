/**
 * T03247（PRD AI-104①②）：提示词模板变量。
 *
 * 变量写法 `{{变量名}}`（双大括号，与单大括号的「普通占位符」严格区分——旧文案里的 `{占位符}`
 * 不再参与渲染，避免把 JSON/代码片段误当变量）。渲染只在**服务端**做：前端即便绕过弹窗直接
 * 调接口，未填必填变量也会被 400 拦下，控制台任务落库的一定是完整正文。
 *
 * 变量名按首次出现顺序去重；空名（`{{}}`/`{{  }}`）忽略，避免生成无语义输入框。
 */

/** 与前端 web/src/ui/promptTemplate.ts 同一条正则；两侧一致性由门（verify-t03247）逐例对拍 */
const VAR_RE = /\{\{([^{}]*)\}\}/g;

/** 模板里的变量名（按首次出现顺序去重；忽略空名） */
export function promptTemplateVars(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(VAR_RE)) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export interface RenderedPrompt {
  text: string;
  /** 必填但未填（含仅空白）的变量名，按首次出现顺序 */
  missing: string[];
}

/**
 * 渲染模板：已填变量替换为值，未填变量保留原样并计入 missing（调用方据此拒绝发起）。
 * 替换用函数形式，避免值里的 `$&`/`$1` 被 String.replace 当成替换模式。
 */
export function renderPromptTemplate(content: string, values: Record<string, unknown>): RenderedPrompt {
  const missing: string[] = [];
  const text = content.replaceAll(VAR_RE, (raw, name: string) => {
    const key = name.trim();
    if (!key) return raw;
    const v = values[key];
    const numText = typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
    const s = typeof v === 'string' ? v : numText;
    if (!s.trim()) {
      if (!missing.includes(key)) missing.push(key);
      return raw;
    }
    return s;
  });
  return { text, missing };
}
