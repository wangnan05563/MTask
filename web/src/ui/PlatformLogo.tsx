/**
 * T05766：执行会话来源平台标识。
 *
 * 五个常用平台使用安装目录中的真实应用图标（随前端打包，离线可用）；
 * 中继/MCP 与未知平台继续使用品牌色 + 短标记回退。
 *
 * T05793：配置化厂商别名映射（避免硬编码分支）——豆包/Codex 等经 MCP 上报时，
 * platform 可能带 relay:/mcp: 前缀或 -mcp/-ai 等后缀、或用中文名/厂商别名，
 * 统一在 brandFor 里按别名表归一后再取品牌，杜绝被误判成 workbuddy/未知平台。
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
  unknown: { label: '未知平台', short: '?', color: '#64748b', text: '#ffffff' },
  relay: { label: '中继', short: 'R', color: '#475569', text: '#ffffff' },
  mcp: { label: 'MCP', short: 'M', color: '#0369a1', text: '#ffffff' },
};

/**
 * T05793：厂商别名 → 规范键的配置化映射表（新增厂商只改这里，不动识别逻辑）。
 * 值必须是 BRANDS 里已有的规范键；键统一小写，匹配时先做归一化。
 */
const PLATFORM_ALIASES: Readonly<Record<string, string>> = {
  // 豆包：MCP 上报常见形态 doubao / doubao-mcp / mcp:doubao / relay:doubao / 豆包 / 火山方舟系
  'doubao-mcp': 'doubao',
  'doubaoai': 'doubao',
  'dou-bao': 'doubao',
  '豆包ai': 'doubao',
  '豆包助手': 'doubao',
  'volcengine': 'doubao',
  '火山': 'doubao',
  '火山方舟': 'doubao',
  '方舟': 'doubao',
  // Codex：codex-mcp / OpenAI Codex / Codex++ 等
  'openai-codex': 'codex',
  'codexcli': 'codex',
  'codex-cli': 'codex',
  'codexmcp': 'codex',
  'codex-mcp': 'codex',
  'codexpp': 'codex',
  'codex ++': 'codex',
  // WorkBuddy 变体
  'work-buddy': 'workbuddy',
  'work buddy': 'workbuddy',
  'wb': 'workbuddy',
  // Trae / Qoder 变体
  'traeai': 'trae',
  'trae-ai': 'trae',
  'qcoder': 'qoder',
  'qoder-ai': 'qoder',
};

/**
 * T05793：平台标识归一化——用于识别，不改变存库的 platform 原值（会话唯一键口径保持不变）。
 * 步骤：trim → 小写 → 去 relay:/mcp: 前缀 → 去 -mcp/-ai 等尾缀 → 折叠空白/下划线/连字符。
 */
function normalizeForBrand(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^(relay|mcp|平台|platform)\s*[:：/]\s*/, ''); // 去掉通道前缀
  s = s.replace(/[-_]\s*(mcp|ai|agent|client|assistant)\b/g, ''); // 去掉常见角色尾缀
  s = s.replace(/[\s_]+/g, ' ').replace(/[-]+/g, '-'); // 折叠空白/连字符
  return s.trim();
}

function brandFor(platform: string | null | undefined): Brand {
  const raw = (platform ?? '').trim();
  const key = normalizeForBrand(raw);
  // 先按别名表归一，再查 BRANDS；别名的 value 是 BRANDS 的规范键
  const canonical = BRANDS[key] ? key : PLATFORM_ALIASES[key] ?? '';
  return BRANDS[canonical] ?? {
    label: raw || '未知平台',
    short: (raw || '?').slice(0, 2).toUpperCase(),
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
