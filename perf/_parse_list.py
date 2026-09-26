import json, re, sys

path = r'D:/code/otherProjects/26_MTask/perf/_mtlist.txt'
raw = open(path, encoding='utf-8').read()
i = raw.find('[')
body = raw[i:]

nos = re.findall(r'"task_no": "(T\d+)"', body)
sts = re.findall(r'"status": "(\w+)"', body)
tis = re.findall(r'"title": "((?:[^"\\]|\\.)*)"', body)
prs = re.findall(r'"priority": "(\w+)"', body)
ves = re.findall(r'"verified": (\w+)', body)
ars = re.findall(r'"archived": (\w+)', body)

print('count', len(nos))
for n, s, t, p, v, a in zip(nos, sts, tis, prs, ves, ars):
    print('%-7s %-6s v=%-5s %-7s arch=%-5s | %s' % (n, s, v, p, a, t))
