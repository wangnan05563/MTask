/**
 * T03268（PRD 4.2 / D-12）：项目级时区解析单源。
 *
 * 口径：
 *  - `projects.timezone` 空串＝跟随系统时区；配置了 IANA 时区名则以项目时区为准；
 *  - 非法/失效时区名（历史脏数据）回落系统时区，不让报表入口因一条坏配置直接 500；
 *  - 校验用 `Intl.DateTimeFormat` 的真实构造，不靠正则枚举——夏令时、别名（Asia/Calcutta 等）
 *    由运行时 ICU 判定。
 */
import { getDb } from '../db/connection';
import { systemTz } from '../util/workdays';

export interface ResolvedTz {
  tz: string;
  source: 'project' | 'system';
}

/** 运行时能否识别该 IANA 时区名 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 单项目报表/预测的业务日时区：项目配置优先，空/非法回落系统时区 */
export function resolveProjectTz(projectId?: string | null): ResolvedTz {
  if (projectId) {
    const row = getDb().prepare('SELECT timezone FROM projects WHERE id = ?').get(projectId) as { timezone?: string | null } | undefined;
    const configured = (row?.timezone ?? '').trim();
    if (configured && isValidTimeZone(configured)) return { tz: configured, source: 'project' };
  }
  return { tz: systemTz(), source: 'system' };
}
