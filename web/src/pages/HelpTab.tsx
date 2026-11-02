import { useState } from 'react';

/**
 * 设置页「帮助文档」Tab：集中展示功能说明、MCP 接口文档、配置 JSON 样例与快速上手。
 * 内容以结构化数据驱动渲染，字段与现有实现（mcp/server.ts、SettingsPage、settings.tsx）对齐，
 * 离线可读、便于维护。样式沿用全局 CSS 变量，自动适配主题与字号。
 *
 * T03715：按当前一级菜单（任务/模型/提示词/通用需求/项目管理/AI 工作台/队列/执行会话/设置）
 * 与设置页三分组重排；MCP 工具清单与 server.ts 注册的 44 个工具逐条对齐。
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
    name: '任务',
    overview: '按项目组织待办的处理中枢：待办/已完成/搁置三态分页、列表与看板双视图、多选批量、详情抽屉，以及「处理 → 回传 → 审核 → 归档」的 AI 状态闭环。',
    steps: [
      '左侧选择项目（支持排序/置顶/重命名/绑定工作空间），右侧按「待办 / 已完成 / 搁置」切换',
      '新建任务：标题必填，可填描述/优先级/分类/自定义字段；支持粘贴截图（单图建议 ≤8MB）',
      '列表与看板随时切换；点列头排序，按下拉筛选分类/优先级/自定义字段，分页触底续载',
      '多选模式勾选后批量操作：完成/重开、优先级、分类、字体颜色、归档、标记验证',
      '展开行或打开详情抽屉：描述、处理结果、AI 摘要、时间线、关联计划、Git、阻塞关系、自定义字段八个标签',
      '已完成任务可「标记验证失败」：弹窗填写原因并附截图，提交后自动回退待办',
      '「AI 美化」重排正文并保留全部语义；「AI 简化」依据正文高度总结为 ≤40 字简洁标题（无正文时置灰）',
    ],
    tips: [
      '任务编号前的 AI 状态由接口显式驱动：running=转圈、unread=待查看圆点、failed=红色警示；读取详情不会自动置为运行中',
      '只有 done+verified 才算验证通过；标记验证失败会清空验证结果并回退待办',
      '非归档任务不可删除，需先归档；归档任务可在「设置 → 归档」还原或彻底删除',
      '详情抽屉「结果历史」保留处理结果的逐版 diff，可回滚到任一历史版本',
      '同一项目内可建子任务（父任务层级），子任务状态与进度在抽屉底部汇总',
    ],
  },
  {
    name: '任务的 AI 辅助与 Git 关联',
    overview: '任务行内的智能能力：分类/优先级建议、工作空间检索与只读问答、Git 提交徽标，以及「未回写」补录闭环。',
    steps: [
      '「AI 分类建议」给出分类 + 优先级 + 一句理由，采纳后才落库；建议入口显隐与采纳率在「设置 → 通用设置」',
      '项目绑定工作空间后可用「工作空间检索」全文找代码；「工作空间问答」只读作答，引用可跳转源码',
      'Git 徽标显示关联提交简写（多个提交显示最新一条 +N）；未回写的已完成任务显示「未回写」',
      '已完成 tab 顶部「未回写」提示条：可一键复制回写指令，或打开 Git 树弹窗手动关联',
      '「AI 智能关联」让 AI 比对已完成未回写任务与仓库近期提交，给出候选后逐条勾选确认（不自动落库）',
      '任务工具条「Git」开关可整列隐藏徽标，切换页面后保持',
    ],
    tips: [
      '徽标点开：能识别 GitHub/GitLab/Gitee/自建 GitLab 时打开提交页，否则打开详情抽屉的 Git 页',
      'Git 环境不可用（未绑定工作空间 / 非 Git 仓库 / 未装 git / 无 origin）时徽标显示「不可用」，悬浮给出具体原因',
      '「未回写」只统计当前页已加载的已完成任务；任务归档后可能被物理删除，补录窗口有限',
      '只读问答不会 checkout 或改动工作区；未绑定工作空间时入口置灰并说明原因',
    ],
  },
  {
    name: '模型',
    overview: '管理 AI 厂商连接配置：地址、密钥（加密落库、界面脱敏）、模型、用途与默认项；支持连通性测试、模型拉取与用量统计。',
    steps: [
      '「新增配置」选择类型并填写 endpoint / API Key / 模型；编辑时密钥留空即保留原值',
      '操作列「测试连接」校验连通性；「拉取模型」获取该服务可用模型列表',
      '「复制模型」一键复制模型名；「归档」软删除该配置（列表不再显示、记录仍保留）',
      '设为「默认整理」或「默认开发」后，各 AI 功能默认使用该配置',
      '页面下方「用量」面板按模型统计调用次数、Token 与耗时',
    ],
    tips: [
      '支持类型：openai-compatible / claude / ollama / workbuddy',
      '密钥仅加密存储，界面只显示脱敏值；查看原文需二次确认',
      '配置不可用（额度/鉴权失败）时相关 AI 入口可见但禁用，并给出原因与修复动作，不会静默回退',
    ],
  },
  {
    name: '提示词',
    overview: '按分类维护可复用提示词，支持排序检索、复制、复制到待办与智能分类。',
    steps: [
      '「新建分类」组织分组，并维护条目（新建 / 编辑 / 归档）',
      '「复制」到剪贴板；「复制到待办任务」在指定项目生成一条待办',
      '任务页标题分类下拉可启用智能分类；任务页「提示词优化」可对提示词发起优化，运行态切页保持',
    ],
    tips: ['删除分类时其下条目不删除，自动回到未分类', '归档条目数据保留，列表不再显示'],
  },
  {
    name: '通用需求',
    overview: '沉淀「优秀实现 / 解决方案」类通用需求，按分类维护；可一键转待办，也可作为项目计划草稿的来源。',
    steps: [
      '新建分类与条目（新建 / 编辑 / 删除 / 复制）',
      '条目「复制到待办任务」落到指定项目',
      'AI 控制台「提炼通用需求」可批量把任务洞察存为需求条目',
    ],
    tips: [
      '条目带内容指纹（sha256 前 24 位），重复提炼/转存会提示已存在',
      '通用需求转计划草稿时带「[需求]」前缀并自动查重',
      '零散需求走这里，整份 PRD 走「AI 工作台 → 从 PRD 导入项目计划」',
    ],
  },
  {
    name: '项目管理 · 计划与时间线',
    overview: '串行瀑布时间线：计划任务按工作日自动顺排（跳过周末与节假日），支持列表/甘特/时间轴视图、依赖与里程碑、三点估算与 Excel 导入导出。',
    steps: [
      '选择项目后新建计划任务并填工期；首条带开始日期作锚点，其余按工作日自动顺排',
      '视图切换：计划列表 / 甘特 / 纵向时间轴；点列头展开过滤控件',
      '多选批量：改状态、挂接待办、归档、AI 评估、补算复杂度',
      '维护节假日（手动或联网导入法定节假日），时间线随之整表重排',
      '依赖成对维护：serial（串行，顺延后续排期）/ parallel（并行）；里程碑可由子任务包络自动重算起止与工期',
      '「估算视图」录入三点估算（乐观/最可能/悲观），查看 P50/P84 区间并导出 Excel / PDF',
      'Excel 模板导入导出；「分享」下载只读快照图片',
    ],
    tips: [
      '列过滤只隐藏不匹配行，序号与里程碑区间仍按全量计算',
      '计划状态变更会同步关联待办（linked_task_id）；待办完成会回写计划状态与进度',
      '任务层级仅两级（parent_id），不支持三级链',
      'AI 复杂度评级 1~5，≥4 标红并建议拆分',
      '里程碑达成预测依据剩余工作日与子项进度给出结论',
    ],
  },
  {
    name: '项目管理 · 需求与质量视图',
    overview: '项目级的四类结构与视图：PRD 管理、需求跟踪矩阵、测试用例、迭代燃尽，以及项目洞察与 Webhook。',
    steps: [
      '「PRD 管理」查看文档生命周期与待确认问题；AI 生成的 PRD 也在此确认后入库',
      '「需求跟踪矩阵」每条需求挂接计划与待办，一眼看覆盖与进度，可手工新建/关联/调整',
      '「测试用例」按需求维护用例与步骤并显示覆盖率；AI 可从 PRD 生成用例草稿',
      '「迭代与燃尽」按迭代查看剩余工作量与燃尽曲线',
      '「项目洞察」四张图呈现进度、风险与分布；「Webhook」维护订阅与投递日志',
    ],
    tips: [
      '需求状态由关联计划与待办完成度自动派生（done / doing / todo），不需要手工追状态',
      '测试用例与需求挂接后计入覆盖率，孤立用例可单独筛选',
      'PRD 原文可在任务/计划/需求侧反查，作为 AI 处理上下文',
    ],
  },
  {
    name: 'AI 工作台 · 能力卡片',
    overview: '11 张能力卡集中入口：报表、PRD、计划、测试用例、PPT、讲稿与质量扫描；顶部范围选择器决定项目范围。',
    steps: [
      '「AI 项目计划导入」：上传 Excel / 需求文档，AI 解析为计划草稿，确认后批量入库',
      '「离线报表 / AI 报表」：本地聚合或 AI 撰写洞察，按模板合成 Excel/Word/PDF/PPT（周报/月报）',
      '「原始需求生成 PRD」：上传原始需求，结合项目源码上下文生成 PRD 与待确认问题',
      '「从 PRD 导入项目计划」：AI 拆分 WBS + 逐条提取需求，生成计划与需求跟踪矩阵（可选同步待办）；支持 .docx/.md/.txt/.xlsx/.csv/.pdf/.html/.htm（HTML 可直接用 Confluence 导出页或浏览器另存页）；未被任何计划关联的需求会由系统自动补一条「REQ-xxx … 实现/验证」任务（可改标题或取消勾选），解析失败的分片可在面板查看原文并单独补解析',
      '「从 PRD 生成测试用例」：拆分需求 + 分块生成 + 覆盖校验，草稿确认后入库（同一 PRD 重跑幂等）',
      '「启动会 PPT / 阶段总结 PPT」：按项目资料或汇报周期装配原生可编辑 .pptx',
      '「代码评审讲稿」：采集增量 diff，左 diff 右讲稿，锚点可定位',
      '「Git 增量资产提取」：按任务导出源文件 zip / Excel 清单 / Markdown 清单（只读，不耗 AI 额度）',
      '「Sonar 质量扫描」：对关联提交快照扫描，七阶段进度、按严重度分组、高危问题自动回写待办（不耗 AI 额度）',
    ],
    tips: [
      '卡片角标显示运行状态与耗时；执行输出统一在右侧 AI 控制台滚动显示',
      '需要 AI 的卡片在模型不可用时显示禁用与原因（不静默失败）',
      '多项目范围：报表与阶段总结支持合并多项目；启动会 PPT 与导入类以面板内目标项目为准',
      'Git 提取单次上限 2000 文件 / 50MB，同时最多 2 个导出；Sonar 并发默认 1（可调 2），超限不排队',
    ],
  },
  {
    name: 'AI 工作台 · 控制台与用量',
    overview: '右侧 AI 控制台承载所有 AI 任务的执行输出：分析结果 tab 并存、多模型对比、统一用量统计。',
    steps: [
      '选择分析内容（周期要点 / 风险与阻塞 / 改进建议 / 经验教训 / 提炼通用需求 / 自定义）→ 开始分析，结果以 tab 并存',
      '「对比模式」勾选多个模型并行执行同一分析，结果 tab 并列对比',
      '「收起文档区」全屏看控制台日志，「展开文档区」恢复面板',
      '「用量」面板按模型与卡片统计调用量、Token 与耗时',
    ],
    tips: [
      'AI 任务互不阻塞，可随时切换 tab 查看',
      'AI 生成严格基于聚合的真实数据，不虚构；生成的报表文件读取即删除，不在服务端留存',
    ],
  },
  {
    name: '队列',
    overview: '把「任务 + AI 工具」按序组队执行；并行任务池限制同时运行数量，结果需人工采纳才算闭环。',
    steps: [
      '新建今日队列并打开，「加入队列」选择任务与工具',
      '点击发送：同步工具即时返回，异步工具受理后由后台轮询收口',
      '展开行审阅 request/response，可「采纳」或「复制」',
      '并行任务池显示运行中/排队/上限，可调整上限；单任务可暂停（移出分发池，任务转搁置）',
      '「重试失败」把失败/超时任务重置为待发送',
    ],
    tips: [
      '提交前会固化任务上下文快照，避免任务被改导致回执错位',
      '采纳仅保存文本并置任务完成；异步任务超时按工具 timeoutMs 判定',
      '删除队列 / 移除任务前有二次确认',
    ],
  },
  {
    name: '执行会话',
    overview: '外部 AI 平台（WorkBuddy / Trae / 中继）执行任务期间的会话观测面板：存活/停滞/已完成三态、阶段、进度、心跳与关联任务。',
    steps: [
      '打开「执行会话」查看顶部三态统计',
      '每条会话展示平台、阶段、进度、最近心跳与关联任务',
      '点右上「刷新」立即拉取；页面每 15 秒自动轮询',
    ],
    tips: [
      '停滞口径：最近心跳超过 supervisor.sessionStaleMs（默认 10 分钟）',
      '数据来自外部平台调用 mtask_report_progress 的上报（建议 30~60 秒一次）',
      '面板只读，不提供任何会触发外部平台动作的入口',
      '监督器（Supervisor）可判定就绪任务并分配平台，状态与审计在「设置 → 监督审计」',
    ],
  },
  {
    name: '设置 · 通用与仪表盘',
    overview: '应用级偏好与统计：主题/主题预设/强调色/字体/字号/界面语言/任务通知/关闭窗口行为/AI 建议开关，以及仪表盘四指标。',
    steps: [
      '「通用设置」选择主题（浅色/深色/跟随系统）或主题预设，调整强调色、字体字号与界面语言',
      '桌面端可开启「任务通知」：AI 处理完成/失败弹系统通知，点击通知可定位到任务',
      '桌面端可设「关闭窗口行为」：最小化到托盘（应用继续运行，正在跑的 AI 任务不打断，点托盘图标即唤回窗口）或直接关闭；未记住时点关闭按钮会弹窗询问，勾选「记住此选择，下次不再提示」后按所选行为直接执行',
      '「任务分类建议」提供总开关与采纳率（分母为已展示数）',
      '「仪表盘」查看周吞吐、AI 成功率、AI 平均耗时、验证通过率与吞吐趋势，可切换 7/30/90 天与项目',
    ],
    tips: [
      '偏好即时生效并写入 settings.prefs，刷新/重开应用后保持',
      '界面语言为渐进式接入，未覆盖的页面仍显示中文',
    ],
  },
  {
    name: '设置 · 数据管理',
    overview: '任务分类、自定义字段、循环任务、历史资产、归档、数据迁移与数据维护七个数据页签。',
    steps: [
      '「任务分类」新增/编辑/删除分类；删除后其下任务回到未分类（任务保留）',
      '「自定义字段」按项目定义文本/数字/日期/单选字段与选项；被任务引用的选项禁止硬删',
      '「循环任务」按频率或 cron 表达式定时生成任务副本（标题自动带日期后缀）',
      '「历史资产」把项目整体沉淀为快照，可恢复或归档删除',
      '「归档」批量还原或彻底删除已归档的任务与计划（支持搜索、分类/项目筛选与分页）',
      '「数据迁移」导出单个 JSON 备份，导入可选合并/保留/覆盖三种策略',
      '「数据维护」对任意业务表在线增删改查、批量删除、CSV/JSON 导入导出并查看表结构',
    ],
    tips: [
      '循环任务由服务端在启动时与每小时 tick 检查到期生成',
      '历史资产沉淀后项目名被占用：新建同名项目会被拒绝；沉淀不删除任何数据',
      '覆盖导入会清空并替换全部数据，不可恢复；导入在单事务内完成，失败自动回滚',
      '数据维护的危险操作需输入确认码 CONFIRM_DELETE，表名/列名经白名单校验',
      '任务图片随任务级联归档/删除；归档是软删除区，历史资产是项目级组织过程资产',
    ],
  },
  {
    name: '设置 · API Token 与 SonarQube',
    overview: '外部脚本凭据与 SonarQube 质量扫描的环境配置。',
    steps: [
      '「API Token」新建命名凭据并选择只读或读写范围；明文仅在创建时展示一次，可停用或撤销',
      '「SonarQube」填写服务器地址、认证 Token（加密、脱敏、查看需二次确认并留审计）、扫描器路径与各项目 projectKey',
      '「连接测试」可分别校验服务器状态 / 扫描器版本 / 项目键可达性，支持用未保存的草稿值直接测试',
      '扫描并发上限 1~2（默认 1），超出不排队',
    ],
    tips: [
      '只读凭据仅放行 GET（写操作返回 403），适合看板/统计类脚本',
      'Sonar Token 权限给「执行分析 + 浏览」即可，不需要项目管理员',
      '扫描基于提交快照，不 checkout、不改动工作树；Java 环境为只读探测展示',
    ],
  },
  {
    name: '设置 · 运维与诊断',
    overview: '监督审计、内网穿透与日志三个排障页签。',
    steps: [
      '「监督审计」查看监督器状态（熔断开关 / tick 周期 / token 预算 / 活跃与停滞会话）、最近决策与审计记录，可调整中继与运行参数',
      '「内网穿透」配置 provider 与访问令牌，启动后获得公网 URL',
      '「日志」按级别与来源筛选、暂停/继续、清空，并可调整轮询间隔',
    ],
    tips: [
      '已配置访问令牌时所有 /api 数据接口需携带 X-Access-Token',
      '打包版使用端口 39877，开发版 39876',
      '监督器熔断关闭时不产生就绪任务，拉取接口返回空',
    ],
  },
  {
    name: '设置 · 关于与版本更新',
    overview: '应用信息与在线更新。',
    steps: [
      '「关于」查看版本、描述与许可信息',
      '「检查更新」拉取最新 Release 并与当前版本比较',
      '桌面端可一键下载并静默安装；下载中断会自动续传，菜单入口的下载进度以全局提示条展示',
    ],
    tips: ['升级前建议先在「数据迁移」导出备份', '更新失败时先确认安装包打包时间是否早于修复提交'],
  },
  {
    name: '命令面板（Ctrl+K）',
    overview: '全局命令面板：跨实体搜索任务/项目/提示词，直达全部主菜单与设置页签。',
    steps: [
      '按 Ctrl/Cmd+K 打开（Esc 关闭）；Ctrl/Cmd+F 优先聚焦当前页搜索',
      '输入关键字：模糊匹配任务（标题/编号）、项目名、提示词，或直接匹配页面名',
      '↑↓ 选择、Enter 执行（跳转页面并自动定位）、Esc 关闭',
    ],
    tips: [
      '选中任务会跳转任务页并自动填入搜索词定位该任务；选中项目跳任务页并按项目过滤',
      '页面直达覆盖全部一级菜单，设置子页签也可直达',
    ],
  },
  {
    name: '移动端（随手记）',
    overview: '移动 Web 适配：底部 5 Tab（任务 / 随手记 / 队列 / 提示词 / 更多）。随手记支持文本/语音/模板/图片，离线存本地草稿，重连自动同步。',
    steps: [
      '移动端按视口与触摸判定自动加载移动布局（或 URL 加 ?m=1 强制）',
      '「随手记」≤3 步建任务，支持语音与图片附件',
      '离线创建的任务存为草稿，恢复网络后自动 flush',
    ],
    tips: [
      '只读模块（队列/配置/归档）编辑引导回桌面端',
      '访问令牌缺失时弹出令牌输入框（/health 为探活豁免路径，不作为鉴权判据）',
    ],
  },
];

/** MCP 工具：与 server/src/mcp/server.ts 注册的 44 个工具对齐（参数前 * 为必填） */
interface McpTool { name: string; title: string; desc: string; params: string; }
interface McpGroup { group: string; tools: McpTool[]; }
const MCP_GROUPS: McpGroup[] = [
  {
    group: '任务管理（10）',
    tools: [
      { name: 'mtask_list_projects', title: '列出项目', desc: '返回全部项目', params: '—' },
      { name: 'mtask_create_task', title: '创建任务', desc: '建任务；默认同项目同标题查重，命中返回 reused=true', params: '*title；projectId / projectName / parentId / priority / status / categoryId / dedupe / derivedFrom' },
      { name: 'mtask_update_task', title: '更新任务', desc: '按 id 更新字段，未提供的保持不变', params: 'id / taskNo；title / description / priority / status / verified / pinned / categoryId' },
      { name: 'mtask_list_tasks', title: '列出任务', desc: '按项目/状态/归档态列任务；默认只返回待处理或未验证', params: 'projectId / projectName / status / scope / archived' },
      { name: 'mtask_get_task', title: '查询任务', desc: '返回详情与截图元信息；读取不会自动置为运行中', params: 'id / taskNo；markRunning（显式声明本次读取即开始处理）' },
      { name: 'mtask_get_task_images', title: '读取任务截图', desc: '返回全部截图 dataURL（含验证失败反馈截图）', params: 'id / taskNo；includeData（默认 true）' },
      { name: 'mtask_update_task_result', title: '同步处理结果', desc: '把结论写入任务「处理结果」字段', params: 'id / taskNo；*result' },
      { name: 'mtask_summarize_task', title: '生成总结摘要', desc: '聚合任务全量信息生成 AI 摘要', params: 'id / taskNo；toolId（缺省用默认整理工具）' },
      { name: 'mtask_move_tasks', title: '批量移动项目', desc: '把一组任务移动到目标项目', params: '*taskIds；*projectId' },
      { name: 'mtask_set_tasks_archived', title: '归档 / 还原', desc: '批量归档或还原任务', params: '*taskIds；*archived' },
    ],
  },
  {
    group: '项目计划（4）',
    tools: [
      { name: 'mtask_list_plans', title: '列出项目计划', desc: '返回时间线计划（含依赖、需求锚点、复杂度）；条目多时用 brief', params: 'projectId / projectName / kind / brief / includeArchived' },
      { name: 'mtask_create_plans', title: '批量建计划', desc: 'WBS 拆行批量建计划，首条 startDate 作锚点，其余按工作日顺排', params: '*items；projectId / projectName / requirements / createTasks' },
      { name: 'mtask_update_plan', title: '更新计划条目', desc: '改日期/工期/进度/状态/负责人/类型/依赖；依赖变更会联动后续排期', params: 'id / planId / title / newTitle / startDate / durationDays / progress / status / assignee / kind / deps' },
      { name: 'mtask_delete_plan', title: '删除计划条目', desc: '归档（软删）并从时间线衔接重排，可在归档区恢复', params: 'id / title' },
    ],
  },
  {
    group: '需求与 PRD（7）',
    tools: [
      { name: 'mtask_import_prd', title: '从 PRD 导入计划', desc: '提取文本 → AI 拆 WBS + 逐条提取需求 → 建需求矩阵与计划（可选建待办）', params: '*toolId；*filename；*fileBase64；projectId / createTasks / onDuplicatePlan / dryRun' },
      { name: 'mtask_list_matrix', title: '查询需求矩阵', desc: '返回需求及其关联计划/待办的覆盖与进度', params: 'projectId / projectName' },
      { name: 'mtask_update_matrix', title: '维护需求矩阵', desc: '新建/改/删需求或调整关联', params: '*action（create/update/delete/link）；projectId / reqId / reqNo / title / linked' },
      { name: 'mtask_list_testcases', title: '查询测试用例', desc: '返回用例、步骤与覆盖度摘要，可按需求/关键词/结果筛选', params: 'projectId / projectName；reqId / q / module / priority / type / status / orphanOnly / limit / offset' },
      { name: 'mtask_update_testcases', title: '维护测试用例', desc: '新建/改/删/批量改用例', params: '*action；caseId / caseIds / reqId / title / steps / patch' },
      { name: 'mtask_get_prd', title: '查询 PRD 原文', desc: '按任务/计划/需求/项目反查关联 PRD 的完整 Markdown', params: 'taskId / taskNo / planId / reqId / prdId / projectId / projectName' },
      { name: 'mtask_update_prd', title: '反向更新 PRD', desc: '用修订后的完整 Markdown 全量覆盖指定 PRD', params: '*prdId；*contentMd' },
    ],
  },
  {
    group: '裁决（3）',
    tools: [
      { name: 'mtask_get_ruling_options', title: '获取裁决选项', desc: '返回该单可选的裁决项（服务端单源）', params: 'id / taskNo' },
      { name: 'mtask_mark_ruling', title: '标记待裁决', desc: '给派生单或请求裁决的单打「待裁决」标记', params: 'id / taskNo' },
      { name: 'mtask_submit_ruling', title: '提交裁决', desc: '提交裁决结果并追加到任务详情末尾', params: 'id / taskNo；*result' },
    ],
  },
  {
    group: 'Git 与状态（2）',
    tools: [
      { name: 'mtask_link_git_commit', title: '回写 Git 提交', desc: '提交代码后回写 commit ID（任务↔提交关联主通道）', params: 'taskNo / id；*commits（单个或数组）' },
      { name: 'mtask_write_task_status', title: '回写 AI 状态', desc: '显式设置 running / failed / unread（「未读待查看」）', params: 'taskNo / id；*state' },
    ],
  },
  {
    group: '执行会话与监督（4）',
    tools: [
      { name: 'mtask_report_progress', title: '上报执行进度', desc: '外部平台周期上报会话与进度并刷新心跳（建议 30~60s）', params: '*platform；*session_id；*task_id；pct / phase / note / done / failed' },
      { name: 'mtask_list_ready_tasks', title: '拉取就绪任务', desc: '返回未认领、无未完成前置依赖且平台匹配的待办', params: 'platform / limit' },
      { name: 'mtask_claim_task', title: '原子认领任务', desc: '校验未被认领后原子置 running 并绑定会话', params: '*task_id；*platform；*session_id' },
      { name: 'mtask_supervisor_status', title: '查询监督状态', desc: '返回熔断开关、tick、预算、会话与最近决策（只读）', params: '—' },
    ],
  },
  {
    group: '提示词（6）',
    tools: [
      { name: 'mtask_list_prompt_categories', title: '列出提示词分类', desc: '返回分类及各分类条目数', params: '—' },
      { name: 'mtask_create_prompt_category', title: '创建提示词分类', desc: '新建提示词分类', params: '*name；description' },
      { name: 'mtask_list_prompts', title: '列出提示词', desc: '按分类或关键词列条目', params: 'categoryId / keyword' },
      { name: 'mtask_create_prompt', title: '创建提示词', desc: '在指定分类下建条目', params: '*categoryId；*title；content' },
      { name: 'mtask_update_prompt', title: '更新提示词', desc: '更新标题/内容/分类/置顶', params: '*id；title / content / categoryId / pinned' },
      { name: 'mtask_delete_prompt', title: '删除提示词', desc: '按 id 删除（不可恢复）', params: '*id' },
    ],
  },
  {
    group: '报表（3）',
    tools: [
      { name: 'mtask_gather_report_data', title: '聚合周期数据', desc: '聚合 day/week/month 真实任务数据（只读）', params: '*period（day/week/month）；projectId / projectIds' },
      { name: 'mtask_generate_report', title: '生成周期报表', desc: '按周期与格式生成报表文件（base64）', params: '*period；*format（xlsx/docx/pdf/pptx）；projectId / projectIds / templateId' },
      { name: 'mtask_ai_generate_report', title: 'AI 生成报表', desc: 'AI 撰写洞察并合成文件，返回洞察正文与文件', params: '*period；*format；*toolId；projectId / projectIds' },
    ],
  },
  {
    group: '数据迁移（2）',
    tools: [
      { name: 'mtask_export_data', title: '导出全量数据', desc: '导出全部业务数据为 bundle JSON', params: '—' },
      { name: 'mtask_import_data', title: '导入全量数据', desc: '导入 export 产物；单事务，失败回滚', params: '*data；*mode（overwrite/keep/merge）' },
    ],
  },
  {
    group: '估算（3）',
    tools: [
      { name: 'mtask_get_estimates', title: '读取估算汇总', desc: '返回三点加权 E 人天、人月、阶段构成与 P50/P84 区间', params: 'projectId / projectName；full / includeArchived' },
      { name: 'mtask_update_estimates', title: '回写三点估算', desc: '按 planId 或 taskNo 回写乐观/最可能/悲观（校验 O≤M≤P）', params: 'planId / taskNo；*optimistic；*likely；*pessimistic；phase / source / note' },
      { name: 'mtask_export_estimate_workload', title: '导出工作量评估', desc: '生成《项目工作量评估》Excel/PDF 交付件', params: 'projectId / projectName；*format；audience / scope / phases' },
    ],
  },
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
  const total = MCP_GROUPS.reduce((n, g) => n + g.tools.length, 0);
  return (
    <div style={{ maxWidth: 860 }}>
      <p style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)' }}>
        MTask 通过 <strong>MCP（Model Context Protocol）Streamable HTTP</strong> 暴露能力给外部 AI agent。端点{' '}
        <code style={{ background: 'var(--code-bg)', padding: '1px 4px', borderRadius: 4 }}>/api/mcp</code>，开发版端口<code style={{ background: 'var(--code-bg)', padding: '1px 4px', borderRadius: 4 }}>39876</code>，打包版<code style={{ background: 'var(--code-bg)', padding: '1px 4px', borderRadius: 4 }}>39877</code>。已配置访问令牌时，需携带{' '}
        <code style={{ background: 'var(--code-bg)', padding: '1px 4px', borderRadius: 4 }}>X-Access-Token</code> 请求头（主令牌或「设置 → API Token」生成的命名凭据）。
      </p>

      <div style={{ fontWeight: 600, fontSize: 'var(--fs-l)', margin: '6px 0 4px' }}>协议与会话</div>
      <div style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 8 }}>基于 JSON-RPC 2.0，请求体为 JSON；会话通过 <code style={{ background: 'var(--code-bg)', padding: '1px 4px', borderRadius: 4 }}>mcp-session-id</code> 头部关联。</div>
      <FieldTable head={['时机', '方法', '说明']} rows={[
        ['首次', 'initialize', '握手并建立会话（无 mcp-session-id 时须为首个请求）'],
        ['会话中', 'notifications/initialized + tools/* 等', '凭 mcp-session-id 复用同一传输执行调用'],
        ['结束', 'DELETE /api/mcp', '终止会话并释放连接'],
      ]} />

      <div style={{ fontWeight: 600, fontSize: 'var(--fs-l)', margin: '12px 0 4px' }}>工具清单（{total} 个，按业务分组）</div>
      {MCP_GROUPS.map((g) => (
        <div key={g.group} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 'var(--fs-m)', fontWeight: 600, margin: '8px 0 2px' }}>{g.group}</div>
          <FieldTable head={['工具名', '功能', '参数（* 为必填）']} rows={g.tools.map((t) => [t.name, `${t.title} · ${t.desc}`, humanStr(t.params)])} />
        </div>
      ))}

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
    "arguments": { "title": "示例任务", "priority": "high", "projectName": "MTask" } } }`} />
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
        ['403', '只读凭据越权', '只读 API Token 调用写操作被拒绝'],
        ['业务', '执行失败', '工具返回 isError:true 及中文错误文本'],
      ]} />
    </div>
  );
}

const CFG_FIELDS: string[][] = [
  ['type', 'string', '必填', '适配器类型：openai-compatible / claude / ollama / workbuddy'],
  ['name', 'string', '必填', '工具显示名'],
  ['endpoint', 'string', '必填', '接口地址；openai-compatible 未带版本段时自动补 /v1'],
  ['apiKey', 'string', '视类型', '接口密钥（加密落库、界面脱敏）；ollama 本地无需'],
  ['model', 'string', '推荐', '默认模型名'],
  ['modelNotes', 'string', '可选', '模型配置说明（给使用者看的备注）'],
  ['purpose', 'string', '可选', 'organize（整理）/ develop（开发）'],
  ['temperature', 'number', '可选', '采样温度，默认 0.2'],
  ['maxTokens', 'number', '可选', '最大输出 token，默认 4096'],
  ['timeoutMs', 'number', '可选', '超时毫秒，默认 60000（workbuddy 作为异步等待上限）'],
  ['enabled', 'boolean', '可选', '是否启用，默认 true'],
  ['remark', 'string', '可选', '配置备注'],
  ['consoleUrl', 'string', '可选', '厂商官方控制台 URL（仅用于跳转展示）'],
];

/** SonarQube 环境配置（设置 → SonarQube，服务端加密存储与审计） */
const SONAR_FIELDS: string[][] = [
  ['serverUrl', 'string', '必填', '服务器地址（http(s)://…），保存时去尾部斜杠并做连通性测试'],
  ['token', 'string', '必填', '认证 Token（加密存储、默认脱敏；查看原文需二次确认并留审计）'],
  ['scannerPath', 'string', '可选', 'sonar-scanner 路径；留空按 PATH 自动探测'],
  ['projectKey', 'string', '按项目', '每个 MTask 项目映射一个 SonarQube projectKey'],
  ['scanLimit', 'number', '可选', '扫描并发上限 1~2（默认 1，超限不排队）'],
];

function ConfigScreen() {
  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)' }}>
        以下为「模型」页新增 AI 工具时的配置模板（3 种典型场景），在配置页填写即可；字段含义见下表。
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

      <div style={{ fontWeight: 600, fontSize: 'var(--fs-l)', margin: '14px 0 4px' }}>AI 工具字段说明</div>
      <FieldTable head={['字段', '类型', '必填', '说明']} rows={CFG_FIELDS} />

      <div style={{ fontWeight: 600, fontSize: 'var(--fs-l)', margin: '14px 0 4px' }}>SonarQube 配置（设置 → SonarQube）</div>
      <FieldTable head={['字段', '类型', '必填', '说明']} rows={SONAR_FIELDS} />
      <Code lang="说明" title="连接测试与权限" code={`· 三项连接测试：服务器状态 / 扫描器版本 / 项目键可达性（可用未保存的草稿值直接测）
