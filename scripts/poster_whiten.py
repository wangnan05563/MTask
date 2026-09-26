"""Normalize a generated line-art poster to a pure-white background.

The image model reliably renders a faint warm-gray "paper" background.
Line art is high-contrast (near-black strokes on light field), so a
levels adjustment that maps the light field to pure #FFFFFF and deepens
the strokes restores the intended clean-white poster look.
"""
import os
import sys
from PIL import Image

SRC = r"d:\code\otherProjects\26_MTask\generated-images\Vertical_poster__2_3_ratio___T_2026-09-19T00-03-24.png"
OUT_DIR = r"D:\code\otherProjects\26_MTask\outputs"
OUT = os.path.join(OUT_DIR, "life-home-tokyo-techou-poster.png")

im = Image.open(SRC).convert("RGB")
w, h = im.size
px = im.load()

corners = {
    "TL": (3, 3),
    "TR": (w - 4, 3),
    "BL": (3, h - 4),
    "BR": (w - 4, h - 4),
    "midtop": (w // 2, 3),
    "midleft": (3, h // 2),
}
print("size:", w, h)
for k, p in corners.items():
    print(k, p, px[p])


def lut(bp, wp):
    table = []
    for i in range(256):
        v = (i - bp) / float(wp - bp) * 255.0
        v = 0 if v < 0 else (255 if v > 255 else int(round(v)))
        table.append(v)
    return table * 3  # apply same LUT to R, G and B


# Push the light field to pure white while keeping strokes solid black.
WHITE_POINT = 230
BLACK_POINT = 34
out = im.point(lut(BLACK_POINT, WHITE_POINT))

os.makedirs(OUT_DIR, exist_ok=True)
out.save(OUT)

# report the new corner values (should be 255,255,255)
px2 = out.load()
print("after:", [px2[p] for p in corners.values()])
print("saved:", OUT)
print("python:", sys.version.split()[0])
