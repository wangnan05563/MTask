/**
 * 设置中心的数据迁移服务：全量导出 / 导入（另一台电脑重装时迁移用户数据用）。
 * - 导出：把所有业务表读成行，`task_images.data`(BLOB) 转 base64；`ai_tools` 的密文 API Key
 *   解密为明文（见下），便于跨机迁移后重新加密。
 * - 导入：校验 bundle 结构后按冲突策略写入；全部在单个事务内完成，失败整体回滚保证完整性。
 *   keep/merge 写 projects 前按 T02943 单源判据查重名（T02945）：撞重名的行按行跳过并点名，
 *   不整单失败——导入是恢复性操作，硬失败会让用户拿不到任何数据。
 *
 * 为什么 API Key 要导出明文：主密钥默认由本机名派生，换机后密钥不同、旧密文无法解密。
 * 故导出时解为明文，导入时用目标机的密钥重新加密；解密失败的行仅置空并提示重录。
 */
import { getDb } from '../db/connection';
import { encrypt, decrypt } from '../util/crypto';
import { findProjectNameOwners } from '../util/projectRouting'; // T02945：导入通道的重名查重复用 T02943 单源判据
import { cacheClear } from '../util/ttl-cache'; // T02945：导入是全覆盖写路径，收口时清集合缓存
import Database from 'better-sqlite3';

export type ImportMode = 'overwrite' | 'keep' | 'merge';

/**
 * T02945：导入时因项目名撞重被跳过的行明细（bundle 行名 ↔ 库内占用行 id）。
 * keep/merge 两条分支写 projects 前过 `findProjectNameOwners`（CI 口径，与新建/改名/恢复同判据），
 * 命中行不落库——导入是恢复性操作，硬失败会让用户拿不到任何数据，故按行跳过并点名，不整单失败。
 */
export type ImportNameConflict = {
  /** bundle 行里的项目名（原始写法，大小写与 bundle 一致） */
  name: string;
  /** bundle 行的 id（无 id 的行本就不会写，进不了冲突清单） */
  bundleRowId: string | null;
  /** 占用行（CI 判据命中，可能多行——含归档/历史快照行） */
  owners: Array<{ id: string; name: string }>;
};

/** 导入结果：`imported` 为实际写入行数；T02945 起并列透出重名跳过计数与明细 */
export type ImportResult = {
  imported: number;
  /** 因项目名撞重被跳过未导入的行数 */
  skippedDuplicateNames: number;
  /** 冲突明细（bundle 行名 ↔ 占用行 id），供事后核对 */
  nameConflicts: ImportNameConflict[];
};

interface ExportBundle {
  app: 'mtask';
  version: 1;
  exportedAt: string;
  data: Record<string, unknown[]>;
}

/** 覆盖模式清表顺序：子表先删，避免外键约束阻塞 */
const DELETE_ORDER = ['queue_jobs', 'task_images', 'prompts', 'task_categories', 'app_settings', 'tasks', 'queues', 'ai_tools', 'prompt_categories', 'projects'];
const INSERT_ORDER = ['projects', 'prompt_categories', 'ai_tools', 'queues', 'task_categories', 'app_settings', 'tasks', 'prompts', 'task_images', 'queue_jobs'];

const EXPORT_TABLES: (keyof ExportBundle['data'])[] = [
  'projects', 'prompt_categories', 'ai_tools', 'queues', 'task_categories', 'app_settings', 'tasks', 'prompts', 'task_images', 'queue_jobs',
];

/** ai_tools 导出行：api_key_enc(密文) → apiKey(明文)，供跨机后用目标机密钥重新加密 */
function aiToolExportRow(r: Record<string, unknown>): Record<string, unknown> {
  const { api_key_enc, ...rest } = r;
  let apiKey: string | null = null;
  // 显式收窄为 string 而非 String() 强转：密文列来自 SQLite 文本列，
  // 异常类型值直接按无密钥处理，避免被隐式转成 "[object Object]" 去解密
  if (typeof api_key_enc === 'string' && api_key_enc) {
    try { apiKey = decrypt(api_key_enc); } catch { /* 密钥不匹配时留空，提示重录 */ }
  }
  return { ...rest, apiKey };
}

