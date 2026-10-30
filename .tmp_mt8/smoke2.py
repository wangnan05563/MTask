# -*- coding: utf-8 -*-
"""八期批次1 真机冒烟：隔离实例（REST + MCP over HTTP）跑通任务↔Git 关联全链。

端口 43999、数据目录 D:/code/tmp/mt8srv/data、fixture 仓库 D:/code/tmp/mt8srv/repo（每次重建）。
绝不碰生产库/生产配置；输出 UTF-8 报告到 D:/code/tmp/mt8srv/report.txt。
"""
import json
import os
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

BASE = 'http://127.0.0.1:43999'
ROOT = Path('D:/code/tmp/mt8srv')
REPO = ROOT / 'repo'
DATA = ROOT / 'data'
SKILL = r'C:/Users/hspcadmin/.qoder-cn/skills/mtask/scripts/mcp-direct-call.py'
lines = []
fails = 0


def say(tag, msg):
    global fails
    if tag == 'FAIL':
        fails += 1
    lines.append(f'[%s] %s' % (tag, msg))


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json', 'Origin': BASE})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode('utf8') or 'null')
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf8', 'replace')
        try:
            return e.code, json.loads(raw or 'null')
        except Exception:
            return e.code, {'raw': raw[:200]}
    except Exception as e:
        return 0, {'err': str(e)}


def mcp(tool_name, args):
    env = dict(os.environ, MTASK_MCP_URL=BASE + '/api/mcp', MTASK_MCP_TOKEN='', TEMP=str(ROOT), TMP=str(ROOT), PYTHONIOENCODING='utf-8')
    p = subprocess.run(['python', SKILL, 'raw', tool_name, json.dumps(args, ensure_ascii=False)],
                       capture_output=True, env=env, text=True, encoding='utf8', errors='replace')
    out = (p.stdout or '') + (p.stderr or '')
    Path(ROOT / ('mcp-' + tool_name + '.txt')).write_text(out, encoding='utf8')
    tail = [l for l in out.splitlines() if l.strip() and '会话' not in l]
    return out, (tail[-1] if tail else '(空)')


def git(*a, **kw):
    return subprocess.run(['git', *a], cwd=kw.get('cwd', REPO), capture_output=True, text=True,
                          encoding='utf8', errors='replace', env=kw.get('env'))


