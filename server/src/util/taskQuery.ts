/**
 * T03184（PM-102）：命令面板结构化搜索语法。
 *
 * 支持 `status:` / `priority:` / `project:` 字段、AND / OR（大小写不敏感）与括号分组；
 * 不含字段与逻辑词时**不算结构化查询**——调用方退回既有模糊匹配（PRD ③），
 * 否则「foo bar」这类多词短语会被隐式 AND 拆开，改变原有语义。
 *
 * 非法语法抛 TaskQuerySyntaxError，调用方降级为全文搜索并把 message 原样提示（PRD ②）。
 * 编译产物是**参数化** SQL 片段：过滤在 SQLite 全表执行后再 LIMIT/OFFSET，
 * 不在内存里的「前 500 条」上二次筛选（PRD ④）。
 */

export type TaskQueryField = 'status' | 'priority' | 'project';

export type TaskQueryNode =
  | { readonly type: 'and' | 'or'; readonly children: readonly TaskQueryNode[] }
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'field'; readonly field: TaskQueryField; readonly value: string };

export interface TaskQueryParsed {
  /** fuzzy = 保持原模糊匹配（含空查询）；structured = 已解析成语法树 */
  readonly mode: 'fuzzy' | 'structured';
  readonly text: string;
  readonly node: TaskQueryNode | null;
}

export class TaskQuerySyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskQuerySyntaxError';
  }
}

interface Token {
  readonly kind: 'word' | '(' | ')';
  readonly text: string;
}

const STATUS_ALIASES: Record<string, 'todo' | 'done'> = {
  todo: 'todo', '待办': 'todo', '未完成': 'todo', '待处理': 'todo',
  done: 'done', '已完成': 'done', '完成': 'done',
};

const PRIORITY_ALIASES: Record<string, 'low' | 'normal' | 'high' | 'urgent'> = {
  low: 'low', '低': 'low', '低优先级': 'low',
  normal: 'normal', medium: 'normal', '普通': 'normal', '中': 'normal',
  high: 'high', '高': 'high', '高优先级': 'high',
  urgent: 'urgent', '紧急': 'urgent', '最高': 'urgent',
};

/** 关键词前必须是行首/空白/左括号；`(status:todo` 也要被判为结构化 */
export function looksStructured(raw: string): boolean {
  return /[()]/.test(raw)
    || /(^|[\s(])(and|or)(?=[\s)]|$)/i.test(raw)
    || /(^|[\s(])(status|priority|project)\s*:/i.test(raw);
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')') { tokens.push({ kind: ch, text: ch }); i++; continue; }
    // 词内引号：`project:"Gamma Box"` 这类「字段:带空格取值」必须整块成一条词，
    // 否则会在空格处断开，把 Box" 当成另一个查询项
    let text = '';
    while (i < input.length) {
      const c = input[i];
      if (/\s/.test(c) || c === '(' || c === ')') break;
      if (c === '"' || c === "'") {
        const quote = c;
        const openAt = i;
        i++;
        let inner = '';
        while (i < input.length && input[i] !== quote) { inner += input[i]; i++; }
        if (i >= input.length) throw new TaskQuerySyntaxError(`引号未闭合：${input.slice(openAt)}`);
        i++;
        text += inner;
        continue;
      }
      text += c;
      i++;
    }
    if (!text) throw new TaskQuerySyntaxError('存在空的查询项（引号内没有内容）');
    tokens.push({ kind: 'word', text });
  }
  return tokens;
}