/** 构造真正可写入 ai_tools 表的行：把导出行的 apiKey 明文重新加密回 api_key_enc */
function aiToolImportRow(r: Record<string, unknown>): Record<string, unknown> {
  const { apiKey, ...rest } = r;
  // 明文 key 仅接受 string，与导出行结构一一对应，避免隐式对象字符串化
  const enc = typeof apiKey === 'string' && apiKey ? encrypt(apiKey) : null;
  return { ...rest, api_key_enc: enc };
}

/**
 * 导出配置包。默认全量（与历史行为一致，供「导出配置」按钮使用）。
 *
 * 传入 tables 时只导出白名单内的子集——用于「只看/只迁移配置类表」等场景（显著减小体积：
 * 全量包中 task_images 的 base64 二进制往往是体积大头）。
 * ⚠️ 子集包**不满足 importBundle 的 CORE_TABLES 校验**，仅作查看/局部迁移用途，不能直接整体回导。
 */
export async function exportBundle(tables?: string[]): Promise<ExportBundle> {
  const db = getDb();
  const requested = tables?.length
    ? EXPORT_TABLES.filter((t) => tables.includes(t))
    : EXPORT_TABLES;
  const data: ExportBundle['data'] = {} as ExportBundle['data'];
  for (const table of requested) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    data[table] = rows.map((r) => {
      if (table === 'task_images') return { ...r, data: r.data instanceof Buffer ? r.data.toString('base64') : r.data };
      if (table === 'ai_tools') return aiToolExportRow(r);
      return r;
    });
    // T00789 建议②：每导完一表让出事件循环，把单次同步阻塞切成多段，
    // 避免全量导出（实测 4.4MB / 122ms）长时间占住主线程拖慢无关请求。
    await new Promise<void>((r) => setImmediate(r));
  }
  return { app: 'mtask', version: 1, exportedAt: new Date().toISOString(), data };
}

/** 合法导出表名白名单（供路由校验 ?tables=，拒绝未知表名而非静默忽略） */
export function isExportTable(name: string): boolean {
  return EXPORT_TABLES.includes(name);
}

/** 结构校验：仅对 bundle 大纲做防御性检查，避免导入任意/损坏文件破坏库 */
/** 核心表：导入时必须存在；其余表（如新版本的 task_categories）缺失时按空处理，兼容旧备份文件 */
const CORE_TABLES = ['projects', 'tasks', 'ai_tools', 'prompts', 'prompt_categories', 'queues', 'queue_jobs', 'task_images'];

function validateBundle(b: unknown): b is ExportBundle {
  if (!b || typeof b !== 'object') return false;
  const bundle = b as ExportBundle;
  if (bundle.app !== 'mtask' || bundle.version !== 1 || !bundle.data || typeof bundle.data !== 'object') return false;
  return CORE_TABLES.every((t) => Array.isArray(bundle.data[t]));
}

/**
 * 逐行 upsert（以主键 id 判断）：存在则更新各列，不存在则插入。
 * 仅做列级更新（不删除），因此不会触发被引用行的外键约束问题。
 */
