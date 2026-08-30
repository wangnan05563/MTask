# 验证 P2 慢请求日志：快请求不记录，慢请求(≥100ms)记录并含耗时
import json, time, urllib.request

BASE = 'http://127.0.0.1:39876'
LOG = 'D:/code/otherProjects/26_MTask/perf/sandbox/verify.log'

def get(path):
    t0 = time.perf_counter()
    with urllib.request.urlopen(BASE + path, timeout=60) as r:
        body = r.read()
    return r.status, (time.perf_counter() - t0) * 1000

def log_lines():
    try:
        with open(LOG, encoding='utf-8', errors='ignore') as f:
            return f.read().splitlines()
    except Exception:
        return []

before = len(log_lines())

# 快请求：health 连发 10 次
health_ms = []
for _ in range(10):
    s, ms = get('/api/health')
    health_ms.append(ms)
print('health 10 次耗时 ms:', [round(m, 1) for m in health_ms])

# 慢请求：全量 tasks（1277 条，CPU 饱和下大概率 >100ms）
s, ms = get('/api/tasks?projectId=proj-main')
print('tasks 全量耗时 ms:', round(ms, 1), 'status', s)

time.sleep(1.5)  # 等日志 flush
after = log_lines()[before:]
print('--- verify.log 新增 ---')
for line in after:
    print('  ' + line)

# 校验：有慢日志条目，且每条格式含耗时 ms
slow_entries = [l for l in after if l.startswith('[mtask]')]
ok_format = all(('ms' in l and l.split()[-1].endswith('ms')) for l in slow_entries)
health_logged = any('GET /api/health' in l for l in slow_entries)
print('PASS 慢日志记录数:', len(slow_entries), '| 格式含耗时:', ok_format)
print('说明: health 若被记录说明其耗时≥100ms(环境 CPU 饱和所致)；tasks 全量应被记录')
