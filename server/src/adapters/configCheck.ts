/**
 * T02208：AI 工具配置的本地体检（纯字符串判定，零外部请求）。
 * 存在理由：「连接测试」只做目录型探测（GET /models），而该接口不受计费/模型权限门禁约束
 * （口径见 netutil.probeOkMessage）——密钥填成别家、模型名混入不可见字符这两类「实调必失败」
 * 的配置，连接测试一律放行。本模块把这两类问题在保存/测试时就地点名。
 */

export type CheckField = 'apiKey' | 'endpoint' | 'model';

export interface ConfigIssue {
  field: CheckField;
  message: string;
  /** 一键规范化的目标值：仅当规范化结果全为 ASCII 才给出，否则只点名不代改 */
  fixed?: string;
}

/**
 * Endpoint 厂商 ↔ 密钥前缀对照表。
 * 只收录 T02197 实测混填过的两家：规则越臆测，误报越多，用户就越会忽略真实告警。
 */
const VENDOR_KEY_RULES: { host: RegExp; hostLabel: string; vendor: string; prefix: string }[] = [
  { host: /openrouter\.ai/i, hostLabel: 'openrouter.ai', vendor: 'OpenRouter', prefix: 'sk-or-v1-' },
  { host: /api\.groq\.com/i, hostLabel: 'api.groq.com', vendor: 'Groq', prefix: 'gsk_' },
];

/** 已知密钥前缀 → 归属厂商（点名「这把钥匙其实是别家的」） */
const KEY_PREFIX_OWNER: { prefix: string; vendor: string }[] = [
  { prefix: 'sk-or-v1-', vendor: 'OpenRouter' },
  { prefix: 'gsk_', vendor: 'Groq' },
];

/**
 * 形近字符映射：从备注表格/文档复制模型名时高发（实测 groq 行 `llama‑3.3‑70b‑versatile` 含 3 个 U+2011）。
 * 只收录「能确定 ASCII 等价物」的字符；其余非 ASCII（含零宽字符、中文）由 normalizeAscii 直接剔除，
 * 剔除过的值不再享受一键规范化（见 nonAsciiIssue 的 1:1 判据）。
 */
const LOOKALIKE: Record<string, string> = {
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2212': '-', '\u00a0': ' ',
};

function isAsciiPrintable(cp: number): boolean {
  return cp >= 0x20 && cp <= 0x7e;
}

/** 非 ASCII / 控制字符清单（`U+2011×3、U+00A0×1`）——只报码位与次数，不回显原字符 */
export function describeNonAscii(value: string): string {
  const counts = new Map<string, number>();
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isAsciiPrintable(cp)) continue;
    const label = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => (n > 1 ? `${label}×${n}` : label)).join('、');
}

/** 规范化：形近字符映射为 ASCII 等价物，其余非 ASCII/控制字符剔除 */
export function normalizeAscii(value: string): string {
  let out = '';
  for (const ch of value) {
    const mapped = LOOKALIKE[ch] ?? ch;
    const cp = mapped.codePointAt(0) ?? 0;
    if (isAsciiPrintable(cp)) out += mapped;
  }
  return out;
}

function nonAsciiIssue(field: CheckField, label: string, value: string): ConfigIssue | undefined {
  const codes = describeNonAscii(value);
  if (!codes) return undefined;
  const fixed = normalizeAscii(value);
  // 只在「逐字符 1:1 替换」时给一键规范化：整串非 ASCII（如中文模型名）规范化后会变成空串或面目全非，
  // 那种情况点名即可，代改反而误导
  const oneToOne = fixed.length === value.length && fixed !== value && !describeNonAscii(fixed);
  return {
    field,
    message: `${label}含不可见/非 ASCII 字符（${codes}）——多为从表格或文档复制引入，实调必失败`,
    ...(oneToOne ? { fixed } : {}),
  };
}

/** 配置体检入口：入参为「生效值」（编辑时未改的字段由调用方带原值传入） */
export function checkToolConfig(input: { endpoint?: string; apiKey?: string; model?: string }): ConfigIssue[] {
  const endpoint = input.endpoint ?? '';
  const model = input.model ?? '';
  const apiKey = (input.apiKey ?? '').trim();
  const issues: ConfigIssue[] = [];
  const epIssue = nonAsciiIssue('endpoint', 'Endpoint', endpoint);
  if (epIssue) issues.push(epIssue);
  const modelIssue = nonAsciiIssue('model', '模型名', model);
  if (modelIssue) issues.push(modelIssue);
  if (!apiKey) return issues;
  const rule = VENDOR_KEY_RULES.find((r) => r.host.test(endpoint));
  if (rule && !apiKey.startsWith(rule.prefix)) {
    const owner = KEY_PREFIX_OWNER.find((k) => apiKey.startsWith(k.prefix));
    const current = owner
      ? `是 ${owner.vendor} 的 ${owner.prefix} 前缀`
      : `前缀非该厂商形态（长度 ${apiKey.length}）`;
    issues.push({
      field: 'apiKey',
      message: `密钥与 Endpoint 厂商不匹配：${rule.hostLabel} 要求 ${rule.prefix} 前缀，当前密钥${current}`
        + `——实调必被鉴权拒绝，而连接测试（读模型目录）查不出这一点`,
    });
  }
  return issues;
}

/** 汇成一句提示（供连接测试结果文案拼接） */
export function summarizeIssues(issues: ConfigIssue[]): string {
  return issues.map((i) => i.message).join('；');
}
