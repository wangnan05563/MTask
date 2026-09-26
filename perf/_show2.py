import json
d = json.load(open(r'D:/code/otherProjects/26_MTask/perf/_mtlist_full.json', encoding='utf-8'))
for t in d:
    if t['no'] in ('T00790', 'T00782'):
        print('=' * 70)
        print(t['no'], '|', t['title'], '| status=', t['status'], 'derived_from=', t['derived_from'])
        print('-' * 70)
        print(t['desc'])
