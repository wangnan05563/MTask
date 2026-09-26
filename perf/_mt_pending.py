# -*- coding: utf-8 -*-
"""解析待办清单，列出待处理(todo/未验证)任务的结构化信息。"""
import json, sys

path = r'D:/code/otherProjects/26_MTask/perf/_mt_list_full_clean.json'
with open(path, encoding='utf-8-sig') as f:
    data = json.load(f)

print('总任务数:', len(data))
print('=' * 70)
for t in data:
    mark = ''
    if t.get('status') == 'todo':
        mark = 'TODO'
    elif t.get('verified') is False and t.get('status') != 'done':
        mark = 'UNVERI'
    if not mark:
        continue
    print('[%s] %s | pid=%s | proj=%s | state=%s' % (
        mark,
        t.get('task_no') or t.get('id')[:8],
        t['project_id'],
        t.get('status'),
        repr(t.get('ai_state')),
    ))
    print('    title:', (t.get('title') or '')[:60])
    desc = (t.get('description') or '').replace('\n', ' ')[:60]
    print('    desc :', desc)
    hr = t.get('handle_result')
    print('    hr   :', ('有(前60): ' + hr[:60].replace(chr(10), ' ')) if hr else '无')
    print('-' * 70)