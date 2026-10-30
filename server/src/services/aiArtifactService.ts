/**
 * T03240（PRD AI-101 ④）：AI 产物找回登记。
 *
 * 报表下载走「临时令牌 → 下载即删」，令牌文件活不过一次下载；而 ④ 要求
 * 「刷新或重进后可从任务记录恢复」——所以成功产物的**持久副本**另存
 * `DATA_DIR/artifacts/<cardKey>/<filename>`，并在 `ai_artifacts` 表留一行。
 * 临时令牌链路（isReportToken / TTL 清扫）保持不变，两套存储互不接管：
 * 下载仍走令牌（下载即删），找回走持久副本（每卡保留最近 N 份）。
 */
import { getDb } from '../db/connection';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 每卡保留的持久副本份数——产物是演示稿/报表，过多久留只会吃盘 */
export const ARTIFACT_KEEP_PER_CARD = 20;

function dataDir(): string {
  return process.env.MTask_DATA_DIR ?? join(__dirname, '..', 'data');
}

/** 产物根目录（应用数据目录内，随数据目录一起备份/迁移） */
export function artifactRoot(): string {
  const dir = join(dataDir(), 'artifacts');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 卡片键做目录名：只允许安全字符，避免 ai.weekly_report 之外的键带出路径分隔符 */
function safeKey(cardKey: string): string {
  return cardKey.replaceAll(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
}

export interface AiArtifact {
  id: string;
  cardKey: string;
  filename: string;
  path: string;
  createdAt: string;
  /** 生成时的溯源行（JSON 原文）——找回时连「依据」一起恢复，而不只是一个文件名 */
  provenance?: string | null;
}

export interface AiArtifactView extends AiArtifact {
  /** 文件是否还在盘上（用户手工删除/清理后置 false，界面照实提示而非给死链） */
  exists: boolean;
  /** 解析后的溯源（坏 JSON 时为 null，不因历史脏数据把找回入口拖崩） */
  provenanceView: unknown;
}

/** 登记一次成功产物：写持久副本 + 落库 + 按卡裁剪旧份数 */
export function recordArtifact(args: { cardKey: string; filename: string; buffer: Buffer; provenance?: unknown }): AiArtifact {
  const dir = join(artifactRoot(), safeKey(args.cardKey));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, args.filename);
  writeFileSync(path, args.buffer);
  const row: AiArtifact = {
    id: randomUUID(),
    cardKey: args.cardKey,
    filename: args.filename,
    path,
    createdAt: new Date().toISOString(),
    provenance: args.provenance ? JSON.stringify(args.provenance) : null,
  };
  const db = getDb();
  db.prepare('INSERT INTO ai_artifacts (id, card_key, filename, path, created_at, provenance) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.id, row.cardKey, row.filename, row.path, row.createdAt, row.provenance);
  trimOld(args.cardKey);
  return row;
}

/** 超出保留份数的旧产物：先删文件再删行（文件删失败也删行，否则永远卡在超限态） */
function trimOld(cardKey: string): void {
  const db = getDb();
  const extra = db.prepare(
    `SELECT id, path FROM ai_artifacts WHERE card_key = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
  ).all(cardKey, ARTIFACT_KEEP_PER_CARD) as Array<{ id: string; path: string }>;
  for (const e of extra) {
    try { unlinkSync(e.path); } catch { /* 已被手工删除 */ }
    db.prepare('DELETE FROM ai_artifacts WHERE id = ?').run(e.id);
  }
}

/** 某卡最近 N 份产物（界面「从任务记录恢复」用），带文件是否仍在 */
export function listArtifacts(cardKey: string, limit = 5): AiArtifactView[] {
  const rows = getDb().prepare(
    `SELECT id, card_key AS cardKey, filename, path, created_at AS createdAt, provenance
       FROM ai_artifacts WHERE card_key = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(cardKey, Math.max(1, Math.min(50, limit))) as AiArtifact[];
  return rows.map((r) => ({ ...r, exists: existsSync(r.path), provenanceView: parseProvenance(r.provenance) }));
}

/** 溯源 JSON 解析：坏数据返回 null（历史行可能来自旧版本，不因此让找回入口报错） */
function parseProvenance(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}
