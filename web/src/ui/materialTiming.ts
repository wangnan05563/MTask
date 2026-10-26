import { api } from '../api/client';

/**
 * 汇报材料耗时埋点（T03189 / PRD G-1）。
 *
 * 采样口径与 `server/src/services/MaterialTimingService.ts` 对齐：
 * 卡片展开即开始、成品下载成功才收口；同一卡片未收口前重复 start 复用同一样本（重试计入时长）。
 * 样本 id 存 sessionStorage（跨面板卸载/重挂仍能收口），失败全部静默——
 * 埋点不该干扰材料生成主流程。
 */

export type MaterialCardKey = 'offline-report' | 'ai-report' | 'kickoff-ppt' | 'summary-ppt';

const ID_PREFIX = 'materialTiming.id.';

function setSampleId(cardKey: MaterialCardKey, id: string): void {
  try { sessionStorage.setItem(ID_PREFIX + cardKey, id); } catch { /* 配额异常忽略 */ }
}

function takeSampleId(cardKey: MaterialCardKey): string {
  try {
    const id = sessionStorage.getItem(ID_PREFIX + cardKey) ?? '';
    sessionStorage.removeItem(ID_PREFIX + cardKey);
    return id;
  } catch { return ''; }
}

/** 卡片展开：开始计时（幂等，重复调用复用未收口的样本） */
export async function startMaterialTiming(cardKey: MaterialCardKey, projectId?: string | null): Promise<void> {
  try {
    const r = await api.post<{ id: string }>('/report/material-timing/start', { cardKey, projectId: projectId || undefined });
    if (r?.id) setSampleId(cardKey, r.id);
  } catch { /* 埋点失败不影响主流程 */ }
}

/** 下载成功（或放弃）时收口；`ok=false` 用于放弃/失败样本（只计放弃率，不进 P50/P90） */
export async function finishMaterialTiming(cardKey: MaterialCardKey, ok = true): Promise<void> {
  const id = takeSampleId(cardKey);
  // 没有本窗口的样本 id 就不发请求：服务端「按卡种找最近未收口」是给无 sessionStorage 的调用方用的，
  // 本窗口贸然走兜底会把另一个窗口刚开的样本提前收口。
  if (!id) return;
  try {
    await api.post('/report/material-timing/finish', { cardKey, id, ok });
  } catch { /* 同上 */ }
}