· 认证 Token 权限给「执行分析 + 浏览」即可，不需要项目管理员
· Java 环境为只读探测展示；扫描基于提交快照，不 checkout、不改动工作树`} />

      <div style={{ fontWeight: 600, fontSize: 'var(--fs-l)', margin: '14px 0 4px' }}>应用偏好（localStorage）</div>
      <Code lang="application/json" title="settings.prefs" code={`{
  "theme": "light",       // light | dark | auto（跟随系统）
  "font": "default",      // default | mono | kai | song
  "fontSize": "m",        // s | m | l
  "accent": "",           // #rrggbb；空串 = 跟随主题默认
  "zen": false            // 极简阅读模式（隐藏徽标/计数、放大字号）
}`} />
    </div>
  );
}

function QuickstartScreen() {
  const steps = [
    ['1', '建项目与任务', '在任务页选择或新建项目，再建任务（标题必填，可填描述/优先级/分类/自定义字段）。'],
    ['2', '配置模型', '「模型」页新增 AI 配置并按「配置样例」填写 endpoint/模型/密钥，测试连接通过后再使用。'],
    ['3', '需求与计划', '「AI 工作台 → 从 PRD 导入项目计划」拆 WBS 与需求矩阵，或在「项目管理」手工建计划与依赖。'],
    ['4', 'AI 处理任务', '任务页触发 AI 梳理/美化，或加入「队列」按序分发；异步平台由后台轮询收口。'],
    ['5', '结果审阅与回写', '队列行展开审阅并「采纳」；把处理结论回传任务「处理结果」并显式回写 AI 状态。'],
    ['6', 'Git 回写与验证', '提交代码后用 mtask_link_git_commit 回写提交 ID；验证通过后任务标 done+verified。'],
    ['7', '报表与总结', '「AI 工作台」生成周报/月报、启动会 PPT、阶段总结或质量扫描，观察执行会话与用量。'],
    ['8', '沉淀与归档', '项目收口后沉淀为「历史资产」；任务与计划归档后可在「设置 → 归档」还原或彻底删除。'],
  ];
  return (
    <div style={{ maxWidth: 720 }}>
      <p style={{ fontSize: 'var(--fs-m)', color: 'var(--text-secondary)', marginBottom: 12 }}>
        一条贯穿主流程的路径：从需求到任务、交给 AI 执行、回写提交并归档沉淀。
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
