/**
 * T05793 门：豆包 MCP 调用被误识为 WorkBuddy 的显示修复。
 *
 * 两层验证：
 * ① Skill 侧 mcp-direct-call.py 的 resolve_platform：配置化映射表替代「其余→workbuddy」硬编码回退；
 * ② 前端 PlatformLogo.tsx：配置化别名表 + 归一化，豆包/Codex 各形态归一到正确品牌。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/tests/verify-t05793-platform-brand.mts
 * 需 python 可用（用于 resolve_platform 纯函数断言）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.MTASK_GATE_ROOT
  ? resolve(process.env.MTASK_GATE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, '.workbuddy');

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  cond ? (pass += 1) : (fail += 1);
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${cond || extra === undefined ? '' : ` → ${JSON.stringify(extra).slice(0, 320)}`}`);
};

const PY = join(ROOT, 'skills/mtask/scripts/mcp-direct-call.py');
const LOGO = readFileSync(join(ROOT, 'web/src/ui/PlatformLogo.tsx'), 'utf8');
const PY_SRC = readFileSync(PY, 'utf8');

// ---- ① Skill 侧：配置化映射表 + resolve_platform 分支断言 ----
ok('S-01 移除硬编码三目回退（其余→workbuddy），改为配置化 PLATFORM_HOST_MAP',
  !/\.trae-cn" in __file__ else/.test(PY_SRC)
  && /PLATFORM_HOST_MAP = \[/.test(PY_SRC)
  && /def resolve_platform\(/.test(PY_SRC));
ok('S-02 映射表含 trae/qoder/workbuddy + 新增 doubao/codex 宿主标识',
  /\([\"']\.trae-cn[\"'], [\"']trae[\"']\)/.test(PY_SRC)
  && /\([\"']\.qoder-cn[\"'], [\"']qoder[\"']\)/.test(PY_SRC)
  && /\([\"']doubao[\"'], [\"']doubao[\"']\)/.test(PY_SRC)
  && /\([\"']codex[\"'], [\"']codex[\"']\)/.test(PY_SRC)
  && /\([\"']\.workbuddy[\"'], [\"']workbuddy[\"']\)/.test(PY_SRC));
ok('S-03 progress 命令改用 resolve_platform（不再内联 env/host 三目）',
  /platform = resolve_platform\(__file__\)/.test(PY_SRC)
  && !/os\.environ\.get\([\"']MTASK_PLATFORM[\"'], _host_default\)/.test(PY_SRC));

// 用 python 导入模块并调用 resolve_platform（MTASK_MCP_URL 指向无效端口，避免触发真实连接；load_endpoint 只读 env）
const pySnippet = `
import importlib.util, os
os.environ['MTASK_MCP_URL'] = 'http://127.0.0.1:9/'
spec = importlib.util.spec_from_file_location('m', r'${PY.replace(/\\/g, '\\\\')}')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
cases = [
  ('/x/.workbuddy/s.py', {}, 'workbuddy'),
  ('/x/.trae-cn/s.py', {}, 'trae'),
  ('/x/.qoder-cn/s.py', {}, 'qoder'),
  ('/x/.doubao/s.py', {}, 'doubao'),
  ('/x/.codex/s.py', {}, 'codex'),
  ('/x/other/s.py', {'MTASK_PLATFORM':'doubao'}, 'doubao'),
  ('/x/other/s.py', {'MTASK_PLATFORM':'relay:doubao'}, 'doubao'),
  ('/x/other/s.py', {}, 'workbuddy'),
]
bad = [(p,e,g,m.resolve_platform(p,e)) for p,e,g in cases if m.resolve_platform(p,e) != g]
print('PY_BAD=' + repr(bad))
`;
let pyOut = '';
try {
  pyOut = execFileSync('python', ['-c', pySnippet], { encoding: 'utf8' });
} catch (e) {
  pyOut = `PY_ERROR ${(e as Error).message}`;
}
ok('S-04 resolve_platform 8 组分支实测（含默认/显式/前缀穿透）',
  /PY_BAD=\[\]/.test(pyOut), pyOut.trim().slice(0, 300));

// ---- ② 前端：配置化别名表 + 归一化 ----
ok('F-01 配置化别名表 PLATFORM_ALIASES（豆包/Codex/WorkBuddy 变体）',
  /const PLATFORM_ALIASES: Readonly<Record<string, string>> = \{/.test(LOGO)
  && /['\"]doubao-mcp['\"]:\s*['\"]doubao['\"]/.test(LOGO)
  && /['\"]volcengine['\"]:\s*['\"]doubao['\"]/.test(LOGO)
  && /['\"]codex-mcp['\"]:\s*['\"]codex['\"]/.test(LOGO)
  && /['\"]codexpp['\"]:\s*['\"]codex['\"]/.test(LOGO));
ok('F-02 normalizeForBrand 去 relay:/mcp: 前缀与 -mcp/-ai 尾缀',
  /function normalizeForBrand\(raw: string\): string/.test(LOGO)
  && /\^\(relay\|mcp\|平台\|platform\)/.test(LOGO)
  && /mcp\|ai\|agent\|client\|assistant/.test(LOGO));
ok('F-03 brandFor 先别名归一再查 BRANDS（不再仅精确匹配）',
  /const canonical = BRANDS\[key\] \? key : PLATFORM_ALIASES\[key\].*/.test(LOGO));
ok('F-04 豆包/Codex 真实图标资产存在（前端静态 import）',
  /import doubaoIcon from ['\"]\.\.\/assets\/platforms\/doubao\.png['\"]/.test(LOGO)
  && /import codexIcon from ['\"]\.\.\/assets\/platforms\/codex\.png['\"]/.test(LOGO));

mkdirSync(OUT_DIR, { recursive: true });
const summary = `T05793 门：${pass} 通过 / ${fail} 失败`;
console.log('');
console.log(summary);
writeFileSync(join(OUT_DIR, 't05793-gate-results.txt'), `${pass}通过/${fail}失败`, 'utf8');
process.exit(fail === 0 ? 0 : 1);