function upsertRows(db: Database.Database, table: string, rows: unknown[], mode: 'keep' | 'merge'): number {
  let touched = 0;
  // app_settings 是 KV 表、主键列为 key；其余业务表统一主键为 id。
  // 统一对任一表按 `WHERE id` 预编译会导致 prepare 阶段报 "no such column: id"，
  // 故按表确定主键列，exists / update / 去重判断均以该列为准。
  const keyCol: string = table === 'app_settings' ? 'key' : 'id';
  const existsStmt = db.prepare(`SELECT 1 FROM ${table} WHERE ${keyCol} = ?`);
  const insert = (row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    const sql = `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    db.prepare(sql).run(...cols.map((c) => row[c]));
  };
  const update = (row: Record<string, unknown>) => {
    const cols = Object.keys(row).filter((c) => c !== keyCol);
    if (cols.length === 0) return;
    // SET 子句先独立拼接，避免模板字面量嵌套（嵌套模板难以阅读且易漏转义）
    const setSql = cols.map((c) => `${c} = ?`).join(', ');
    const sql = `UPDATE ${table} SET ${setSql} WHERE ${keyCol} = ?`;
    db.prepare(sql).run(...cols.map((c) => row[c]), row[keyCol]);
  };
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    if (row[keyCol] == null) continue;
    const exists = existsStmt.get(row[keyCol]);
    if (mode === 'keep') {
      if (exists) continue; // 保留：已有主键跳过
    } else if (exists) {
      update(row); // 合并：覆盖已存在主键的更新列
    }
    insert(row);
    touched++;
  }
  return touched;
}

/**
 * T02945：keep/merge 分支写 `projects` 前的重名查重（T02943 单源判据的第四条通道——
 * 新建/改名/快照恢复已收口，数据导入是最后一条绕过它的产生侧）。
 *
 * 判定用 `findProjectNameOwners`（CI + 两侧 TRIM，含归档区与历史快照行），
 * **不在本文件再抄一份 SQL**（T02938 的教训就是 8 份抄本各自演化）。
 * `excludeId=bundle 行 id`：merge 更新已有行时，改成自己的名字不算撞名。
 * keep 模式下「id 已存在」的行本就会被 `upsertRows` 跳过（不写），无需查重——
 * 否则会把没打算写的行也算进冲突计数，响应计数失真。
 *
 * 处置口径（任务裁定 A）：命中行**跳过并记冲突**，不整单失败——导入是恢复性操作，
 * 硬失败会让用户拿不到任何数据；冲突明细在响应里点名「bundle 行名 ↔ 占用行 id」。
 */
function filterProjectRows(
  db: Database.Database,
  rows: unknown[],
  mode: 'keep' | 'merge',
): { accepted: unknown[]; conflicts: ImportNameConflict[] } {
  const conflicts: ImportNameConflict[] = [];
  const accepted: unknown[] = [];
  const existsStmt = db.prepare('SELECT 1 FROM projects WHERE id = ?');
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const rowId = typeof row.id === 'string' ? row.id : null;
    const name = typeof row.name === 'string' ? row.name : '';
    if (mode === 'keep' && rowId && existsStmt.get(rowId)) continue; // 本就不会写，无需查重
    const owners = findProjectNameOwners(name, { excludeId: rowId ?? undefined }, db);
    if (owners.length > 0) {
      conflicts.push({
        name,
        bundleRowId: rowId,
        owners: owners.map((o) => ({ id: o.id, name: o.name })),
      });
      continue;
    }
    accepted.push(raw);
  }
  return { accepted, conflicts };
}

/** 导入 */
export function importBundle(b: unknown, mode: ImportMode): ImportResult {
  if (!validateBundle(b)) throw new Error('导入文件无效或格式不受支持');
  const db = getDb();
  const nameConflicts: ImportNameConflict[] = [];
  const imported = db.transaction(() => {
    if (mode === 'overwrite') {
      // 先清空全部业务表（子表先删保证外键安全），再按父表顺序重插。
      // overwrite 不查重：清表后库内没有任何占用行，bundle 内部重名是 bundle 自身的问题
      // （T02945 任务明确该模式「只要自身内部不重名就不会新增重名行」，维持原语义）。
      for (const t of DELETE_ORDER) db.prepare(`DELETE FROM ${t}`).run();
      let n = 0;
      for (const t of INSERT_ORDER) {
        if (!Array.isArray(b.data[t])) continue; // 兼容旧备份缺少新增表
        n += insertAll(db, t, b.data[t]);
      }
      return n;
    }
    // keep / merge：不改动现有多余数据的差异删减，仅按策略合并导入行
    let n = 0;
    for (const t of EXPORT_TABLES) {
      if (!Array.isArray(b.data[t])) continue; // 兼容旧备份缺少新增表
      const rows = normalize(db, t, b.data[t]);
      if (t === 'projects') {
        // T02945：导入通道的最后一条重名产生侧——写 projects 前过单源判据，冲突行跳过并点名
        const { accepted, conflicts } = filterProjectRows(db, rows, mode);
        nameConflicts.push(...conflicts);
        n += upsertRows(db, t, accepted, mode);
        continue;
      }
      n += upsertRows(db, t, rows, mode);
    }
    return n;
  })();
  // T02945 附带收口：导入（含 keep/merge 的部分写）此前不清集合缓存，而仓内约定是「写端点主动
  // cacheClear」——projects 等列表有 5s TTL 兜底，但导入后立刻看列表会看到导入前的旧数据
  // （T02945 门 R-05 实测）。清全部集合缓存：导入可能改任意业务表，保守全清（TTL 仅 5s，代价可忽略）。
  cacheClear();
  return { imported, skippedDuplicateNames: nameConflicts.length, nameConflicts };
}

/** 按目标表规范化导入行（base64 → Buffer 解码、明文 key → 密文），并插入 */
function insertAll(db: Database.Database, table: string, rows: unknown[]): number {
  if (table === 'task_images') {
    const ins = db.prepare('INSERT OR IGNORE INTO task_images (id, task_id, mime_type, data, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows as Record<string, unknown>[]) {
      if (typeof r.id !== 'string') continue;
      // 图片 data 仅接受 string（base64），异常类型按空图处理而非隐式 "[object Object]"
      const data = typeof r.data === 'string' ? r.data : '';
      ins.run(r.id, r.task_id, r.mime_type, Buffer.from(data, 'base64'), r.created_at);
    }
    return rows.length;
  }
  if (table === 'ai_tools') {
    const dbRows = (rows as Record<string, unknown>[]).map(aiToolImportRow);
    return insertGeneric(db, 'ai_tools', dbRows);
  }
  return insertGeneric(db, table, rows as Record<string, unknown>[]);
}

/** 通用插入：以行键为列名 */
function insertGeneric(db: Database.Database, table: string, rows: Record<string, unknown>[]): number {
  let n = 0;
  for (const r of rows) {
    if (typeof r.id !== 'string') continue;
    const cols = Object.keys(r);
    const sql = `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    db.prepare(sql).run(...cols.map((c) => r[c]));
    n++;
  }
  return n;
}

/** 归一化：把导入行规整为可直接写库的形态（base64 图片→ Buffer、明文 key→ 密文） */
function normalize(db: Database.Database, table: string, rows: unknown[]): unknown[] {
  if (table === 'task_images') {
    // 校验 base64 合法性：解码再回卷不相等即为损坏数据，置空该图（保留记录、丢图）而非写入乱码
    return (rows as Record<string, unknown>[]).map((r) => {
      // data 仅接受 string；replaceAll 需全局正则，语义与原 replace(/\s+/g) 一致
      const b64 = (typeof r.data === 'string' ? r.data : '').replaceAll(/\s+/g, '');
      let buf = Buffer.alloc(0);
      try {
        const decoded = Buffer.from(b64, 'base64');
        if (decoded.toString('base64').replace(/=+$/, '') === b64.replace(/={0,3}$/, '')) buf = decoded;
      } catch { /* 非法 base64 → 保留空缓冲 */ }
      return { ...r, data: buf };
    });
  }
  if (table === 'ai_tools') return (rows as Record<string, unknown>[]).map(aiToolImportRow);
  return rows;
}