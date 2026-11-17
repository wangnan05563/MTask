/**
 * T02120（PRD §12-R1 后半）：估算参数「改值留痕」。
 *
 * 口径（与 `.workbuddy/t02120-e2e.mjs` 的 33 条断言一一对应）：
 * - 只记**实际发生变化的键**：同值重写 logged=0，审计面不产噪声；
 * - 旧值取自调用方传入的「改前 KV 原件」（未合并本次写入），新值取自本次写入 —— 不为留痕开第二套数；
 * - `effective` 快照由调用方已算好的**同一份** `resolveEstimateConfig` 生效结果裁剪（人月标准 / 每天小时 / Σ系数）；
 * - 越界被拒的 PUT 在 `resolveEstimateConfig` 就抛出，压根走不到这里，所以「零写入」与「零留痕」是同一件事；
 * - 写入与留痕由调用方放在同一事务里（`estimates.ts` PUT），不存在「改了却没留痕」的中间态。
 *
 * 消费面只有一个：`GET /api/estimates/params` 的 `logs` 字段（最近 50 条，新→旧），
 * §11-E13 参数页的「改值历史」区直接读它，不再另开端点。
 */
import { getDb } from '../db/connection';
import { v4 as uuid } from 'uuid';
import { ESTIMATE_COEF_KEYS, type EstimateConfig } from './estimate-engine';

export interface EstimateParamLogRow {
  id: string;
  project_id: string;
  actor: string;
  key: string;
  old_value: string;
  new_value: string;
  /** JSON 字符串：{ manDaysPerManMonth, hoursPerManDay, coefSum } */
  effective: string;
  created_at: string;
}

/** 与 `GET /params` 的展示口径一致：留痕只给最近 50 条 */
const LIST_LIMIT = 50;

function now(): string {
  return new Date().toISOString();
}

/**
 * Σ系数按两位小数落盘：0.06+0.06+0.05+0.06 在 IEEE754 下是 0.22999999999999998，
 * 直接进快照会让「同一次改值」在不同调用路径下写出两种字符串，审计件失去可复现性。
 */
function effectiveSnapshot(config: EstimateConfig): string {
  const coefSum = Math.round(ESTIMATE_COEF_KEYS.reduce((a, k) => a + config.coefs[k], 0) * 100) / 100;
  return JSON.stringify({
    manDaysPerManMonth: config.manDaysPerManMonth,
    hoursPerManDay: config.hoursPerManDay,
    coefSum,
  });
}

export const EstimateParamLogService = {
  /**
   * 逐键比对「改前原件 → 本次写入」，只为真正变化的键落一条。
   * @param before 改前 KV 原件（`readKv` 结果，未合并本次写入）
   * @param written 本次写入的键值对（含显式清空 = 空串）
   * @param config 写后回读的生效值（与响应体 config 同一份）
   * @returns 本次实际留痕条数
   */
  recordChanges(
    projectId: string,
    actor: string,
    before: Record<string, string | null>,
    written: Array<[string, string]>,
    config: EstimateConfig,
  ): number {
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO estimate_param_logs (id, project_id, actor, key, old_value, new_value, effective, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const t = now();
    const effective = effectiveSnapshot(config);
    let logged = 0;
    for (const [key, value] of written) {
      const oldValue = before[key] ?? '';
      if (oldValue === value) continue; // no-op 不产噪声
      insert.run(uuid(), projectId, actor, key, oldValue, value, effective, t);
      logged += 1;
    }
    return logged;
  },

  /** 改值历史（新→旧）。同一次多键 PUT 的几条时间戳相同，用 rowid 兜住顺序确定性。 */
  list(projectId: string, limit = LIST_LIMIT): EstimateParamLogRow[] {
    return getDb()
      .prepare(
        `SELECT * FROM estimate_param_logs WHERE project_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(projectId, limit) as EstimateParamLogRow[];
  },
};
