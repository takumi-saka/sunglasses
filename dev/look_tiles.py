# ルックの見本の画（dev/look_samples.mjs が撮った写真の画）の真ん中を四角に切り、204px の JPEG にする
# 使い方: uv run --with pillow python dev/look_tiles.py <撮った画のフォルダ> <web/looks/tiles>
import sys, os, glob
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
for p in sorted(glob.glob(src + "/*.png")):
    im = Image.open(p).convert("RGB")
    s = min(im.size)
    im = im.crop(((im.width - s) // 2, (im.height - s) // 2, (im.width + s) // 2, (im.height + s) // 2)).resize((204, 204), Image.LANCZOS)
    dst = os.path.join(out, os.path.splitext(os.path.basename(p))[0] + ".jpg")
    im.save(dst, quality=88, optimize=True)
    print(dst, os.path.getsize(dst))
