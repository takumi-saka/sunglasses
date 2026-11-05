"""ページの画の処理（ブラウザで描いた PNG）と、パソコンの道具の式で描いた画の、色の差を測る（2026-11-05）。

同じ RAW を同じ設定で読み（rawpy。ページの LibRaw と一致を確かめ済み）、同じ露光量で、
  lut      … 核の対応表だけ
  nograin  … 対応表 ＋ やわらかさ・にじみ・白み（粒なし）
  neutral  … 素直な現像
をパソコンの道具（look_lr.base_image・lr_apply）で描き、ページの画と比べる。
あわせて、露光量の自動合わせの違いを、本人に見せてきた作り方（1.85:1 に切り、白み・にじみまでかけた画で測る）と比べる。
使い方: python -I dev/compare.py <カメラアプリの _work> <RAW のファイル> <check.mjs の書き出し先>
"""
import json
import sys
from pathlib import Path

import colour
import numpy as np
import rawpy
from PIL import Image

work, dng, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
sys.path.insert(0, str(work / "scripts"))
import look_lr as lr  # noqa: E402
import look_search as ls  # noqa: E402
from base_vs_aftersun import crop_185  # noqa: E402

res = json.loads((out / "結果.json").read_text(encoding="utf-8"))
looks = json.loads((Path(__file__).resolve().parents[1] / "web/looks/looks.json").read_text(encoding="utf-8"))
core = {c["id"]: c for c in looks["cores"]}
CUBE = {"aftersun": "Aftersun.cube", "mine": "自分の好み.cube", "weak": "Aftersun弱め.cube"}
JSONS = {"aftersun": "段6/核_昼.json", "mine": "段6/核_自分の好み_昼.json", "weak": "段6/核_Aftersun弱め_昼.json"}

with rawpy.imread(str(dng)) as raw:
    cam = np.array(raw.camera_whitebalance[:3], dtype=float)
    wb = {"use_camera_wb": True} if cam.min() > 0 and cam.max() / cam.min() > 1.3 else \
         {"user_wb": list(raw.daylight_whitebalance[:3]) + [raw.daylight_whitebalance[1]]}
    aces = raw.postprocess(gamma=(1, 1), no_auto_bright=True, output_bps=16, half_size=False,
                           output_color=rawpy.ColorSpace.ACES, **wb).astype(np.float32) / 65535.0
