/**
 * T06411 静态门禁：收件箱刷新图标化右移、待决策文案、转入项目箭头。
 * 运行：node scripts/tests/verify-t06411-inbox-toolbar.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const page = readFileSync(join(root, 'web/src/pages/InboxPage.tsx'), 'utf8');
const css = readFileSync(join(root, 'web/src/pages/inboxPage.css'), 'utf8');
const help = readFileSync(join(root, 'web/src/pages/HelpTab.tsx'), 'utf8');

const failures = [];
const check = (name, cond) => { if (!cond) failures.push(name); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`); };

check('decision 分类文案为「待决策」', /decision:\s*\{\s*label:\s*'待决策'/.test(page));
check('收件箱页不存在「待我决策」', !page.includes('待我决策'));
check('帮助页不存在「待我决策」', !help.includes('待我决策'));

check('页头不再承载刷新按钮', !/primaryAction=\{\s*\(\s*<Button[\s\S]{0,400}刷新/.test(page));
check('刷新按钮位于 FilterBar 内', /<FilterBar[\s\S]*?className="mt-inbox-refresh"[\s\S]*?<\/FilterBar>/.test(page));
check('刷新按钮在「转入项目」组之后', /mt-inbox-target-group[\s\S]*?mt-inbox-refresh/.test(page));
check('刷新按钮无文字、仅有刷新图标', /className="mt-inbox-refresh"[\s\S]*?<RefreshCw size=\{14\}[\s\S]*?<\/button>/.test(page)
  && !/<button[\s\S]{0,400}className="mt-inbox-refresh"[\s\S]{0,400}>\s*刷新\s*<\/button>/.test(page));
check('刷新按钮具备可访问名称与 title', /aria-label="刷新收件箱"/.test(page) && /title="刷新"/.test(page));

check('转入项目使用自绘箭头包裹层', /className="mt-inbox-select"/.test(page) && /<ChevronDown[\s\S]{0,120}className="mt-inbox-select-arrow"/.test(page));
check('转入项目 select 关闭原生外观', /\.mt-inbox-select select\s*\{[\s\S]*?appearance:\s*none/.test(css) && /-webkit-appearance:\s*none/.test(css));
check('箭头绝对定位且不拦截点击', /\.mt-inbox-select-arrow\s*\{[\s\S]*?position:\s*absolute[\s\S]*?pointer-events:\s*none/.test(css));
check('转入项目组与刷新按钮水平排列', /\.mt-inbox-target-group\s*\{[\s\S]*?display:\s*inline-flex[\s\S]*?align-items:\s*center/.test(css));
check('刷新按钮 30×30 图标化', /\.mt-inbox-refresh\s*\{[\s\S]*?width:\s*30px[\s\S]*?height:\s*30px[\s\S]*?justify-content:\s*center/.test(css));
check('窄屏移除转入项目组的自动左推', /@media \(max-width: 960px\)[\s\S]*?\.mt-inbox-target-group\s*\{\s*margin-left:\s*0/.test(css)
  && /@media \(max-width: 760px\)[\s\S]*?\.mt-inbox-target-group\s*\{\s*margin-left:\s*0/.test(css));

if (failures.length) {
  console.error(`\nT06411 静态门禁 FAIL：${failures.length} 项`);
  process.exit(1);
}
console.log('\nT06411 静态门禁 PASS：刷新图标化右移、待决策文案、转入项目箭头与窄屏布局');
