import { ConfigService } from './ConfigService';
import { checkToolConfig, summarizeIssues, type ConfigIssue } from '../adapters/configCheck';

/**
 * T03176（PRD D-14）：AI 可用性单源诊断——「主入口可见但禁用 + 原因/修复动作」的统一判据。
 *
 * 背景：此前各页面各写一套判断（有的只查 model、有的点了才报错、有的隐藏入口），
 * D-14 要求主入口一律可见禁用并给出原因；只有「从未启用过的上下文建议」允许隐藏。
 * 本服务把判据收敛为一处，前端只消费 ready/code/reason/fix，不再自造第二套。
 *
 * 判据与运行时对齐（AIService.runtimeWithModel 同口径）：工具启用 + 填了模型才算可用；
 * 再叠加离线配置体检（configCheck）识别「可选中但实调必失败」的厂商/密钥错配。
 * 只做本地判定，零外部请求——入口禁用不能依赖网络。
 */

export type AiUnavailableCode = 'no_tool' | 'all_disabled' | 'missing_model' | 'config_issue';

export interface AiReadiness {
  /** 任一工具可实调即为 true */
  ready: boolean;
  /** 不可用原因分类；ready 时缺省 */
  code?: AiUnavailableCode;
  /** 用户可读原因（ready 时为空串） */
  reason: string;
  /** 修复动作：统一跳「模型」页（前端按 tab 键导航，不硬编码 URL） */
  fix: { label: string; tab: string } | null;
  /** 可用工具（ready 时给出一个可直接派发的 id） */
  toolId?: string;
  toolName?: string;
  counts: { total: number; enabled: number; usable: number };
  /** 可用工具上的非阻断体检提示（如密钥前缀可疑但不足以判死） */
  warnings?: ConfigIssue[];
  checkedAt: string;
}

const FIX_ACTION = { label: '去模型管理', tab: 'aitools' };

function base(counts: AiReadiness['counts']): Pick<AiReadiness, 'counts' | 'checkedAt'> {
  return { counts, checkedAt: new Date().toISOString() };
}

export function checkAiReadiness(): AiReadiness {
  const tools = ConfigService.list();
  const enabled = tools.filter((t) => t.enabled);
  // 与运行时同口径：model 为空时 AIService 直接抛 MODEL_UNCONFIGURED
  const withModel = enabled.filter((t) => (t.model ?? '').trim().length > 0);
  const counts = { total: tools.length, enabled: enabled.length, usable: withModel.length };

  if (tools.length === 0) {
    return { ready: false, code: 'no_tool', reason: '尚未配置 AI 工具，AI 功能暂不可用', fix: FIX_ACTION, ...base(counts) };
  }
  if (enabled.length === 0) {
    return { ready: false, code: 'all_disabled', reason: `已配置 ${tools.length} 个 AI 工具，但均已停用`, fix: FIX_ACTION, ...base(counts) };
  }
  if (withModel.length === 0) {
    return { ready: false, code: 'missing_model', reason: `已启用 ${enabled.length} 个 AI 工具，但未填写默认模型`, fix: FIX_ACTION, ...base(counts) };
  }

  // 离线体检：用运行时配置（含解密密钥）判定厂商/密钥错配——不在出参暴露密钥
  const checked = withModel.map((t) => {
    let issues: ConfigIssue[] = [];
    try {
      const { config } = ConfigService.getRuntimeConfig(t.id);
      issues = checkToolConfig({ endpoint: config.endpoint, apiKey: config.apiKey, model: config.model });
    } catch { /* 工具行异常时按可用处理，交由实调报错 */ }
    return { tool: t, issues };
  });
  const clean = checked.filter((c) => c.issues.length === 0);
  if (clean.length === 0) {
    const reason = summarizeIssues(checked[0].issues) || 'AI 工具配置校验未通过';
    return {
      ready: false, code: 'config_issue', fix: FIX_ACTION,
      reason: checked.length > 1 ? `${reason}（${checked.length} 个工具均有配置问题）` : reason,
      toolId: checked[0].tool.id, toolName: checked[0].tool.name, ...base(counts),
    };
  }

  const chosen = clean[0];
  const warnings = checked.filter((c) => c.issues.length > 0).flatMap((c) => c.issues);
  return {
    ready: true,
    reason: '',
    fix: null,
    toolId: chosen.tool.id,
    toolName: chosen.tool.name,
    ...(warnings.length ? { warnings: warnings.slice(0, 5) } : {}),
    ...base(counts),
  };
}
