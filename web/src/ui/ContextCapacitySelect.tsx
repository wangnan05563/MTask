/**
 * T06088 失败反馈：上下文容量不仅要展示，还要能在模型选择旁实时切换。
 *
 * 选择结果立即写回模型配置（沿用 model_notes，不新增后端字段）；组件只负责
 * 档位展示与回调，持久化由页面层统一处理，避免选择器直接耦合 API。
 */
import type { ModelContextProfile } from '../utils/modelContext';
import { FIELD_SM } from './primitives';

interface ContextCapacitySelectProps {
  readonly profile: ModelContextProfile | null;
  /** 当前配置值；为空时落到官方建议中档 */
  readonly value: string;
  readonly onChange: (label: string) => void;
  readonly disabled?: boolean;
  readonly label?: string;
}

export function ContextCapacitySelect({ profile, value, onChange, disabled = false, label = '上下文容量' }: ContextCapacitySelectProps) {
  if (!profile?.tiers.length) return null;
  const selected = value && profile.tiers.some((tier) => tier.label === value)
    ? value
    : profile.tiers[1]?.label ?? profile.tiers[0].label;
  const extraValue = value && !profile.tiers.some((tier) => tier.label === value) ? value : '';
  return (
    <select
      data-t06088="context-capacity-live-select"
      aria-label={`${label}：选择 ${profile.officialLabel} 上限内的三挡`}
      title={`${label}：官方上限 ${profile.officialLabel}；${profile.source}`}
      value={selected}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...FIELD_SM, flex: '0 0 78px', width: 78, padding: '3px 4px', fontSize: 'var(--fs-xs)' }}
    >
      {profile.tiers.map((tier, index) => (
        <option key={tier.label} value={tier.label}>
          {tier.label}{index === 1 ? ' 建议' : ''}
        </option>
      ))}
      {extraValue && <option value={extraValue}>{extraValue}（已配置）</option>}
    </select>
  );
}
