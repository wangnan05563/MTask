#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通用 GitHub Release 发布脚本（零依赖，仅 Python 标准库）
======================================================

把「创建 Release + 附带说明（读 Markdown 文件）+ 上传资产」三步原子化做完。
token 优先从本地 .env（GH_TOKEN）读取，其次复用 git 凭据库（git credential fill）；不打印、也不落盘进仓库（.env 已被 .gitignore 忽略）。

用法：
    python publish-release.py <资产路径> <说明md路径> [资产显示名]

环境变量（均可选，缺省自动推断）：
    GH_REPO        仓库坐标 owner/name。缺省从 `git remote get-url origin` 推断。
    GH_TAG         Release 标签（=版本号）。缺省用 `git describe --tags --abbrev=0`。
    GH_TOKEN       GitHub token。优先读本地 .env，其次自动从 git 凭据库读取。
    GH_TARGET      目标分支/commit。缺省为当前分支。
    GH_DRAFT       1=草稿。缺省 0（正式发布）。
    GH_PRERELEASE  1=预发布。缺省 0。
    GH_API_BASE    API 域名，默认 https://api.github.com （企业版/镜像可改）。

幂等：Release 已存在则复用；资产已存在则跳过上传。网络抖动自动重试。

示例（在仓库根目录）：
    GH_TAG=1.2.3 GH_REPO=me/myapp python tooling/scripts/publish-release.py \
        dist/MyApp-1.2.3-setup.exe release-notes-1.2.3.md
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def _load_dotenv():
    """从本地 .env 读取配置（GitHub Token 等），不覆盖已存在的环境变量。

    查找顺序：当前工作目录 -> 仓库根（向上查 .git）-> 脚本所在目录。
    .env 已被 .gitignore 忽略，不会入库；入库模板请用 .env.example。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    root = here
    for _ in range(10):
        if os.path.isdir(os.path.join(root, ".git")) or os.path.dirname(root) == root:
            break
        root = os.path.dirname(root)
    if not os.path.isdir(os.path.join(root, ".git")):
        root = here
    candidates = []
    for d in (os.getcwd(), root, here):
        p = os.path.join(d, ".env")
        if p not in candidates:
            candidates.append(p)
    for p in candidates:
        if not os.path.isfile(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                for raw in f:
                    line = raw.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip()
                    if len(v) >= 2 and v[0] in ("'", '"') and v[-1] == v[0]:
                        v = v[1:-1]
                    if k and k not in os.environ:
                        os.environ[k] = v
        except Exception:
            pass


def _read_text(path):
    """读取文本文件，编码回退：utf-8 -> gbk -> 系统默认。

    兼容中文 Windows 下记事本以 GBK 保存的 .md 说明文件。
    """
    import locale
    for enc in ("utf-8", "gbk", None):
        try:
            with open(path, encoding=enc) as f:
                return f.read()
        except (UnicodeDecodeError, UnicodeError):
            continue
    with open(path, encoding=locale.getpreferredencoding(False)) as f:
        return f.read()


_load_dotenv()

API_BASE = os.environ.get("GH_API_BASE", "https://api.github.com").rstrip("/")
REPO = (os.environ.get("GH_REPO") or "").strip()
TAG = (os.environ.get("GH_TAG") or "").strip()
TOKEN = (os.environ.get("GH_TOKEN") or "").strip()
TARGET = (os.environ.get("GH_TARGET") or "").strip()
DRAFT = os.environ.get("GH_DRAFT", "0") == "1"
PRERELEASE = os.environ.get("GH_PRERELEASE", "0") == "1"
DRY_RUN = os.environ.get("GH_DRY_RUN", "0") == "1"


def _find_repo_root():
    """Walk up from this script to the nearest directory containing .git."""
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(10):
        if os.path.isdir(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return os.getcwd()


GIT_CWD = _find_repo_root()


def sh(cmd):
    """跑一条 shell 命令，返回 stdout（失败返回空串，不抛）。cwd 锚定仓库根，与启动目录无关。"""
    try:
        out = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30,
                             cwd=GIT_CWD, encoding="utf-8", errors="replace")
        return (out.stdout or "").strip()
    except Exception:
        return ""


def detect_repo():
    url = sh("git remote get-url origin")
    # 支持 https 与 ssh 两种格式
    url = url.replace("git@github.com:", "https://github.com/").replace(".git", "")
    if "github.com/" in url:
        return url.split("github.com/", 1)[1].strip("/")
    return ""


def detect_tag():
    return sh("git describe --tags --abbrev=0")


def detect_branch():
    b = sh("git rev-parse --abbrev-ref HEAD")
    return b or "master"


def fetch_token():
    """复用 git 凭据库里的 github.com 密码（即你的 PAT/凭证）。

    注意：必须用 Python 子进程直接喂 stdin，不能依赖 shell 的 `printf | git
    credential fill`（Windows 原生 CMD 没有 printf，.bat 环境下会失败）。
    """
    try:
        proc = subprocess.run(
            ["git", "credential", "fill"],
            input="protocol=https\nhost=github.com\n\n",
            capture_output=True, text=True, timeout=30,
        )
        for line in (proc.stdout or "").splitlines():
            if line.startswith("password="):
                return line[len("password="):].strip()
    except Exception:
        pass
    return ""


def api(path, data=None, method=None, base=None):
    base = base or API_BASE
    body = json.dumps(data).encode("utf-8") if data is not None else None
    last = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(
                base + path, data=body,
                method=method or ("POST" if body else "GET"),
                headers={
                    "Authorization": "Bearer " + TOKEN,
                    "Accept": "application/vnd.github+json",
                    "User-Agent": "publish-release",
                    "Content-Type": "application/json",
                })
            with urllib.request.urlopen(req, timeout=90) as r:
                txt = r.read().decode("utf-8")
                return r.status, (json.loads(txt) if txt else None)
        except urllib.error.HTTPError as e:
            payload = e.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(payload) if payload else None
            except Exception:
                parsed = None
            last = (e.code, parsed or payload)
            # 409/422：tag 或 release 已存在 —— 交给调用方走「复用」分支
            if e.code in (409, 422):
                return e.code, parsed
            if e.code in (403, 429, 500, 502, 503):
                time.sleep(10)
                continue
            return last
        except Exception as e:  # 连接重置/空响应
            last = ("EXC", str(e))
            time.sleep(10)
    return last


def get_existing_release_by_tag(tag):
    st, resp = api(f"/repos/{REPO}/releases/tags/{tag}")
    if st == 200 and isinstance(resp, dict):
        return resp
    return None


def main():
    if len(sys.argv) < 3:
        sys.exit("用法: python publish-release.py <资产路径> <说明md路径> [资产显示名]")
    asset = os.path.abspath(sys.argv[1])
    notes = os.path.abspath(sys.argv[2])
    display_name = sys.argv[3] if len(sys.argv) > 3 else os.path.basename(asset)

    global REPO, TAG, TOKEN, TARGET
    if not REPO:
        REPO = detect_repo()
    if not TAG:
        TAG = detect_tag()
    if not TOKEN:
        TOKEN = fetch_token()
    if not TARGET:
        TARGET = detect_branch()

    if not REPO:
        sys.exit("无法确定仓库（GH_REPO 未设且 git remote 无 github.com origin）")
    if not TAG:
        sys.exit("无法确定标签（GH_TAG 未设且无 git tag）")
    if not os.path.isfile(asset):
        sys.exit(f"资产不存在: {asset}")
    if not os.path.isfile(notes):
        sys.exit(f"说明文件不存在: {notes}")

    print(f"仓库={REPO}  标签={TAG}  目标={TARGET}  draft={DRAFT} prerelease={PRERELEASE}")
    print(f"资产={asset}\n说明={notes}")

    body = _read_text(notes)

    # ---- 0) DRY-RUN：只打印将要执行的动作，不触碰 GitHub ----
    if DRY_RUN:
        size = os.path.getsize(asset)
        print("\n[DRY-RUN] 以下动作【不会】真正执行：")
        print(f"  POST /repos/{REPO}/releases")
        print(f"    tag_name   = {TAG}")
        print(f"    target     = {TARGET}")
        print(f"    name       = {display_name}")
        print(f"    draft      = {DRAFT}  prerelease = {PRERELEASE}")
        print(f"    body 长度  = {len(body)} 字符")
        print(f"  UPLOAD 资产  = {display_name}  ({size} bytes)")
        print("  （设置 GH_DRY_RUN=0 或清除该变量后重跑即可真正发布）")
        return

    if len(TOKEN) < 20:
        sys.exit("GH_TOKEN 缺失（git 凭据库里也没有 github.com 凭证）")

    # ---- 1) 创建 Release（已存在则复用）----
    st, resp = api(f"/repos/{REPO}/releases", {
        "tag_name": TAG,
        "target_commitish": TARGET,
        "name": display_name,
        "body": body,
        "draft": DRAFT,
        "prerelease": PRERELEASE,
    })
    if st not in (200, 201) and st not in (409, 422):
        print("create release 失败:", st, json.dumps(resp, ensure_ascii=False)[:800])
        sys.exit(1)

    if isinstance(resp, dict) and "upload_url" in resp:
        release = resp
    else:
        # 创建冲突 → 按 tag 拉取已有 Release
        release = get_existing_release_by_tag(TAG)
        if not release:
            print("无法获取已有 Release，退出。", json.dumps(resp, ensure_ascii=False)[:400])
            sys.exit(1)
    print("release id:", release.get("id"), "html:", release.get("html_url"))

    # ---- 2) 上传资产（已存在则跳过）----
    assets = release.get("assets") or []
    already = {a.get("name") for a in assets}
    if display_name in already:
        print("资产已存在，跳过上传:", display_name)
        return

    upload_url = release["upload_url"].split("{")[0] + "?name=" + urllib.parse.quote(display_name)
    size = os.path.getsize(asset)
    data = open(asset, "rb").read()
    print("上传中", display_name, f"{size} bytes ...")
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(
                upload_url, data=data, method="POST",
                headers={
                    "Authorization": "Bearer " + TOKEN,
                    "Accept": "application/vnd.github+json",
                    "User-Agent": "publish-release",
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(size),
                })
            with urllib.request.urlopen(req, timeout=1800) as r:
                j = json.loads(r.read().decode("utf-8"))
                print("资产上传完成:", r.status, j.get("name"), j.get("size"), j.get("browser_download_url"))
            return
        except Exception as e:
            last = e
            print(f"  上传第 {attempt + 1} 次失败: {str(e)[:200]}")
            time.sleep(15)
    sys.exit(f"资产上传失败: {last}")


if __name__ == "__main__":
    main()
