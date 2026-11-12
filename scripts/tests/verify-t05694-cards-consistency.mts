/**
 * T05694 门：三卡片紧凑任务列表统一 + 讲稿卡片项目选择限同工作空间。
 *
 * 现场：
 *   1. Git 提取 / Sonar 两卡片（共用 GitScopePicker）的任务勾选区是整行列表，与讲稿卡
 *      「已完成任务」的紧凑 chip 流式不一致；
 *   2. 讲稿卡片的项目多选没有同工作空间约束，而 Git 提取 / Sonar 卡多项目必须同一 workspace_path。
 *
 * 判据：
 *   A 组 列表统一——GitScopePicker 任务区组内改 PILL chip 流式（与讲稿卡 chipStyle 同源），
 *        分组头 / 置灰 / 禁勾 / 悬浮说明保留。
 *   B 组 项目约束——ProjectScopePicker 增加可选 workspaceConstraint（默认关，既有调用方不变），
 *        开启时判据单源 projectPickability、跨空间写明原因；讲稿卡片调用处开启。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05694-cards-consistency.mts
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

const PICKER = readFileSync(join(ROOT, 'web/src/ui/gitScopePicker.tsx'), 'utf8');
const PROJ_PICKER = readFileSync(join(ROOT, 'web/src/ui/projectScopePicker.tsx'), 'utf8');
const LECTURE = readFileSync(join(ROOT, 'web/src/pages/CodeReviewLecturePanel.tsx'), 'utf8');

// A 组：任务列表统一（Git 提取 + Sonar 共用组件，一处改两卡生效）
ok('A-01 任务勾选区组内改为 PILL chip 流式（flexWrap，与讲稿卡 chipStyle 同一样式单源）',
  /flexWrap: 'wrap', gap: 6/.test(PICKER) && /\.\.\.PILL, display: 'inline-flex'/.test(PICKER));
ok('A-02 分组头保留（项目名 + 数量），未丢「数据归属」信息',
  /GROUP_HEAD/.test(PICKER) && /（\{g\.tasks\.length\}）/.test(PICKER));
ok('A-03 置灰/禁勾/悬浮说明保留：未回写仍 disabled + not-allowed',
  /disabled=\{!linked\}/.test(PICKER) && /cursor: linked \? 'pointer' : 'not-allowed'/.test(PICKER)
  && /未回写 commit id，无可提取内容/.test(PICKER));
ok('A-04 讲稿卡「已完成任务」标杆区未被破坏（PILL chip + disabled 语义仍在）',
  /data-lck="done-tasks"/.test(LECTURE) && /\.\.\.chipStyle, display: 'inline-flex'/.test(LECTURE)
  && /disabled=\{!t\.commits\.length\}/.test(LECTURE));

// B 组：讲稿卡片项目选择限同工作空间
ok('B-01 ProjectScopePicker 新增可选 workspaceConstraint（默认关，既有报表/总结调用方行为逐字不变）',
  /readonly workspaceConstraint\?: boolean/.test(PROJ_PICKER)
  && /workspaceConstraint \? projectPickability\(p, value, projects\) : \{ ok: true, reason: '' \}/.test(PROJ_PICKER));
ok('B-02 开启时判据单源 projectPickability（与 GitScopePicker 同一份），跨空间置灰并写明原因',
  /import \{ projectPickability \} from '\.\/gitScopePicker';/.test(PROJ_PICKER)
  && /blocked = capBlocked \|\| \(!pick\.ok && !checked\)/.test(PROJ_PICKER)
  && /\{pick\.reason\}/.test(PROJ_PICKER));
ok('B-03 约束开启时行尾显示工作空间名（未绑定写明「未绑定工作空间」）',
  /p\.workspace_path \? wsBasename\(p\.workspace_path\) : '未绑定工作空间'/.test(PROJ_PICKER));
ok('B-04 讲稿卡片调用处开启 workspaceConstraint',
  /<ProjectScopePicker projects=\{projects\} value=\{projectIds\} onChange=\{onProjectIdsChange\} workspaceConstraint \/>/.test(LECTURE));

const body = [`T05694 三卡一致门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05694-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05694-gate-results.txt')}`);
