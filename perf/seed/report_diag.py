# 诊断 report_generate 真实耗时 + 是否阻塞事件循环（health 旁证）
import json, threading, time, urllib.request

BASE = 'http://127.0.0.1:39876'
results = []

def probe():
    for i in range(90):
        t0 = time.perf_counter()
        try:
            urllib.request.urlopen(BASE + '/api/health', timeout=130).read()
            el = (time.perf_counter() - t0) * 1000
            results.append(('health', i, round(el, 1)))
        except Exception as e:
            results.append(('health', i, 'ERR ' + str(e)))
        time.sleep(2)

th = threading.Thread(target=probe)
th.start()

body = json.dumps({"period": "week", "format": "xlsx", "projectId": "proj-main"}).encode()
req = urllib.request.Request(BASE + '/api/report/generate', data=body, method='POST',
                             headers={'Content-Type': 'application/json'})
t0 = time.perf_counter()
try:
    r = urllib.request.urlopen(req, timeout=200)
    data = r.read()
    el = (time.perf_counter() - t0) * 1000
    print('report_generate: %.1f ms, status %s, body %d bytes' % (el, r.status, len(data)))
except Exception as e:
    print('report_generate ERR: %s after %.1f ms' % (e, (time.perf_counter() - t0) * 1000))

th.join()
print('--- health during report_generate ---')
for h in results:
    print(h)
