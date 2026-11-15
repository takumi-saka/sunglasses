"""サングラスのアイコンを作る（2026-11-15 描き直し）。青緑の空の下、水平線に沈む日食と、水面に映る橙の光。

Android のアイコン（前景の層）を 5 つの大きさで書き出す。画は前景 1 枚で地まで塗ってあり、
見えるのは真ん中の 3 分の 2（丸や角丸に切られる）。外側には空と海をそのまま伸ばしてある。
使い方: python -I tools/make_icon.py <android/app/src/main/res> [見本の PNG の書き出し先]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

S = 3456  # xxxhdpi（432 画素）の 8 倍で描いて縮める
DENS = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
K = S / 768  # 図案は 512 の方眼。全体 768 の真ん中に置く（まわり 128 ずつが切られる余白）
OFF = 128
SKY_TOP, SKY_LOW, SEA = (20, 57, 54), (42, 102, 96), (6, 19, 18)
ORANGE, DEEP, BLACK = (240, 168, 80), (200, 100, 42), (5, 5, 5)
HORIZON, SUN_R, GLOW_R = 318, 118, 118 * 1.42
REFLECT = ((336, 250, 0.8), (358, 190, 0.6), (380, 130, 0.45), (402, 80, 0.3))  # 上の端・幅・濃さ


def mix(a, b, t):
    t = np.clip(t, 0, 1)[..., None]
    return np.asarray(a, np.float32) * (1 - t) + np.asarray(b, np.float32) * t


def draw():
    y, x = np.mgrid[0:S, 0:S].astype(np.float32)
    x, y = (x + 0.5) / K - OFF, (y + 0.5) / K - OFF  # 図案の方眼での位置
    img = mix(SKY_TOP, SKY_LOW, y / (512 * 0.62))  # 空: 上が暗い青緑、水平線へ明るく
    # 光の輪: 内側は橙、外へ深い橙になって消える
    t = np.hypot(x - 256, y - HORIZON) / GLOW_R
    col = mix(ORANGE, DEEP, (t - 0.72) / 0.14)
    alpha = np.where(t < 0.72, 1, np.where(t < 0.86, 1 - 0.45 * (t - 0.72) / 0.14, 0.55 * (1 - t) / 0.14))
    alpha = np.clip(alpha, 0, 1)[..., None]
    img = img * (1 - alpha) + col * alpha
    # 黒い太陽（縁は 1 画素ぶんぼかす）
    edge = np.clip((SUN_R - np.hypot(x - 256, y - HORIZON)) * K + 0.5, 0, 1)[..., None]
    img = img * (1 - edge) + np.asarray(BLACK, np.float32) * edge
    img[y >= HORIZON] = SEA  # 水平線から下は海
    out = Image.fromarray(np.clip(img + 0.5, 0, 255).astype(np.uint8)).convert("RGBA")
    # 水面に映る光: 下へ行くほど短く、薄くなる横線
    for top, w, a in REFLECT:
        layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        box = [round((v + OFF) * K) for v in (256 - w / 2, top, 256 + w / 2, top + 7)]
        ImageDraw.Draw(layer).rounded_rectangle(box, radius=round(3.5 * K), fill=ORANGE + (round(255 * a),))
        out.alpha_composite(layer)
    return out


def main(res_dir, preview=None):
    img = draw()
    res = Path(res_dir)
    for name, size in DENS.items():
        out = res / f"mipmap-{name}"
        out.mkdir(parents=True, exist_ok=True)
        img.resize((size, size), Image.LANCZOS).save(out / "ic_launcher_foreground.png")
    if preview:  # 見える範囲（真ん中の 3 分の 2）を、角丸と丸に切って並べる
        a = round(OFF * K)
        vis = img.crop((a, a, S - a, S - a)).resize((512, 512), Image.LANCZOS)
        sheet = Image.new("RGBA", (1104, 592), (32, 36, 43, 255))
        for i, rad in enumerate((116, 256)):
            m = Image.new("L", (2048, 2048), 0)
            ImageDraw.Draw(m).rounded_rectangle((0, 0, 2047, 2047), radius=rad * 4, fill=255)
            sheet.paste(vis, (40 + 552 * i, 40), m.resize((512, 512), Image.LANCZOS))
        sheet.save(preview)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
