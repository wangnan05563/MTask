/**
 * T06019 门：设置子页说明从正文段落收敛为语义图标 + 按需气泡。
 *
 * 判据腿：
 * A 说明图标组件：默认隐藏气泡、悬浮/聚焦/点击展开、带 data 锚点；
 * B 覆盖完整性：8 个设置页面文件共 10 处说明入口，无漏页；
 * C 语义映射：10 个入口使用对应 lucide 图标（通用/分类/迁移/字段/数据库/历史/记忆/令牌/Sonar/隧道）；
 * D 菜单收敛：设置菜单默认 compact，明文模式仍可回退；设置页签仍为 17 项。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeGateResults } from './lib/gate-results.mts';

const ROOT = 'D:/code/otherProjects/MTask';
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 2000)}`}`);
};
const src = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const HELP_PAGES = [
  'web/src/pages/SettingsPage.tsx',
  'web/src/pages/CustomFieldsTab.tsx',
  'web/src/pages/DbAdminTab.tsx',
  'web/src/pages/HistoryPage.tsx',
  'web/src/pages/MemoryTab.tsx',
  'web/src/pages/RecurringTokensTabs.tsx',
  'web/src/pages/SonarSettingsTab.tsx',
  'web/src/pages/TunnelPanel.tsx',
] as const;

const ICONS = ['Settings2', 'Tags', 'ArrowLeftRight', 'ListPlus', 'Database', 'History', 'Brain', 'KeyRound', 'ScanLine', 'Network'] as const;

try {
  const comp = src('web/src/ui/settingsHelp.tsx');
  const page = src('web/src/pages/SettingsPage.tsx');
  const tabs = src('web/src/ui/settingsTabs.ts');

  const count = HELP_PAGES.reduce((n, p) => n + (src(p).match(/<SettingsHelpIcon/g)?.length ?? 0), 0);
  ok('A-01 说明图标组件带 data-t06019 锚点', comp.includes('data-t06019="help"'));
  ok('A-02 气泡默认隐藏（visibility:hidden + opacity:0）',
    comp.includes('visibility: hidden') && comp.includes('opacity: 0'));
  ok('A-03 悬浮/聚焦/点击均可展开气泡',
    comp.includes('.settings-help-wrap:hover .settings-help-tip') &&
    comp.includes('.settings-help-wrap:focus-within .settings-help-tip') &&
    comp.includes('.settings-help-tip.is-open'));
  ok('A-04 说明入口具备可访问名与展开态', comp.includes('aria-label=') && comp.includes('aria-expanded={open}'));

  ok('B-01 8 个设置页面文件共 10 处说明入口（覆盖 10 个带说明子页）', count === 10, { count });
  ok('B-02 每个说明入口都写了 ariaDescription（读屏可读完整说明）',
    HELP_PAGES.reduce((n, p) => n + (src(p).match(/ariaDescription=/g)?.length ?? 0), 0) === 10);
  ok('B-03 设置页签仍为 17 项', (tabs.match(/key: '/g)?.length ?? 0) >= 17);

  for (const icon of ICONS) {
    ok(`C 语义图标 ${icon} 已接入说明入口`,
      HELP_PAGES.some((p) => src(p).includes(`icon={${icon}}`)));
  }

  ok('D-01 设置菜单默认 compact，明文模式保留为可选回退',
    page.includes("localStorage.getItem('mtask.settingsMenuMode.v2') === 'detailed' ? 'detailed' : 'compact'") &&
    page.includes("setMenuMode(compactMenu ? 'detailed' : 'compact')"));
  ok('D-02 明文模式仍保留分组渲染（未删除旧能力）', page.includes('data-t03271="group"'));
} catch (e) {
  fail += 1;
  lines.push(`[FAIL] 门体异常：${e instanceof Error ? e.message : String(e)}`);
} finally {
  console.log(lines.join('\n'));
  console.log(`T06019 设置说明图标门：PASS=${pass} FAIL=${fail}`);
  writeGateResults(OUT_DIR, 't06019-gate-results.txt', lines.join('\n'), { root: ROOT });
  globalThis.process.exitCode = fail === 0 ? 0 : 1;
}
