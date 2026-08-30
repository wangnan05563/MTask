import { getDb } from '../db/connection';
import { encrypt, decrypt, maskSecret } from '../util/crypto';
import { v4 as uuid } from 'uuid';
import { listAdapterTypes, testAdapter, listAdapterModels } from '../adapters';
import { cacheGet, cacheSet, cacheClear } from '../util/ttl-cache';

export interface AIToolRow {
  id: string;
  name: string;
  type: string;
  purpose: string;
  endpoint: string;
  api_key_enc: string | null;
  model: string | null;
  model_notes: string;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  enabled: number;
  is_default_organize: number;
  is_default_develop: number;
  remark: string;
  console_url: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

export interface AIToolInput {
  name: string;
  type: string;
  purpose?: string;
  endpoint: string;
  apiKey?: string;
  model?: string;
  modelNotes?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  enabled?: boolean;
  remark?: string;
  /** 厂商官方控制台页面 URL（仅用于 UI 链接跳转，不参与连接逻辑） */
  consoleUrl?: string;
  /** 置顶：true=固定到列表顶部 */
  pinned?: boolean;
}

function now(): string {
  return new Date().toISOString();
}

// 模型列表内存缓存：按 type|endpoint 维度缓存 5 分钟。
// 为什么与 apiKey 无关：可用模型清单不依赖具体密钥，按服务商缓存可避免反复拉取外部 /models。
const modelsCache = new Map<string, { at: number; models: string[] }>();
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

/** 出参脱敏：永不返回明文 API Key（FR3.5） */
function toSafe(row: AIToolRow) {
  const { api_key_enc, ...rest } = row;
  return {
    ...rest,
    enabled: Boolean(row.enabled),
    isDefaultOrganize: Boolean(row.is_default_organize),
    isDefaultDevelop: Boolean(row.is_default_develop),
    pinned: Boolean(row.pinned),
    hasApiKey: Boolean(api_key_enc),
    apiKeyMasked: api_key_enc ? maskSecret(decrypt(api_key_enc)) : null,
  };
}

/** FR3 AI 工具配置管理 */
export const ConfigService = {
  create(input: AIToolInput) {
    const db = getDb();
    const id = uuid();
    const t = now();
    db.prepare(
      `INSERT INTO ai_tools (id, name, type, purpose, endpoint, api_key_enc, model, model_notes, temperature, max_tokens, timeout_ms, enabled, remark, console_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, input.name, input.type, input.purpose ?? 'develop', input.endpoint,
      input.apiKey ? encrypt(input.apiKey) : null,
      input.model ?? null, input.modelNotes ?? '', input.temperature ?? 0.2, input.maxTokens ?? 4096, input.timeoutMs ?? 60000,
      input.enabled === false ? 0 : 1, input.remark ?? '', input.consoleUrl ?? '', t, t,
    );
    cacheClear('aitools'); // 工具列表缓存失效，新建立即可见
    return this.getById(id);
  },

  getById(id: string) {
    const row = getDb().prepare('SELECT * FROM ai_tools WHERE id = ?').get(id) as AIToolRow | undefined;
    return row ? toSafe(row) : null;
  },

  list() {
    const cached = cacheGet<ReturnType<typeof toSafe>[]>('aitools');
    if (cached) return cached;
    const rows = getDb().prepare('SELECT * FROM ai_tools ORDER BY pinned DESC, created_at DESC').all() as AIToolRow[];
    const safe = rows.map(toSafe);
    cacheSet('aitools', safe, 5000); // 读多写少，5s TTL；写操作会主动失效
    return safe;
  },

  update(id: string, patch: Partial<AIToolInput>) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM ai_tools WHERE id = ?').get(id) as AIToolRow;
    if (!row) throw new Error('AI 工具不存在');
    const next: AIToolInput = {
      name: patch.name ?? row.name,
      type: patch.type ?? row.type,
      purpose: patch.purpose ?? row.purpose,
      endpoint: patch.endpoint ?? row.endpoint,
      model: patch.model ?? row.model ?? undefined,
      modelNotes: patch.modelNotes ?? row.model_notes ?? '',
      temperature: patch.temperature ?? row.temperature,
      maxTokens: patch.maxTokens ?? row.max_tokens,
      timeoutMs: patch.timeoutMs ?? row.timeout_ms,
      enabled: patch.enabled ?? Boolean(row.enabled),
      remark: patch.remark ?? row.remark ?? '',
      consoleUrl: patch.consoleUrl ?? row.console_url ?? '',
    };
    // apiKey 留空/未传 → 保留原密文，避免编辑时覆盖丢失密钥（FR3.5）
    const apiKeyEnc = patch.apiKey ? encrypt(patch.apiKey) : row.api_key_enc;
    db.prepare(
      `UPDATE ai_tools SET name=?, type=?, purpose=?, endpoint=?, api_key_enc=?, model=?, model_notes=?, temperature=?, max_tokens=?, timeout_ms=?, enabled=?, remark=?, console_url=?, updated_at=? WHERE id=?`
    ).run(
      next.name, next.type, next.purpose, next.endpoint, apiKeyEnc,
      next.model ?? null, next.modelNotes, next.temperature, next.maxTokens, next.timeoutMs,
      next.enabled ? 1 : 0, next.remark, next.consoleUrl ?? '', now(), id,
    );
    // 置顶独立处理：pinned 是列表展示元数据，不与编辑表单字段耦合，仅当显式传入时更新
    if (patch.pinned !== undefined) {
      db.prepare('UPDATE ai_tools SET pinned = ?, updated_at = ? WHERE id = ?').run(patch.pinned ? 1 : 0, now(), id);
    }
    cacheClear('aitools'); // 编辑/置顶影响列表展示，失效缓存
    return this.getById(id);
  },

  remove(id: string): void {
    getDb().prepare('DELETE FROM ai_tools WHERE id = ?').run(id);
    cacheClear('aitools');
  },

  /** FR3.3 连接测试 */
  async testConnection(id: string) {
    const row = getDb().prepare('SELECT * FROM ai_tools WHERE id = ?').get(id) as AIToolRow;
    if (!row) throw new Error('AI 工具不存在');
    const result = await testAdapter(row.type, {
      endpoint: row.endpoint,
      model: row.model ?? undefined,
      apiKey: row.api_key_enc ? decrypt(row.api_key_enc) : undefined,
      timeoutMs: row.timeout_ms,
    });
    return result;
  },

  /** FR3.3 草稿连接测试：用表单未保存的值提前验证连通性，避免保存后才发现配置错误 */
  async testDraft(input: { type: string; endpoint: string; apiKey?: string; model?: string }) {
    if (!input?.type || !input?.endpoint) throw new Error('缺少厂商类型或 Endpoint');
    return testAdapter(input.type, {
      endpoint: input.endpoint,
      model: input.model || undefined,
      apiKey: input.apiKey || undefined,
      timeoutMs: 15000,
    });
  },

  /** 获取已保存工具的可用模型列表（解密后拉取，带 5 分钟缓存） */
  async listModels(id: string) {
    const row = getDb().prepare('SELECT * FROM ai_tools WHERE id = ?').get(id) as AIToolRow;
    if (!row) throw new Error('AI 工具不存在');
    return this.fetchModels(row.type, row.endpoint, row.api_key_enc ? decrypt(row.api_key_enc) : undefined);
  },

  /** 草稿模型列表：用表单未保存的 type/endpoint/apiKey 拉取，供新建时选择模型 */
  async listModelsDraft(input: { type: string; endpoint: string; apiKey?: string }) {
    if (!input?.type || !input?.endpoint) throw new Error('缺少厂商类型或 Endpoint');
    return this.fetchModels(input.type, input.endpoint, input.apiKey || undefined);
  },

  /** 拉取模型清单的统一入口：命中缓存直接返回；失败返回 { ok:false, message } 而非抛错 */
  async fetchModels(type: string, endpoint: string, apiKey?: string) {
    const cacheKey = `${type}|${endpoint.replace(/\/+$/, '')}`;
    const cached = modelsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MODELS_CACHE_TTL_MS) {
      return { ok: true, models: cached.models, cached: true };
    }
    const result = await listAdapterModels(type, { endpoint, apiKey, timeoutMs: 15000 });
    if (result.ok && result.models) {
      modelsCache.set(cacheKey, { at: Date.now(), models: result.models });
    }
    return { ...result, cached: false };
  },

  /**
   * 查看原文：按需返回解密后的 API Key。
   * 仅在用户显式点击时由独立路由拉取，不随列表/创建/更新响应返回，也不写日志。
   */
  getApiKey(id: string) {
    const row = getDb().prepare('SELECT * FROM ai_tools WHERE id = ?').get(id) as AIToolRow;
    if (!row) throw new Error('AI 工具不存在');
    if (!row.api_key_enc) return { hasApiKey: false, apiKey: null };
    return { hasApiKey: true, apiKey: decrypt(row.api_key_enc) };
  },

  /** FR3.4 设为默认工具：同 kind 互斥（事务内先清后置） */
  setDefault(id: string, kind: 'organize' | 'develop'): void {
    const db = getDb();
    const row = db.prepare('SELECT id FROM ai_tools WHERE id = ?').get(id) as { id: string } | undefined;
    if (!row) throw new Error('AI 工具不存在');
    const col = kind === 'organize' ? 'is_default_organize' : 'is_default_develop';
    db.transaction(() => {
      db.prepare(`UPDATE ai_tools SET ${col} = 0`).run();
      db.prepare(`UPDATE ai_tools SET ${col} = 1, updated_at = ? WHERE id = ?`).run(now(), id);
    })();
    cacheClear('aitools'); // 默认工具变化反映在列表的 isDefault 字段
  },

  /** FR3.4 查询当前默认工具 */
  getDefaults() {
    const db = getDb();
    const organize = db.prepare('SELECT id FROM ai_tools WHERE is_default_organize = 1 LIMIT 1').get() as { id: string } | undefined;
    const develop = db.prepare('SELECT id FROM ai_tools WHERE is_default_develop = 1 LIMIT 1').get() as { id: string } | undefined;
    return { organize: organize?.id ?? null, develop: develop?.id ?? null };
  },

  /** 供调度使用：拿到含解密密钥的运行时配置 */
  getRuntimeConfig(id: string) {
    const row = getDb().prepare('SELECT * FROM ai_tools WHERE id = ?').get(id) as AIToolRow;
    if (!row) throw new Error('AI 工具不存在');
    return {
      type: row.type,
      config: {
        endpoint: row.endpoint,
        model: row.model ?? undefined,
        temperature: row.temperature,
        maxTokens: row.max_tokens,
        timeoutMs: row.timeout_ms,
        apiKey: row.api_key_enc ? decrypt(row.api_key_enc) : undefined,
      },
    };
  },

  listAdapterTypes,
};
