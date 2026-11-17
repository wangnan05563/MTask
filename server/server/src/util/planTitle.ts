/**
 * T01875：计划条目撞名时的「区分后缀」。
 * 与 T01867/T01921 的需求编号顺延同构——**已有条目一律不动**，让新行换个可辨识的标题，
 * 不再出现两行并排同名（重导同一份 PRD 时曾被读成「原有任务被重置」）。
 * 后缀用全角括号 `（N）`，从 2 起，跳过项目内已占用（含本批内已生成）的标题。
 */
export function nextPlanTitle(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}（${n}）`)) n += 1;
  return `${base}（${n}）`;
}