/** 字段取值归一：状态/优先级接受中文别名；无法识别即语法错误（调用方降级并提示） */
function normalizeFieldValue(field: TaskQueryField, raw: string): string {
  const value = raw.trim();
  if (!value) throw new TaskQuerySyntaxError(`「${field}:」缺少取值`);
  if (field === 'project') return value;
  if (field === 'status') {
    const hit = STATUS_ALIASES[value.toLowerCase()];
    if (!hit) throw new TaskQuerySyntaxError(`status: 只支持 todo/done（收到「${value}」）`);
    return hit;
  }
  const hit = PRIORITY_ALIASES[value.toLowerCase()];
  if (!hit) throw new TaskQuerySyntaxError(`priority: 只支持 urgent/high/normal/low（收到「${value}」）`);
  return hit;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): TaskQueryNode {
    if (this.tokens.length === 0) throw new TaskQuerySyntaxError('查询为空');
    const node = this.parseOr();
    const rest = this.tokens[this.pos];
    if (rest) throw new TaskQuerySyntaxError(rest.kind === ')' ? '多余的右括号' : `无法解析「${rest.text}」`);
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isBool(token: Token | undefined, word: 'and' | 'or'): boolean {
    return token?.kind === 'word' && token.text.toLowerCase() === word;
  }

  private parseOr(): TaskQueryNode {
    const children: TaskQueryNode[] = [this.parseAnd()];
    while (this.isBool(this.peek(), 'or')) {
      this.pos++;
      children.push(this.parseAnd());
    }
    return children.length === 1 ? children[0] : { type: 'or', children };
  }

  private parseAnd(): TaskQueryNode {
    const children: TaskQueryNode[] = [this.parsePrimary()];
    for (;;) {
      const next = this.peek();
      if (!next || next.kind === ')' || this.isBool(next, 'or')) break;
      if (this.isBool(next, 'and')) this.pos++; // 显式 AND 与相邻词并列同义
      children.push(this.parsePrimary());
    }
    return children.length === 1 ? children[0] : { type: 'and', children };
  }

  private parsePrimary(): TaskQueryNode {
    const token = this.peek();
    if (!token) throw new TaskQuerySyntaxError('AND/OR 或括号后缺少查询项');
    if (token.kind === ')') throw new TaskQuerySyntaxError('多余的右括号');
    if (token.kind === '(') {
      this.pos++;
      if (this.peek()?.kind === ')') throw new TaskQuerySyntaxError('括号内为空');
      const node = this.parseOr();
      if (this.peek()?.kind !== ')') throw new TaskQuerySyntaxError('括号未闭合');
      this.pos++;
      return node;
    }
    if (this.isBool(token, 'and') || this.isBool(token, 'or')) {
      throw new TaskQuerySyntaxError(`「${token.text.toUpperCase()}」前后缺少查询项`);
    }
    this.pos++;
    const m = /^(status|priority|project):(.*)$/i.exec(token.text);
    if (!m) return { type: 'text', value: token.text };
    const field = m[1].toLowerCase() as TaskQueryField;
    return { type: 'field', field, value: normalizeFieldValue(field, m[2]) };
  }
}

export function parseTaskQuery(raw: string): TaskQueryParsed {
  const text = raw.trim();
  if (!text || !looksStructured(text)) return { mode: 'fuzzy', text, node: null };
  return { mode: 'structured', text, node: new Parser(tokenize(text)).parse() };
}

function escapeLike(value: string): string {
  return value.replaceAll(/[%_]/g, (m) => '\\' + m);
}

export interface TaskQuerySql {
  readonly where: string;
  readonly values: readonly unknown[];
}

/** 语法树 → 参数化 SQL（WHERE 片段，不含外层括号；由调用方 AND 进既有过滤条件） */
export function compileTaskQuery(node: TaskQueryNode): TaskQuerySql {
  if (node.type === 'text') {
    const kw = `%${escapeLike(node.value)}%`;
    return {
      // 编号也纳入：外部跳转以 task_no 作搜索词，只搜标题/描述会把目标行整条筛掉
      where: String.raw`(title LIKE ? ESCAPE '\' OR description LIKE ? ESCAPE '\' OR task_no LIKE ? ESCAPE '\')`,
      values: [kw, kw, kw],
    };
  }
  if (node.type === 'field') {
    if (node.field === 'status') return { where: 'status = ?', values: [node.value] };
    if (node.field === 'priority') return { where: 'priority = ?', values: [node.value] };
    const kw = `%${escapeLike(node.value)}%`;
    // SQLite 的 LIKE 对 ASCII 默认大小写不敏感，项目名匹配无需额外 COLLATE
    return {
      where: String.raw`project_id IN (SELECT id FROM projects WHERE name LIKE ? ESCAPE '\')`,
      values: [kw],
    };
  }
  const parts = node.children.map((child) => compileTaskQuery(child));
  return {
    where: `(${parts.map((p) => p.where).join(node.type === 'and' ? ' AND ' : ' OR ')})`,
    values: parts.flatMap((p) => p.values),
  };
}
