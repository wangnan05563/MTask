/**
 * T05687 门：两菜单「全部收藏」跨分组聚合视图。
 *
 * 设计：后端不需要新接口——`GET /prompts` 与 `GET /req-entries` 的 `categoryId` 都是可选的，
 * 不传 + `favorited=1` 就是「所有分组的收藏」。前端只需一个哨兵值 `__fav__`（两页共用一份），
 * 在取数时切换查询轴，并在行内标明来源分组。
 *
 * 判据：
 *   A 组 后端条件——两个列表端点在 categoryId 缺省时不做分类收窄，favorited=1 时收窄到收藏。
 *   B 组 共用哨兵——只在一处定义；两页都用 `isAllFav` 判定，不再各写字面量。
 *   C 组 两页行为——下拉首项是「全部收藏」且带主题色；取数按视图切换；选择恢复不把 `__fav__` 重置掉；
 *        空态与来源分组标识存在（标识须在标题同行、时间字段前，不另占一行）；现有「单分组内看收藏」能力保留。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05687-fav-scope.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const lines: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  lines.push(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`}`);
};

const FAV = await import('../../web/src/ui/favScope.ts');
const ROUTES = readFileSync(join(ROOT, 'server/src/routes/index.ts'), 'utf8');
const REQ_SVC = readFileSync(join(ROOT, 'server/src/services/ReqService.ts'), 'utf8');
const REQ = readFileSync(join(ROOT, 'web/src/pages/ReqPage.tsx'), 'utf8');
const PROMPTS = readFileSync(join(ROOT, 'web/src/pages/PromptsPage.tsx'), 'utf8');

// A 组：后端条件
ok('A-01 /prompts 的 categoryId 是可选轴，favorited=1 才收窄到收藏',
  /if \(categoryId\) \{ where\.push\('category_id = \?'\)/.test(ROUTES)
  && /if \(favorited === '1' \|\| favorited === 'true'\) where\.push\('is_favorited = 1'\)/.test(ROUTES), {});
ok('A-02 /req-entries 同口径（categoryId 可选 + favorited 显式收窄）',
  /favorited: favorited === '1' \|\| favorited === 'true'/.test(ROUTES)
  && /if \(categoryId\) \{ where\.push\('category_id = \?'\)/.test(REQ_SVC)
  && /if \(favorited\) where\.push\('is_favorited = 1'\)/.test(REQ_SVC));

// B 组：共用哨兵
ok('B-01 哨兵值只在 favScope 一处定义，且 isAllFav 仅认它',
  FAV.ALL_FAV === '__fav__' && FAV.isAllFav('__fav__') === true && FAV.isAllFav('cat-1') === false);
ok('B-02 两页都不再写 `__fav__` 字面量（共用同一份，防止一页写错静默退回全部分类）',
  !/'__fav__'/.test(REQ) && !/'__fav__'/.test(PROMPTS)
  && /from '\.\.\/ui\/favScope'/.test(REQ) && /from '\.\.\/ui\/favScope'/.test(PROMPTS));

// C 组：两页行为
for (const [name, src, store] of [['需求页', REQ, '/req-entries'], ['提示词页', PROMPTS, '/prompts']] as const) {
  ok(`C-01 ${name}：下拉首项是「全部收藏」且用主题色区分`,
    new RegExp(`<option value=\\{ALL_FAV\\}[^>]*>★ 全部收藏</option>`).test(src)
    && /var\(--accent\)/.test(src));
  ok(`C-02 ${name}：全部收藏视图改传 favorited=1（不带 categoryId）`,
    /isAllFav\([^)]*\)\) qs\.set\('favorited', '1'\)/.test(src)
    && new RegExp(`api\\.get<[^>]+>\\(\`${store}\\?`).test(src));
  ok(`C-03 ${name}：选择恢复不会把 __fav__ 重置成第一个分类`,
    /isAllFav\(cur\) \|\| cats\.some\(/.test(src));
  ok(`C-04 ${name}：空态有「还没有收藏」分支（与「该分类下暂无」区分）`,
    /还没有收藏任何(提示词|通用需求)/.test(src));
  // T05687 二轮：验证失败意见要求「来源放到标题同行末尾、时间字段前，记录一行呈现」。
  // 因此除了字面量，还要锁死 DOM 位置：不得是独占一行的 div，且必须夹在标题按钮与时间字段之间。
  ok(`C-05 ${name}：来源分组标在标题同行、时间字段之前（不另占一行）`,
    !/<div data-t05687="fav-source"/.test(src)
    && /data-t05687="fav-source"/.test(src)
    && /来源：\{categories\.find\(\(c\) => c\.id === p\.category_id\)/.test(src)
    && /row-title-btn[\s\S]{0,1400}data-t05687="fav-source"[\s\S]{0,700}relTime\(p\.updated_at\)/.test(src)
    && /maxWidth: 120[\s\S]{0,240}whiteSpace: 'nowrap'/.test(src));
}

ok('C-06 单分组内「只看收藏」能力保留（未被新视图取代）',
  /viewScope === 'fav'/.test(REQ) && /viewScope === 'fav'/.test(PROMPTS));

const body = [`T05687 全部收藏视图门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05687-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05687-gate-results.txt')}`);
