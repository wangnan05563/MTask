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
// T04130（PRD MEM-104）：memories 必须同时进三张顺序表——漏 EXPORT_TABLES 导出不含记忆、
// 漏 INSERT_ORDER overwrite 清空后不恢复（记忆丢失）、漏 DELETE_ORDER 旧记忆残留+新记忆再插（记忆翻倍）。
// 无外键 ⇒ 表内位置任意，统一放末尾。
const DELETE_ORDER = ['queue_jobs', 'task_images', 'prompts', 'task_categories', 'app_settings', 'tasks', 'queues', 'ai_tools', 'prompt_categories', 'projects', 'memories', 'memory_review_log'];
const INSERT_ORDER = ['projects', 'prompt_categories', 'ai_tools', 'queues', 'task_categories', 'app_settings', 'tasks', 'prompts', 'task_images', 'queue_jobs', 'memories', 'memory_review_log'];

// T04158（MEM-604/F8）：评审记录随包往返——抽样评审是 Phase 1 发布判据的回归基线，换机不能丢。
// memory_review_queue 的同类缺口由 T04485 跟踪，本表不与它混签。
const EXPORT_TABLES: (keyof ExportBundle['data'])[] = [
  'projects', 'prompt_categories', 'ai_tools', 'queues', 'task_categories', 'app_settings', 'tasks', 'prompts', 'task_images', 'queue_jobs', 'memories', 'memory_review_log',
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
 * 导出行的字段整形。一次性 bundle 与流式切片**必须共用这一份**：两条路径产出的行 JSON
 * 若分叉（例如 base64 只在一边做），换机恢复时就会出现「同一张表按调用路径拿到不同字节」。
 */
function exportRow(table: string, r: Record<string, unknown>): Record<string, unknown> {
  if (table === 'task_images') return { ...r, data: r.data instanceof Buffer ? r.data.toString('base64') : r.data };
  if (table === 'ai_tools') return aiToolExportRow(r);
  return r;
}

/**
 * 导出配置包。默认全量（与历史行为一致，供「导出配置」按钮使用）。
 *
 * 传入 tables 时只导出白名单内的子集——用于「只看/只迁移配置类表」等场景（显著减小体积：
 * 全量包中 task_images 的 base64 二进制往往是体积大头）。
 * ⚠️ 子集包**不满足 importBundle 的 CORE_TABLES 校验**，仅作查看/局部迁移用途，不能直接整体回导。
 *
 * 用途限定：这条一次性物化的路径留给 **MCP `mtask_export_data`**（调用方要的就是一个 JS 对象）。
 * HTTP `GET /api/settings/export` 已改走 {@link exportBundleChunks}（M2-a），因为全量包在实测库上是
 * 52.7MB 文本 / 24,507 行，整体物化 + `res.json` 一次 stringify 的冷堆峰值实测 +175MB。
 */
export async function exportBundle(tables?: string[]): Promise<ExportBundle> {
  const db = getDb();
  const data: ExportBundle['data'] = {} as ExportBundle['data'];
  for (const table of requestedExportTables(tables)) {
    data[table] = (db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]).map((r) => exportRow(table, r));
    // T00789 建议②：每导完一表让出事件循环，把单次同步阻塞切成多段，
    // 避免全量导出长时间占住主线程拖慢无关请求。
    await new Promise<void>((r) => setImmediate(r));
  }
  return { app: 'mtask', version: 1, exportedAt: new Date().toISOString(), data };
}

/** 白名单交集（保持 EXPORT_TABLES 的顺序——bundle 的表序是导出文件版面的一部分，不能随入参顺序变） */
function requestedExportTables(tables?: string[]): string[] {
  return tables?.length ? EXPORT_TABLES.filter((t) => tables.includes(t)) : EXPORT_TABLES;
}

