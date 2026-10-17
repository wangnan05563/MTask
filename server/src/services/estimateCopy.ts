/**
 * 估算族错误文案**单源表**（T02293 · `docs/验收门判据规约.md` 判据 1）。
 *
 * 为什么单独成一个文件：估算族有四层抛出点（`estimate-engine` 解析配置、`EstimateService` 校验与 CRUD、
 * `EstimateDerive` 推导、`routes/estimates` 参数收口）。若把常量表挂在其中某一层，
 * 其它层为了一个词干就得跟着引入整层依赖（`routes` 引 `engine`、`mcp` 引 `routes`）。
 * 表落在零依赖的文件里，四层引用同一个对象——改词干只改这一处；
 * `EstimateService` 继续向外 re-export，既有引用（含验收门）不改路径。
 *
 * 只收「门会断言的词干」：整句里带变量的部分（数值、key、planId）留在抛出点拼。
 * 门断言的是「哪一类拒绝」，不是整句话的抄本；改措辞时锚点随常量移动，门不会假红。
 */

/** 「查不到项目」整句词干（历史上散在 service/derive/routes 三处） */
export const ESTIMATE_PROJECT_NOT_FOUND = '项目不存在';

export const ESTIMATE_ERRORS = {
  projectNotFound: ESTIMATE_PROJECT_NOT_FOUND,
  projectIdRequired: 'projectId 必填',
  planIdRequired: 'planId 必填',
  pointsRequired: '必填（该计划尚无估算行）',
  notNumber: '必须是数字',
  negative: '不能为负',
  ordering: '不能大于',
  unknownPhase: '未知阶段',
  unknownUnit: '未知计量单位',
  planNotInProject: '不属于该项目',
  planMissing: '计划条目不存在',
  rowRereadFailed: '估算行写入后回读失败',
  batchEmpty: '批量写入内容为空',
  nothingToClean: '未选择要清理的估算行',
  rowConflict: '该计划已存在估算行',
  milestoneReadonly: '已收口',
  unknownSnapshotFormat: '未知导出格式',
  payloadUnserializable: '无法序列化为 JSON',
  // —— 引擎侧（estimate-engine 解析配置）——
  ratioFormat: '估算推导比例配置格式应为「O:M权重:P」三段正数（如 1:4:1.6）',
  ratioMidPert: '估算推导比例中段必须是 PERT 权重 4（式子 (O+4M+P)/6）',
  paramLabel: '估算参数',
  paramMin: '不得小于',
  paramMax: '不得大于',
  // —— 推导侧（EstimateDerive 用例权重系数 k）——
  caseWeightK: '用例权重系数 k',
  mustBePositive: '必须是正数',
  // —— 路由侧（routes/estimates 参数收口）——
  unknownDeriveRule: '未知推导档位',
  unknownParamKey: '未知估算参数键',
  unknownBatchMode: '未知批量模式',
  compareNeedsTwo: 'compare 需要两个快照 id（形如 ?compare=idA,idB）',
  unknownScope: '未知导出范围',
  unknownAudience: '未知导出版本',
  emptyPhases: 'phases 不能为空（不传即导全部阶段）',
  // —— MCP 侧（mcp/server.ts 估算三枚工具：定位参数只在这里翻译，第二份抄本会让门假绿）——
  projectOrNameRequired: 'projectId 或 projectName 必填',
  planLocateRequired: 'planId 与 taskNo 至少提供一个',
  planMissingOrArchived: '计划不存在或已归档',
  planProjectMismatch: '项目与计划不匹配',
  planOwnerPrefix: '计划属于',
  requestProjectPrefix: '请求里给的是',
  taskNoNoPlanLink: '没有关联计划行',
  taskNoAmbiguousTail: '请改传 planId 指明哪一条',
} as const;

/**
 * §6.3 件名口径单源：`工作量评估[-客户版]-项目名-时间戳`。
 * 三处出口（REST 下载头、MCP base64 件、快照表 filename）都从这里拼，门按同一张表断言——
 * 件名是交付物的一部分，抄两份迟早一份漂移。
 */
export const ESTIMATE_FILE_BASE = '工作量评估';
export const ESTIMATE_FILE_CLIENT_MARK = '-客户版';

/** 三点字段的中文标签单源（校验文案与门断言共用这一份，改措辞不留第二份抄本） */
export const ESTIMATE_POINT_LABELS = {
  optimistic: '乐观值 O',
  likely: '最可能值 M',
  pessimistic: '悲观值 P',
} as const;

/**
 * 按 O→M→P 顺序取标签（声明顺序即文案顺序，`pointsRequired` 整句据此拼）。
 *
 * ⚠ 必须是**函数**而不是模块加载期的数组常量：常量数组是对 `ESTIMATE_POINT_LABELS` 的快照抄本，
 * 表改了它不跟着改——等于把同一份文案存了两处。T02293 的改名模拟（E3 G-01）正是这样抓到第二份抄本的。
 */
export function pointLabelList(): readonly string[] {
  return Object.values(ESTIMATE_POINT_LABELS);
}
