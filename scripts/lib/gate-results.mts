/**
 * T02287：验收门结果产物的统一命名与归属口径。
 *
 * 并发跑门是本工作区的常态（同项目多会话同时验收）。结果文件用固定名时，后写者会整文覆写
 * 前者的证据，人工复核看到的那份「结果」其实属于另一个会话——且相当一部分门 stdout 不打汇总，
 * 固定名文件被覆写等于本轮零证据。这里把口径收敛成一处：
 *
 * - 结果文件名带**运行标识**（`<pid>-<启动时刻>`），同一次运行的 .txt / .json 产物共用同一标识；
 * - 文本结果在**汇总行之后紧跟一行归属行**（门名 · 运行时刻 · PID · 端口 · 数据目录 · 结果文件全路径），
 *   其余内容逐字不变——汇总行保持第 1 行，`head -1` / `grep '^PASS='` 一类既有取数习惯不受影响
 *   （与 T02285 在 t02166-ai 门落地的位置同口径）；
 * - `.json` 结果不加归属行（保持可被 `JSON.parse` 读取），归属信息在文件名里。
 *
 * 用法（门侧只改写点，不改判据）：
 *   writeGateResults(OUT_DIR, 't02098-gate-results.txt', summary, { port: PORT, dataDir: DATA_DIR });
 *   writeFileSync(gateArtifactPath(OUT_DIR, 't02099-sample.pptx'), built.buffer); // T02309：旁证同标识
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type GateRunMeta = { port?: number | string; dataDir?: string; note?: string };

const pad = (n: number) => String(n).padStart(2, '0');
const started = new Date();
/** 进程级常量：同一次运行的多个产物（txt/json/早退轮）必须落到同一个标识下。 */
const RUN_TAG = `${process.pid}-${started.getFullYear()}${pad(started.getMonth() + 1)}${pad(started.getDate())}-${pad(started.getHours())}${pad(started.getMinutes())}${pad(started.getSeconds())}`;

/** `t02098-gate-results.txt` → `t02098-gate-results-<runTag>.txt` */
export function gateResultsPath(outDir: string, base: string): string {
  const dot = base.lastIndexOf('.');
  const tagged = dot < 0 ? `${base}-${RUN_TAG}` : `${base.slice(0, dot)}-${RUN_TAG}${base.slice(dot)}`;
  return join(outDir, tagged);
}

/**
 * T02309：旁证产物（payload JSON / pptx / pdf / report JSON 等）的命名口径。
 * 与 {@link gateResultsPath} **同一进程级 RUN_TAG**——同一次运行的汇总与旁证共用一个标识，
 * 人工复核时按标识即可配对「这轮的结果」与「这轮的稿子」；二进制/JSON 不加归属行（JSON 保持可 parse）。
 */
export function gateArtifactPath(outDir: string, base: string): string {
  return gateResultsPath(outDir, base);
}

/** 归属行——沿用 T02285 在 t02166-ai 门落地的写法，字段按可得性拼接。 */
export function gateBanner(outDir: string, base: string, meta: GateRunMeta = {}): string {
  const gate = base.replace(/-gate-results.*$/, '');
  const parts = [`门 ${gate}`, `运行 ${started.toLocaleString('sv')}`, `PID ${process.pid}`];
  if (meta.port !== undefined) parts.push(`端口 ${meta.port}`);
  if (meta.dataDir) parts.push(`数据目录 ${meta.dataDir}`);
  if (meta.note) parts.push(meta.note);
  parts.push(`结果文件 ${gateResultsPath(outDir, base)}`);
  return `本轮门实例：${parts.join(' · ')}`;
}

/** 写结果并返回实际路径（门侧可在 stdout 里把路径打出来，便于事后核对归属）。 */
export function writeGateResults(outDir: string, base: string, content: string, meta: GateRunMeta = {}): string {
  mkdirSync(outDir, { recursive: true });
  const file = gateResultsPath(outDir, base);
  if (base.endsWith('.json')) {
    writeFileSync(file, content, 'utf8');
    return file;
  }
  const banner = gateBanner(outDir, base, meta);
  const nl = content.indexOf('\n');
  const body = nl < 0 ? `${content}\n${banner}\n` : `${content.slice(0, nl + 1)}${banner}\n${content.slice(nl + 1)}`;
  writeFileSync(file, body, 'utf8');
  return file;
}
