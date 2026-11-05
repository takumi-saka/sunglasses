"""サングラスのアイコンを作る（2026-11-05）。黒地に、夕方の海を映したレンズのサングラス。

Android のアイコン（前景の層）を5つの大きさで書き出す。背景の色は res/values/colors.xml の黒。
使い方: python -I tools/make_icon.py <android/app/src/main/res> [見本の PNG の書き出し先]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

S = 1728  # xxxhdpi（432 画素）の 4 倍で描いて縮める
DENS = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
FRAME = (242, 234, 220, 255)
TOP, MID, BOTTOM = (52, 150, 143), (20, 62, 66), (231, 164, 94)  # 空の青緑 → 暗い海 → 夕日


def gradient(w, h):
    g = Image.new("RGBA", (w, h))
    px = g.load()
    for y in range(h):
        t = y / (h - 1)
        a, b, u = (TOP, MID, t / 0.55) if t < 0.55 else (MID, BOTTOM, (t - 0.55) / 0.45)
        c = tuple(round(a[i] + (b[i] - a[i]) * u) for i in range(3)) + (255,)
        for x in range(w):
            px[x, y] = c
    return g


def draw():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w, h, gap, r = 500, 380, 120, 150
    cx, cy = S // 2, 880
    y0, y1 = cy - h // 2, cy + h // 2
    lenses = [(cx - gap // 2 - w, y0, cx - gap // 2, y1), (cx + gap // 2, y0, cx + gap // 2 + w, y1)]
    # 枠と、レンズをつなぐ橋
    for x0, _, x1, _ in lenses:
        d.rounded_rectangle((x0 - 24, y0 - 24, x1 + 24, y1 + 24), radius=r + 24, fill=FRAME)
    d.rounded_rectangle((cx - gap // 2 - 30, y0 + 36, cx + gap // 2 + 30, y0 + 80), radius=20, fill=FRAME)
    # レンズ（夕方の海を映した色）と、ななめの光の筋
    for x0, _, x1, _ in lenses:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle((x0, y0, x1, y1), radius=r, fill=255)
        layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        layer.paste(gradient(x1 - x0, y1 - y0), (x0, y0))
        img.paste(layer, (0, 0), mask)
        shine = Image.new("L", (S, S), 0)
        ImageDraw.Draw(shine).polygon([(x0 + 70, y0), (x0 + 190, y0), (x0, y0 + 250), (x0, y0 + 130)], fill=70)
        shine = Image.fromarray(np.minimum(np.asarray(shine), np.asarray(mask)))
        img.paste(Image.new("RGBA", (S, S), (255, 255, 255, 255)), (0, 0), shine)
    return img


def main(res_dir, preview=None):
    img = draw()
    res = Path(res_dir)
    for name, size in DENS.items():
        out = res / f"mipmap-{name}"
        out.mkdir(parents=True, exist_ok=True)
        img.resize((size, size), Image.LANCZOS).save(out / "ic_launcher_foreground.png")
    if preview:
        bg = Image.new("RGBA", (S, S), (11, 11, 11, 255))
        bg.alpha_composite(img)
        m = Image.new("L", (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, S - 1, S - 1), radius=S // 4, fill=255)
        out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        out.paste(bg, (0, 0), m)
        out.resize((512, 512), Image.LANCZOS).save(preview)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
