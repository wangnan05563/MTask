/**
 * T05766：执行会话来源平台标识。
 *
 * 五个常用平台使用安装目录中的真实应用图标（随前端打包，离线可用）；
 * 中继/MCP 与未知平台继续使用品牌色 + 短标记回退。
 */
import workbuddyIcon from '../assets/platforms/workbuddy.png';
import traeIcon from '../assets/platforms/trae.png';
import qoderIcon from '../assets/platforms/qoder.png';
import doubaoIcon from '../assets/platforms/doubao.png';
import codexIcon from '../assets/platforms/codex.png';

type Brand = {
  label: string;
  short: string;
  color: string;
  text: string;
  icon?: string;
};

const BRANDS: Record<string, Brand> = {
  workbuddy: { label: 'WorkBuddy', short: 'WB', color: '#0f766e', text: '#ffffff', icon: workbuddyIcon },
  workbuddyai: { label: 'WorkBuddy', short: 'WB', color: '#0f766e', text: '#ffffff', icon: workbuddyIcon },
  trae: { label: 'Trae', short: 'T', color: '#6d28d9', text: '#ffffff', icon: traeIcon },
  'trae cn': { label: 'Trae', short: 'T', color: '#6d28d9', text: '#ffffff', icon: traeIcon },
  'trae-cn': { label: 'Trae', short: 'T', color: '#6d28d9', text: '#ffffff', icon: traeIcon },
  qcoder: { label: 'Qcoder', short: 'Q', color: '#1d4ed8', text: '#ffffff', icon: qoderIcon },
  qoder: { label: 'Qcoder', short: 'Q', color: '#1d4ed8', text: '#ffffff', icon: qoderIcon },
  'qoder cn': { label: 'Qcoder', short: 'Q', color: '#1d4ed8', text: '#ffffff', icon: qoderIcon },
  'qoder-cn': { label: 'Qcoder', short: 'Q', color: '#1d4ed8', text: '#ffffff', icon: qoderIcon },
  qodercn: { label: 'Qcoder', short: 'Q', color: '#1d4ed8', text: '#ffffff', icon: qoderIcon },
  doubao: { label: '豆包', short: '豆', color: '#f97316', text: '#ffffff', icon: doubaoIcon },
  '豆包': { label: '豆包', short: '豆', color: '#f97316', text: '#ffffff', icon: doubaoIcon },
  codex: { label: 'Codex', short: 'Cx', color: '#111827', text: '#ffffff', icon: codexIcon },
  'codex++': { label: 'Codex', short: 'Cx', color: '#111827', text: '#ffffff', icon: codexIcon },
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
        background: brand.icon ? 'transparent' : brand.color,
        color: brand.text,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size >= 30 ? 12 : 11,
        fontWeight: 800,
        letterSpacing: '-0.02em',
        lineHeight: 1,
        overflow: 'hidden',
        boxShadow: brand.icon
          ? '0 1px 4px rgba(15,23,42,.16)'
          : 'inset 0 0 0 1px rgba(255,255,255,.16), 0 2px 6px rgba(15,23,42,.12)',
        userSelect: 'none',
      }}
    >
      {brand.icon ? (
        <img
          src={brand.icon}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      ) : brand.short}
    </span>
  );
}

/** 平台显示名（与 platformLabel 的既有口径兼容，额外覆盖豆包/Codex）。 */
export function platformDisplayName(platform: string | null | undefined): string {
  return brandFor(platform).label;
}
