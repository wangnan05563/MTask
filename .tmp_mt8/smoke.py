# -*- coding: utf-8 -*-
"""八期批次1 真机冒烟：隔离实例（REST + MCP over HTTP）跑通任务↔Git 关联全链。

端口 43999、数据目录 D:/code/tmp/mt8srv/data（隔离，绝不碰生产库/生产配置）。
输出 UTF-8 报告到 D:/code/tmp/mt8srv/report.txt（控制台 GBK 会乱码，一律落文件）。
"""
import json
import os
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
    lines.append(f'[{tag}] {msg}')


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                data=json.dumps(body).encode() if body is not None else None,
                                headers={'Content-Type': 'application/json', 'Origin': BASE})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode('utf8') or 'null')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode('utf8', 'replace') or 'null') if e.headers.get('content-type', '').startswith('application/json') else {'raw': 'non-json'}
    except Exception as e:  # noqa: BLE001
        return 0, {'err': str(e)}


def mcp(tool_name, args):
    env = dict(os.environ, MTASK_MCP_URL=BASE + '/api/mcp', MTASK_MCP_TOKEN='',
               TEMP=str(ROOT), TMP=str(ROOT))
    p = subprocess.run(['python', SKILL, 'raw', tool_name, json.dumps(args, ensure_ascii=False)],
                       capture_output=True, env=env, text=True, encoding='utf8', errors='replace')
    out = (p.stdout or '') + (p.stderr or '')
    Path(ROOT / f'mcp-{tool_name}.txt').write_text(out, encoding='utf8')
    return out


# 1. fixture 仓库：初始提交 / 普通提交 / 重命名提交
os.makedirs(REPO, exist_ok=True)
os.makedirs(DATA, exist_ok=True)
g = lambda *a: subprocess.run(['git', *a], cwd=REPO, capture_output=True, text=True, encoding='utf8', errors='replace')
if not (REPO / '.git').exists():
    g('init', '-q', '-b', 'main')
env_commit = dict(os.environ, GIT_AUTHOR_NAME='张三', GIT_AUTHOR_EMAIL='z@x.com',
                  GIT_COMMITTER_NAME='张三', GIT_COMMITTER_EMAIL='z@x.com',
                  GIT_AUTHOR_DATE='2026-01-05T10:00:00+08:00', GIT_COMMITTER_DATE='2026-01-05T10:00:00+08:00',
                  **{'user.name': '张三', 'user.email': 'z@x.com'})


def commit(files, msg, date):
    for n, c in files.items():
        (REPO / n).write_text(c, encoding='utf8')
    e = dict(env_commit, GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
    subprocess.run(['git', 'add', '-A'], cwd=REPO, capture_output=True)
    subprocess.run(['git', '-c', 'user.name=张三', '-c', 'user.email=z@x.com', 'commit', '-q', '-m', msg],
                   cwd=REPO, capture_output=True, env=e)
    return subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=REPO, capture_output=True, text=True).stdout.strip()


c1 = commit({'a.txt': 'l1\nl2\nl3\n'}, '八期冒烟：初始提交', '2026-01-05T10:00:00+08:00')
c2 = commit({'a.txt': 'l1\nl2\nl3\nl4\n', 'b.txt': 'x\n'}, '八期冒烟：改动与新文件', '2026-01-06T10:00:00+08:00')
subprocess.run(['git', 'mv', 'b.txt', 'b2.txt'], cwd=REPO, capture_output=True)
c3 = subprocess.run(['git', '-c', 'user.name=张三', '-c', 'user.email=z@x.com', 'commit', '-q', '-m', '八期冒烟：重命名'],
                    cwd=REPO, capture_output=True).stdout
c3 = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=REPO, capture_output=True, text=True).stdout.strip()

# 2. 项目 / 任务 / 绑定工作空间
st, proj = api('POST', '/api/projects', {'name': f'八期冒烟{uuid.uuid4().hex[:6]}'})
say('PASS' if st in (200, 201) else 'FAIL', f'P-01 建项目 HTTP {st} :: {json.dumps(proj, ensure_ascii=False)[:160]}')
pid = proj.get('id') if isinstance(proj, dict) else None
st, upd = api('PATCH', f'/api/projects/{pid}', {'workspacePath': str(REPO).replace('\\', '/')})
wp = (upd or {}).get('workspacePath') if isinstance(upd, dict) else None
say('PASS' if wp == str(REPO).replace('\\', '/') or wp == str(REPO) else 'FAIL', f'P-02 绑定工作空间 HTTP {st} :: {wp}')
st, task = api('POST', '/api/tasks', {'projectId': pid, 'title': '八期冒烟任务：Git 关联'})
Path(ROOT/'task.json').write_text(json.dumps(task,ensure_ascii=False),encoding='utf8')
tno, tid = task.get('task_no') or task.get('taskNo'), task.get('id')
say('PASS' if tno else 'FAIL', f'P-03 建任务 HTTP {st} :: {tno} {tid}')

