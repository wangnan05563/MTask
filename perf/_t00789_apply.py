# -*- coding: utf-8 -*-
"""T00789 建议项：从 HEAD blob 做字节级精确替换，经 hash-object + update-index
写入暂存区（index=HEAD 时精确构造 index blob，仅含 T00789 改动），
规避 CRLF 下 git apply 的行尾匹配失败，且不裹挟并发会话 WIP。
干净文件（export-gate.ts / SettingsService.ts）与 verify 脚本另行 git add。"""
import subprocess, sys

GIT = 'git'
ROOT = r'D:/code/otherProjects/26_MTask'

r1 = (
    "// T00789：exportBundle() 为同步重活（4.4MB 全量序列化，实测 122ms/次）→ defer 令其让出事件循环，\n"
    "// 否则同步执行期间无法接受后续请求、闸门计数永远到不了上限（实测 10 路并发 0×429、线性叠加至 946ms）\n"
    "api.get('/settings/export', exportGate('settings-export', undefined, { defer: true }), (req, res) => {"
)
r1_new = (
    "// T00789：exportBundle() 曾为纯同步重活（4.4MB 全量序列化，实测 122ms/次），同步期间无法接受后续请求、\n"
    "// 闸门计数到不了上限（实测 10 路并发 0×429、线性叠加至 946ms）。现在 exportBundle 已建议②分表让出\n"
    "// （每导一表 await setImmediate），但 defer 仍保留兜底，保证闸门在最坏情况（首表即大表）下依然可见。\n"
    "api.get('/settings/export', exportGate('settings-export', undefined, { defer: true }), async (req, res) => {"
)

files = {
    'server/src/routes/index.ts': [
        (r1, r1_new, 1),
        ("return res.json(exportBundle(names));", "return res.json(await exportBundle(names));", 1),
        ("    res.json(exportBundle());", "    res.json(await exportBundle());", 1),
    ],
    'server/src/mcp/server.ts': [
        ("const bundle = exportBundle();", "const bundle = await exportBundle();", 1),
    ],
}


def to_bytes(s):
    # HEAD blob 在仓库内是 LF 换行，直接 UTF-8 编码即可（无需 CRLF 转换）
    return s.encode('utf-8')


ok = True
for path, subs in files.items():
    old_bytes = subprocess.check_output([GIT, 'show', 'HEAD:' + path], cwd=ROOT)
    for old_s, new_s, expect in subs:
        old_b = to_bytes(old_s)
        new_b = to_bytes(new_s)
        cnt = old_bytes.count(old_b)
        if cnt != expect:
            print('!! [%s] 期望替换 %d 次，实际 %d 次: %r' % (path, expect, cnt, old_s[:60]))
            ok = False
            continue
        old_bytes = old_bytes.replace(old_b, new_b)
    # hash-object 写入对象库，update-index 指向新 blob（暂存区仅含 T00789 改动）
    blob = subprocess.check_output([GIT, 'hash-object', '-w', '--stdin'],
                                   cwd=ROOT, input=old_bytes).strip().decode()
    subprocess.run([GIT, 'update-index', '--cacheinfo', '100644,%s,%s' % (blob, path)],
                   cwd=ROOT, check=True)
    print('   ✅ %s → index blob %s' % (path, blob))

print('PATCH_APPLY:', 'OK' if ok else 'FAIL')
sys.exit(0 if ok else 1)