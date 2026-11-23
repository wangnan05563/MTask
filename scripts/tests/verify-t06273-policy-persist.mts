/**
 * T06273 / AC-16：派发配置跨进程重启持久化。
 * 编排器启动两个独立 Node 进程：第一个保存策略并退出，第二个重新初始化后读取并校验。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const IS_CHILD = process.argv.includes('--child');
const MODE = process.argv.includes('--read') ? 'read' : 'write';
const ROOT = process.env.T06273_ROOT || join('D:/tmp', `t06273-persist-${process.pid}`);

async function child(): Promise<void> {
  process.env.MTask_DATA_DIR = join(ROOT, 'data');
  mkdirSync(process.env.MTask_DATA_DIR, { recursive: true });
  const schema = await import('../../server/src/db/schema.ts');
  schema.initSchema();
  const policy = await import('../../server/src/services/DispatchPolicy.ts');
  if (MODE === 'write') {
    policy.savePolicy({
      autoEnabled: false,
      defaultChannel: 'auto',
      b0ToolId: '',
      scopeProjectIds: [],
      trigger: 'interval',
      intervalMs: 45000,
      cooldownMs: 900000,
      maxPerTick: 3,
      maxAttempts: 2,
      allowFallbackA: false,
      retentionDays: 14,
    });
    console.log(JSON.stringify(policy.readPolicy()));
    return;
  }
  const p = policy.readPolicy();
  const checks: Array<[string, boolean]> = [
    ['trigger 持久化为 interval', p.trigger === 'interval'],
    ['intervalMs 持久化为 45000', p.intervalMs === 45000],
    ['cooldownMs 持久化为 900000', p.cooldownMs === 900000],
    ['maxPerTick 持久化为 3', p.maxPerTick === 3],
    ['maxAttempts 持久化为 2', p.maxAttempts === 2],
    ['allowFallbackA 持久化为 false', p.allowFallbackA === false],
    ['retentionDays 持久化为 14', p.retentionDays === 14],
  ];
  for (const [name, cond] of checks) console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
  if (checks.some(([, cond]) => !cond)) {
    console.log(`[t06273-persist] pass=${checks.filter(([, c]) => c).length} fail=${checks.filter(([, c]) => !c).length}`);
    process.exitCode = 1;
  } else {
    console.log(`[t06273-persist] pass=${checks.length} fail=0`);
  }
}

function runChild(flag: '--write' | '--read'): number {
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const r = spawnSync(process.execPath, [tsx, join(process.cwd(), 'scripts/tests/verify-t06273-policy-persist.mts'), '--child', flag], {
    env: { ...process.env, MTask_DATA_DIR: join(ROOT, 'data'), T06273_ROOT: ROOT },
    stdio: 'inherit',
    encoding: 'utf8',
  });
  return r.status ?? 1;
}

if (IS_CHILD) {
  child()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      const conn = await import('../../server/src/db/connection.ts');
      try { conn.closeDb(); } catch { /* ignore */ }
    });
} else {
  const write = runChild('--write');
  if (write !== 0) {
    console.error('配置保存进程失败');
    process.exitCode = 1;
  } else {
    const read = runChild('--read');
    process.exitCode = read;
  }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* Windows 占用时保留 */ }
}
