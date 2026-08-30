# 验证 P0-2 后端：GET /tasks 分页/搜索/分类/排序/兼容性
import json, urllib.request

BASE = 'http://127.0.0.1:39876'

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read())

# 1. 全量（兼容：不传 limit 返回 Task[]）
full = get('/api/tasks?projectId=proj-main')
print('1. 全量条数:', len(full), '| 首条:', full[0]['title'][:20] if full else 'EMPTY')

# 2. 分页 limit=100
p1 = get('/api/tasks?projectId=proj-main&limit=100&offset=0')
print('2. 第1页(offset=0):', len(p1), '| 末条id:', p1[-1]['id'] if p1 else '-')

# 3. 分页 offset=100（与第1页不重叠）
p2 = get('/api/tasks?projectId=proj-main&limit=100&offset=100')
ids1 = {t['id'] for t in p1}
ids2 = {t['id'] for t in p2}
print('3. 第2页(offset=100):', len(p2), '| 与第1页重叠:', len(ids1 & ids2))

# 4. keyword 搜索（title 含"压测任务-10"）
k1 = get('/api/tasks?projectId=proj-main&keyword=' + urllib.parse.quote('压测任务-1'))
print('4. keyword=压测任务-1 命中:', len(k1), '| 样例:', k1[0]['title'] if k1 else 'NONE')

# 5. categoryId=none（seed 任务 category_id 均为 NULL）
c1 = get('/api/tasks?projectId=proj-main&categoryId=none')
print('5. categoryId=none 条数:', len(c1), '(应为全量，seed 任务未分类)')

# 6. sort=created_asc（最早创建在前：seed 里 task-0001 最早）
s1 = get('/api/tasks?projectId=proj-main&sort=created_asc&limit=3')
print('6. sort=created_asc 前3:', [t['id'] for t in s1])

# 7. 组合：分页 + 搜索 + 分类
combo = get('/api/tasks?projectId=proj-main&keyword=' + urllib.parse.quote('压测任务-2') + '&limit=5')
print('7. keyword+limit 组合:', len(combo), '| 全命中keyword:', all('压测任务-2' in t['title'] for t in combo))

# 8. 归档兼容（archived=1 全量）
arch = get('/api/tasks?archived=1')
print('8. archived=1 全量:', len(arch), '(兼容 ArchivePage)')

# 9. 非法 limit 回退全量
bad = get('/api/tasks?projectId=proj-main&limit=99999')
print('9. limit=99999 回退全量:', len(bad) == len(full), f'({len(bad)})')