# 3. MCP 工具真调用（幂等）
o1 = mcp('mtask_link_git_commit', {'taskNo': tno, 'commits': c1[:7]})
say('PASS' if 'linked=1' in o1 else 'FAIL', f'M-01 MCP 回写短 SHA：linked=1 :: {o1.strip().splitlines()[0] if o1.strip() else "(空)"}')
o2 = mcp('mtask_link_git_commit', {'taskNo': tno, 'commits': [c1.upper(), c2, c3]})
say('PASS' if 'linked=2' in o2 and 'skipped=1' in o2 else 'FAIL', f'M-02 重复(大写短写)+2 新 SHA：linked=2 skipped=1 :: {o2.strip().splitlines()[0] if o2.strip() else "(空)"}')
o3 = mcp('mtask_link_git_commit', {'taskNo': tno, 'commits': ['f' * 40]})
say('PASS' if '不在当前仓库' in o3 else 'FAIL', f'M-03 仓库解析不出的 SHA 被点名（不静默） :: {o3.strip()[:180]}')

# 4. REST：内联字段 / 抽屉首屏 / 懒加载 / 手动绑定与解绑
st, rows = api('GET', '/api/tasks')
row = next((r for r in (rows if isinstance(rows, list) else rows.get('items', [])) if r.get('id') == tid), {})
say('PASS' if row.get('gitLinkCount') == 3 and len(row.get('gitLinks', [])) == 1 else 'FAIL',
    f'R-01 GET /tasks 内联 gitLinks(1 条最新)+gitLinkCount(3) HTTP {st} :: {json.dumps(row.get("gitLinks"), ensure_ascii=False)[:160]}')
st, view = api('GET', f'/api/tasks/{tid}/git')
Path(ROOT/'view.json').write_text(json.dumps(view,ensure_ascii=False),encoding='utf8')
commits = (view or {}).get('commits', []) if isinstance(view, dict) else []
say('PASS' if st == 200 and len(commits) == 3 and commits[0]['sha'] == c3 and commits[-1]['isInitial'] is True else 'FAIL',
    f'R-02 抽屉首屏：3 张卡时间倒序 + 首提交 isInitial HTTP {st} :: '
    + json.dumps([{k: c.get(k) for k in ('shortSha', 'author', 'subject', 'source', 'isInitial')} for c in commits], ensure_ascii=False)[:420])
st, files = api('GET', f'/api/tasks/{tid}/git/{c1[:7]}/files')
say('PASS' if st == 200 and files.get('files') and files['files'][0]['status'] == 'A' else 'FAIL',
    f'R-03 首提交文件清单以空树为基线（全 A）HTTP {st} :: {json.dumps(files, ensure_ascii=False)[:220]}')
st, f2 = api('GET', f'/api/tasks/{tid}/git/{c3}/files?diff=1')
say('PASS' if st == 200 and f2.get('files') and f2['files'][0].get('oldPath') == 'b.txt' and f2.get('diffs') else 'FAIL',
    f'R-04 重命名清单带 oldPath，?diff=1 附 hunks HTTP {st} :: {json.dumps(f2, ensure_ascii=False)[:260]}')
st, summ = api('POST', '/api/git/commit-summaries', {'items': [{'taskId': tid, 'sha': c1}, {'taskId': tid, 'sha': c1}, {'taskId': tid, 'sha': c2}]})
gr = (summ or {}).get('groups', [])
say('PASS' if st == 200 and gr and gr[0]['commits'].__len__() == 2 and gr[0].get('remote') is not None else 'FAIL',
    f'R-05 commit-summaries：同 workspace 去重后 2 条 + 远端信息 HTTP {st} :: {json.dumps(summ, ensure_ascii=False)[:260]}')
st, man = api('POST', f'/api/tasks/{tid}/git/links', {'sha': c2[:8]})
say('PASS' if st == 200 and (man or {}).get('link', {}).get('source') == 'manual' else 'FAIL', f'R-06 手动绑定 source=manual HTTP {st} :: {json.dumps(man, ensure_ascii=False)[:160]}')
mid = (man or {}).get('link', {}).get('sha') or c2
st, delok = api('DELETE', f'/api/tasks/{tid}/git/links/{mid[:7]}')
say('PASS' if st == 200 else 'FAIL', f'R-07 解绑 manual 关联成功 HTTP {st} :: {json.dumps(delok, ensure_ascii=False)[:120]}')
st, del409 = api('DELETE', f'/api/tasks/{tid}/git/links/{c1[:7]}')
say('PASS' if st == 409 else 'FAIL', f'R-08 解绑 AI 回写的关联 → 409（仅 manual 可解绑）HTTP {st} :: {json.dumps(del409, ensure_ascii=False)[:160]}')
st, lg = api('GET', '/api/git/log?workspacePath=' + urllib.parse.quote(str(REPO).replace('\\', '/')) + '&limit=5')
say('PASS' if st == 200 and (isinstance(lg, dict) or isinstance(lg, list)) else 'FAIL',
    f'R-09 GET /git/log 新端点 HTTP {st} :: {json.dumps(lg, ensure_ascii=False)[:200]}')

# 5. 只读红线：冒烟全程后仓库工作树未被改动
before = subprocess.run(['git', 'status', '--porcelain'], cwd=REPO, capture_output=True, text=True).stdout
st, _ = api('GET', f'/api/tasks/{tid}/git')
after = subprocess.run(['git', 'status', '--porcelain'], cwd=REPO, capture_output=True, text=True).stdout
say('PASS' if before == after == '' else 'FAIL', f'N-01 全链只读：git status 前后一致且干净 :: before={before!r} after={after!r}')

lines.insert(0, f'==== 八期批次1 冒烟：{"FAIL " + str(fails) if fails else "ALL PASS"} ====')
Path(ROOT / 'report.txt').write_text('\n'.join(lines), encoding='utf8')
print('fails=', fails)
