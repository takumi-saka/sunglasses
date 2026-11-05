"""確かめ用の写真の一覧と小さな画を作る（2026-11-05）。出力は dev/_data/（公開の置き場には入れない）。
RAW の中の見本の画を取り出し、長い辺 384 に縮める（スマホの一覧の小さな画の代わり）。
使い方: python -I dev/make_data.py <RAW のフォルダ> <dev/_data>
"""
import io
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import rawpy
from PIL import Image, ImageOps

src, out = Path(sys.argv[1]), Path(sys.argv[2])
(out / "thumbs").mkdir(parents=True, exist_ok=True)
items = []
for i, p in enumerate(sorted(src.glob("*.dng"))):
    with rawpy.imread(str(p)) as raw:
        t = raw.extract_thumb()
        sizes = raw.sizes
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(t.data))).convert("RGB") if t.format == rawpy.ThumbFormat.JPEG else Image.fromarray(t.data)
    im.thumbnail((384, 384), Image.LANCZOS)
    im.save(out / "thumbs" / (p.stem + ".jpg"), quality=88)
    m = re.search(r"(\d{8})_(\d{6})", p.name)
    taken = int(datetime.strptime("".join(m.groups()), "%Y%m%d%H%M%S").timestamp() * 1000) if m else 0
    items.append({"id": i + 1, "volume": "external_primary", "name": p.name, "dateTaken": taken, "dateModified": int(p.stat().st_mtime),
                  "size": p.stat().st_size, "width": sizes.width, "height": sizes.height, "folder": "DCIM/Camera/Raw/"})
items.sort(key=lambda x: -x["dateTaken"])
(out / "list.json").write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
print(len(items), "枚")
