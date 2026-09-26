"""临时构造「改造前」的 WorkspaceService（refreshSymbols 无事务 + us逐文件 SELECT）用于对比。
只替换 refreshSymbols/indexFileSymbols 两处逻辑，其余保持。测量完毕后立即还原。
"""
import io, re, shutil, sys

P = r'D:/code/otherProjects/26_MTask/server/src/services/WorkspaceService.ts'
BK = r'D:/code/otherProjects/26_MTask/perf/sandbox/ws_after.bak.ts'

mode = sys.argv[1] if len(sys.argv) > 1 else 'show'
src = io.open(P, encoding='utf-8', newline='').read()

if mode == 'revert':
    shutil.copy2(BK, P)
    print('已还原改造后版本')
    sys.exit(0)

if mode == 'before':
    # 1) indexFileSymbols 改回「逐文件 SELECT MAX(file_mtime)」
    old_lookup = "  if (ctx.knownMtime.get(relChild) === mtime) { ctx.skipped++; return; }"
    new_lookup = """  const known = db.prepare('SELECT MAX(file_mtime) AS m FROM workspace_symbols WHERE project_id = ? AND path = ?').get(projectId, relChild);
  if (known && known.m === mtime) { ctx.skipped++; return; }"""
    assert src.count(old_lookup) == 1, 'lookup anchor not unique'
    src = src.replace(old_lookup, new_lookup, 1)

    # 2) 移除事务包裹
    old_tx = """    const run = db.transaction(() => symbolIndexWalk(ctx, workspace, ''));
    run();"""
    new_tx = "    symbolIndexWalk(ctx, workspace, '');"
    assert src.count(old_tx) == 1, 'tx anchor not unique'
    src = src.replace(old_tx, new_tx, 1)

    io.open(P, 'w', encoding='utf-8', newline='').write(src)
    print('已切换为改造前实现（无事务 + 逐文件 SELECT）')

elif mode == 'show':
    for pat in ("knownMtime.get(relChild)", "db.transaction", "SELECT MAX(file_mtime)"):
        print(pat, '→', src.count(pat))
