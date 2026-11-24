import { getDb } from './connection';

/**
 * T06311（REQ-038 / PRD §B9）：模型路由与成本预算增量表。
 *
 * 边界：只新增路由画像、预算与决策审计三张表，不改 ai_tools 既有列，
 * 不改队列/执行会话/用量表的既有口径。既有工具没有画像时按「未配置」处理，
 * 不伪造价格与延迟；路由仍可回退到默认工具，但不会据此误停预算。
 *
 * 表职责：
 * - model_route_profiles：单个 AI 工具的成本/延迟/上下文/能力/供应商健康画像；
 * - model_budgets：项目维度的项目/日/月/单 Run 预算与预警、停止策略；
 * - model_route_decisions：每次真实路由的输入、候选、选中结果与预算状态审计。
 *   committed=0 仅代表模拟器决策，不参与预算占用。
 */
const MODEL_ROUTING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS model_route_profiles (
  tool_id             TEXT PRIMARY KEY REFERENCES ai_tools(id) ON DELETE CASCADE,
  input_cost_per_1k   REAL NOT NULL DEFAULT 0 CHECK(input_cost_per_1k >= 0),
  output_cost_per_1k  REAL NOT NULL DEFAULT 0 CHECK(output_cost_per_1k >= 0),
  expected_latency_ms INTEGER NOT NULL DEFAULT 0 CHECK(expected_latency_ms >= 0),
  context_limit       INTEGER NOT NULL DEFAULT 0 CHECK(context_limit >= 0),
  capabilities        TEXT NOT NULL DEFAULT 'general',
  health              TEXT NOT NULL DEFAULT 'healthy'
                        CHECK(health IN ('healthy','degraded','down')),
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_budgets (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  project_limit  REAL NOT NULL DEFAULT 0 CHECK(project_limit >= 0),
  daily_limit    REAL NOT NULL DEFAULT 0 CHECK(daily_limit >= 0),
  monthly_limit  REAL NOT NULL DEFAULT 0 CHECK(monthly_limit >= 0),
  run_limit      REAL NOT NULL DEFAULT 0 CHECK(run_limit >= 0),
  warning_pct    REAL NOT NULL DEFAULT 80 CHECK(warning_pct > 0 AND warning_pct < 100),
  stop_mode      TEXT NOT NULL DEFAULT 'stop' CHECK(stop_mode IN ('stop','degrade')),
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_route_decisions (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id             TEXT,
  task_type          TEXT NOT NULL,
  selected_tool_id   TEXT NOT NULL DEFAULT '',
  selected_model     TEXT NOT NULL DEFAULT '',
  estimated_cost     REAL NOT NULL DEFAULT 0 CHECK(estimated_cost >= 0),
  estimated_latency_ms INTEGER NOT NULL DEFAULT 0 CHECK(estimated_latency_ms >= 0),
  input_tokens       INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  output_tokens      INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  budget_status      TEXT NOT NULL DEFAULT 'unconfigured'
                       CHECK(budget_status IN ('ok','warning','hard_stop','unconfigured')),
  budget_banner      TEXT NOT NULL DEFAULT '',
  downgraded_from    TEXT NOT NULL DEFAULT '',
  reason             TEXT NOT NULL DEFAULT '',
  candidates_json    TEXT NOT NULL DEFAULT '[]',
  committed          INTEGER NOT NULL DEFAULT 0 CHECK(committed IN (0,1)),
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_route_decisions_project_time
  ON model_route_decisions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_route_decisions_model
  ON model_route_decisions(project_id, selected_model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_route_decisions_run
  ON model_route_decisions(run_id, created_at DESC);
`;

/** 幂等建表；initSchema 每次启动调用，老库零迁移成本。 */
export function ensureModelRoutingSchema(): void {
  getDb().exec(MODEL_ROUTING_SCHEMA_SQL);
}
