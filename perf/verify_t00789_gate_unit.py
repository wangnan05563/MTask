"""T00789 补充验证：用**可控慢端点**证明闸门逻辑正确（不受端点真实耗时影响）。

首轮发现：settings/export 与 dbadmin/export 在隔离库上执行过快（<5ms），
线程客户端无法形成重叠，故 5 路全 200 属**负载不足**而非闸门失效
（report/generate 已实测 3×429 证明闸门生效）。

本脚本用 express 中间件级注入一个 300ms 延时到 dbadmin/settings 闸门所保护的真实端点上？
不可行（不改生产代码）。改为**直接单元测试 export-gate 模块语义**：
  - limit=2：并发 5 路 → 2 放行 + 3 拒绝（429 + 中文）
  - finish/close 归还计数，不重复归还（once 去重）
  - 不同闸名互不干扰
  - 计数归零后恢复放行
"""
import json, os, subprocess, sys

ROOT = r'D:/code/otherProjects/26_MTask'
SRV = os.path.join(ROOT, 'server')
NODE = r'C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'

TEST = os.path.join(SRV, 'src', 'util', '__gate_probe.ts')
CODE = r'''
import { exportGate, gateSnapshot, EXPORT_GATE_LIMIT } from './export-gate';

type Handler = (req: unknown, res: unknown, next: () => void) => void;

/** 造一个极简 res 替身：记录 status/json，并可手动 emit finish/close */
function mkRes() {
  const r: any = {
    _status: 200, _body: null, _listeners: {} as Record<string, Array<() => void>>,
    status(c: number) { r._status = c; return r; },
    json(b: unknown) { r._body = b; return r; },
    once(ev: string, fn: () => void) { (r._listeners[ev] ||= []).push(fn); return r; },
    emit(ev: string) { for (const fn of r._listeners[ev] || []) fn(); },
  };
  return r;
}

const out: Record<string, unknown> = { EXPORT_GATE_LIMIT };

// ---- 场景1：limit=2，5 路并发 → 2 放行 3 拒绝 ----
const g = exportGate('probe', 2);
const codes: string[] = [];
const held: any[] = [];
for (let i = 0; i < 5; i++) {
  const res = mkRes();
  let passed = false;
  g({} as never, res as never, () => { passed = true; });
  if (passed) { codes.push('pass'); held.push(res); }
  else codes.push('reject:' + res._status + ':' + (res._body?.error ?? ''));
}
out.scenario1_codes = codes;
out.scenario1_pass = codes.filter((c) => c === 'pass').length;
out.scenario1_reject = codes.filter((c) => c.startsWith('reject')).length;
out.scenario1_msg_ok = codes.filter((c) => c.startsWith('reject')).every((c) => c.endsWith('导出任务过多，请稍后再试'));
out.snapshot_while_full = gateSnapshot();

// ---- 场景2：finish 归还 → 计数下降 ----
held[0].emit('finish');
out.after_one_finish = gateSnapshot();
// close 二次触发不应重复归还（once 去重）
held[0].emit('close');
out.after_double_release = gateSnapshot();

// ---- 场景3：释放全部 → 计数归零，恢复放行 ----
held[1].emit('finish');
out.after_all_finish = gateSnapshot();
const res6 = mkRes();
let pass6 = false;
g({} as never, res6 as never, () => { pass6 = true; });
out.scenario3_recovers = pass6;
res6.emit('finish');

// ---- 场景4：闸名隔离——另一闸满载不影响本闸 ----
const ga = exportGate('A', 1);
const gb = exportGate('B', 1);
const ra = mkRes(); let pa = false; ga({} as never, ra as never, () => { pa = true; });
const rb = mkRes(); let pb = false; gb({} as never, rb as never, () => { pb = true; });
out.scenario4_both_pass = pa && pb;
const ra2 = mkRes(); let pa2 = false; ga({} as never, ra2 as never, () => { pa2 = true; });
out.scenario4_a_full_blocks_a = !pa2 && ra2._status === 429;
const rb2 = mkRes(); let pb2 = false; gb({} as never, rb2 as never, () => { pb2 = true; });
out.scenario4_b_full_blocks_b = !pb2 && rb2._status === 429;
ra.emit('finish'); rb.emit('finish');

console.log('__GATE_PROBE__' + JSON.stringify(out));
'''

with open(TEST, 'w', encoding='utf-8') as f:
    f.write(CODE)

try:
    p = subprocess.run([NODE, os.path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/util/__gate_probe.ts'],
                       cwd=SRV, capture_output=True, text=True, timeout=120)
    out = (p.stdout or '') + (p.stderr or '')
    line = next((l for l in out.splitlines() if l.startswith('__GATE_PROBE__')), None)
    if not line:
        print('!! 未拿到探针输出：\n', out[-3000:])
        sys.exit(1)
    d = json.loads(line.replace('__GATE_PROBE__', ''))
    print(json.dumps(d, ensure_ascii=False, indent=2))
    ok = (d['scenario1_pass'] == 2 and d['scenario1_reject'] == 3
          and d['scenario1_msg_ok'] is True
          and d['after_one_finish'].get('probe') == 1
          and d['after_double_release'].get('probe') == 1
          and d['scenario3_recovers'] is True
          and d['after_all_finish'] == {}
          and d['scenario4_both_pass'] is True
          and d['scenario4_a_full_blocks_a'] is True
          and d['scenario4_b_full_blocks_b'] is True)
    d['overall'] = 'PASS' if ok else 'FAIL'
    print('\nOVERALL:', d['overall'])
    with open(os.path.join(ROOT, 'perf', 'sandbox', 'gate_probe.result.json'), 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    sys.exit(0 if ok else 1)
finally:
    try:
        os.remove(TEST)
    except Exception:
        import ctypes
        ctypes.windll.kernel32.DeleteFileW(TEST)
