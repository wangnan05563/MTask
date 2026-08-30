# 验证 P1 缓存：低频集合读缓存 + 写后失效 + 基本端点不破坏
import json, urllib.request, urllib.parse, time

BASE = 'http://127.0.0.1:39876'

def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={'Content-Type': 'application/json'} if data else {})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())

def check(name, ok, detail=''):
    print(('PASS' if ok else 'FAIL'), name, detail)

# 1. 低频集合端点各两次，均正常
for ep in ['/api/projects', '/api/queues', '/api/aitools', '/api/prompt-categories', '/api/report/templates']:
    s1, d1 = req('GET', ep)
    s2, d2 = req('GET', ep)
    check(f'GET {ep}', s1 == 200 and s2 == 200 and d1 == d2, f'size={len(d1)} 两次一致={d1 == d2}')

# 2. 写后失效：POST /projects 新建 → GET /projects 立即可见
_, before = req('GET', '/api/projects')
marker = '缓存验证项目-' + str(int(time.time()))
s, created = req('POST', '/api/projects', {'name': marker})
_, after = req('GET', '/api/projects')
check('POST /projects 后缓存失效立即可见', s == 201 and any(p['name'] == marker for p in after),
      f'before={len(before)} after={len(after)}')
# 清理测试项目
if created and created.get('id'):
    req('DELETE', f"/api/projects/{created['id']}")

# 3. 队列创建后立即可见
qmarker = '缓存验证队列-' + str(int(time.time()))
s, q = req('POST', '/api/queues', {'name': qmarker, 'date': '2026-08-28'})
_, qlist = req('GET', '/api/queues')
check('POST /queues 后列表立即可见', s == 201 and any(x['name'] == qmarker for x in qlist))

# 4. 任务基本端点仍正常（分页参数未被缓存逻辑破坏）
s, tl = req('GET', '/api/tasks?projectId=proj-main&limit=10')
check('GET /tasks?limit=10', s == 200 and len(tl) == 10, f'len={len(tl)}')

# 5. 健康检查正常
s, h = req('GET', '/api/health')
check('GET /api/health', s == 200 and h.get('ok') is True)
