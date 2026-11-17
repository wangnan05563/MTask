/**
 * T03274（UX-14③④）：覆盖式迁移前的可恢复快照。
 *
 * 覆盖导入会先清空全部业务表；此前界面只写「不可恢复」，没有任何现场副本。
 * 这里复用 T01061 的 online backup（运行中一致性由 SQLite 保证），把「先备份、再覆盖」
 * 变成硬前置：快照失败即中止导入，并给出可执行的恢复指引，避免用户在半途状态里失去现场。
 */
import { runBackup } from './BackupService';

/** 快照失败：路由据此返回 409（不是用户输入错误，而是服务端保护性中止） */
export class MigrationSnapshotError extends Error {
  readonly code = 'MIGRATION_SNAPSHOT_FAILED';
}

export interface MigrationSnapshot {
  readonly name: string;
  readonly size: number;
}

/**
 * 覆盖导入前创建快照。失败一律转成带恢复指引的中文错误——
 * 原始原因（磁盘满/权限/目录占位）一并带出，用户才知道该清盘还是改权限。
 */
export async function createMigrationSnapshot(): Promise<MigrationSnapshot> {
  try {
    return await runBackup('auto');
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new MigrationSnapshotError(
      `覆盖导入已中止：迁移前快照创建失败（${reason}）。`
      + '当前数据未被改动。请先到「设置 → 数据维护」手动备份，或清理磁盘空间/备份目录权限后重试。',
    );
  }
}
