import { useState } from 'react';

/**
 * 设置页「帮助文档」Tab：集中展示功能说明、MCP 接口文档、配置 JSON 样例与快速上手。
 * 内容以结构化数据驱动渲染，字段与现有实现（mcp/server.ts、SettingsService、settings.tsx）对齐，
 * 离线可读、便于维护。样式沿用全局 CSS 变量，自动适配主题与字号。
 */

type Sub = 'features' | 'mcp' | 'config' | 'quickstart';
const SUBS: { key: Sub; label: string }[] = [
  { key: 'features', label: '功能说明' },
  { key: 'mcp', label: 'MCP 接口' },
  { key: 'config', label: '配置样例' },
  { key: 'quickstart', label: '快速上手' },
];

/** 代码块：横向可滚动、随主题配色，保持窄屏下不破坏排版 */
function Code({ title, lang, code }: { readonly title?: string; readonly lang?: string; readonly code: string }) {
  return (
    <div style={{ margin: '8px 0', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--card-bg)' }}>
      {title && (
        <div style={{ fontSize: 'var(--fs-m)', fontWeight: 600, padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          {title}{lang ? <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>{lang}</span> : null}
        </div>
      )}
      <pre style={{ margin: 0, padding: 12, overflowX: 'auto', fontSize: 'var(--fs-m)', lineHeight: 1.6, color: 'var(--text)', background: 'transparent' }}><code>{code}</code></pre>
    </div>
  );
}

/** 字段/行数据表：列 = 项目 | 说明（可选字段列） */
function FieldTable({ head, rows }: { readonly head: string[]; readonly rows: string[][] }) {
  return (
    <div style={{ overflowX: 'auto', margin: '8px 0' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-m)', minWidth: 420 }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: '6px 10px', border: '1px solid var(--border)', background: 'var(--surface)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.join('|')}>
              {r.map((c) => (
                <td key={c} style={{ padding: '6px 10px', border: '1px solid var(--border)', verticalAlign: 'top' }}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 功能模块：概述 + 步骤 + 注意事项 */
interface FeatureModule { name: string; overview: string; steps?: string[]; tips?: string[]; }
const FEATURES: FeatureModule[] = [
  {
    name: '项目管理与任务',
    overview: '以「项目」为维度组织开发任务，任务支持标题、描述、优先级、分类、状态（待办/完成）、验证标记、置顶、字体颜色与截图附件。',
    steps: [
      '进入「任务」选择或新建项目，新增任务（标题必填，可填描述/优先级/分类）',
      '粘贴或选择截图随任务保存（≤8MB 建议尺寸）',
      '工具栏「多选模式」勾选后可批量：完成/重开、优先级、分类、字体颜色、归档',
      '标题下方工具栏默认收起（列表更紧凑），悬浮标题即展开',
      '「AI 美化」重排语言保留全部语义；「AI 简化」依据任务详情高度总结为 ≤40 字简洁标题（需先有详情，否则按钮置灰）',
      '已完成任务可「标记验证失败」：弹窗内填写原因并**附截图**，提交后回退待办',
    ],
    tips: [
      '任务编号前的 AI 状态动画由接口自动驱动：读取详情→转圈 / 回传结果→未读圆点 / 验证失败→红色警示，用户查看后自动清空',
      '验证失败反馈窗口内可直接查看随反馈提交的截图（点击放大）；截图可由 AI 经 MCP 读取识别',
      '非归档任务不可删除，需先归档；移动任务可跨项目批量操作',
    ],
  },
  {
    name: 'AI 梳理（FR2）',
    overview: '将任务的标题与描述交给 AI 产出结构化文本（实现思路/完整代码/风险），先入草稿、确认后回填 ai_summary。',
    steps: ['在任务页选中任务，触发「AI 梳理」', '选择已配置的 AI 工具与模型', '审阅草稿，确认后回填保存'],
    tips: ['模型未配置时不会静默回退，会提示先配置模型', '结果仅作为摘要，不覆盖原描述'],
  },
  {
    name: '模型菜单 / AI 工具配置（FR3）',
    overview: '注册可用的 AI 工具（适配器类型），密钥加密落库、测试连接、拉取模型列表、设为默认梳理/开发工具；支持一键复制模型名与归档配置。',
    steps: [
      '进入「模型菜单」→ 新增工具，选择类型并填写 endpoint / 模型 / 密钥',
      '「测试连接」校验连通性后保存；可用「拉取模型」获取该服务可用模型',
      '操作列「复制模型」按钮：点击复制当前模型名（图标切换为对勾反馈）',
      '操作列「归档」按钮：软删该配置（列表不再显示，记录保留在库中）',
      '设为默认整理/开发工具后，AI 工作台与 AI 解析将默认使用它',
    ],
    tips: ['支持类型：openai-compatible / claude / ollama / workbuddy', '密钥仅加密存储，界面只显示脱敏值', '归档为软删除，记录仍可通过接口恢复'],
  },
  {
    name: '队列分发（FR4）',
    overview: '把待办任务按顺序组队绑定 AI 工具，提交执行并保存回执文本，供人工审阅采纳；异步平台支持「提交 + 轮询收口」。',
    steps: ['进入「队列」新建当日队列', '向队列追加「任务 + 工具」对', '点击发送：同步工具即时返回，异步工具受理后由后台轮询收口', '展开行审阅 request/response，可「采纳」或「复制」'],
    tips: ['提交前会固化任务上下文快照，避免任务被改导致回执错位', '采纳仅保存文本并把任务置为完成', '异步任务超时（按工具 timeoutMs）会置为 timeout，可重置重发'],
  },
  {
    name: '项目计划（甘特）',
    overview: '以「串行瀑布」时间线管理项目计划：任务按工作日自动顺排（跳过周末与节假日），支持列表/甘特视图、关联待办、Excel 导入导出与多选批量。',
    steps: [
      '进入「项目计划」选择项目，新建计划任务（填工期天数，时间线自动重排）',
      '点击列字段名（标题/开始/结束/状态/进度/负责人）可展开过滤控件，输入或选择即筛选',
      '工具栏「多选模式」勾选后可批量改状态、批量挂接待办、批量归档、AI 评估',
      '维护节假日或联网导入法定节假日，时间线随之重算',
      'Excel 模板导入/导出；AI 解析导入请到「AI 工作台」的 AI 项目计划导入卡片（已迁移）',
    ],
    tips: [
      '列过滤仅隐藏不匹配行，序号与里程碑区间仍按全量计算保持正确',
      '计划状态变更会同步关联待办（linked_task_id）',
      '任务层级仅两级（parent_id），已禁用三级链',
      '节假日变更后全量重排在同一事务内完成',
    ],
  },
  {
    name: '归档管理（FR6）',
    overview: '归档 = 软删除区：任务与项目计划归档后统一在此管理（可还原或彻底删除）；支持多选批量、搜索、分类/项目筛选与分页。',
    steps: [
      '任务/计划页多选勾选后「归档」，条目进入归档区',
      '进入「设置 → 归档管理」，可「多选模式」勾选后批量还原或批量彻底删除',
      '搜索框按标题/编号/项目名检索；任务区可按分类筛选、计划区可按项目筛选',
      '列表分页展示（每页 20 条），支持逐条还原/删除',
    ],
    tips: ['彻底删除不可恢复（仅限已归档内容）', '任务图片随任务级联归档/删除', '归档与「历史资产」语义不同：归档是软删除区，历史资产是项目级组织过程资产沉淀'],
  },

  {
    name: '历史资产（项目快照）',
    overview: '项目级组织过程资产沉淀：把整个项目转为「历史快照」——沉淀后该项目从任务菜单/项目计划菜单的项目列表中完全隐去，内容以快照形式留存，可整体恢复或归档删除。',
    steps: [
      '进入「历史资产」，在项目下拉选择要沉淀的活跃项目 → 点击「沉淀为历史快照」',
      '快照卡片显示：项目名 + 统计（任务/完成、计划/完结）+ 沉淀时间',
      '展开快照卡片可查看该项目**全量任务与计划**的只读快照',
      '「恢复」：整个快照回到活跃项目（重新出现在任务/计划菜单）',
      '「归档删除」：整个项目内容转入归档区（软删除、可恢复），项目标记为已归档',
    ],
    tips: [
      '沉淀后项目名被占用：新建同名项目会被拒绝（避免与快照混淆）',
      '沉淀不删除任何数据——任务与计划原样保留在快照中',
      '统计卡展示活跃项目数、历史快照数、快照内任务与计划总数及沉淀时间跨度',
    ],
  },
  {
    name: '提示词库',
    overview: '按分类维护可复用的提示词模板，任务页可快速插入，支持智能分类。',
    steps: ['在「提示词」页新建分类与条目', '任务页标题分类下拉可启用智能分类'],
  },
  {
    name: '通用需求仓库',
    overview: '沉淀「优秀实现 / 解决方案」类通用需求，按分类维护条目，可一键转待办或转化为项目计划草稿，支持内容指纹查重避免重复。',
    steps: ['在「通用需求」页新建分类与条目', '条目可「转待办」落到收件箱，或「转化为计划」生成项目计划草稿', 'AI 控制台「提炼通用需求」可批量将任务洞察存为需求条目'],
    tips: ['条目带内容指纹（sha256 前 24 位），重复提炼/转存会提示已存在', '通用需求 → 计划草稿带「[需求]」前缀并自动查重'],
  },
  {
    name: 'AI 工作台（周报与 AI 控制台）',
    overview: 'AI 能力入口与报表生成中枢：页面顶部为能力卡片（AI 项目计划导入 / 离线周报生成 / AI 周报生成），右侧为 AI 控制台（统一承载所有 AI 任务的执行输出）。',
    steps: [
      '「AI 项目计划导入」：展开面板 → 选目标项目与文件（.xlsx/.csv/.md/.docx）→ AI 解析（使用控制台当前模型）→ 编辑草稿 → 保存入库；执行过程在控制台「AI 项目计划导入」tab 逐行滚动输出',
      '「离线周报生成」：选择模板与周期，本地聚合并按标准版式合成 Excel/Word/PDF/PPT，无需联网',
      '「AI 周报生成」：结合真实任务数据由 AI 撰写洞察并按内置 skill 版式合成；可勾选「生成后把摘要写入收件箱任务」',
      'AI 控制台：选择分析内容（周期要点汇总/风险与阻塞/改进建议/经验教训/提炼通用需求/自定义）→「开始分析」并行执行，结果以 tab 并存',
      '「对比模式」：勾选多个模型后并行执行同一分析，结果 tab 并列对比',
    ],
    tips: [
      '所有 AI 任务在控制台以 tab 并列展示，可随时切换查看，互不阻塞',
      '执行输出统一在控制台滚动显示（含 AI 项目计划导入、AI 周报流式生成）',
      'AI 生成严格基于聚合的真实数据，不虚构；生成结果为一次性文件，读取即删除',
      '「转存需求」可把分析出的通用需求清单一键存入「通用需求」分组',
    ],
  },
  {
    name: '数据迁移',
    overview: '换机/重装时全量导出为单个 JSON 备份，必要时导入（合并/保留/覆盖三种策略）。',
    steps: ['旧机「导出备份」下载 JSON', '新机「选择文件导入」并按需选择冲突策略'],
    tips: ['覆盖策略会清空并替换全部数据，操作不可恢复', '导入/导出在单事务内完成，失败自动回滚'],
  },
  {
    name: '内网穿透',
    overview: '将本地服务暴露到公网（Tailscale / Cloudflare / cpolar），便于远程访问 API 或 Web 界面；配置访问令牌可防止未授权读写。',
    steps: ['进入「内网穿透」配置 provider 与令牌', '启动后获得公网 URL', '远程访问时需携带 X-Access-Token'],
    tips: ['已配置令牌时，所有 /api 数据接口需携带 X-Access-Token', '打包版使用独立端口 39877，开发版 39876'],
  },
  {
    name: '命令面板（Ctrl+F）',
    overview: '全局命令面板：跨实体搜索任务/项目/提示词，并支持全部主菜单页面直达。按 Ctrl/Cmd+F 唤起。',
    steps: [
      '按 Ctrl/Cmd+F 打开面板（Esc 关闭）',
      '输入关键字：模糊匹配任务（标题/编号）、项目名、提示词，或直接匹配页面名',
      '↑↓ 选择、Enter 执行（跳转页面并自动定位）、Esc 关闭',
    ],
    tips: [
      '选中任务会跳转任务页并自动填入搜索词定位该任务；选中项目跳任务页并按项目名过滤',
      '页面直达覆盖全部主菜单：任务/模型菜单/提示词/通用需求/项目计划/队列/AI 工作台/历史资产/设置',
    ],
  },
  {
    name: '数据维护（DB Admin）',
    overview: '设置 → 数据维护：对任意业务表在线增删改查、批量删除、CSV/JSON 导入导出，并查看表结构。供高级用户直接维护数据。',
    steps: ['进入「设置 → 数据维护」', '选择表后分页查看行、编辑或新增', '危险操作（删行/批删/导入覆盖）需输入确认码 CONFIRM_DELETE'],
    tips: ['表名/列名经白名单正则校验，防注入', '图片 BLOB 以元信息展示，避免列表卡顿'],
  },
  {
    name: '移动端（随手记）',
    overview: '移动 Web 适配：底部 5 Tab（任务/随手记/队列/提示词/更多）。随手记支持文本/语音/模板/图片，离线时存本地草稿，重连自动同步。',
    steps: ['移动端自动按视口/触摸判定加载移动布局（或 URL 加 ?m=1 强制）', '「随手记」≤3 步建任务，支持语音与图片附件', '离线创建的任务存为草稿，恢复网络后自动 flush'],
    tips: ['只读模块（队列/配置/归档）编辑引导回桌面端', '访问令牌缺失时弹出令牌输入框（/health 返回 unauthorized）'],
  },
];

/** MCP 工具清单（与 server/src/mcp/server.ts 对齐） */
interface McpTool { name: string; title: string; desc: string; params: string; }
const MCP_TOOLS: McpTool[] = [
  { name: 'mtask_list_projects', title: '列出项目', desc: '返回全部项目（项目维度任务管理容器）', params: '—' },
  { name: 'mtask_create_task', title: '创建任务', desc: '指定项目新建任务，projectId 缺省落默认记事项目', params: 'title*（必填）；projectId / description / priority / status / categoryId 可选' },
  { name: 'mtask_update_task', title: '更新任务', desc: '按 id 更新任务字段，未提供的字段保持不变', params: 'id*；title / description / priority / status / verified / pinned / categoryId（null=清除）' },
  { name: 'mtask_list_tasks', title: '列出任务', desc: '按项目/归档态列任务，projectId 空列出全部', params: 'projectId?；archived?（默认 false）' },
  { name: 'mtask_get_task', title: '查询任务', desc: '按 id 或任务编号返回任务详情（含截图元信息）；读取待办详情会自动把该任务置为「运行中」状态', params: 'id? / taskNo?（二选一）' },
  {
    name: 'mtask_get_task_images',
    title: '读取任务截图',
    desc: '读取任务全部截图（含验证失败反馈随附截图）；默认返回 base64 dataURL，AI 可直接识别图片内容（单图 >3MB 仅返回元信息）',
    params: 'id? / taskNo?；includeData?（默认 true）',
  },
  {
    name: 'mtask_write_task_status',
    title: '回写 AI 处理状态',
    desc: '显式设置任务的 AI 处理状态（running/failed/unread/空=已读）。常规场景无需调用——状态已由接口自动驱动（读取→running、回传→unread、验证失败→failed）',
    params: 'id? / taskNo?；state*（running|failed|unread|""）',
  },
  { name: 'mtask_move_tasks', title: '批量移动项目', desc: '把一组任务移动到目标项目', params: 'taskIds[]*；projectId*' },
  { name: 'mtask_set_tasks_archived', title: '归档/还原任务', desc: '批量归档（true）或还原（false）一组任务', params: 'taskIds[]*；archived*' },
  { name: 'mtask_list_prompt_categories', title: '列出提示词分类', desc: '返回全部提示词分类及各自条目数量', params: '—' },
  { name: 'mtask_create_prompt_category', title: '创建提示词分类', desc: '新建提示词分类', params: 'name*；description?' },
  { name: 'mtask_list_prompts', title: '列出提示词', desc: '按分类/关键词列出提示词条目', params: 'categoryId?；keyword?' },
  { name: 'mtask_create_prompt', title: '创建提示词', desc: '在指定分类下创建提示词条目', params: 'categoryId*；title*；content?（默认空）' },
  { name: 'mtask_update_prompt', title: '更新提示词', desc: '更新 title / content / categoryId / pinned', params: 'id*；title / content / categoryId / pinned 可选' },
  { name: 'mtask_delete_prompt', title: '删除提示词', desc: '按 id 删除提示词（不可恢复）', params: 'id*' },
  { name: 'mtask_gather_report_data', title: '聚合周期数据', desc: '聚合 day/week/month 的真实任务数据（只读）', params: 'period*（day|week|month）；projectId?' },
  { name: 'mtask_generate_report', title: '生成周期报表', desc: '按周期+格式生成报表文件，返回 base64 与文件名', params: 'period*；format*（xlsx|docx|pdf|pptx）；projectId?；templateId?' },
  { name: 'mtask_ai_generate_report', title: 'AI 生成周报', desc: '基于周期真实数据由 AI 撰写洞察并合成文件', params: 'period*；format*；toolId*；projectId?' },
  { name: 'mtask_export_data', title: '导出全量数据', desc: '导出全部业务数据为 bundle JSON', params: '—' },
  { name: 'mtask_import_data', title: '导入全量数据', desc: '导入 export 产物；overwrite/keep/merge 策略，单事务回滚', params: 'data（bundle 对象）*；mode*（overwrite|keep|merge）' },
  { name: 'mtask_list_plans', title: '列出项目计划', desc: '返回项目计划（串行瀑布时间线 + 关联待办号）', params: 'projectId?；projectName?；includeArchived?' },
  { name: 'mtask_create_plans', title: '批量建计划', desc: 'WBS 拆行批量建计划，首条 startDate 作锚点，其余按工作日顺排', params: 'projectId?；projectName?；items[]*（title/durationDays/...）' },
  { name: 'mtask_update_task_result', title: '同步处理结果', desc: '把 AI 执行结果写回任务 handle_result 字段', params: 'id?；taskNo?；result*' },
];

const humanStr = (s: string) => s.replaceAll('**', '');

function FeaturesScreen() {
  return (
    <div style={{ maxWidth: 760 }}>
      {FEATURES.map((f) => (
        <div key={f.name} style={{ marginBottom: 16, padding: 14, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)' }}>
          <div style={{ fontSize: 'var(--fs-l)', fontWeight: 600, marginBottom: 6 }}>● {f.name}</div>
          <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 8 }}>{f.overview}</div>
          {f.steps && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 'var(--fs-m)', fontWeight: 600, marginBottom: 4 }}>操作步骤</div>
              <ol style={{ margin: 0, paddingLeft: 20, fontSize: 'var(--fs-m)' }}>
                {f.steps.map((s) => <li key={s} style={{ marginBottom: 2 }}>{s}</li>)}
              </ol>
            </div>
          )}
          {f.tips && (
            <div>
              <div style={{ fontSize: 'var(--fs-m)', fontWeight: 600, marginBottom: 4 }}>注意事项</div>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 'var(--fs-m)', color: 'var(--text-secondary)' }}>
                {f.tips.map((t) => <li key={t} style={{ marginBottom: 2 }}>{t}</li>)}
              </ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function McpScreen() {
  return (
    <div style={{ maxWidth: 860 }}>
      <p style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)' }}>
        MTask 通过 <strong>MCP（Model Context Protocol）Streamable HTTP</strong> 暴露能力给外部 AI agent。端点{' '}
        <code style={{ background: 'var(--code-bg)', padding: '1px 4px', borderRadius: 4 }}>/api/mcp</code>，开发版端口<code style={{ background: 'var(--code-bg)', padding: '1px 4px', borderRadius: 4 }}>39876</code>，打包版<code style={{ background: 'var(--code-bg)', padding: '1px 4px', borderRadius: 4 }}>39877</code>。已配置访问令牌时，需携带{' '}
        <code style={{ background: 'var(--code-bg)', padding: '1px 4px', borderRadius: 4 }}>X-Access-Token</code> 请求头。
      </p>

      <div style={{ fontWeight: 600, fontSize: 'var(--fs-l)', margin: '6px 0 4px' }}>协议与会话</div>
      <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 8 }}>基于 JSON-RPC 2.0，请求体为 JSON；会话通过 <code style={{ background: 'var(--code-bg)', padding: '1px 4px', borderRadius: 4 }}>mcp-session-id</code> 头部关联。</div>
      <FieldTable head={['时机', '方法', '说明']} rows={[
        ['首次', 'initialize', '握手并建立会话（无 mcp-session-id 时须为首个请求）'],
        ['会话中', 'notifications/initialized + tools/* 等', '凭 mcp-session-id 复用同一传输执行调用'],
        ['结束', 'DELETE /api/mcp', '终止会话并释放连接'],
      ]} />

      <div style={{ fontWeight: 600, fontSize: 'var(--fs-l)', margin: '12px 0 4px' }}>工具清单（21 个）</div>
      <FieldTable head={['工具名', '功能', '参数（* 为必填）']} rows={MCP_TOOLS.map((t) => [t.name, `${t.title} · ${t.desc}`, humanStr(t.params)])} />

      <div style={{ fontWeight: 600, fontSize: 'var(--fs-l)', margin: '12px 0 4px' }}>请求示例</div>
      <Code lang="JSON-RPC" title="1) 初始化会话" code={`POST /api/mcp HTTP/1.1
Host: 127.0.0.1:39876
Content-Type: application/json
X-Access-Token: <配置的访问令牌>

{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": { "protocolVersion": "2025-06-18", "capabilities": {},
    "clientInfo": { "name": "my-agent", "version": "1.0.0" } } }`} />
      <Code lang="JSON-RPC" title="2) 调用工具" code={`{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "mtask_create_task",
    "arguments": { "title": "示例任务", "priority": "high" } } }`} />
      <Code lang="JSON-RPC" title="响应示例" code={`{ "jsonrpc": "2.0", "id": 2, "result": {
  "content": [ { "type": "text", "text": "{...任务整体 JSON...}" } ],
  "structuredContent": { "task": { "id": "...", "title": "示例任务" } } } }`} />

      <div style={{ fontWeight: 600, fontSize: 'var(--fs-l)', margin: '12px 0 4px' }}>错误码</div>
      <FieldTable head={['错误码', '含义', '说明']} rows={[
        ['-32700', '解析错误', '请求体非法 JSON'],
        ['-32600', '无效请求', '缺少会话或非法请求结构'],
        ['-32601', '方法未找到', '调用了未注册的 JSON-RPC 方法'],
        ['-32602', '无效参数', '参数缺失或类型/枚举不合法'],
        ['-32603', '内部错误', '服务端处理失败'],
        ['-32000', '无效会话', 'HTTP 层返回 400：无有效 mcp-session-id'],
        ['401', '未授权', 'X-Access-Token 缺失或不匹配'],
        ['业务', '执行失败', '工具返回 isError:true 及中文错误文本'],
      ]} />
    </div>
  );
}

const CFG_FIELDS: string[][] = [
  ['type', 'string', '必填', '适配器类型：openai-compatible / claude / ollama / workbuddy'],
  ['name', 'string', '必填', '工具显示名'],
  ['endpoint', 'string', '必填', '接口地址；openai-compatible 自动补 /v1'],
  ['apiKey', 'string', '视类型', '接口密钥（加密落库、界面脱敏）；ollama 本地无需'],
  ['model', 'string', '推荐', '默认模型名'],
  ['purpose', 'string', '可选', 'organize（梳理）/ develop（开发）'],
  ['temperature', 'number', '可选', '采样温度，默认 0.2'],
  ['maxTokens', 'number', '可选', '最大输出 token，默认 4096'],
  ['timeoutMs', 'number', '可选', '超时毫秒，默认 60000（workbuddy 作为异步等待上限）'],
  ['enabled', 'boolean', '可选', '是否启用，默认 true'],
];

function ConfigScreen() {
  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)' }}>
        以下为「AI 配置」新增工具时的配置模板（3 种典型场景），在配置页填写即可；字段含义见下表。
      </p>

      {[
        ['典型 1 · OpenAI 兼容（DeepSeek / 通义等）', 'application/json', `{
  "type": "openai-compatible",          // 必填：适配器类型
  "name": "DeepSeek",                    // 必填：显示名
  "endpoint": "https://api.deepseek.com",// 必填：未带版本段时自动补 /v1（自带 /v4 等则不补）
  "apiKey": "sk-xxxx",                   // 必填：接口密钥
  "model": "deepseek-chat",              // 推荐：默认模型
  "purpose": "develop",                  // organize | develop
  "temperature": 0.2, "maxTokens": 4096, "timeoutMs": 60000
}`],
        ['典型 2 · 本地 Ollama', 'application/json', `{
  "type": "ollama",                      // 本地推理，无需密钥
  "name": "本地 Ollama",
  "endpoint": "http://127.0.0.1:11434",  // 走 /api/chat
  "model": "qwen2.5-coder:7b",
  "purpose": "develop",
  "timeoutMs": 120000
}`],
        ['典型 3 · WorkBuddy 回调中继（异步）', 'application/json', `{
  "type": "workbuddy",                   // 中继/回调型适配器
  "name": "WorkBuddy 中继",
  "endpoint": "https://your-relay.example.com/mock/workbuddy",
  "purpose": "develop",
  "timeoutMs": 120000                    // 作为异步等待上限（轮询收口）
}`],
      ].map(([t, lang, code]) => (
        <Code key={t} title={t} lang={lang} code={code} />
      ))}

      <div style={{ fontWeight: 600, fontSize: 'var(--fs-l)', margin: '14px 0 4px' }}>字段说明</div>
      <FieldTable head={['字段', '类型', '必填', '说明']} rows={CFG_FIELDS} />

      <div style={{ fontWeight: 600, fontSize: 'var(--fs-l)', margin: '14px 0 4px' }}>应用偏好（localStorage）</div>
      <Code lang="application/json" title="settings.prefs" code={`{
  "theme": "light",       // light | dark
  "font": "default",      // default | mono | kai | song
  "fontSize": "m"         // s | m | l
}`} />
    </div>
  );
}

function QuickstartScreen() {
  const steps = [
    ['1', '建项目与任务', '在项目页新建项目并用任务页建任务（标题必填，可填描述/优先级/分类）。'],
    ['2', '配置 AI 工具', 'AI 配置页新增工具并按「配置样例」填写 endpoint/模型/密钥，测试连接通过后再使用。'],
    ['3', 'AI 梳理任务', '任务页触发 AI 梳理，审阅草稿并确认回填为任务摘要。'],
    ['4', '队列分发执行', '队列页新建当日队列，把待办任务与工具组队发送；异步平台会自动轮询收口结果。'],
    ['5', '审阅与归档', '队列行展开审阅回执，可「采纳」保存到任务；完成任务随时归档，归档后可删除。'],
    ['6', '接入 AI Agent（MCP）', '外部 agent 以 MCP 调用 /api/mcp 能力，可读写项目/任务/提示词、生成报表、导入导出数据。'],
  ];
  return (
    <div style={{ maxWidth: 720 }}>
      <p style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 12 }}>
        一条贯穿主流程的路径：从建任务到交给 AI 执行并归档。
      </p>
      {steps.map(([n, t, d]) => (
        <div key={n} style={{ display: 'flex', gap: 12, marginBottom: 12, padding: 14, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--card-bg)' }}>
          <div style={{ flexShrink: 0, width: 28, height: 28, borderRadius: '50%', background: 'var(--accent)', color: 'var(--accent-text)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 'var(--fs-m)' }}>{n}</div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 'var(--fs-m)' }}>{t}</div>
            <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginTop: 2 }}>{d}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function HelpTab() {
  const [sub, setSub] = useState<Sub>('features');
  return (
    <div>
      <nav style={{ display: 'flex', gap: 4, marginBottom: 12, overflowX: 'auto' }}>
        {SUBS.map((t) => (
          <button
            key={t.key}
            onClick={() => setSub(t.key)}
            style={{
              fontSize: 'var(--fs-m)', padding: '6px 14px', borderRadius: 6, whiteSpace: 'nowrap',
              background: sub === t.key ? 'var(--accent)' : 'var(--card-bg)',
              color: sub === t.key ? 'var(--accent-text)' : 'var(--text)', cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {sub === 'features' && <FeaturesScreen />}
      {sub === 'mcp' && <McpScreen />}
      {sub === 'config' && <ConfigScreen />}
      {sub === 'quickstart' && <QuickstartScreen />}
    </div>
  );
}