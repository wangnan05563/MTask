#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包 MTask 技能包（独立于安装包的 Release 资产）。

用法：python pack-skill.py <version> <output_zip>

产物：MTask_Skill_v<version>.zip，zip 内根目录为 mtask/，解压后把整个
      mtask 目录放进所用 AI Coding 平台的技能目录即可（保持 SKILL.md 在目录根）。

只收录技能核心文件；临时文件/查询缓存/探针脚本/__pycache__ 一律排除，
并在日志里逐条列出被排除项——避免把过程产物发进 Release。
纯标准库，无第三方依赖；被 scripts/publish-oneclick.ps1 与 .github/workflows/build.yml 共用。
"""
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL_DIR = ROOT / 'skills' / 'mtask'

# 核心文件必须全部存在，缺一即视为技能包不完整，拒绝出包。
REQUIRED = (
    'SKILL.md',
    'assets/result-template.md',
    'config/config.yaml',
    'references/1-listing-parsing.md',
    'references/2-handling-workflow.md',
    'references/3-output-standard.md',
    'references/4-scope-judgement.md',
    'references/5-frontend-ui-guard.md',
    'references/6-token-efficiency.md',
    'references/7-plan-workflow.md',
    'references/8-milestone-workflow.md',
    'references/pitfalls.md',
    'scripts/mcp-direct-call.py',
    'scripts/prd_to_plan.py',
    'scripts/list-todo.ps1',
)

# 过程产物规则：命中即排除。新增临时文件命名时在这里补一条即可。
EXCLUDE_DIRS = {'__pycache__'}
EXCLUDE_SUFFIXES = ('.pyc', '.pyo', '.log')


def is_temp(rel: str) -> bool:
    name = os.path.basename(rel)
    parts = rel.split('/')
    if any(p in EXCLUDE_DIRS for p in parts[:-1]):
        return True
    if name.endswith(EXCLUDE_SUFFIXES):
        return True
    if name.startswith(('tmp_', '_qs_', 'g_T', '_')):
        return True
    if '%' in name or name.startswith('.'):
        return True
    return False


def main() -> int:
    if len(sys.argv) < 3:
        sys.exit('用法: python pack-skill.py <version> <output_zip>')
    version = sys.argv[1].strip()
    out = Path(sys.argv[2]).resolve()

    if not SKILL_DIR.is_dir():
        sys.exit(f'技能目录不存在: {SKILL_DIR}')
    missing = [r for r in REQUIRED if not (SKILL_DIR / r).is_file()]
    if missing:
        sys.exit('技能包核心文件缺失，拒绝出包: ' + ', '.join(missing))

    all_files = sorted(
        p.relative_to(SKILL_DIR).as_posix()
        for p in SKILL_DIR.rglob('*') if p.is_file()
    )
    included = [r for r in all_files if not is_temp(r)]
    excluded = [r for r in all_files if is_temp(r)]

    out.parent.mkdir(parents=True, exist_ok=True)
    # 固定时间戳 + 固定顺序，保证同版本重复打包产物字节一致，便于校验与幂等上传。
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in included:
            info = zipfile.ZipInfo('mtask/' + rel, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, (SKILL_DIR / rel).read_bytes())

    print(f'版本: {version}')
    print(f'产物: {out}  ({out.stat().st_size} bytes)')
    print(f'收录核心文件: {len(included)} 个')
    for r in included:
        print('  + ' + r)
    if excluded:
        print(f'已排除过程产物: {len(excluded)} 个')
        for r in excluded:
            print('  - ' + r)
    return 0


if __name__ == '__main__':
    sys.exit(main())
