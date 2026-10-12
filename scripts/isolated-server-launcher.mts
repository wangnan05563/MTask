/**
 * 隔离实例启动器解析（T02044 实测坑）：
 * `打包.bat`/electron-builder 会把 `better-sqlite3` 重编译成 Electron ABI（本机现为 130），
 * 此后用任何本地 Node 直跑 server 都会 ERR_DLOPEN_FAILED——门禁脚本不能把 execPath 写死。
 * 这里按「能否加载原生模块」探测候选启动器，命中即用，全部不可用则回退 execPath（让日志如实报错）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Launcher {
  exec: string;
  /** tsx 入口参数（`[tsxPath, entry]`） */
  tsx: string[];
  env: Record<string, string>;
  label: string;
}

const PROBE = "const D=require('better-sqlite3'); new D(':memory:');";

function probe(root: string, exec: string, env: Record<string, string>): boolean {
  try {
    execFileSync(exec, ['-e', PROBE], { cwd: root, env: { ...process.env, ...env }, stdio: 'pipe', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

export function resolveServerLauncher(root: string, entry: string): Launcher {
  const tsxPath = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const plain: Launcher = {
    exec: process.execPath,
    tsx: [tsxPath, entry],
    env: {},
    label: `${process.execPath}（node ${process.version}，ABI ${process.versions.modules}）`,
  };
  const viaElectron: Launcher | null = existsSync(electron)
    ? { exec: electron, tsx: [tsxPath, entry], env: { ELECTRON_RUN_AS_NODE: '1' }, label: `${electron} + ELECTRON_RUN_AS_NODE=1（Electron ABI）` }
    : null;
  if (probe(root, plain.exec, plain.env)) return plain;
  if (viaElectron && probe(root, viaElectron.exec, viaElectron.env)) return viaElectron;
  return { ...plain, label: `${plain.label}：原生模块探测全失败，按 execPath 直跑（日志会如实报错）` };
}
