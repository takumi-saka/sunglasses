"""核の色の対応表と設定を、ページで読む形にする（2026-11-05）。

読むもの（カメラアプリの作業フォルダ _work/ の中）:
  アプリ用/{Aftersun,自分の好み,Aftersun弱め}.cube   … look_bake.py で焼いた 65³ の対応表（入口は ACEScct）
  アプリ用/アプリの設定.json                           … 露光量の目安・核ごとの明るさの上乗せ・まわりを見る処理
  段6/核_*.json                                        … 白みのあたたかさ（BloomWarm）
書くもの（web/looks/）:
  {id}.bin    … 対応表。半精度の浮動小数点の RGB、赤がいちばん速く変わる順（.cube と同じ）
  looks.json  … 核の一覧と値、素直な現像の曲線、色の変換の行列、JPEG を光の量に戻す曲線
使い方: python -I tools/make_looks.py <_work のフォルダ> <web/looks のフォルダ>
"""
import json
import sys
from pathlib import Path

import numpy as np

CORES = [  # id, 画面に出す名前, 対応表, 核の元の設定, ひとこと
    ("aftersun", "Aftersun", "Aftersun.cube", "段6/核_昼.json", "映画の色に一番寄せた核"),
    ("mine", "自分の好み", "自分の好み.cube", "段6/核_自分の好み_昼.json", "本人の直しから学んだ核（青緑を抜いて、やわらかく）"),
    ("weak", "Aftersun 弱め", "Aftersun弱め.cube", "段6/核_Aftersun弱め_昼.json", "Aftersun の色付けを弱くした核"),
]


def read_cube(path):
    lo, hi, n, rows = [0.0] * 3, [1.0] * 3, 0, []
    for line in path.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or t.startswith("TITLE"):
            continue
        if t.startswith("LUT_3D_SIZE"):
            n = int(t.split()[1])
        elif t.startswith("DOMAIN_MIN"):
            lo = [float(v) for v in t.split()[1:4]]
        elif t.startswith("DOMAIN_MAX"):
            hi = [float(v) for v in t.split()[1:4]]
        else:
            rows.append([float(v) for v in t.split()[:3]])
    data = np.asarray(rows, np.float32)
    assert data.shape == (n * n * n, 3), (path, data.shape, n)
    return n, lo, hi, data


def main(work, out):
    work, out = Path(work), Path(out)
    out.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(work / "scripts"))
    import look_lr as lr  # noqa: E402  パソコンの道具と同じ数字を使う

    setting = json.loads((work / "アプリ用/アプリの設定.json").read_text(encoding="utf-8"))
    cores = []
    for cid, name, cube, src, desc in CORES:
        n, lo, hi, data = read_cube(work / "アプリ用" / cube)
        (out / f"{cid}.bin").write_bytes(data.astype("<f2").tobytes())
        jp = {"Aftersun.cube": "Aftersun", "自分の好み.cube": "自分の好み", "Aftersun弱め.cube": "Aftersun弱め"}[cube]
        s = setting["核"][jp]
        sp = s["まわりを見る処理"]
        full = json.loads((work / src).read_text(encoding="utf-8"))["設定"]
        cores.append({
            "id": cid, "name": name, "desc": desc, "file": f"{cid}.bin", "size": n, "lo": lo, "hi": hi,
            "lift": float(s["明るさの上乗せ"]),
            "halation": float(sp.get("Halation", 0)), "bloom": float(sp.get("Bloom", 0)),
            "bloomWarm": float(full.get("BloomWarm", 1.0)), "soften": float(sp.get("Soften", 0)),
            "grain": float(sp.get("GrainAmount", 0)), "grainSize": float(sp.get("GrainSize", 25)),
            "texture": float(sp.get("Texture", 0)), "clarity": float(sp.get("Clarity", 0)),
            "vignette": float(sp.get("VignetteAmount", 0)),
        })
    x = np.linspace(0, 1, 1024, dtype=np.float32)
    looks = {
        "version": 1,
        "targetL": float(setting["露光量の目安（真ん中の明るさ L*）"]),
        "cores": cores,
        "ap0ToAp1": np.asarray(lr.AP0_TO_AP1_F, np.float64).round(10).tolist(),
        "ap0ToSrgb": np.asarray(lr.AP0_TO_SRGB, np.float64).round(10).tolist(),
        "srgbToAp0": np.asarray(lr.SRGB_TO_AP0, np.float64).round(10).tolist(),
        # 素直な現像: sRGB の光の量 → 明るい所の肩 → sRGB の曲線 → 中くらいのコントラストの曲線（1025 点、0〜1 を等分）
        "neutralCurve": [round(float(v), 7) for v in lr.DIGITAL_CURVE[1]],
        # JPEG の値（0〜1 を 1024 等分）→ sRGB の光の量（素直な現像の逆）
        "jpegToLinear": [round(float(v), 7) for v in lr.inv_digital(np.stack([x, x, x], -1))[..., 0]],
    }
    (out / "looks.json").write_text(json.dumps(looks, ensure_ascii=False, indent=1), encoding="utf-8")
    for c in cores:
        print(c["id"], c["name"], "上乗せ", c["lift"], "にじみ", c["halation"], "白み", c["bloom"], "あたたかさ", c["bloomWarm"],
              "やわらかさ", c["soften"], "粒", c["grain"], c["grainSize"])


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
