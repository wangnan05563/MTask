/**
 * T05766：执行会话来源平台标识。
 *
 * 这里用品牌色 + 短标记组成的轻量 Logo，不依赖外网资源，打包后离线也能正常显示。
 * 重点覆盖 WorkBuddy / Trae / Qcoder / 豆包 / Codex，并为未知平台保留中性回退。
 */
type Brand = {
  label: string;
  short: string;
  color: string;
  text: string;
};

const BRANDS: Record<string, Brand> = {
  workbuddy: { label: 'WorkBuddy', short: 'WB', color: '#0f766e', text: '#ffffff' },
  trae: { label: 'Trae', short: 'T', color: '#6d28d9', text: '#ffffff' },
  qcoder: { label: 'Qcoder', short: 'Q', color: '#1d4ed8', text: '#ffffff' },
  qoder: { label: 'Qcoder', short: 'Q', color: '#1d4ed8', text: '#ffffff' },
  doubao: { label: '豆包', short: '豆', color: '#f97316', text: '#ffffff' },
  '豆包': { label: '豆包', short: '豆', color: '#f97316', text: '#ffffff' },
  codex: { label: 'Codex', short: 'Cx', color: '#111827', text: '#ffffff' },
  relay: { label: '中继', short: 'R', color: '#475569', text: '#ffffff' },
  mcp: { label: 'MCP', short: 'M', color: '#0369a1', text: '#ffffff' },
};

function brandFor(platform: string | null | undefined): Brand {
  const key = (platform ?? '').trim().toLowerCase();
  return BRANDS[key] ?? {
    label: platform?.trim() || '未知平台',
    short: (platform?.trim() || '?').slice(0, 2).toUpperCase(),
    color: '#64748b',
    text: '#ffffff',
  };
}

/** 统一 28×28、可自适应居中；title/aria-label 同时给出完整平台名，避免只靠颜色识别。 */
export function PlatformLogo({ platform, size = 28 }: { readonly platform: string | null | undefined; readonly size?: number }) {
  const brand = brandFor(platform);
  return (
    <span
      data-lck="platform-logo"
      title={`来源平台：${brand.label}`}
      aria-label={`来源平台：${brand.label}`}
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        borderRadius: Math.max(6, Math.round(size * 0.25)),
        background: brand.color,
        color: brand.text,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size >= 30 ? 12 : 11,
        fontWeight: 800,
        letterSpacing: '-0.02em',
        lineHeight: 1,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.16), 0 2px 6px rgba(15,23,42,.12)',
        userSelect: 'none',
      }}
    >
      {brand.short}
    </span>
  );
}

/** 平台显示名（与 platformLabel 的既有口径兼容，额外覆盖豆包/Codex）。 */
export function platformDisplayName(platform: string | null | undefined): string {
  return brandFor(platform).label;
}
