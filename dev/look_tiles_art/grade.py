# 絵にルックごとの色の向きを付ける（本物のルックではなく、違いが小さな画でも分かるように強めた目印）
import sys, numpy as np
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
G = {  # 彩度, 明るさ, 明暗, 全体の色のかたより, 影に足す色, 明るい所に掛ける色, 黒の持ち上げ
    "cinema":    (.62, .86, 1.10, (1.00, 1.00, 1.00), (.00, .055, .075), (1.05, 1.00, .90), .00),
    "aftersun3": (.88, 1.03, .90, (1.04, 1.00, .93), (.06, .035, .00), (1.04, 1.00, .92), .07),
    "deepblue":  (.80, 1.00, 1.00, (.84, .97, 1.17), (.00, .02, .09), (.97, 1.00, 1.05), .02),
    "aqua":      (.80, 1.02, .98, (.82, 1.07, 1.05), (.00, .06, .06), (.96, 1.03, 1.02), .03),
    "warm":      (1.05, .98, 1.02, (1.13, .98, .72), (.06, .02, .00), (1.05, .99, .88), .01),
}
for name in ["softcream", "beach", "orbs"]:
    a = np.asarray(Image.open(f"{src}/illust_{name}.jpg").convert("RGB").resize((408, 408), Image.LANCZOS)).astype(np.float32) / 255
    for lk, (sat, gain, con, bal, sh, hi, lift) in G.items():
        x = a * np.array(bal, np.float32)
        lum = (x * np.array([.2126, .7152, .0722], np.float32)).sum(-1, keepdims=True)
        x = lum + (x - lum) * sat
        x = (x - .5) * con + .5
        x = x * gain
        l2 = np.clip(lum, 0, 1)
        x = x + np.array(sh, np.float32) * (1 - l2) ** 2
        x = x * (1 + (np.array(hi, np.float32) - 1) * l2)
        x = lift + x * (1 - lift)
        Image.fromarray((np.clip(x, 0, 1) * 255 + .5).astype(np.uint8)).save(f"{out}/{name}__{lk}.png")
print("ok")
