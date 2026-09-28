import { getDb } from './connection';

/** 首次启动建表。DDL 与 docs/技术设计.md 第 3 节保持一致。 */
export function initSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      sort_weight INTEGER DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      task_no     TEXT UNIQUE,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority    TEXT NOT NULL DEFAULT 'normal',
      status      TEXT NOT NULL DEFAULT 'todo',
      verified    INTEGER NOT NULL DEFAULT 0,
      archived    INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      ai_summary  TEXT,
      pinned      INTEGER NOT NULL DEFAULT 0,
      category_id TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived);
    -- 复合索引：贴合列表查询的实际 WHERE/ORDER 组合（按项目列归档 / 全库按归档+时间排序），
    -- 覆盖原单列索引，减少大数据量下的回表与文件排序
    CREATE INDEX IF NOT EXISTS idx_tasks_project_archived ON tasks(project_id, archived);
    CREATE INDEX IF NOT EXISTS idx_tasks_archived_created ON tasks(archived, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_archived_pinned_created ON tasks(archived, pinned, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project_archived_pinned_created ON tasks(project_id, archived, pinned, created_at);
    -- 分类维度：按分类筛选任务列表、删除分类时把所属任务 category_id 置空（UPDATE ... WHERE category_id=?）
    -- 原先无索引 → 全表扫描；实测「删除任务分类」单发 331ms，加索引后应降至 <10ms
    CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category_id);

    -- 任务分类：供任务归类使用；删除分类时由服务层把所属任务 category_id 置空（任务保留、回到未分类）
    CREATE TABLE IF NOT EXISTS task_categories (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      sort_weight INTEGER DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    -- 任务截图/图片附件（粘贴截图以 BLOB 落库，保持 SQLite 单文件可移植）
    CREATE TABLE IF NOT EXISTS task_images (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      mime_type  TEXT NOT NULL DEFAULT 'image/png',
      data       BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_images_task ON task_images(task_id);

    CREATE TABLE IF NOT EXISTS ai_tools (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      purpose     TEXT NOT NULL DEFAULT 'develop',
      endpoint    TEXT NOT NULL,
      api_key_enc TEXT,
      model       TEXT,
      model_notes TEXT DEFAULT '',
      temperature REAL DEFAULT 0.2,
      max_tokens  INTEGER DEFAULT 4096,
      timeout_ms  INTEGER DEFAULT 60000,
      enabled     INTEGER NOT NULL DEFAULT 1,
      is_default_organize INTEGER NOT NULL DEFAULT 0,
      is_default_develop  INTEGER NOT NULL DEFAULT 0,
      remark      TEXT DEFAULT '',
      console_url TEXT DEFAULT '',
      pinned      INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queues (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      date       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_jobs (
      id               TEXT PRIMARY KEY,
      queue_id         TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
      task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      tool_id          TEXT NOT NULL REFERENCES ai_tools(id) ON DELETE CASCADE,
      order_index      INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'queued',
      request_payload  TEXT,
      response_payload TEXT,
      error            TEXT,
      sent_at          TEXT,
      finished_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_queue ON queue_jobs(queue_id);
    -- 复合索引：重试/查询按 队列+状态 过滤，覆盖单列 idx_jobs_queue
    CREATE INDEX IF NOT EXISTS idx_jobs_queue_status ON queue_jobs(queue_id, status);

    -- 提示词仓库：分类 + 提示词条目（提示词管理功能）
    CREATE TABLE IF NOT EXISTS prompt_categories (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      sort_weight INTEGER DEFAULT 0,
      builtin     INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id          TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES prompt_categories(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL DEFAULT '',
      pinned      INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompts_category ON prompts(category_id);
    -- 复合索引：分类内按 置顶+更新时间 排序（GET /prompts 的常见查询路径）
    CREATE INDEX IF NOT EXISTS idx_prompts_category_order ON prompts(category_id, pinned, updated_at);

    -- 通用需求仓库：分类 + 条目（沉淀"通用优秀实现/解决方案"，三级组织：分类 → 条目）
    CREATE TABLE IF NOT EXISTS req_categories (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      sort_weight INTEGER DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS req_entries (
      id          TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES req_categories(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL DEFAULT '',
      pinned      INTEGER NOT NULL DEFAULT 0,
      sort_weight INTEGER DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_req_entries_category ON req_entries(category_id);
    -- 复合索引：分类内按 置顶+更新时间 排序（GET /req-entries 的常见查询路径）
    CREATE INDEX IF NOT EXISTS idx_req_entries_category_order ON req_entries(category_id, pinned, updated_at);

    -- 应用级键值设置：当前仅承载移动端「默认记事项目」指针（defaultNoteProjectId）。
    -- KV 结构便于未来扩展其它轻量偏好，且随数据迁移整体导出/导入。
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- AI 控制台持久化并行任务（T00417）：分析任务落库后由后端异步运行，
    -- 即使前端页面切换/刷新也不中断；运行中任务切回页面仍可恢复与查看结果。
    CREATE TABLE IF NOT EXISTS console_jobs (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      prompt     TEXT NOT NULL,
      category   TEXT NOT NULL DEFAULT 'custom',
      period     TEXT,
      status     TEXT NOT NULL DEFAULT 'busy',
      answer     TEXT,
      error      TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- 列表按创建时间排序（GET /console-jobs 返回顺序即 tab 展示顺序）
    CREATE INDEX IF NOT EXISTS idx_console_jobs_created ON console_jobs(created_at);

    -- 项目计划任务（T00431）：按项目隔离的计划条目，串行瀑布时间线（见 docs/PRD-项目计划.md）。
    -- end_date 冗余存储重排结果（= start_date 起 duration_days 个工作日的含尾日），由服务层保证一致。
    CREATE TABLE IF NOT EXISTS plan_tasks (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title          TEXT NOT NULL,
      description    TEXT DEFAULT '',
      start_date     TEXT NOT NULL,
      end_date       TEXT NOT NULL,
      duration_days  INTEGER NOT NULL DEFAULT 1,
      progress       INTEGER NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'todo',
      assignee       TEXT DEFAULT '',
      sort_order     INTEGER NOT NULL DEFAULT 0,
      linked_task_id TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plan_tasks_project ON plan_tasks(project_id, sort_order);

    -- T00662：PRD 需求跟踪矩阵——需求项（矩阵行），与计划/待办经 req_ids 多对多关联
    CREATE TABLE IF NOT EXISTS prd_requirements (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      req_no      TEXT DEFAULT '',
      title       TEXT NOT NULL,
      content     TEXT DEFAULT '',
      source_ref  TEXT DEFAULT '',
      priority    TEXT NOT NULL DEFAULT 'normal',
      status      TEXT NOT NULL DEFAULT 'todo',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prd_req_project ON prd_requirements(project_id, sort_order);

    -- T01064-FR1.4/1.5：任务事件流——状态/验证/AI 状态/回传结果变更埋点（通知中心 + 任务时间线数据源）
    CREATE TABLE IF NOT EXISTS task_events (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      task_no     TEXT,
      project_id  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      detail      TEXT DEFAULT '',
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_proj ON task_events(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at DESC);

    -- T01072-FR1.9：处理结果历史——handle_result 每次被覆盖前留档（diff 视图与一键回滚数据源）
    CREATE TABLE IF NOT EXISTS task_result_history (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      prev_result TEXT DEFAULT '',
      replaced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_result_hist_task ON task_result_history(task_id, replaced_at DESC);

    -- T01073-FR5.5（REQ-037）：循环任务规则——到期自动生成任务副本（pull 模式下由 server 定时 tick）
    CREATE TABLE IF NOT EXISTS recurring_rules (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority    TEXT NOT NULL DEFAULT 'normal',
      category_id TEXT,
      freq        TEXT NOT NULL DEFAULT 'weekly',
      next_run_at TEXT NOT NULL,
      last_task_no TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_rules(enabled, next_run_at);

    -- T01073-FR5.6（REQ-038）：API Token——外部脚本经 X-Access-Token 调用 REST 的具名凭据（可启停/撤销/记录最近使用）
    CREATE TABLE IF NOT EXISTS api_tokens (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      token        TEXT NOT NULL UNIQUE,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL,
      last_used_at TEXT
    );

    -- T00763：PRD 原文文档——导入时完整保留 Markdown 原文（不截断不丢内容），
    -- 需求行经 prd_requirements.prd_id 关联到文档；矩阵面板可弹窗查看，AI 上下文可反查注入
    CREATE TABLE IF NOT EXISTS prd_docs (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      filename    TEXT DEFAULT '',
      content_md  TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prd_docs_project ON prd_docs(project_id);

    -- T00770：PRD 待确认问题——挂在某份 PRD 文档下（prd_id 可空=项目级泛问题），
    -- 确认（status=resolved 且填了 answer）后可回写到对应 PRD 文档的「待确认问题结论」节
    CREATE TABLE IF NOT EXISTS prd_issues (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      prd_id      TEXT REFERENCES prd_docs(id) ON DELETE CASCADE,
      question    TEXT NOT NULL,
      answer      TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'open',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prd_issues_project ON prd_issues(project_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_prd_issues_prd ON prd_issues(prd_id);

    -- T00777：轻量符号索引——正则提取源码文件的函数/类/导出声明，mtime 增量刷新，
    -- 供 AI 卡片先看「项目有哪些符号」再点名读文件（P1：读得懂；向量语义检索留 P2）
    CREATE TABLE IF NOT EXISTS workspace_symbols (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path        TEXT NOT NULL,
      symbol      TEXT NOT NULL,
      line        INTEGER NOT NULL DEFAULT 0,
      kind        TEXT NOT NULL DEFAULT 'function',
      file_mtime  INTEGER NOT NULL DEFAULT 0,
      workspace   TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_ws_sym ON workspace_symbols(project_id, symbol);
    CREATE INDEX IF NOT EXISTS idx_ws_sym_path ON workspace_symbols(project_id, path);
    -- 任务列表批量反查「计划联动」来源（plan_tasks.linked_task_id IN (...)：无索引时全表扫描）
    CREATE INDEX IF NOT EXISTS idx_plan_tasks_linked ON plan_tasks(linked_task_id);

    -- 节假日表（T00431）：工作日判定排除项（周末固定排除，此处存法定节假日/调休上班以外的休息日）
    CREATE TABLE IF NOT EXISTS holidays (
      date TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT ''
    );

    -- AI 用量记录（T00448 / PRD AI-1）：每次模型调用一行，供「模型」页用量面板聚合
    CREATE TABLE IF NOT EXISTS ai_usage (
      id            TEXT PRIMARY KEY,
      tool_id       TEXT,
      tool_name     TEXT NOT NULL,
      model         TEXT DEFAULT '',
      kind          TEXT NOT NULL,
      ok            INTEGER NOT NULL DEFAULT 1,
      duration_ms   INTEGER NOT NULL DEFAULT 0,
      content_chars INTEGER NOT NULL DEFAULT 0,
      error         TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_tool ON ai_usage(tool_id, created_at);

    -- T01268（PRD §5.1）：外部平台执行会话——AI 编排大脑的观测底座。
    -- 每次外部平台（WorkBuddy/Trae/中继）执行会话一行，记录平台/会话标识/关联任务/
    -- 状态/进度/阶段/最近心跳；Supervisor 据此判定存活与停滞（FR-1.1 / FR-1.3）。
    -- 纯新增表，CREATE TABLE IF NOT EXISTS 保证老库向后兼容（NFR-4）。
    CREATE TABLE IF NOT EXISTS exec_sessions (
      id             TEXT PRIMARY KEY,
      platform       TEXT NOT NULL,
      session_id     TEXT,
      task_ids       TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'active',
      progress       REAL DEFAULT 0,
      phase          TEXT DEFAULT '',
      last_heartbeat TEXT NOT NULL,
      started_at     TEXT NOT NULL,
      finished_at    TEXT
    );
    -- 按 平台+状态 查活跃/停滞会话（Supervisor 每轮 tick 的探测路径）
    CREATE INDEX IF NOT EXISTS idx_exec_platform_status ON exec_sessions(platform, status);
    -- 按 最近心跳 判定停滞（last_heartbeat < now - supervisor.sessionStaleMs）
    CREATE INDEX IF NOT EXISTS idx_exec_heartbeat ON exec_sessions(last_heartbeat);

    -- T01268（PRD §5.2）：监督审计——每次监督 tick 的决策与动作留痕（FR-4.6）。
    -- snapshot=快照摘要、actions=LLM 原始动作、applied=护栏后实际落地、blocked_by=拦截原因。
    -- 前端「监督审计」视图据此逐条回溯「AI 为什么这么做」（FR-5.3）。
    CREATE TABLE IF NOT EXISTS monitor_runs (
      id          TEXT PRIMARY KEY,
      ran_at      TEXT NOT NULL,
      snapshot    TEXT,
      actions     TEXT NOT NULL,
      applied     TEXT NOT NULL,
      blocked_by  TEXT DEFAULT '',
      model       TEXT DEFAULT ''
    );
    -- 审计列表按时间倒序分页（GET /monitor-runs 的查询路径）
    CREATE INDEX IF NOT EXISTS idx_monitor_runs_ran ON monitor_runs(ran_at DESC);
  `);

  // 迁移兜底：老库缺列时补列（CREATE TABLE IF NOT EXISTS 对已存在表不生效）
  ensureColumn('ai_tools', 'is_default_organize', 'is_default_organize INTEGER NOT NULL DEFAULT 0');
  ensureColumn('ai_tools', 'is_default_develop', 'is_default_develop INTEGER NOT NULL DEFAULT 0');
  ensureColumn('ai_tools', 'model_notes', "model_notes TEXT DEFAULT ''");
  ensureColumn('ai_tools', 'remark', "remark TEXT DEFAULT ''");
  ensureColumn('ai_tools', 'console_url', "console_url TEXT DEFAULT ''");
  ensureColumn('tasks', 'verified', 'verified INTEGER NOT NULL DEFAULT 0');
  // T00490：记录字体颜色（Excel 风格颜色按钮）——空串=默认色
  ensureColumn('tasks', 'color', "color TEXT DEFAULT ''");
  ensureColumn('prompts', 'color', "color TEXT DEFAULT ''");
  ensureColumn('prompts', 'archived', 'archived INTEGER NOT NULL DEFAULT 0'); // T00525：删除改归档
  // T00872：归档时间——归档页据此展示「归档于」时间（还原时置空），与任务/计划归档一致
  ensureColumn('prompts', 'archived_at', 'archived_at TEXT');
  ensureColumn('req_entries', 'color', "color TEXT DEFAULT ''");
  ensureColumn('plan_tasks', 'color', "color TEXT DEFAULT ''");
  ensureColumn('plan_tasks', 'deps', "deps TEXT DEFAULT ''"); // T00499：前置依赖 JSON [{id,type:'serial'|'parallel'}]
  ensureColumn('plan_tasks', 'kind', "kind TEXT DEFAULT 'normal'"); // T00506：任务类型 normal=普通、milestone=阶段里程碑、daily=日常任务
  ensureColumn('tasks', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
  ensureColumn('tasks', 'category_id', 'category_id TEXT');
  // 任务编号：供 AI Agent 通过 MCP 按编号定位任务；老库先补列再用现有存量回填编号
  ensureColumn('tasks', 'task_no', 'task_no TEXT');
  // 处理结果：AI 可把根因分析/解决方案等结论同步到任务（MCP mtask_update_task_result 写入），前端查看/编辑
  ensureColumn('tasks', 'handle_result', 'handle_result TEXT');
  // T00566：AI 处理状态动画（'' 已读/无 | running 运行中 | failed 运行失败 | unread 未读）
  ensureColumn('tasks', 'ai_state', "ai_state TEXT DEFAULT ''");
  // T01057-FR1.2：失败重试计数——手动重试时 +1，任务行显示「重试×N」，历史保留在 handle_result 追加段
  ensureColumn('tasks', 'retry_count', 'retry_count INTEGER NOT NULL DEFAULT 0');
  // T01058-FR2.1：计划行 AI 复杂度评级（1~5，≥4 标红提示建议拆分）；PRD 导入时 AI 输出
  ensureColumn('plan_tasks', 'complexity', 'complexity INTEGER');
  // T00620：AI 状态变更时间（ISO 字符串）——两个用途：
  // 1) running 超时（Agent 中断/崩溃无兜底）→ 读取时惰性置 failed；
  // 2) 标记"是否被 AI 处理过"——'' 状态（用户已读清空）时保留该时间戳不丢，
  //    据此让 MCP 只在"从未处理过"的任务上自动置 running（避免抹掉 unread/failed 终态）。
  ensureColumn('tasks', 'ai_state_at', "ai_state_at TEXT DEFAULT ''");
  // T00620：ai_state 索引——支撑 running 超时的轻量探测（读取路径每次都要判断是否有过期项）
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_ai_state ON tasks(ai_state)");
  // T00577：派生待办溯源——记录原任务编号（如 T00422），AI 处理完成后自动把派生单结论整合回原任务
  ensureColumn('tasks', 'derived_from', 'derived_from TEXT');
  // T00776：父子任务进度汇总（TaskService.syncPlanOnStatusChange 按子任务完成比例回写父任务 progress）——
  // T00450 引入父子层级时漏加该列，首个「有父任务的任务标 done」即触发 no such column: progress 500
  ensureColumn('tasks', 'progress', 'progress INTEGER NOT NULL DEFAULT 0');
  // T00719：搁置任务——shelved=1 的任务从待办/已完成列表与 MCP 查询中隔离（不计入待办上下文），仅出现在搁置列表
  ensureColumn('tasks', 'shelved', 'shelved INTEGER DEFAULT 0');
  // T00764：节假日类型（'holiday'=放假日 | 'overtime'=加班日，周末/节假日调来上班按工作日排期）
  ensureColumn('holidays', 'kind', "kind TEXT DEFAULT 'holiday'");
  // T00587：模型配置归档（删除按钮改归档）——软删保留记录，列表默认隐藏
  ensureColumn('ai_tools', 'archived', 'archived INTEGER NOT NULL DEFAULT 0');
  // T00589：历史资产（组织过程资产沉淀，与归档=软删除语义区分）——history_at 非空即已入历史资产
  ensureColumn('tasks', 'history_at', 'history_at TEXT');
  ensureColumn('plan_tasks', 'history_at', 'history_at TEXT');
  // T00662：需求跟踪矩阵关联——计划/待办以 JSON 数组保存关联的需求 id（多对多）
  ensureColumn('plan_tasks', 'req_ids', 'req_ids TEXT');
  ensureColumn('tasks', 'req_ids', 'req_ids TEXT');
  // T01268（PRD §5.3）：AI 编排大脑——tasks 增量列（ensureColumn 幂等补列，兼容既有库，NFR-4）。
  // monitor_ready=待外部平台拉取的就绪标记（FR-3.1）；monitor_preferred_platform=REDISPATCH 偏好平台（FR-3.4）；
  // monitor_retry=监督器重试计数（FR-4.2）；exec_session_id=关联 exec_sessions.id（FR-1.2）
  ensureColumn('tasks', 'monitor_ready', 'monitor_ready INTEGER NOT NULL DEFAULT 0');
  ensureColumn('tasks', 'monitor_preferred_platform', 'monitor_preferred_platform TEXT');
  ensureColumn('tasks', 'monitor_retry', 'monitor_retry INTEGER NOT NULL DEFAULT 0');
  ensureColumn('tasks', 'exec_session_id', 'exec_session_id TEXT');
  // 就绪任务拉取按 monitor_ready 过滤（mtask_list_ready_tasks），加索引避免全表扫描
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_monitor_ready ON tasks(monitor_ready)");
  // T00763：需求行关联的 PRD 文档 id（导入时若携带 PRD 原文则回填，供矩阵查看与 AI 上下文反查）
  ensureColumn('prd_requirements', 'prd_id', 'prd_id TEXT');
  // T00770：PRD 文档状态流转——'prd'=草稿/评审中 | 'confirmed'=确认版（进入需求跟踪矩阵的正式基线）
  ensureColumn('prd_docs', 'status', "status TEXT NOT NULL DEFAULT 'prd'");
  // T00821：同源生成批次标识——同一份 AI 生成多次「确认录入」据此覆盖同一条而非重复新建；空=未参与覆盖（不改动其它业务）
  ensureColumn('prd_docs', 'origin_hash', "origin_hash TEXT DEFAULT ''");
  // T00769：问题级别——blocker=🔴阻塞 | suggested=🟡建议 | info=🟢提示 | custom=用户自定义（空=未分级）
  ensureColumn('prd_issues', 'level', "level TEXT DEFAULT ''");
  // T00817：AI 建议——针对该问题的建议选项（"选项A：… / 选项B：…"），辅助决策；空=暂无建议
  ensureColumn('prd_issues', 'suggestion', "suggestion TEXT DEFAULT ''");
  // T00780：符号索引生命周期——记录建索引时的工作空间根路径，换绑/解绑时据此判定旧索引失效需清理
  ensureColumn('workspace_symbols', 'workspace', "workspace TEXT NOT NULL DEFAULT ''");
  // T00771：项目工作空间根路径——项目上下文锚点（多项目可指向同一目录，仅存路径引用）；
  // 为空表示未绑定。任务菜单工作空间下拉条 / AI 上下文注入 / MCP 项目列表均消费该字段
  ensureColumn('projects', 'workspace_path', "workspace_path TEXT DEFAULT ''");
  // T00589 二轮：**项目级快照**——projects.history_at 非空即整个项目已沉淀为历史资产快照
  // （该项目在任务/计划菜单的项目列表中不再出现，内容随项目快照整体恢复或归档）
  ensureColumn('projects', 'history_at', 'history_at TEXT');
  ensureColumn('projects', 'archived', 'archived INTEGER NOT NULL DEFAULT 0');
  backfillTaskNo();
  ensureColumn('ai_tools', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
  // T00446：模型拖拽排序权重（小值在前）
  ensureColumn('ai_tools', 'sort_weight', 'sort_weight INTEGER NOT NULL DEFAULT 0');
  ensureColumn('prompts', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
  // 异步队列回执：ticket=平台受理标识，submitted_at=提交时间（配合 polling 判超时用）
  ensureColumn('queue_jobs', 'ticket', 'ticket TEXT');
  ensureColumn('queue_jobs', 'submitted_at', 'submitted_at TEXT');
  // 通用需求内容指纹（T00435）：标题+正文规范化后哈希，转存时查重防重复提炼转存
  ensureColumn('req_entries', 'fingerprint', "fingerprint TEXT DEFAULT ''");
  // 项目计划归档（删除改归档）：archived=1 的计划从时间线移除但在归档菜单可恢复/彻底删除
  ensureColumn('plan_tasks', 'archived', 'archived INTEGER NOT NULL DEFAULT 0');
  ensureColumn('plan_tasks', 'archived_at', 'archived_at TEXT');
  // 任务父子层级（T00450 / PRD UX-3）：parent_id 指向父任务（epic→task 两级）；子任务紧随父任务展示
  ensureColumn('tasks', 'parent_id', 'parent_id TEXT');
  // 手动排序权重（T00446）：拖拽排序结果；REAL 支持插入中间位置无需整体重编；pinned 组内生效
  ensureColumn('tasks', 'user_sort', 'user_sort REAL');
  // T00463：提示词/通用需求条目拖拽排序权重（与 req_entries 既有列对齐）
  ensureColumn('prompts', 'sort_weight', 'sort_weight INTEGER NOT NULL DEFAULT 0');
  // T00837：可选的「通用需求分类」归属——指向 req_categories（独立于自身提示词分类；空=未归属）
  ensureColumn('prompts', 'req_category_id', "req_category_id TEXT DEFAULT ''");
  // 老库 queue_jobs 的 task_id/tool_id 外键缺 ON DELETE CASCADE，删除关联任务/工具/项目时
  // 会被外键约束阻断（500）。SQLite 不支持 ALTER 外键，需整表重建，按幂等方式检测后执行
  ensureQueueJobsCascade();

  seedPromptCategories();
  // 移动端随手记默认归属项目（收件箱）：确定性 id，保证每次启动只创建一次
  seedInboxProject();
}

/**
 * 种子「收件箱」系统项目：移动端随手记在用户未指定默认记事项目时，任务落入此处，
 * 与桌面端共享同一 SQLite，避免引入独立移动库。id 固定，幂等。
 */
function seedInboxProject(): void {
  const db = getDb();
  const id = 'sys-inbox';
  if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) return;
  const t = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, name, description, sort_weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, '收件箱', '移动端随手记默认归属项目（系统）', -1000, t, t);
}

/** 首次启动预制通用提示词分类与示例提示词（仅分类表为空时播种） */
function seedPromptCategories(): void {
  const db = getDb();
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM prompt_categories').get() as { c: number };
  if (c > 0) return;

  const t = new Date().toISOString();
  const insertCat = db.prepare(
    'INSERT INTO prompt_categories (id, name, description, sort_weight, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
  );
  const insertPrompt = db.prepare(
    'INSERT INTO prompts (id, category_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const rnd = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  const seed = (name: string, description: string, weight: number, prompts: [string, string][]) => {
    const catId = rnd();
    insertCat.run(catId, name, description, weight, t, t);
    for (const [title, content] of prompts) insertPrompt.run(rnd(), catId, title, content, t, t);
  };

  const tx = db.transaction(() => {
    seed('通用提示词', '适用于日常对话、角色设定与通用任务的基础模板', 0, [
      ['万能 AI 助手', '你是一位博学、严谨、耐心的 AI 助手。回答问题时请遵循：1. 先给出直接结论；2. 再展开关键依据与推理过程；3. 如信息不足，明确列出需要补充的信息而不是臆测。回答使用与提问相同的语言。'],
      ['结构化思考', '请以结构化方式分析以下问题：先拆解问题要素，再逐一分析，最后给出综合结论与可执行建议。问题：{在此填写问题}'],
    ]);
    seed('编程开发', '面向编码、调试与技术方案设计的提示词', 1, [
      ['代码实现', '你是资深软件工程师。请根据以下需求实现代码：{需求描述}。要求：遵循语言惯用写法，添加必要注释，考虑边界情况与错误处理，并附上简要使用说明。'],
      ['Bug 排查', '以下代码出现了异常行为：{异常描述}。请分析可能的根因，按可能性从高到低列出，并给出对应的修复方案与验证方法。相关代码：\n{粘贴代码}'],
    ]);
    seed('代码评审', '用于 AI 辅助 Code Review 的提示词', 2, [
      ['代码评审', '请以严格评审者的视角审查以下代码，重点关注：1. 逻辑正确性与边界情况；2. 安全漏洞（注入、越权、敏感信息泄露）；3. 性能问题；4. 可读性与可维护性。对每个问题标注严重程度（高/中/低）并给出修改建议。代码：\n{粘贴代码}'],
    ]);
    seed('文档写作', '技术文档、需求说明与变更记录类提示词', 3, [
      ['README 生成', '请根据以下项目信息生成一份 README：包含项目简介、核心功能、技术栈、快速开始、目录结构说明。语言简洁专业。项目信息：{填写项目信息}'],
    ]);
    seed('翻译润色', '中英互译与文案润色类提示词', 4, [
      ['专业翻译', '请将以下内容翻译为{目标语言}，保持专业术语准确、语句通顺自然，不遗漏也不添加信息。原文：\n{粘贴原文}'],
    ]);
  });
  tx();
}

/** 幂等补列：列不存在时 ALTER TABLE 添加 */
function ensureColumn(table: string, column: string, ddl: string): void {
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/**
 * 老库任务编号回填：仅给 task_no 为空的存量任务补发编号。
 * 编号从当前已有编号的最大序号 +1 起递增，保证与后续新任务的编号不冲突。
 * 事务内逐条 UPDATE，幂等（空编号才处理，重启不重复发号）。
 */
function backfillTaskNo(): void {
  const db = getDb();
  const exist = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get();
  if (!exist) return;
  const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'task_no')) return;
  // 取当前最大序号（T 前缀后数字），纯数字正则防脏数据干扰；无存量则从 1 起
  const m = db.prepare("SELECT task_no FROM tasks WHERE task_no IS NOT NULL").all() as { task_no: string }[];
  let max = 0;
  for (const r of m) {
    const n = /^T(\d+)$/.exec(r.task_no);
    if (n) max = Math.max(max, Number(n[1]));
  }
  const rows = db.prepare('SELECT id FROM tasks WHERE task_no IS NULL').all() as { id: string }[];
  if (rows.length === 0) return;
  const upd = db.prepare('UPDATE tasks SET task_no = ? WHERE id = ?');
  db.transaction(() => {
    for (const { id } of rows) {
      max += 1;
      upd.run(`T${String(max).padStart(5, '0')}`, id);
    }
  })();
}

/**
 * 幂等迁移：老库 queue_jobs 外键缺 ON DELETE CASCADE 时整表重建。
 * SQLite 无法 ALTER 外键，唯一途径是 rename → create → copy → drop；
 * 全程包在事务里，任一步失败回滚保留原表，避免迁移中途崩溃丢数据。
 */
function ensureQueueJobsCascade(): void {
  const db = getDb();
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'queue_jobs'").get() as
    | { sql: string }
    | undefined;
  if (!row) return; // 表不存在：本次 create 已按新定义建表
  // 检测必须针对 task_id/tool_id 两列本身：旧表 queue_id 已带 CASCADE 且 REFERENCES 共 3 处，
  // 仅按「含 CASCADE + 引用计数」判断会把旧定义误判为新定义
  const ok = row.sql.includes('REFERENCES tasks(id) ON DELETE CASCADE')
    && row.sql.includes('REFERENCES ai_tools(id) ON DELETE CASCADE');
  if (ok) return;
  const tx = db.transaction(() => {
    db.exec('ALTER TABLE queue_jobs RENAME TO queue_jobs_old');
    db.exec(`
      CREATE TABLE queue_jobs_new (
        id               TEXT PRIMARY KEY,
        queue_id         TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
        task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tool_id          TEXT NOT NULL REFERENCES ai_tools(id) ON DELETE CASCADE,
        order_index      INTEGER NOT NULL DEFAULT 0,
        status           TEXT NOT NULL DEFAULT 'queued',
        request_payload  TEXT,
        response_payload TEXT,
        error            TEXT,
        sent_at          TEXT,
        finished_at      TEXT,
        ticket           TEXT,
        submitted_at     TEXT
      );
    `);
    db.exec(`
      INSERT INTO queue_jobs_new (id, queue_id, task_id, tool_id, order_index, status,
                                  request_payload, response_payload, error, sent_at, finished_at, ticket, submitted_at)
      SELECT id, queue_id, task_id, tool_id, order_index, status,
             request_payload, response_payload, error, sent_at, finished_at, ticket, submitted_at
      FROM queue_jobs_old;
    `);
    db.exec('DROP TABLE queue_jobs_old');
    db.exec('ALTER TABLE queue_jobs_new RENAME TO queue_jobs');
  });
  tx();
  // 重建后恢复索引（索引随 DROP 一并消失）
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_queue ON queue_jobs(queue_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_queue_status ON queue_jobs(queue_id, status)');
}
