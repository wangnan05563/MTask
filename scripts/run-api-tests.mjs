#!/usr/bin/env node
/**
 * T00783：API 断言套件统一入口——避免回归脚本散落、靠手工执行而漏跑。
 * 用法：
 *   npm run test:api [baseUrl] [套件名...]
 * 例：
 *   npm run test:api                       # 全部套件，默认 http://127.0.0.1:39877
 *   npm run test:api http://127.0.0.1:39906 t00776 t00777
 *
 * 约定：每个套件脚本以 `==== <NAME> SUMMARY: x/y passed ====` 结尾并以退出码表达成败。
 * 需要特殊环境的套件（如 t00763 的探针需 MTASK_TEST_DATA_DIR 指向实例数据目录）在此集中声明。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const [baseUrl = 'http://127.0.0.1:39877', ...only] = process.argv.slice(2);

/** 套件注册表：name → 脚本文件名（按依赖/历史顺序） */
const SUITES = [
  't00707-prd-matrix-api-test.mjs',
  't00754-holiday-workday-api-test.mjs',
  't00763-prd-context-test.mjs',
  't00769-prd-gen-api-test.mjs',
  't00770-prd-manage-api-test.mjs',
  't00776-workspace-api-test.mjs',
  't00777-symbols-api-test.mjs',
  't00779-stream-truncate-test.mjs',
  't00780-symbols-lifecycle-test.mjs',
  't00781-writeback-dedupe-test.mjs',
];

const selected = SUITES.filter((f) => only.length === 0 || only.some((o) => f.startsWith(o)));
if (selected.length === 0) {
  console.error(`未匹配到套件：${only.join(', ')}\n可选：${SUITES.map((f) => f.replace('-api-test.mjs', '').replace('-test.mjs', '')).join(', ')}`);
  process.exit(2);
}

let failed = 0;
for (const file of selected) {
  const name = file.replace(/\.mjs$/, '');
  console.log(`\n──────── ${name} ────────`);
  const r = spawnSync(process.execPath, [join(HERE, file), baseUrl], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`✗ ${name} 失败（exit=${r.status}）`); }
}
console.log(`\n==== API 套件汇总：${selected.length - failed}/${selected.length} 通过 ====`);
process.exit(failed > 0 ? 1 : 0);
