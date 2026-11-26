/**
 * T06352 品牌包门禁：运行时副本与证据文件一致、Token 引用全部可解析、
 * 浅色主题 CSS 真正被 SettingsProvider 消费、关键文本对比度达标。
 * 用法：node node_modules/tsx/dist/cli.mjs --tsconfig web/tsconfig.json scripts/tests/verify-t06352-brand.tsx
 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BrandPackage } from '../../web/src/theme/brand.ts';

function luminance(hex: string): number {
  const rgb = hex.replace('#', '').match(/../g)!.map((part) => parseInt(part, 16) / 255);
  const linear = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

async function main() {
  (globalThis as unknown as { document: { baseURI: string } }).document = { baseURI: 'http://localhost/' };

  const root = process.cwd();
  const evidencePath = path.join(root, 'docs/evidence/t06352-brand/mtask-brand.json');
  const runtimePath = path.join(root, 'web/src/theme/mtask-brand.json');
  const failures: string[] = [];
  const must = (label: string, ok: boolean, detail = '') => {
    if (!ok) failures.push(`${label}${detail ? `：${detail}` : ''}`);
  };

  const evidence = fs.readFileSync(evidencePath);
  const runtime = fs.readFileSync(runtimePath);
  must('运行时品牌 JSON 与证据文件字节一致', evidence.equals(runtime), `${evidence.length} vs ${runtime.length} bytes`);

  const pkg = JSON.parse(runtime.toString('utf8')) as BrandPackage;
  const { resolveBrand, BRAND_LIGHT_CSS, BRAND_META } = await import('../../web/src/theme/brand.ts');
  const resolved = resolveBrand(pkg);
  must('品牌元信息', BRAND_META.name === 'mtask' && BRAND_META.version === 1);
  must('品牌 CSS 已生成', BRAND_LIGHT_CSS.length > 100);
  must('品牌 CSS 作用域仅浅色', BRAND_LIGHT_CSS.includes("[data-theme='light']") && !BRAND_LIGHT_CSS.includes("[data-theme='dark']"));
  must('旧变量接入 --accent', /--accent:\s*#2563EB/i.test(BRAND_LIGHT_CSS));
  must('旧变量接入 --accent-ink', /--accent-ink:\s*#1D4ED8/i.test(BRAND_LIGHT_CSS));
  must('旧变量接入 --accent-soft', /--accent-soft:\s*#EFF6FF/i.test(BRAND_LIGHT_CSS));
  must('设计令牌接入 primitive', BRAND_LIGHT_CSS.includes('--mt-primitive-blue-600: #2563EB;'));
  must('设计令牌接入 button primary', BRAND_LIGHT_CSS.includes('--mt-component-button-primary-bg: #2563EB;'));
  must('设计令牌接入 card radius', BRAND_LIGHT_CSS.includes('--mt-component-card-radius: 8px;'));
  must('组件 token 全部解析', Object.values(resolved.component).every((v) => !/^(raw|semantic|component)\./.test(v)));

  const pairs: Array<[string, string, string]> = [
    ['brand 对白底', resolved.semantic.brand, resolved.raw.neutral0],
    ['品牌文字对品牌浅底', resolved.semantic['brand-ink'], resolved.semantic['brand-soft']],
    ['正文对卡片', resolved.semantic.ink, resolved.semantic.card],
    ['次要文字对卡片', resolved.semantic['ink-2'], resolved.semantic.card],
    ['弱提示对表面', resolved.semantic.muted, resolved.semantic.surface],
  ];
  for (const [label, fg, bg] of pairs) {
    const ratio = contrast(fg, bg);
    must(`${label} ≥4.5:1`, ratio >= 4.5, `${ratio.toFixed(2)}:1 (${fg} on ${bg})`);
  }

  const cycle = structuredClone(pkg);
  cycle.semantic.brand = 'semantic.brand';
  let cycleRejected = false;
  try { resolveBrand(cycle); } catch { cycleRejected = true; }
  must('引用成环被拒绝', cycleRejected);

  const broken = structuredClone(pkg);
  broken.semantic.brand = 'raw.not-exist';
  let brokenRejected = false;
  try { resolveBrand(broken); } catch { brokenRejected = true; }
  must('未知引用被拒绝', brokenRejected);

  const { SettingsProvider } = await import('../../web/src/settings.tsx');
  const html = renderToStaticMarkup(
    React.createElement(SettingsProvider, null, React.createElement('span', null, 'brand-runtime')),
  );
  must('SettingsProvider SSR 包含品牌 CSS', html.includes('--mt-component-button-primary-bg: #2563EB;'));
  must('SettingsProvider SSR 保留默认主题 CSS', html.includes('--app-bg: #ffffff;'));

  console.log(JSON.stringify({
    brand: BRAND_META,
    runtimeBytes: runtime.length,
    cssBytes: BRAND_LIGHT_CSS.length,
    contrasts: Object.fromEntries(pairs.map(([label, fg, bg]) => [label, Number(contrast(fg, bg).toFixed(2))])),
    resolvedTokens: Object.keys(resolved.semantic).length + Object.keys(resolved.component).length,
    failures,
  }, null, 2));
  if (failures.length > 0) process.exit(1);
  console.log('PASS: T06352 品牌包运行时接入门禁通过。');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