def commit(files, msg, date):
    for name, content in files.items():
        (REPO / name).write_text(content, encoding='utf8')
    env = dict(os.environ, GIT_AUTHOR_NAME='张三', GIT_AUTHOR_EMAIL='z@x.com',
               GIT_COMMITTER_NAME='张三', GIT_COMMITTER_EMAIL='z@x.com',
               GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
    git('add', '-A')
    subprocess.run(['git', '-c', 'user.name=张三', '-c', 'user.email=z@x.com', 'commit', '-q', '-m', msg],
                   cwd=REPO, capture_output=True, env=env)
    return git('rev-parse', 'HEAD').stdout.strip()


shutil.rmtree(REPO, ignore_errors=True)
os.makedirs(REPO, exist_ok=True)
os.makedirs(DATA, exist_ok=True)
git('init', '-q', '-b', 'main')
c1 = commit({'a.txt': 'l1\nl2\nl3\n'}, '八期冒烟：初始提交', '2026-01-05T10:00:00+08:00')
c2 = commit({'a.txt': 'l1\nl2\nl3\nl4\n', 'b.txt': 'x\n'}, '八期冒烟：改动与新文件', '2026-01-06T10:00:00+08:00')
git('mv', 'b.txt', 'b2.txt')
c3 = commit({'c.txt': 'new\n'}, '八期冒烟：重命名并新增', '2026-01-07T10:00:00+08:00')
REPO_FWD = str(REPO).replace('\\', '/')
J = lambda d: json.dumps(d, ensure_ascii=False)[:260]

st, proj = api('POST', '/api/projects', {'name': '八期冒烟' + uuid.uuid4().hex[:6]})
pid = proj.get('id')
say('PASS' if st in (200, 201) and pid else 'FAIL', 'P-01 建项目 HTTP %s :: id=%s' % (st, pid))
st, upd = api('PATCH', '/api/projects/%s' % pid, {'workspacePath': REPO_FWD})
got = upd.get('workspacePath') or upd.get('workspace_path') or ''
say('PASS' if str(got).replace('\\', '/') == REPO_FWD else 'FAIL', 'P-02 绑定工作空间 HTTP %s :: %s' % (st, got))
st, task = api('POST', '/api/tasks', {'projectId': pid, 'title': '八期冒烟任务：Git 关联'})
tno, tid = task.get('task_no') or task.get('taskNo'), task.get('id')
say('PASS' if tno and tid else 'FAIL', 'P-03 建任务 HTTP %s :: %s %s' % (st, tno, tid))

o1, t1 = mcp('mtask_link_git_commit', {'taskNo': tno, 'commits': c1[:7]})
say('PASS' if 'linked=1' in o1 else 'FAIL', 'M-01 短 SHA 回写 linked=1 :: %s' % t1[:200])
o2, t2 = mcp('mtask_link_git_commit', {'taskNo': tno, 'commits': [c1.upper(), c2, c3]})
say('PASS' if 'linked=2' in o2 and 'skipped=1' in o2 else 'FAIL', 'M-02 重复(大写短写)+2 新 SHA → linked=2 skipped=1 :: %s' % t2[:200])
o3, t3 = mcp('mtask_link_git_commit', {'taskNo': tno, 'commits': ['f' * 40]})
say('PASS' if 'linked=0' in o3 and '不在当前仓库' in o3 else 'FAIL', 'M-03 解析不出的 SHA 逐条点名（不静默） :: %s' % t3[:200])
o4, t4 = mcp('mtask_link_git_commit', {'commits': [c1]})
say('PASS' if ('isError' in o4) or ('taskNo' in o4) else 'FAIL', 'M-04 缺定位参数被拒（不落到任意任务） :: %s' % t4[:200])

st, rows = api('GET', '/api/tasks')
lst = rows if isinstance(rows, list) else rows.get('items', [])
row = next((r for r in lst if r.get('id') == tid), {})
gl = row.get('gitLinks', [])
say('PASS' if row.get('gitLinkCount') == 3 and len(gl) == 1 and gl[0]['sha'] == c3 else 'FAIL',
    'R-01 GET /tasks 内联 gitLinks(最新 1 条=c3)+gitLinkCount(3) HTTP %s :: %s' % (st, J(row and {k: row.get(k) for k in ('gitLinkCount', 'gitLinks')})))
st, view = api('GET', '/api/tasks/%s/git' % tid)
cs = view.get('commits', [])
say('PASS' if st == 200 and len(cs) == 3 and cs[0]['sha'] == c3 and cs[-1]['isInitial'] is True
    and all(c.get('author') and c.get('date') and c.get('subject') and c.get('stats') for c in cs) else 'FAIL',
    'R-02 抽屉首屏：3 卡时间倒序 + 首提交 isInitial + 四要素齐 HTTP %s :: %s' % (st, J([{k: c.get(k) for k in ('shortSha', 'subject', 'isInitial', 'source')} for c in cs])))
st, fl1 = api('GET', '/api/tasks/%s/git/%s/files' % (tid, c1[:7]))
say('PASS' if st == 200 and fl1.get('files') and all(f['status'] == 'A' for f in fl1['files']) else 'FAIL',
    'R-03 首提交清单以空树为基线（全 A，无父提交不报错）HTTP %s :: %s' % (st, J(fl1)))
st, fl3 = api('GET', '/api/tasks/%s/git/%s/files?diff=1' % (tid, c3))
rn = next((f for f in fl3.get('files', []) if f.get('status') == 'R'), {})
say('PASS' if st == 200 and rn.get('oldPath') == 'b.txt' and rn.get('path') == 'b2.txt' and fl3.get('diffs') else 'FAIL',
    'R-04 重命名给 oldPath，?diff=1 附 hunks HTTP %s :: %s' % (st, J(fl3)))
st, summ = api('POST', '/api/git/commit-summaries', {'links': [{'taskId': tid, 'sha': c1}, {'taskId': tid, 'sha': c1}, {'taskId': tid, 'sha': c2}]})
gr = summ.get('groups', [])
say('PASS' if st == 200 and len(gr) == 1 and len(gr[0]['commits']) == 2 else 'FAIL',
    'R-05 commit-summaries：同 workspace 去重后 2 条摘要 HTTP %s :: %s' % (st, J(summ)))
st, bad = api('POST', '/api/git/commit-summaries', {'items': []})
say('PASS' if st == 400 and 'links' in J(bad) else 'FAIL',
    'R-05b 传错字段名不再静默回空 groups → 400 点名 HTTP %s :: %s' % (st, J(bad)))
st, man = api('POST', '/api/tasks/%s/git/links' % tid, {'sha': c2[:8]})
say('PASS' if st == 200 and man.get('link', {}).get('source') == 'agent' and man.get('link', {}).get('sha') == c2 else 'FAIL',
    'R-06 已有 agent 关联时手动绑定不产生重复行（幂等，来源如实保留 agent）HTTP %s :: %s' % (st, J(man)))
st, man2 = api('POST', '/api/tasks/%s/git/links' % tid, {'sha': 'zzzzzz'})
say('PASS' if st == 400 else 'FAIL', 'R-06b 非法 SHA → 400 HTTP %s :: %s' % (st, J(man2)))
st, task2 = api('POST', '/api/tasks', {'projectId': pid, 'title': '八期冒烟任务：手动绑定'})
tid2 = task2.get('id')
st, man3 = api('POST', '/api/tasks/%s/git/links' % tid2, {'sha': c1[:7]})
st2, delok = api('DELETE', '/api/tasks/%s/git/links/%s' % (tid2, c1[:7]))
say('PASS' if man3.get('link', {}).get('source') == 'manual' and st2 == 200 else 'FAIL',
    'R-07 手动绑定 source=manual → 解绑成功 HTTP %s/%s :: %s' % (st, st2, J(delok)))
st3, del409 = api('DELETE', '/api/tasks/%s/git/links/%s' % (tid, c1[:7]))
say('PASS' if st3 == 409 and '仅手动绑定' in J(del409) else 'FAIL',
    'R-08 解绑 AI 回写(agent)的关联 → 409 + 可操作原因 HTTP %s :: %s' % (st3, J(del409)))
st4, del404 = api('DELETE', '/api/tasks/%s/git/links/%s' % (tid2, c2[:7]))
say('PASS' if st4 == 404 else 'FAIL', 'R-08b 解绑不存在的关联 → 404 点名 HTTP %s :: %s' % (st4, J(del404)))
st, lg = api('GET', '/api/git/log?projectId=%s&limit=5' % pid)
say('PASS' if st == 200 and lg.get('ok') and lg.get('commits') else 'FAIL', 'R-09 GET /git/log 新端点按项目取数 HTTP %s :: %s' % (st, J(lg)))
st, lg0 = api('GET', '/api/git/log?limit=5')
say('PASS' if st == 400 else 'FAIL', 'R-09b 缺 projectId → 400 点名（不猜项目）HTTP %s :: %s' % (st, J(lg0)))
st, nogn = api('GET', '/api/tasks/%s/git' % uuid.uuid4())
say('PASS' if st == 404 else 'FAIL', 'R-10 不存在的任务 → 404 HTTP %s :: %s' % (st, J(nogn)))

before = git('status', '--porcelain').stdout
api('GET', '/api/tasks/%s/git' % tid)
api('GET', '/api/tasks/%s/git/%s/files?diff=1' % (tid, c2))
api('POST', '/api/git/commit-summaries', {'links': [{'taskId': tid, 'sha': c2}]})
after = git('status', '--porcelain').stdout
say('PASS' if before == after == '' else 'FAIL', 'N-01 取数全程后 git status 前后一致且干净 :: %r -> %r' % (before, after))
say('PASS' if not list(REPO.glob('.scannerwork')) else 'FAIL', 'N-02 未在仓库内留下任何副产物目录')

Path(ROOT / 'report.txt').write_text('\n'.join(lines), encoding='utf8')
print('fails=', fails)
