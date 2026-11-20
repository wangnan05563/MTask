/**
 * T06085：队列模型选择器。
 *
 * 原生 <select> 无法在 option 内渲染图片，这里改成自定义 listbox：
 * 收起态与展开项都只展示「厂商 logo + 模型名称」，不再展示厂商全称；
 * 推断不出厂商时统一用 OpenAI 图标兜底。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { AITool } from '../api/client';
import { LOCAL_PROVIDER_LOGOS, inferProviderId } from '../ui/providerLogos';
import { FIELD_SM } from '../ui/primitives';
import { ContextCapacitySelect } from '../ui/ContextCapacitySelect';
import { contextBadgeFor, contextProfileFor, selectedContextCapacity } from '../utils/modelContext';

const FALLBACK_LOGO = LOCAL_PROVIDER_LOGOS.openai;

function modelLabel(tool: AITool): string {
  return tool.model?.trim() || '未配模型';
}

function providerLogoSrc(tool: AITool): string {
  const id = inferProviderId({ name: tool.name, endpoint: tool.endpoint, model: tool.model ?? '' });
  return (id ? LOCAL_PROVIDER_LOGOS[id] : undefined) ?? FALLBACK_LOGO;
}

function ModelLogo({ tool, size = 16 }: { readonly tool: AITool; readonly size?: number }) {
  return (
    <img
      data-t06085="model-vendor-logo"
      src={providerLogoSrc(tool)}
      alt=""
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      style={{ width: size, height: size, flex: `0 0 ${size}px`, objectFit: 'contain' }}
    />
  );
}

interface QueueModelPickerProps {
  readonly tools: readonly AITool[];
  readonly value: string;
  readonly onChange: (toolId: string) => void;
  /** T06088：选中模型后可就地切换上下文容量，立即写回该模型配置 */
  readonly onContextChange?: (toolId: string, capacity: string) => void;
}

export function QueueModelPicker({ tools, value, onChange, onContextChange }: QueueModelPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => tools.find((t) => t.id === value) ?? null, [tools, value]);
  const selectedBadge = selected ? contextBadgeFor(selected) : null;
  const selectedProfile = selected ? contextProfileFor(selected) : null;

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} data-queue-model-picker="1" style={{ position: 'relative', flex: '1 1 280px', minWidth: 240, maxWidth: 360 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        aria-label="选择要交付的 AI 模型"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected ? `当前模型：${modelLabel(selected)}${selectedBadge ? ` · 上下文 ${selectedBadge.label}` : ''}` : '选择 AI 模型'}
        onClick={() => setOpen((v) => !v)}
        style={{
          ...FIELD_SM,
          flex: '1 1 auto',
          width: 'auto',
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          textAlign: 'left',
          cursor: tools.length ? 'pointer' : 'not-allowed',
        }}
        disabled={tools.length === 0}
      >
        {selected ? <ModelLogo tool={selected} /> : <img src={FALLBACK_LOGO} alt="" width={16} height={16} style={{ width: 16, height: 16, flex: '0 0 16px', objectFit: 'contain', opacity: 0.6 }} />}
        <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? modelLabel(selected) : (tools.length ? '选择 AI 模型' : '暂无可用模型')}
        </span>
        {selectedBadge && !selectedProfile && (
          <span
            data-t06088="context-capacity-badge"
            title={selectedBadge.title}
            style={{
              flexShrink: 0, padding: '0 4px', borderRadius: 4, fontSize: 'var(--fs-xs)',
              color: selectedBadge.configured ? 'var(--accent)' : 'var(--text-muted)',
              border: '1px solid var(--border)', background: 'var(--surface-2)',
            }}
          >
            {selectedBadge.label}
          </span>
        )}
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--text-muted)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .12s ease' }} />
      </button>
      {selected && selectedProfile && (
        <ContextCapacitySelect
          profile={selectedProfile}
          value={selectedContextCapacity(selected)}
          label="上下文容量"
          disabled={tools.length === 0 || !onContextChange}
          onChange={(capacity) => onContextChange?.(selected.id, capacity)}
        />
      )}
      </div>
      {open && (
        <div
          role="listbox"
          aria-label="AI 模型列表"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 40,
            maxHeight: 260,
            overflowY: 'auto',
            padding: 4,
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--card-bg)',
            boxShadow: '0 8px 24px rgba(0,0,0,.16)',
          }}
        >
          {tools.map((tool) => {
            const active = tool.id === value;
            const badge = contextBadgeFor(tool);
            return (
              <button
                key={tool.id}
                type="button"
                role="option"
                aria-selected={active}
                data-model-option={tool.id}
                title={`模型：${modelLabel(tool)}${badge ? ` · 上下文 ${badge.label}` : ''}`}
                onClick={() => { onChange(tool.id); setOpen(false); }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 8px',
                  borderRadius: 6,
                  textAlign: 'left',
                  background: active ? 'var(--accent-soft)' : 'transparent',
                  color: 'var(--text)',
                  cursor: 'pointer',
                }}
              >
                <ModelLogo tool={tool} />
                <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {modelLabel(tool)}
                </span>
                {badge && (
                  <span
                    data-t06088="context-capacity-badge"
                    title={badge.title}
                    style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}
                  >
                    {badge.label}
                  </span>
                )}
                {active && <span aria-hidden="true" style={{ color: 'var(--accent)', fontSize: 'var(--fs-xs)' }}>当前</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
