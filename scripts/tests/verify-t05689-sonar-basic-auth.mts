/**
 * T05689 门：SonarQube Basic 认证头必须带 `token:` 的冒号（否则设置页读项目列表恒 401）。
 *
 * 现场：「从服务器读取 project Key」报「读取项目列表被拒绝（HTTP 401）」。
 * 根因：设置页的 `getJson` 用 `Buffer.from(token)` 生成 Basic 头，漏了冒号；
 * Sonar 的 user token 认证约定是「token 作用户名、密码留空」，凭据串必须是 `${token}:`。
 * 扫描侧的 `sonarGet` 写对了（`${token}:`），于是出现「扫描能跑、设置页 401」的半链路故障。
 *
 * 判据：
 *   A 组 行为——base64 解出来必须逐字等于 `${token}:`；粘贴前缀/引号被归一；token 中间的 `:` 不受影响。
 *   B 组 单源——两处调用点都用 sonarBasicAuth；全仓不再有裸 `Buffer.from(token)` / 手写 credentials 的 Basic 头。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05689-sonar-basic-auth.mts
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

const A = await import('../../server/src/util/sonarAuth.ts');

const decode = (header: string) => Buffer.from(header.replace(/^Basic /, ''), 'base64').toString('utf8');

ok('A-01 Basic 头解出来是 `${token}:`（冒号不能少——这正是 401 的根因）',
  decode(A.sonarBasicAuth('squ_abc123')) === 'squ_abc123:', decode(A.sonarBasicAuth('squ_abc123')));
ok('A-02 粘贴的 `Bearer ` 前缀被去掉（否则用户名变成 "Bearer squ_xxx"）',
  decode(A.sonarBasicAuth('Bearer squ_xyz')) === 'squ_xyz:');
ok('A-03 首尾引号/反引号与空白被去掉（token 常被整段粘贴）',
  decode(A.sonarBasicAuth('  "squ_q1"  ')) === 'squ_q1:' && decode(A.sonarBasicAuth('`squ_q2`')) === 'squ_q2:');
ok('A-04 token 内部的 `:` 不被破坏（只补尾部冒号）',
  decode(A.sonarBasicAuth('a:b')) === 'a:b:');
ok('A-05 normalizeSonarToken 对空值不抛错（调用方另有非空判断）',
  A.normalizeSonarToken(undefined as unknown as string) === '');

const SETTINGS = readFileSync(join(ROOT, 'server/src/services/sonarSettings.ts'), 'utf8');
const SCAN = readFileSync(join(ROOT, 'server/src/services/sonarScan.ts'), 'utf8');

ok('B-01 设置页（读项目列表）走 sonarBasicAuth',
  /headers\.Authorization = sonarBasicAuth\(token\)/.test(SETTINGS));
ok('B-02 扫描侧（取数）也走 sonarBasicAuth',
  /Authorization: sonarBasicAuth\(token\)/.test(SCAN));
ok('B-03 全仓不再有裸 token 的 Basic 构造（漏冒号的那种写法已绝迹）',
  !/Buffer\.from\(token\)/.test(SETTINGS) && !/Buffer\.from\(token\)/.test(SCAN)
  && !/Buffer\.from\(credentials\)/.test(SCAN));

const body = [`T05689 Sonar Basic 认证门：PASS ${pass} / FAIL ${fail}`, ...lines].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 't05689-gate-results.txt'), `${body}\n`, 'utf8');
console.log(body);
console.log(`结果文件：${join(OUT_DIR, 't05689-gate-results.txt')}`);
