/**
 * T02616：构建开跑前把「原生模块 ABI 现场」打印出来，让每个安装包都能追溯到用哪个解释器打的。
 *
 * 动因：两枚发布 `.bat` 的托管 Node 目录写死成 `22.22.2-3` / `22.22.2`，两个目录都早已不存在，
 * `if exist` 判假 → PATH 不改 → 全程用 PATH 上的 Node（本机 v24 / NODE_MODULE_VERSION 137），
 * 而 `scripts/lib/abi-switch.mjs` 的 dev 缓存历史上是 ABI 127（Node 22）。这条设计意图失效时**一声不响**，
 * 直到装机/直跑报 `ERR_DLOPEN_FAILED` 才暴露。本模块只做一件事：把三处 ABI 读出来对齐比对，不匹配就点名。
 *
 * ABI 从二进制本身读，不写常量：gyp 编译的 Node 原生模块会把注册符号名 `node_register_module_v<N>`
 * 留在导出表里，实测 `build/native/electron` = 130、工作区那份 = 137，
 * 与 `process.versions.modules` 一一对上；`build/native/dev` 按 T02692 裁决已并入 137（原 127 是旧托管 Node 22 口径）。
 * N-API 构件（`napi_register_module_v1`）与解释器 ABI 无关，单独标注不误报。
 *
 * 用法：`node scripts/lib/abi-hint.mjs [root]`（root 默认当前目录；门内夹具传副本根）。
 * 纪律：本模块**永不非零退出**——它是提示，不能变成构建的新拦路点；读不到就说读不到。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ABI_SYMBOL_RE = /node_register_module_v(\d+)/;
const NAPI_SYMBOL_RE = /napi_register_module_v1/;

/** 读一个 .node 二进制的注册符号，拿到它编译时锁定的 NODE_MODULE_VERSION；拿不到返回 null。 */
export function abiOf(file) {
  try {
    const text = fs.readFileSync(file).toString('latin1');
    const m = ABI_SYMBOL_RE.exec(text);
    if (m) return Number(m[1]);
    if (NAPI_SYMBOL_RE.test(text)) return 'napi';
    return null;
  } catch {
    return null;
  }
}

const describe = (v) => (v === '缺失' ? '缓存不存在' : v === null ? '读不出注册符号' : String(v));

/** 逐行打印 ABI 现场；返回读到的数值与 warn 位，供验收门判定「到底点没点名不匹配」。 */
export function report(root = '.', { log = (m) => console.log(m) } = {}) {
  const nodeAbi = Number(process.versions.modules);
  log(`[ABI] interpreter: node ${process.version} NODE_MODULE_VERSION=${nodeAbi} exe=${process.execPath}`);
  const targets = {
    dev: path.join(root, 'build', 'native', 'dev', 'better_sqlite3.node'),
    electron: path.join(root, 'build', 'native', 'electron', 'better_sqlite3.node'),
    workspace: path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  };
  const found = {};
  for (const [key, file] of Object.entries(targets)) {
    found[key] = fs.existsSync(file) ? abiOf(file) : '缺失';
    log(`[ABI] ${key} 缓存: ${describe(found[key])}（${path.relative(root, file)}）`);
  }
  let warn = false;
  if (typeof found.dev === 'number' && found.dev !== nodeAbi) {
    warn = true;
    log(`[ABI][WARN] 构建解释器是 ABI ${nodeAbi}，dev 缓存却是 ${found.dev}：打包收尾 native-switch.bat dev 会还原成 ${found.dev}，`);
    log(`[ABI][WARN]   本机 node（ABI ${nodeAbi}）直跑 server/dist 将 ERR_DLOPEN_FAILED。要么把构建放回同 ABI 的托管 Node，要么用当前 node 重建 dev 缓存。`);
  } else if (found.dev === '缺失') {
    warn = true;
    log('[ABI][WARN] dev ABI 缓存缺失，native-switch.bat dev 无从还原——构建前就该补缓存，别等装机后。');
  }
  if (typeof found.electron === 'number') log(`[ABI] 安装包内 better-sqlite3 目标 ABI = ${found.electron}（Electron 侧，与构建解释器不同属正常）`);
  if (!warn && typeof found.dev === 'number') log('[ABI] dev 缓存与构建解释器一致，无需处理。');
  return { nodeAbi, warn, ...found };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    report(process.argv[2] || '.');
  } catch (e) {
    console.log(`[ABI][WARN] ABI 提示自身出错（不阻断构建）：${e instanceof Error ? e.message : String(e)}`);
  }
}
