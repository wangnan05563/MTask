/**
 * T06290 Lint：核心页面硬编码十六进制颜色检查（AC-04）。
 *
 * 规则：
 * 1. 只扫描核心页面（App + 10 个一级入口页面）；
 * 2. `var(--token, #hex)` fallback 不算违规（实际颜色由语义 Token 决定，codemod 会收敛）；
 * 3. 设计预设（theme/presets.ts）、数据可视化色板、PPT 品牌色不在核心页面扫描范围；
 * 4. 确属产品内容固定色（如关于页品牌名片）可在该行标注 `hardcoded-color-allow` 豁免。
 *
 * 用法：node scripts/tests/lint-t06290-hardcoded-colors.mjs
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const CORE = [
  'web/src/App.tsx',
  'web/src/pages/DashboardPage.tsx',
  'web/src/pages/TasksPage.tsx',
  'web/src/pages/PlanPage.tsx',
  'web/src/pages/ReqPage.tsx',
  'web/src/pages/ReportPage.tsx',
  'web/src/pages/QueuePage.tsx',
  'web/src/pages/queuePanels.tsx',
  'web/src/pages/ExecSessionsPage.tsx',
  'web/src/pages/PromptsPage.tsx',
  'web/src/pages/AIToolsPage.tsx',
  'web/src/pages/SettingsPage.tsx',
];
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const VAR_FALLBACK = /var\(--[a-z0-9-]+\s*,\s*#[0-9a-fA-F]{3,8}\)/g;

let violations = 0;
for (const rel of CORE) {
  const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes('hardcoded-color-allow')) return;
    const cleaned = line.replace(VAR_FALLBACK, 'var(--token)');
    const hits = cleaned.match(HEX);
    if (!hits) return;
    violations += hits.length;
    console.log(`[FAIL] ${relative(ROOT, join(ROOT, rel)).replace(/\\/g, '/')}:${i + 1} ${hits.join(', ')} → ${line.trim().slice(0, 180)}`);
  });
}
console.log(`\n[t06290-lint] corePages=${CORE.length} hardcodedHex=${violations}`);
process.exit(violations === 0 ? 0 : 1);
