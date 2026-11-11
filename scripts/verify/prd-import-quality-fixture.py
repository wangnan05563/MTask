#!/usr/bin/env python3
"""PRD 导入质量门的只读夹具导出器（Python 标准库，无原生模块 ABI 依赖）。

为什么需要它：质量门的 --db 模式依赖 better-sqlite3 原生模块，桌面安装版用的
Node/Electron ABI 往往与开发机 Node 不一致（实测 NODE_MODULE_VERSION 130 vs 127），
直接 require 会 ERR_DLOPEN_FAILED。Python 的 sqlite3 是标准库，用 URI `mode=ro`
打开同一个文件即可只读导出同样的行，跨平台且不改动任何数据。

用法：
  python scripts/verify/prd-import-quality-fixture.py \
      --db "C:/Users/<you>/AppData/Roaming/mtask/data/mtask.db" \
      --project "BEMP审批" --out tmp/qc-fixture.json

  python scripts/verify/prd-import-quality-fixture.py --db <...> --list-projects

随后：
  node node_modules/tsx/dist/cli.mjs scripts/verify/prd-import-quality-gate.mts \
      --fixture tmp/qc-fixture.json \
      --src-dir "<源文档目录>" \
      --out tmp/prd-import-quality-report.md

红线：连接一律 mode=ro，只执行 SELECT / PRAGMA table_info，绝不写入。
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

TABLES = ("prd_docs", "prd_requirements", "plan_tasks", "tasks", "prd_issues", "prd_parse_failures")


def connect_readonly(db_path: str) -> sqlite3.Connection:
    p = Path(db_path).expanduser().resolve()
    if not p.is_file():
        raise SystemExit(f"数据库不存在：{p}")
    uri = f"file:{p.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")]


def main() -> None:
    ap = argparse.ArgumentParser(description="PRD 导入质量门只读夹具导出器")
    ap.add_argument("--db", required=True, help="MTask SQLite 运行库路径")
    ap.add_argument("--project", help="项目 id 或名称")
    ap.add_argument("--out", default="tmp/qc-fixture.json", help="输出夹具 JSON 路径")
    ap.add_argument("--list-projects", action="store_true", help="只列出项目 id/名称后退出")
    args = ap.parse_args()

    conn = connect_readonly(args.db)
    try:
        if args.list_projects:
            for r in conn.execute("SELECT id, name FROM projects ORDER BY name"):
                print(f"{r['id']}\t{r['name']}")
            return

        rows = list(conn.execute("SELECT id, name FROM projects WHERE id = ? OR name = ?", (args.project, args.project)))
        if not rows:
            raise SystemExit(f"未找到项目：{args.project}（可用 --list-projects 查看）")
        pid, pname = rows[0]["id"], rows[0]["name"]

        fixture: dict = {"projectLabel": pname, "projectId": pid}
        for table in TABLES:
            cols = columns(conn, table)
            if not cols:
                fixture[table] = []
                continue
            if "project_id" not in cols:
                fixture[table] = []
                continue
            sql = f"SELECT {', '.join(cols)} FROM {table} WHERE project_id = ?"
            fixture[table] = [dict(r) for r in conn.execute(sql, (pid,))]

        # 质量门读的键名与表名的对应关系（门内 DataSet 用 docs/reqs/plans/tasks/issues/failures）
        fixture["docs"] = fixture.pop("prd_docs")
        fixture["reqs"] = fixture.pop("prd_requirements")
        fixture["plans"] = fixture.pop("plan_tasks")
        fixture["issues"] = fixture.pop("prd_issues")
        fixture["failures"] = fixture.pop("prd_parse_failures")

        out = Path(args.out).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(fixture, ensure_ascii=False, indent=1), encoding="utf-8")
        summary = {k: len(v) for k, v in fixture.items() if isinstance(v, list)}
        print(f"只读夹具已导出：{out}")
        print(f"项目：{pname}（{pid}）  {summary}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