/**
 * 流式切片的双阈值：行数上限管住「多而小的行」（tasks 10,322 行），字节上限管住「少而大的行」
 * （task_images 只有 56 行，但 base64 单行 ~570KB——只按行数切会让整张 32MB 表挤成一片，
 * 既不放行事件循环，也正好把体积大头变成一次性驻留）。
 * 单个超阈值的行无法再切（那是一行 JSON），所以字节上限是「每片之间必让出」，不是「每片不超过」。
 */
const EXPORT_CHUNK_ROWS = 200;
const EXPORT_CHUNK_BYTES = 256 * 1024;

/**
 * M2-a：逐行流式产出 bundle 的 JSON 切片。
 *
 * 拼接所有片段的字符串，与 `JSON.stringify(await exportBundle())` **逐字节相同**（除 exportedAt 时刻），
 * 取证见 perf/m2/stream-proto.mts（三方 keep 趟 55,286,761B 全等）。契约不变 ⇒ 前端与既有门无需改。
 *
 * 为什么切片而不是整包：全量导出的成本大头不是 CPU（逐行 stringify 合计 271.8ms，反而比整体
 * 一次 stringify 的 374.7ms 更省），而是**整对象图 + 整串文本同时驻留**。逐行 iterate 让峰值
 * 从整库降为一行，同时首字节从「整个 bundle 造完」提前到第一个切片。
 *
 * 代价（要如实登记）：`iterate()` 在读完前持有 SQLite 读语句，WAL 下这会在导出期间推迟 checkpoint
 * 完成；加上套接字背压（调用方等 drain），慢客户端会把这段拉长。导出受并发闸保护且是低频操作，
 * 但导出时长与 WAL 增长是这条路径的新变量。
 */
export async function* exportBundleChunks(tables?: string[]): AsyncGenerator<string, void, unknown> {
  const db = getDb();
  const requested = requestedExportTables(tables);
  yield `{"app":"mtask","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"data":{`;
  for (let ti = 0; ti < requested.length; ti++) {
    const table = requested[ti];
    // 表间分隔由本片的第一个字符承担：首表不带逗号，其后各表带
    yield `${ti ? ',' : ''}${JSON.stringify(table)}:[`;
    const it = db.prepare(`SELECT * FROM ${table}`).iterate() as unknown as IterableIterator<Record<string, unknown>>;
    let firstChunk = true;
    let buf: string[] = [];
    let bufBytes = 0;
    try {
      for (const row of it) {
        const json = JSON.stringify(exportRow(table, row));
        buf.push(json);
        bufBytes += json.length;
        if (buf.length >= EXPORT_CHUNK_ROWS || bufBytes >= EXPORT_CHUNK_BYTES) {
          yield `${firstChunk ? '' : ','}${buf.join(',')}`;
          firstChunk = false;
          buf = [];
          bufBytes = 0;
          // 每片让出一次事件循环：分表让出（T00789②）的粒度是 800ms 级的 tasks，
          // 这里把它切成「200 行或 256KB」一段，才是并发下真正不独占主线程的形态
          await new Promise<void>((r) => setImmediate(r));
        }
      }
    } finally {
      // 提前退出（调用方 break/抛错/客户端断开）必须显式收尾，否则读语句悬挂、WAL checkpoint 被无限推迟
      it.return?.();
    }
    yield `${firstChunk ? '' : ','}${buf.join(',')}]`;
  }
  yield '}}';
}

/** 合法导出表名白名单（供路由校验 ?tables=，拒绝未知表名而非静默忽略） */
export function isExportTable(name: string): boolean {
  return EXPORT_TABLES.includes(name);
}

/** 结构校验：仅对 bundle 大纲做防御性检查，避免导入任意/损坏文件破坏库 */
/** 核心表：导入时必须存在；其余表（如新版本的 task_categories）缺失时按空处理，兼容旧备份文件 */
// T04130（PRD MEM-104 / v1.2·F7 硬约束）：memories 刻意**不**进 CORE_TABLES——
// 旧备份文件没有该 key，误加会让 validateBundle 直接拒绝历史备份。新增表只进上面三张顺序表。
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