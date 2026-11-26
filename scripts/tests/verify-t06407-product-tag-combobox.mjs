/**
 * T06407 产品标签 combobox 静态门禁：
 * 防止实现退回原生 datalist，或丢掉键盘/创建/保存失败保留输入等关键约束。
 * 用法：node scripts/tests/verify-t06407-product-tag-combobox.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const failures = [];
const must = (label, ok, detail = '') => {
  if (!ok) failures.push(`${label}${detail ? `：${detail}` : ''}`);
  else console.log(`[PASS] ${label}`);
};

const combo = read('web/src/ui/ProductTagCombobox.tsx');
const tasks = read('web/src/pages/TasksPage.tsx');
const dialogs = read('web/src/ui/dialogs.tsx');
const css = read('web/src/ui/components.css');
const workspace = read('web/src/ui/WorkspaceSelect.tsx');

must('combobox 存在且有 150ms 防抖', /SEARCH_DEBOUNCE_MS\s*=\s*150/.test(combo));
must('combobox 提供 listbox/activedescendant 语义', /role="combobox"/.test(combo) && /role="listbox"/.test(combo) && /aria-activedescendant/.test(combo));
must('combobox 支持上下/回车/Esc 键盘路径', ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].every((key) => combo.includes(`'${key}'`)));
must('combobox 大小写/trim 归一化判重', /normalized\(option\)\s*===\s*query/.test(combo) && /trim\(\)\.toLowerCase\(\)/.test(combo));
must('combobox 无完全匹配时才显示创建入口', /showCreate\s*=\s*Boolean\(onCreate\s*&&\s*trimmed\s*&&\s*!exactMatch\)/s.test(combo));
must('combobox 创建失败保留下拉并提示', /创建「\$\{trimmed\}」失败，请重试/.test(combo) && /setError/.test(combo));
must('TasksPage 产品标签已移除原生 datalist', !/product-key-options/.test(tasks));
must('TasksPage 新项目弹窗消费 combobox', /<ProductTagCombobox[\s\S]{0,160}inputId="new-project-product-key"/.test(tasks));
must('TasksPage 已有项目入口走 askProductTag 并保存', /askProductTag\(\{/.test(tasks) && /onSave:\s*\(next\)\s*=>\s*saveProductKey/.test(tasks));
must('saveProductKey 返回 boolean 供失败分支使用', /async function saveProductKey[^\n]*Promise<boolean>/.test(tasks) && /catch[^]*?return false;/.test(tasks));
must('askProductTag 存在且暴露 onSave', /export function askProductTag/.test(dialogs) && /onSave\?: \(value: string\) => Promise<boolean>/.test(dialogs));
must('askProductTag 选择/创建/手动确定各自走保存或关闭', /source\s*===\s*'create'/.test(dialogs) && /void commit\(next\)/.test(dialogs) && /void commit\(value\.trim\(\)\)/.test(dialogs));
must('保存失败保留弹窗与输入', /保存失败，请重试；当前输入已保留/.test(dialogs));
must('新项目工作空间 bare 面板改为文档流，避免覆盖产品标签', /position:\s*variant\s*===\s*'bare'\s*\?\s*'static'\s*:\s*'absolute'/.test(workspace));
must('产品标签菜单在文档流内展开', /\.mt-product-tag-combobox__menu\s*\{[^}]*position:\s*static/s.test(css));
must('箭头定位基于输入框容器而非整棵 combobox', /\.mt-product-tag-combobox__field\s*\{[^}]*position:\s*relative/s.test(css));

if (failures.length > 0) {
  console.error(`FAIL=${failures.length}`);
  for (const failure of failures) console.error(`[FAIL] ${failure}`);
  process.exit(1);
}
console.log('PASS=T06407 产品标签 combobox 静态门禁通过');
