/**
 * T01061-FR5.1：数据库自动备份与恢复。
 *
 * - 启动时检查当天是否已有备份，没有则自动执行一次（fire-and-forget）；此后每小时检查日期翻转。
 * - 备份用 better-sqlite3 的 online backup API（db.backup(dest)），运行中备份一致性由 SQLite 保证，无需停机。
 * - 保留最近 KEEP 份（默认 14），超出自动删除最旧。
 * - 恢复：打开快照（只读）→ 反向 online backup 覆盖主库——主库连接无需关闭/重启，恢复后数据即时可见。
 * - 备份失败仅记录日志与 lastError，不阻塞主流程（FR-5.1 验收：失败有告警）。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dbFilePath, getDb } from '../db/connection';

const KEEP = 14;
const FILE_RE = /^mtask-backup-\d{8}-\d{6}\.db$/;

/** 主库文件路径（connection.dbFilePath 单一来源） */
export function mainDbPath(): string {
  return dbFilePath();
}

export function backupDir(): string {
  return path.join(path.dirname(mainDbPath()), 'backups');
}

export interface BackupMeta {
  name: string;
  size: number;
  mtime: string;
}

/** 最近一次自动/手动备份的结果记录（供设置页展示状态） */
let lastRun: { file: string; at: string; reason: string } | null = null;
let lastError: string | null = null;

export function backupStatus(): { lastRun: typeof lastRun; lastError: string | null; keep: number } {
  return { lastRun, lastError, keep: KEEP };
}

function ensureDir(): string {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pruneOld(dir: string): void {
  const files = fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
  while (files.length > KEEP) {
    const oldest = files.shift();
    if (!oldest) break;
    try { fs.unlinkSync(path.join(dir, oldest)); } catch { /* 删除失败不阻断（下次再清） */ }
  }
}

/** 执行一次备份（online backup，返回目标文件名） */
export async function runBackup(reason: 'auto' | 'manual'): Promise<{ name: string; size: number }> {
  const dir = ensureDir();
  const stamp = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const name = `mtask-backup-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.db`;
  const dest = path.join(dir, name);
  try {
    await getDb().backup(dest);
    const size = fs.statSync(dest).size;
    lastRun = { file: name, at: stamp.toISOString(), reason };
    lastError = null;
    pruneOld(dir);
    console.log(`[backup] ${reason} 备份完成: ${name} (${size} bytes)`);
    return { name, size };
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error(`[backup] 备份失败（${reason}）:`, lastError);
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* 清理半成品失败忽略 */ }
    throw new Error(`备份失败：${lastError}`);
  }
}

/** 列出备份文件（新→旧） */
export function listBackups(): BackupMeta[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort().reverse().map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { name, size: st.size, mtime: st.mtime.toISOString() };
  });
}

/** 恢复：从快照反向 online backup 覆盖主库（主库连接保持打开，恢复后数据即时可见） */
export async function restoreBackup(name: string): Promise<void> {
  if (!FILE_RE.test(name)) throw new Error('非法的备份文件名');
  const src = path.join(backupDir(), name);
  if (!fs.existsSync(src)) throw new Error('备份文件不存在');
  // 恢复前先做一次当前状态备份（防误恢复丢失现场，保留在轮转窗口内可回退）
  await runBackup('auto');
  const snap = new Database(src, { readonly: true });
  try {
    await snap.backup(mainDbPath());
  } finally {
    snap.close();
  }
  console.log(`[backup] 已从快照恢复: ${name}`);
}

/** 每日自动备份入口：今天（本地日期）尚无备份文件时执行一次 */
export function maybeDailyBackup(): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const prefix = `mtask-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const dir = backupDir();
    const has = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith(prefix));
    if (!has) void runBackup('auto').catch(() => { /* 失败已记 lastError/日志 */ });
  } catch (e) {
    console.error('[backup] 每日备份检查失败:', e);
  }
}

/** 每小时检查一次日期翻转（跨天后自动备份当天第一份） */
export function startDailyBackupTimer(): void {
  setInterval(maybeDailyBackup, 3600000);
  maybeDailyBackup();
}
