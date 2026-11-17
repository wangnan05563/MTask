/**
 * T01071 后续：i18n 术语表（Glossary）——全站抽取的**唯一译法来源**。
 *
 * 为什么要有它：i18n 的难点不是「翻英文」，而是「同一个概念在 30 个页面里有 8 种中文写法」
 * （如「执行人 / 负责人 / 责任人」），不先统一术语就逐页迁移，译完必然互相打架。
 * 因此本表先固化三层约定：
 *  1. `zh` = 规范中文术语（页面文案必须向它收敛）；
 *  2. `en` = 唯一英文译法（同一 zh 永远得到同一 en）；
 *  3. `aliases` = 需要被消灭的异形写法（CI 会报「术语不一致」，提示改成规范词）。
 *
 * 覆盖范围：跨页面复用的通用词（动作/状态/实体/设置/AI）。页面专有长句不进本表，
 * 由各页面自行 `registerDict('en', {...})` 注册，避免术语表膨胀成百科全书。
 *
 * 约定：zh 与 en 均使用单引号、不含转义字符，便于 CI 脚本（`scripts/i18n-coverage.mjs`）正则解析。
 */
export interface GlossaryTerm {
  /** 规范中文术语 */
  zh: string;
  /** 唯一英文译法 */
  en: string;
  /** 归类（CI 报告按分组统计） */
  group: string;
  /** 异形写法（应收敛到 zh） */
  aliases?: string[];
  /** 备注：为何这样定名 / 易错点 */
  note?: string;
}

export const TERMS: GlossaryTerm[] = [
  // ---- 通用动作 ----
  { zh: '保存', en: 'Save', group: '通用动作' },
  { zh: '删除', en: 'Delete', group: '通用动作' },
  { zh: '编辑', en: 'Edit', group: '通用动作' },
  { zh: '复制', en: 'Copy', group: '通用动作', aliases: ['拷贝'] },
  { zh: '归档', en: 'Archive', group: '通用动作' },
  { zh: '导出', en: 'Export', group: '通用动作' },
  { zh: '导入', en: 'Import', group: '通用动作' },
  { zh: '刷新', en: 'Refresh', group: '通用动作', aliases: ['重新加载'] },
  { zh: '重置', en: 'Reset', group: '通用动作' },
  { zh: '搜索', en: 'Search', group: '通用动作', aliases: ['查找', '检索'] },
  { zh: '取消', en: 'Cancel', group: '通用动作' },
  { zh: '关闭', en: 'Close', group: '通用动作' },
  { zh: '新建', en: 'New', group: '通用动作', aliases: ['新增', '创建'] },
  { zh: '添加', en: 'Add', group: '通用动作' },
  { zh: '移除', en: 'Remove', group: '通用动作' },
  { zh: '确认', en: 'Confirm', group: '通用动作' },
  { zh: '展开', en: 'Expand', group: '通用动作' },
  { zh: '收起', en: 'Collapse', group: '通用动作' },
  { zh: '全选', en: 'Select All', group: '通用动作' },
  { zh: '清空', en: 'Clear', group: '通用动作' },
  { zh: '撤销', en: 'Undo', group: '通用动作', aliases: ['回退', '还原'] },

  // ---- 状态 ----
  { zh: '待办', en: 'To-do', group: '状态', aliases: ['待处理', '未开始'] },
  { zh: '进行中', en: 'In Progress', group: '状态', aliases: ['处理中', '执行中'] },
  { zh: '已完成', en: 'Done', group: '状态', aliases: ['完成', '已结束'] },
  { zh: '受阻', en: 'Blocked', group: '状态', aliases: ['阻塞', '卡住'] },
  { zh: '搁置', en: 'Shelved', group: '状态', aliases: ['挂起', '暂停'] },
  { zh: '待开始', en: 'Not Started', group: '状态' },
  { zh: '启用', en: 'Enabled', group: '状态', aliases: ['开启', '打开'] },
  { zh: '禁用', en: 'Disabled', group: '状态', aliases: ['停用', '关闭'] },
  { zh: '成功', en: 'Success', group: '状态' },
  { zh: '失败', en: 'Failed', group: '状态', aliases: ['错误', '异常'] },

  // ---- 实体 ----
  { zh: '任务', en: 'Task', group: '实体' },
  { zh: '计划', en: 'Plan', group: '实体' },
  { zh: '项目', en: 'Project', group: '实体' },
  { zh: '需求', en: 'Requirement', group: '实体', aliases: ['需求项'] },
  { zh: '用例', en: 'Test Case', group: '实体', aliases: ['测试用例'] },
  { zh: '分类', en: 'Category', group: '实体', aliases: ['类别', '分组'] },
  { zh: '优先级', en: 'Priority', group: '实体' },
  { zh: '负责人', en: 'Assignee', group: '实体', aliases: ['执行人', '责任人', '经办人'] },
  { zh: '进度', en: 'Progress', group: '实体' },
  { zh: '工期', en: 'Duration', group: '实体', aliases: ['时长', '天数'] },
  { zh: '开始日', en: 'Start Date', group: '实体', aliases: ['开始日期', '开始时间'] },
  { zh: '结束日', en: 'End Date', group: '实体', aliases: ['结束日期', '结束时间', '截止日'] },
  { zh: '描述', en: 'Description', group: '实体', aliases: ['说明', '备注'] },
  { zh: '标题', en: 'Title', group: '实体', aliases: ['名称'] },

  // ---- 设置 ----
  { zh: '设置', en: 'Settings', group: '设置', aliases: ['配置'] },
  { zh: '循环任务', en: 'Recurring Task', group: '设置', aliases: ['定时任务', '周期任务'] },
  { zh: '只读', en: 'Read-only', group: '设置' },
  { zh: '读写', en: 'Read/Write', group: '设置' },
  { zh: '每天', en: 'Daily', group: '设置' },
  { zh: '每周', en: 'Weekly', group: '设置' },
  { zh: '每月', en: 'Monthly', group: '设置' },
  { zh: '保留期', en: 'Retention', group: '设置', aliases: ['保留天数'] },
  { zh: '备份', en: 'Backup', group: '设置' },
  { zh: '语言', en: 'Language', group: '设置' },

  // ---- AI ----
  { zh: 'AI 工具', en: 'AI Tool', group: 'AI', aliases: ['模型服务', 'AI 模型'] },
  { zh: '模型', en: 'Model', group: 'AI' },
  { zh: '并发池', en: 'Concurrency Pool', group: 'AI', aliases: ['并发上限', '领取池'] },
  { zh: '复杂度', en: 'Complexity', group: 'AI' },
  { zh: '评估', en: 'Evaluate', group: 'AI', aliases: ['评级', '打分'] },
  { zh: '提示词', en: 'Prompt', group: 'AI' },
];

/** 规范词 → 规范词（快速判定用） */
export function isCanonicalTerm(zh: string): boolean {
  return TERMS.some((x) => x.zh === zh);
}

/** 异形写法 → 规范词；非异形返回 null */
export function canonicalOf(zh: string): string | null {
  const hit = TERMS.find((x) => x.zh === zh || (x.aliases ?? []).includes(zh));
  if (!hit || hit.zh === zh) return null;
  return hit.zh;
}
