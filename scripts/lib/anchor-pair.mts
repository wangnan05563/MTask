/**
 * 验收门断言配对器（T02293 · `docs/验收门判据规约.md` 判据 3 的落地形态）。
 *
 * 规约判据 3 要求：确需保留字面锚点（中文文案、错误消息前缀）时，必须配一条同义行为断言兜底，
 * 且**只在行为断言通过时才算绿**。光写 `ok(name, behavior && literal)` 虽然也是「都过才绿」，
 * 但红的时候读不出是「功能失守」还是「等价重构换了措辞」——后者要人来判定改锚还是改码，
 * 前者要立刻修功能。本模块把这两种红因分开落账，红项自带 `红因` 字段。
 *
 * 语义（与规约逐句对齐）：
 *  - 行为断言 false / 抛错 ⇒ 该条 FAIL，红因「行为失守」（字面锚点不再单独决定结果）；
 *  - 行为断言 true 而字面锚点 false / 抛错 ⇒ 该条 FAIL，红因「字面锚点失配（行为在）」；
 *  - 两者都 true ⇒ PASS。
 * 抛错按「未通过」处理并记入红因：锚点计算本身崩了不能算绿。
 *
 * 用法：`okPair(ok, 'R-07 未知版本 → 400', () => resp.status === 400, () => /未知导出版本/.test(msg), () => ({ msg }))`
 * 传进去的是**取值函数**（惰性），因此行为侧与字面侧各自只在自己的异常域里失败。
 */

type OkFn = (name: string, cond: boolean, extra?: unknown) => void;

interface Probe {
  passed: boolean;
  threw?: string;
}

function probe(fn: () => boolean): Probe {
  try {
    return { passed: fn() === true };
  } catch (e) {
    return { passed: false, threw: e instanceof Error ? e.message : String(e) };
  }
}

/** 行为断言 + 字面锚点配对：红因可区分，绿必须两个都绿 */
export function okPair(
  ok: OkFn,
  label: string,
  behavior: () => boolean,
  literal: () => boolean,
  ctx?: () => unknown,
): void {
  const b = probe(behavior);
  if (!b.passed) {
    ok(label, false, { 红因: b.threw ? `行为断言抛错：${b.threw}` : '行为失守（功能未达成，与文案无关）', ...(ctx ? { 证据: ctx() } : {}) });
    return;
  }
  const l = probe(literal);
  ok(
    label,
    l.passed,
    l.passed ? undefined : { 红因: l.threw ? `字面锚点抛错：${l.threw}` : '字面锚点失配（行为在）——等价重构或文案变更，需人工判定改锚还是改码', ...(ctx ? { 证据: ctx() } : {}) },
  );
}
