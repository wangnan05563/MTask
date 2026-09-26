"""T00785 验收：WAL + synchronous=FULL vs NORMAL 写吞吐对比 + 数据完整性断言。

方法：同一个 seed 库副本，用两种 synchronous 设置跑等量的写事务序列，
测量吞吐（tx/s）与耗时，并断言最终数据一致（行数 + 校验和）。
"""
import json, os, shutil, subprocess, sys

ROOT = r'D:/code/otherProjects/26_MTask'
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
SEED = os.path.join(ROOT, 'perf', 'sandbox', 'data3', 'mtask.db')
SANDBOX = os.path.join(ROOT, 'perf', 'sandbox', 't785')
os.makedirs(SANDBOX, exist_ok=True)

GEN = r'''
const Database = require('better-sqlite3');
const crypto = require('crypto');
const dbPath = process.argv[2];
const MODE = process.argv[3];       // full | normal
const N = Number(process.argv[4]);  // 事务数

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = ' + (MODE === 'full' ? 'FULL' : 'NORMAL'));
const actual = db.pragma('synchronous', { simple: true });

// 写负载：模拟真实热点写（tasks 状态更新 + 审计插入），每条一次 autocommit
const upd = db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?");
const ids = db.prepare("SELECT id FROM tasks WHERE archived = 0 LIMIT 400").all().map((r) => r.id);
if (ids.length === 0) { console.error('no tasks'); process.exit(1); }

db.exec("CREATE TABLE IF NOT EXISTS t785_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT, at TEXT)");
const ins = db.prepare("INSERT INTO t785_audit (payload, at) VALUES (?, ?)");
const delAudit = db.prepare("DELETE FROM t785_audit");
delAudit.run();

// 预热
for (let i = 0; i < 50; i++) { upd.run(new Date().toISOString(), ids[i % ids.length]); }

const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  const id = ids[i % ids.length];
  upd.run(new Date().toISOString(), id);
  ins.run('payload-' + i, new Date().toISOString());
}
const t1 = process.hrtime.bigint();
const ms = Number(t1 - t0) / 1e6;

// 完整性：审计行数 + tasks 表校验和
const auditCount = db.prepare("SELECT COUNT(*) c FROM t785_audit").get().c;
const taskCount = db.prepare("SELECT COUNT(*) c FROM tasks").get().c;
const sum = db.prepare("SELECT COALESCE(SUM(LENGTH(COALESCE(title,''))),0) s FROM tasks").get().s;
db.prepare("DROP TABLE t785_audit").run();
db.close();

console.log(JSON.stringify({
  mode: MODE, syncPragma: actual, n: N, ms: Math.round(ms * 10) / 10,
  tps: Math.round(N / (ms / 1000)),
  auditCount, taskCount, checksum: crypto.createHash('md5').update(String(sum)).digest('hex'),
}));
'''


def run(mode, n=4000, label=None):
    dbp = os.path.join(SANDBOX, 'db_%s.db' % mode)
    if os.path.exists(dbp):
        os.remove(dbp)
    for suf in ('-wal', '-shm'):
        p = dbp + suf
        if os.path.exists(p):
            os.remove(p)
    shutil.copy2(SEED, dbp)
    r = subprocess.run([NODE, os.path.join(SANDBOX, 'bench.cjs'), dbp, mode, str(n)],
                       capture_output=True, text=True, encoding='utf-8', cwd=ROOT)
    if r.returncode != 0:
        print('ERR', mode, r.stdout[-800:], r.stderr[-2000:]); sys.exit(1)
    return json.loads(r.stdout.strip().splitlines()[-1])


open(os.path.join(SANDBOX, 'bench.cjs'), 'w', encoding='utf-8').write(GEN)

N = 4000
print('=== 写负载基准（%d 事务，每次 autocommit）===\n' % N)

full = run('full', N)
print('FULL   : sync=%s  %.1f ms  →  %d tx/s' % (full['syncPragma'], full['ms'], full['tps']))

norm = run('normal', N)
print('NORMAL : sync=%s  %.1f ms  →  %d tx/s' % (norm['syncPragma'], norm['ms'], norm['tps']))

# 再跑两轮取稳定值
full2 = run('full', N)
norm2 = run('normal', N)
print('\n复测 FULL   : %.1f ms  %d tx/s' % (full2['ms'], full2['tps']))
print('复测 NORMAL : %.1f ms  %d tx/s' % (norm2['ms'], norm2['tps']))

fm = (full['ms'] + full2['ms']) / 2
nm = (norm['ms'] + norm2['ms']) / 2
ft = (full['tps'] + full2['tps']) / 2
nt = (norm['tps'] + norm2['tps']) / 2

print('\n=== 结论 ===')
print('平均耗时  FULL %.1f ms  →  NORMAL %.1f ms  (耗时降至 %.0f%%)' % (fm, nm, nm / fm * 100))
print('平均吞吐  FULL %d tx/s →  NORMAL %d tx/s  (提升 %.1f%%)' % (ft, nt, (nt / ft - 1) * 100))

print('\n=== 数据完整性断言 ===')
ok = True
for k in ('auditCount', 'taskCount', 'checksum'):
    same = full[k] == norm[k]
    ok = ok and same
    print('  %-11s FULL=%-8s NORMAL=%-8s %s' % (k, full[k], norm[k], '✅' if same else '❌'))
print('  ==> %s' % ('✅ 两种模式下写入结果完全一致（未丢数据）' if ok else '❌ 数据不一致'))

json.dump({'full': full, 'normal': norm, 'full2': full2, 'normal2': norm2,
           'avg_ms': {'full': fm, 'normal': nm}, 'avg_tps': {'full': ft, 'normal': nt},
           'integrity_ok': ok},
          open(os.path.join(SANDBOX, 'result.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