H, W = aces.shape[:2]
f = W // 1024
small = aces[: H // f * f, : W // f * f].reshape(H // f, f, W // f, f, 3).mean((1, 3))
key = res["key"]
luts = {k: colour.read_LUT(str(work / "アプリ用" / v)) for k, v in CUBE.items()}


def lab(x):
    return ls.rgb2lab(np.asarray(x, np.float32))


print("■ 色の差（ΔE。ページの画とパソコンの道具の画。同じ読み込み・同じ露光量）")
print(f"{'核':<9}{'段':<9}{'真ん中':>7}{'上位5%':>8}{'上位1%':>8}{'明るさの差の平均':>12}")
for r in res["results"]:
    if r["kind"] == "full":
        continue
    if r["kind"] != "knobs":
        got = np.asarray(Image.open(out / f"{r['core']}_{r['kind']}.png").convert("RGB"), np.float32) / 255
    if r["kind"] == "knobs":  # つまみを動かした画: パソコンの道具の lr_apply に、同じつまみ（Lightroom の名前）と核のぼかし系を渡す
        got = np.asarray(Image.open(out / f"{r['core']}_knobs_{r['tag']}.png").convert("RGB"), np.float32) / 255
        c = core[r["core"]]
        ref = lr.base_image(small, 0.18 / key * 2 ** (r["ev"] + r["params"].get("exposure", 0)), luts[r["core"]])
        ref = lr.lr_apply(ref, {"Soften": c["soften"], "Halation": c["halation"], "Bloom": c["bloom"], "BloomWarm": c["bloomWarm"], **r["py"]})
        lg, lf = lab(got), lab(ref)
        d = np.linalg.norm(lg - lf, axis=-1)
        print(f"{r['core']:<9}{r['tag']:<9}{np.median(d):7.2f}{np.percentile(d, 95):8.2f}{np.percentile(d, 99):8.2f}{float((lg[..., 0] - lf[..., 0]).mean()):12.2f}")
        continue
    if r["kind"] == "neutral":
        ref = lr.base_image(small, 0.18 / key * 2 ** r["evNeutral"], None)
    else:
        ref = lr.base_image(small, 0.18 / key * 2 ** r["ev"], luts[r["core"]])
        if r["kind"] == "nograin":
            c = core[r["core"]]
            ref = lr.lr_apply(ref, {"Soften": c["soften"], "Halation": c["halation"], "Bloom": c["bloom"], "BloomWarm": c["bloomWarm"]})
    lg, lf = lab(got), lab(ref)
    d = np.linalg.norm(lg - lf, axis=-1)
    print(f"{r['core']:<9}{r['kind']:<9}{np.median(d):7.2f}{np.percentile(d, 95):8.2f}{np.percentile(d, 99):8.2f}{float((lg[..., 0] - lf[..., 0]).mean()):12.2f}")

if any(r["kind"] == "knobs" for r in res["results"]):
    sys.exit(0)
print("\n■ 粒（粒あり − 粒なしの明るさの揺れ。標準偏差、L*）")
for c in ("aftersun", "mine", "weak"):
    a = lab(np.asarray(Image.open(out / f"{c}_full.png").convert("RGB"), np.float32) / 255)[..., 0]
    b = lab(np.asarray(Image.open(out / f"{c}_nograin.png").convert("RGB"), np.float32) / 255)[..., 0]
    print(f"{c:<9}{float((a - b).std()):.3f}")

print("\n■ 露光量（本人に見せてきた作り方との差。段。＋ならページの方が明るい）")
lr._init(work)
T = lr._W["targets"]["昼・日なた"]["明るさ 50%"]["中央値"]
half = rawpy.imread(str(dng))
a768 = lr.decode_full(dng, 768)  # 本人に見せてきた作り方: 半分の大きさで読み、1.85:1 に切る
k768 = lr.key_of(a768)
sm768 = lr.resize_float(a768, lr.MATCH_W)
full160 = lr.resize_float(aces, lr.MATCH_W)
kfull = lr.key_of(full160)
crop160 = lr.resize_float(crop_185(aces), lr.MATCH_W)
kcrop = lr.key_of(crop160)
print(f"{'核':<9}{'ページ':>8}{'切らない・表だけ':>14}{'切る・表だけ':>12}")
for r in res["results"]:
    if r["kind"] != "lut":
        continue
    cid = r["core"]
    cand = json.loads((work / JSONS[cid]).read_text(encoding="utf-8"))
    base = lr.lut_for(cand, "昼・日なた")
    ref_ev = lr.match_ev(sm768, cand, k768, base, T)
    g_ref = np.log2(0.18 / k768) + ref_ev
    lut_only = {"モデル": None, "設定": {}, "明るさの上乗せ": cand.get("明るさの上乗せ", 0.0)}

    def ev_lut(sm, kk):
        lo, hi = -6.0, 6.0
        for _ in range(9):
            mid = (lo + hi) / 2
            img = lr.base_image(sm, 0.18 / kk * 2 ** mid, luts[cid])
            if np.median(ls.rgb2lab(img)[..., 0]) < T + lut_only["明るさの上乗せ"]:
                lo = mid
            else:
                hi = mid
        return (lo + hi) / 2

    g_page = np.log2(0.18 / key) + r["ev"]
    g_full = np.log2(0.18 / kfull) + ev_lut(full160, kfull)
    g_crop = np.log2(0.18 / kcrop) + ev_lut(crop160, kcrop)
    print(f"{cid:<9}{g_page - g_ref:8.3f}{g_full - g_ref:14.3f}{g_crop - g_ref:12.3f}")
