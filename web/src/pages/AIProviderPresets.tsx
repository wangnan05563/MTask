import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AIProviderPreset } from '../api/client';
import { LOCAL_PROVIDER_LOGOS } from '../ui/providerLogos';

/**
 * T05784：厂商预制卡片与图标。
 * T05780 二轮：优先用随前端本地打包的图标（LOCAL_PROVIDER_LOGOS，按预制 id 命中），
 * 保证 file:// 打包版离线可用；未收录的厂商回落后端 icon_url，再失败才用首字母兜底。
 */
export function ProviderIcon({ preset, size = 32 }: { readonly preset: AIProviderPreset; readonly size?: number }) {
  const [failed, setFailed] = useState(false);
  const initial = preset.provider_name.trim().slice(0, 1).toUpperCase() || '?';
  const logoSrc = LOCAL_PROVIDER_LOGOS[preset.id] ?? preset.icon_url;
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        borderRadius: 8,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        color: 'var(--accent)',
        fontWeight: 700,
        fontSize: size >= 30 ? 'var(--fs-l)' : 'var(--fs-s)',
      }}
    >
      {!failed && logoSrc ? (
        <img
          data-t05780="provider-logo"
          data-provider-id={preset.id}
          src={logoSrc}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 3 }}
        />
      ) : initial}
    </span>
  );
}

interface ProviderPresetGridProps {
  readonly providers: readonly AIProviderPreset[];
  readonly onSelect: (preset: AIProviderPreset) => void;
}

/** 厂商预制选择区：卡片本身就是入口，选中后由父级打开预填好的配置表单。 */
export function ProviderPresetGrid({ providers, onSelect }: ProviderPresetGridProps) {
  if (providers.length === 0) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
      {providers.map((preset) => (
        <button
          key={preset.id}
          type="button"
          className="provider-preset"
          onClick={() => onSelect(preset)}
          title={`使用 ${preset.provider_name} 预制配置 — 自动填充 Base URL、控制台地址与厂商属性`}
          aria-label={`使用 ${preset.provider_name} 预制配置`}
          style={{
            display: 'flex',
            alignItems: 'stretch',
            gap: 9,
            minWidth: 0,
            padding: '10px 11px',
            textAlign: 'left',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--card-bg)',
            color: 'var(--text)',
            cursor: 'pointer',
          }}
        >
          <ProviderIcon preset={preset} />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <strong style={{ fontSize: 'var(--fs-m)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preset.provider_name}</strong>
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)', background: 'var(--accent-soft)', borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap' }}>{preset.provider_type}</span>
            </span>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={preset.base_url}>{preset.base_url}</span>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 3 }}>
              自动填充 <ChevronRight size={11} aria-hidden="true" />
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
