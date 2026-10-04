/**
 * 内置技能资产与服务端枚举单源的一致性校验（T01489）。
 *
 * 为什么需要它：`skills/testcase-generate/SKILL.md` 里的取值表是给 LLM 看的 Markdown，
 * 而真正的口径在 `src/util/testCaseEnums.ts`。两者一旦漂移，故障形态特别隐蔽——
 * `pickEnum` 对脏值**静默回落默认值**（写入不报错），表现成「AI 明明写了 type:integration，库里却是 functional」，
 * 排查的人会先怀疑模型，而不会先怀疑提示词。§5.4 立项理由本身就是「已存在两处口径漂移」。
 * 所以提示词里的枚举必须有一条自动化闸门，而不是靠注释里写一句「以 xxx 为准」。
 *
 * 校验四件事：
 *   1) SKILL.md 的 contract 机读块 == testCaseEnums.ts 的五组枚举与默认值（逐值、逐序）
 *   2) SKILL.md 的 CASES 字段表里 priority/type/method 三行的反引号取值 == contract 块（表与块不能各自演化）
 *   3) 输出协议示例自己必须符合规则：字段在白名单内、不碰禁止输出字段、枚举合法、reqNo 可追溯、
 *      每步有可判定预期、无换行/无标记泄漏、不命中机检禁用词（示例抽取白名单与禁用词均来自资产本身，不另抄一份）
 *   4) 技能目录文件齐全、三个 references 名字确实被 SKILL.md 引用、且 build 已把它复制到 dist
 *
 * 绿灯必须被证伪过才算证据（T01489 实测两道）：
 *   给 CASE_TYPE 添一个 'integration' → CONTRACT_type 红（两侧并列打印）；把示例 expected 改成「…且无报错」→ EXAMPLE_NO_HARD_VAGUE_WORDS 红。
 *
 * 用法：node server/scripts/skill-contract-check.mjs
 * 退出码：0 全通过 / 1 有 FAIL（无 SKIP 语义——本脚本判定项全部可判定）
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENUMS_TS = join(SERVER, 'src', 'util', 'testCaseEnums.ts');
const SKILL_DIR = join(SERVER, 'src', 'skills', 'testcase-generate');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const REFERENCES = ['test-design-rules', 'coverage-rules', 'case-style-rules'];

const results = [];
const ok = (k, cond, msg) => results.push({ k, pass: !!cond, msg });
const fail = (k, msg) => results.push({ k, pass: false, msg });

/** 从 `export const NAME = [...] as const` 抽值数组——按源码文本解析，不引入 ts 运行时依赖 */
function readTsArray(src, name) {
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(src);
  if (!m) throw new Error(`源码里找不到 export const ${name} = [...] as const 的既有写法`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** 从 `export const CASE_DEFAULTS = { key: 'v' as T, ... }` 抽默认值 */
function readTsDefaults(src) {
  const m = /export const CASE_DEFAULTS = \{([\s\S]*?)\n\};/.exec(src);
  if (!m) throw new Error('源码里找不到 export const CASE_DEFAULTS = {...} 的既有写法');
  const out = {};
  for (const p of m[1].matchAll(/(\w+):\s*'([^']+)'/g)) out[p[1]] = p[2];
  return out;
}

/** 抽 SKILL.md 的 contract 机读块：`case-priority: a|b|c` + `case-defaults: k=v|k=v` */
function readContractBlock(md) {
  const m = /```contract\n([\s\S]*?)```/.exec(md);
  if (!m) return null;
  const values = {};
  let defaults = null;
  for (const line of m[1].split('\n')) {
    const kv = /^case-([a-z]+):\s*(\S.*)$/.exec(line.trim());
    if (!kv) continue;
    const items = kv[2].split('|').map((s) => s.trim()).filter(Boolean);
    if (kv[1] === 'defaults') {
      defaults = {};
      for (const it of items) {
        const eq = it.indexOf('=');
        if (eq > 0) defaults[it.slice(0, eq)] = it.slice(eq + 1);
      }
    } else values[kv[1]] = items;
  }
  return { values, defaults };
}

/**
 * 抽字段表某一行的反引号取值，按小节锤定范围。
 * CASES 与 REQUIREMENTS 各有一行 `priority`（用例是 P0-P3，需求是 low/normal/high/urgent）——
 * 不划范围会把两套口径混成一次比对，正好错过我们要防的那类漂移。
 */
function readRowTokens(md, anchor, field) {
  const start = md.indexOf(anchor);
  if (start < 0) return null;
  const next = md.indexOf('\n## ', start);
  const lines = md.slice(start, next > 0 ? next : md.length).split('\n');
  // 表格里的枚举用 `\|` 转义分隔，先占位再按 | 切列，否则会切出半截单元格
  const raw = lines.find((l) => l.startsWith(`| \`${field}\` `));
  if (!raw) return null;
  const cells = raw.replaceAll('\\|', '¦').split('|');
  const cell = cells[3] ?? '';
  return [...new Set([...cell.matchAll(/`([^`]+)`/g)].map((x) => x[1].trim()).filter((v) => /^[A-Za-z0-9_.-]+$/.test(v)))];
}

/**
 * 从 case-style-rules.md「禁用模糊表述」表抽机检名单。
 * 只取**带反引号**的词——那批是「任何语境下都零信息」，可以字面判红；
 * 「正常/正确/成功」这类不带反引号的要看语境（「正确密码」是正常表述），机检故意不碰，避免误伤。
 * 名单单源于 markdown 本身：改表就是改名单，脚本里没有第二份。
 */
function readVagueWords() {
  let src = '';
  try { src = readNorm(join(SKILL_DIR, 'references', 'case-style-rules.md')); } catch { return null; }
  const start = src.indexOf('## 五、');
  const end = src.indexOf('## 六、', start + 1);
  if (start < 0 || end < 0) return null;
  const words = new Set();
  for (const row of src.slice(start, end).split('\n')) {
    if (!row.startsWith('| ') || row.startsWith('|---') || row.startsWith('| 禁用')) continue;
    const cell = row.split('|')[1] ?? '';
    for (const m of cell.matchAll(/`([^`]+)`/g)) for (const w of m[1].split('/')) if (w.trim()) words.add(w.trim());
  }
  return [...words];
}

let enumsSrc = '';
let skillMd = '';
/* 读入即归一换行：Markdown 资产在 Windows IDE 里落盘是 CRLF，而本脚本靠「标记独占一行」与「}` 前是行首」定位，
 * 不归一时 ```contract 块的正则会整段失配（首跑就是这么红的——不是资产缺块，是解析器假设了 LF）。 */
const readNorm = (p) => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
try {
  enumsSrc = readNorm(ENUMS_TS);
} catch (e) {
  fail('ENUM_SOURCE_READABLE', `读不到 ${ENUMS_TS}：${e.message}`);
}
try {
  skillMd = readNorm(SKILL_MD);
} catch (e) {
  fail('SKILL_MD_READABLE', `读不到 ${SKILL_MD}：${e.message}`);
}

if (enumsSrc && skillMd) {
  ok('ENUM_SOURCE_READABLE', true, ENUMS_TS);
  ok('SKILL_MD_READABLE', true, SKILL_MD);

  const tsGroups = {
    priority: readTsArray(enumsSrc, 'CASE_PRIORITY'),
    type: readTsArray(enumsSrc, 'CASE_TYPE'),
    method: readTsArray(enumsSrc, 'CASE_METHOD'),
    status: readTsArray(enumsSrc, 'CASE_STATUS'),
    result: readTsArray(enumsSrc, 'CASE_RESULT'),
  };
  const tsDefaults = readTsDefaults(enumsSrc);
  const block = readContractBlock(skillMd);

  if (!block) {
    fail('CONTRACT_BLOCK_PRESENT', 'SKILL.md 缺少 ```contract``` 机读块');
  } else {
    /** 逐值且逐序比对：顺序也代表语义（P0→P3 的降序、type 的常用度），换序同样要显式确认 */
    for (const [name, tsVals] of Object.entries(tsGroups)) {
      const bVals = block.values[name];
      if (!bVals) { fail(`CONTRACT_${name}`, 'contract 块里没有这一组'); continue; }
      ok(`CONTRACT_${name}`, bVals.join('|') === tsVals.join('|'),
        `skill=[${bVals.join(',')}] enums=[${tsVals.join(',')}]`);
    }
    const dKeys = Object.keys(tsDefaults).sort().join(',');
    const bKeys = Object.keys(block.defaults ?? {}).sort().join(',');
    ok('CONTRACT_defaults_keys', dKeys === bKeys, `contract=[${bKeys}] ts=[${dKeys}]`);
    const mismatched = Object.entries(tsDefaults).filter(([k, v]) => block.defaults?.[k] !== v);
    ok('CONTRACT_defaults_values', mismatched.length === 0,
      mismatched.length ? mismatched.map(([k, v]) => `${k}: ts=${v} skill=${block.defaults?.[k]}`).join(' ') : `全部默认值一致（priority=${tsDefaults.priority}）`);

    /** 字段表与机读块同源校验：只验 AI 真正会输出的三组（status/result 属背景知识，不输出） */
    for (const name of ['priority', 'type', 'method']) {
      const toks = readRowTokens(skillMd, '### `<<<CASES>>>`', name);
      if (!toks) { fail(`TABLE_${name}`, 'CASES 字段表里找不到这一行'); continue; }
      const set = [...new Set(toks)].sort();
      const want = [...(block.values[name] ?? [])].sort();
      ok(`TABLE_${name}`, set.join('|') === want.join('|'), `表=${set.join(',')} 块=${want.join(',')}`);
    }

    /* —— 协议示例自检 ——
     * 模型对示例的模仿强于对规则文本的遵守：示例自己违规，那条规则等于没写。
     * 首版示例就同时踩了两条——「登录成功」没有可核对物、「输入上述账号密码并点击登录」合并动作还用了指代。
     * 字段白名单与禁止字段名都从 SKILL.md 自己抽，校验脚本不另抄一份口径。 */
    const proto = /```\n<<<REQUIREMENTS>>>\n([\s\S]*?)\n<<<CASES>>>\n([\s\S]*?)\n```/.exec(skillMd);
    if (!proto) {
      fail('EXAMPLE_BLOCK_STRUCTURE', '输出协议示例块结构不匹配（围栏或标记行位置变了）');
    } else {
      let reqs = null;
      let cases = null;
      try {
        reqs = JSON.parse(proto[1].trim());
        cases = JSON.parse(proto[2].trim());
        ok('EXAMPLE_JSON_PARSEABLE', Array.isArray(reqs) && Array.isArray(cases), `reqs=${Array.isArray(reqs) ? reqs.length : 'N/A'} cases=${Array.isArray(cases) ? cases.length : 'N/A'}`);
      } catch (e) {
        fail('EXAMPLE_JSON_PARSEABLE', `示例 JSON 连自己都解不了：${e.message}`);
      }
      if (Array.isArray(reqs) && Array.isArray(cases)) {
        const cs = skillMd.indexOf('### `<<<CASES>>>`');
        const csNext = skillMd.indexOf('\n## ', cs);
        const section = skillMd.slice(cs, csNext > 0 ? csNext : skillMd.length);
        const tableFields = [...new Set([...section.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]))];
        const banned = [...((/^`caseNo`.*$/m.exec(skillMd) ?? [''])[0]).matchAll(/`(\w+)`/g)].map((m) => m[1]);
        ok('WHITE_LIST_DEFINED', tableFields.length >= 10 && banned.length >= 5, `CASES 表白名单 ${tableFields.length} 项；禁止输出 ${banned.join(',')}`);

        const keys = [...new Set(cases.flatMap((c) => Object.keys(c)))];
        const extraKeys = keys.filter((k) => !tableFields.includes(k));
        const usedBanned = keys.filter((k) => banned.includes(k));
        ok('EXAMPLE_CASES_FIELDS', extraKeys.length === 0 && usedBanned.length === 0,
          `额外字段=${extraKeys.join(',') || '无'} 命中禁止字段=${usedBanned.join(',') || '无'}`);

        const reqFields = ['reqNo', 'title', 'content', 'sourceRef', 'priority'];
        const reqKeys = [...new Set(reqs.flatMap((r) => Object.keys(r)))];
        ok('EXAMPLE_REQS_FIELDS', reqKeys.every((k) => reqFields.includes(k)), `额外字段=${reqKeys.filter((k) => !reqFields.includes(k)).join(',') || '无'}`);
        const reqPriOk = readRowTokens(skillMd, '### `<<<REQUIREMENTS>>>`', 'priority');
        if (!reqPriOk || !reqPriOk.length) fail('EXAMPLE_REQS_PRIORITY', 'REQUIREMENTS 表的 priority 行抽不出取值（不能靠脚本里硬编一份需求优先级口径）');
        else {
          const reqPriBad = reqs.filter((r) => r.priority !== undefined && !reqPriOk.includes(r.priority)).map((r) => r.priority);
          ok('EXAMPLE_REQS_PRIORITY', reqPriBad.length === 0,
            `白名单=[${reqPriOk.join(',')}]（取自 SKILL.md 本身）非法需求优先级=${reqPriBad.join(',') || '无'}——需求侧与用例侧 P0-P3 是两套值`);
        }

        const enumBad = cases.filter((c) => (c.priority && !block.values.priority.includes(c.priority))
          || (c.type && !block.values.type.includes(c.type)) || (c.method && !block.values.method.includes(c.method)));
        ok('EXAMPLE_CASES_ENUMS', enumBad.length === 0, `枚举非法的用例 ${enumBad.length} 条`);

        const reqNos = new Set(reqs.map((r) => r.reqNo));
        const orphan = cases.filter((c) => !reqNos.has(c.reqNo)).map((c) => c.reqNo);
        ok('EXAMPLE_TRACEABLE', orphan.length === 0, `悬空 reqNo=${orphan.join(',') || '无'}`);

        const steps = cases.flatMap((c) => c.steps ?? []);
        const badStep = steps.filter((s) => !s.action || Object.keys(s).some((k) => k !== 'action' && k !== 'expected')).map((s) => s.action || '(空 action)');
        ok('EXAMPLE_STEPS_SHAPE', steps.length > 0 && badStep.length === 0, `步骤 ${steps.length} 条，异常 ${badStep.length} 条：${badStep.join(' / ') || '无'}`);
        ok('EXAMPLE_EXPECTED_NOT_EMPTY', cases.every((c) => typeof c.expected === 'string' && c.expected.trim()), `用例级 expected 全非空（${cases.length} 条）`);
        ok('EXAMPLE_STEPS_EXPECTED_NOT_EMPTY', steps.every((s) => typeof s.expected === 'string' && s.expected.trim()), '每步都有可判定预期');
        const titles = cases.map((c) => c.title);
        ok('EXAMPLE_TITLES_UNIQUE', new Set(titles).size === titles.length, `标题 ${titles.length} 条互不重复`);
        const texts = [...cases, ...reqs].flatMap((o) => Object.values(o)).filter((v) => typeof v === 'string')
          .concat(steps.flatMap((s) => Object.values(s)).filter((v) => typeof v === 'string'));
        ok('EXAMPLE_SINGLE_LINE', texts.every((v) => !v.includes('\n')), `扫描 ${texts.length} 个字符串字段`);
        ok('EXAMPLE_NO_MARKER_LEAK', texts.every((v) => !v.includes('<<<') && !v.includes('>>>')), '字段值内无协议标记');

        const vague = readVagueWords();
        if (!vague || !vague.length) fail('VAGUE_LIST_EXTRACTABLE', '无法从 case-style-rules.md 第五节抽取机检名单（表结构变了）');
        else {
          const hits = texts.filter((v) => vague.some((w) => v.includes(w)));
          ok('EXAMPLE_NO_HARD_VAGUE_WORDS', hits.length === 0,
            hits.length ? `示例命中机检禁用词：${hits.join(' ｜ ')}` : `机检名单 ${vague.length} 词（${vague.join('、')}）均未命中`);
        }
      }
    }
  }

  /* 资产完整性：文件存在 + 名字被引用（T01490 的 loader 会按名字硬编码读，漏一个就是运行时抛错） */
  for (const n of REFERENCES) {
    const p = join(SKILL_DIR, 'references', `${n}.md`);
    const exists = existsSync(p);
    ok(`REF_EXISTS_${n}`, exists, exists ? `${p}（${readFileSync(p, 'utf8').split('\n').length} 行）` : p);
    ok(`REF_CITED_IN_SKILL_${n}`, skillMd.includes(`references/${n}.md`) || skillMd.includes(`${n}.md`),
      skillMd.includes(`${n}.md`) ? 'SKILL.md 已引用该文件名' : 'SKILL.md 未提到该文件名，loader 清单与提示词会各说各话');
  }

  /* 发布链路：build 的 fs.cpSync 是否真的把新目录带进 dist（PRD 声称「无需改 build」，此处实测） */
  const distMd = join(SERVER, 'dist', 'skills', 'testcase-generate', 'SKILL.md');
  ok('DIST_SKILL_MD', existsSync(distMd),
    existsSync(distMd) ? distMd : `未找到 ${distMd}——先跑 npm run build:server 再校验`);
  const distRefs = REFERENCES.filter((n) => existsSync(join(SERVER, 'dist', 'skills', 'testcase-generate', 'references', `${n}.md`)));
  ok('DIST_REFERENCES', distRefs.length === REFERENCES.length, `dist 内 references ${distRefs.length}/${REFERENCES.length}`);
}

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.k} :: ${r.msg}`);
console.log(`\n技能契约校验：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
if (failed.length) console.log('提示：枚举以 server/src/util/testCaseEnums.ts 为唯一口径，改完 TS 再同步 SKILL.md 的表格与 contract 块。');
process.exit(failed.length ? 1 : 0);
