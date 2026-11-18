#!/usr/bin/env python3
"""T06016：把 11 张 2048 源图标统一裁切/缩放为一致的 512 输出。

问题：原生成图的透明画布内，彩色圆角方块占比不同（最大边长 1207~1902 像素），
直接缩到 512 接入同一 30px 图标容器后，视觉上会出现“有的图标大、有的图标小”。

做法：按 alpha 非透明边界裁切，保持宽高比缩放到固定内容区（默认 400/512，
即约 78%），再居中放入透明画布。这样所有图标在同一容器内视觉尺寸一致。

用法：
  python scripts/normalize-report-icons.py           # 重新生成
  python scripts/normalize-report-icons.py --check   # 只校验，不改文件
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "docs" / "t06016" / "icons"
WEB_DIR = ROOT / "web" / "src" / "assets" / "report-icons"
DOCS_512_DIR = SOURCE_DIR

KEYS = [
    "ai-import",
    "offline",
    "ai-live",
    "prd-gen",
    "prd-import",
    "tc-gen",
    "kickoff-ppt",
    "summary-ppt",
    "review-lecture",
    "git-extract",
    "sonar-scan",
]

CANVAS = 512
CONTENT = 400
TOLERANCE = 1


def alpha_bbox(im: Image.Image) -> tuple[int, int, int, int]:
    bbox = im.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("图标没有非透明像素")
    return bbox


def normalized(im: Image.Image) -> Image.Image:
    bbox = alpha_bbox(im)
    crop = im.crop(bbox)
    scale = CONTENT / max(crop.size)
    size = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
    resized = crop.resize(size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((CANVAS - size[0]) // 2, (CANVAS - size[1]) // 2))
    return canvas


def check(path: Path) -> tuple[int, int, int, int]:
    im = Image.open(path).convert("RGBA")
    if im.size != (CANVAS, CANVAS):
        raise ValueError(f"{path.name}: 期望 {CANVAS}x{CANVAS}，实际 {im.size}")
    bbox = alpha_bbox(im)
    max_side = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
    if abs(max_side - CONTENT) > TOLERANCE:
        raise ValueError(f"{path.name}: 内容最大边 {max_side}px，期望 {CONTENT}px ±{TOLERANCE}")
    return bbox


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="只校验，不写入文件")
    args = parser.parse_args()

    failures: list[str] = []
    for key in KEYS:
        src_2048 = SOURCE_DIR / f"{key}.png"
        web = WEB_DIR / f"{key}.png"
        docs_512 = DOCS_512_DIR / f"{key}-512.png"
        # 优先用 2048 母版保证画质；干净检出没有 docs 母版时回退已接入的 512 资产，
        # 归一化本身是幂等的，仍可复现并校验同一结果。
        src = src_2048 if src_2048.exists() else web
        if not src.exists():
            failures.append(f"{key}: 缺少源图 {src_2048} / {web}")
            continue
        im = Image.open(src).convert("RGBA")
        if im.size not in {(2048, 2048), (CANVAS, CANVAS)}:
            failures.append(f"{key}: 源图尺寸应为 2048x2048 或 {CANVAS}x{CANVAS}，实际 {im.size}")
            continue
        if not args.check:
            out = normalized(im)
            web.parent.mkdir(parents=True, exist_ok=True)
            out.save(web, "PNG", optimize=True)
            if DOCS_512_DIR.exists():
                out.save(docs_512, "PNG", optimize=True)
        for path in (web, docs_512):
            if path == docs_512 and not DOCS_512_DIR.exists():
                continue
            if not path.exists():
                failures.append(f"{key}: 缺少输出 {path}")
                continue
            try:
                bbox = check(path)
                print(f"[OK] {key:14s} {path.relative_to(ROOT)} bbox={bbox}")
            except Exception as exc:  # noqa: BLE001 - 输出统一失败原因
                failures.append(f"{key}: {exc}")

    if failures:
        print("\n[T06016 图标归一化] 失败：", file=sys.stderr)
        for failure in failures:
            print(f" - {failure}", file=sys.stderr)
        return 1
    print(f"\n[T06016 图标归一化] {len(KEYS)} 张图标全部一致（内容区 {CONTENT}/{CANVAS}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
