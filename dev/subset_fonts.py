# -*- coding: utf-8 -*-
"""アプリに同梱する書体を、アプリで使う字だけに小分けする（2026-11-06）。

- 字: Zen Kaku Gothic New（400・500・700）→ web/fonts/sg-gothic-{400,500,700}.woff2（書体の名前は SG Gothic）
- 数字: IBM Plex Mono（400・500・600）→ web/fonts/sg-mono-{400,500,600}.woff2（書体の名前は SG Mono）
  IBM Plex は「Plex」の名前が予約されている（SIL OFL 1.1）。小分けは手を加えたことになるので、名前を変えて同梱する。
  Zen Kaku Gothic New に予約された名前は無いが、そろえて名前を変える。どちらもライセンスの文を web/fonts/ に置く。
- 使う字は、web/ の html・js・css と、APK の Java（画面に出す知らせ）から集める。ひらがな・カタカナは全部入れる。
  画面に新しい字を足したら、もう一度回す（入っていない字は、端末の書体で出る）。

使い方（fontTools と brotli が要る）:
  python dev/subset_fonts.py <元の ttf と OFL の txt を置いたフォルダ>
  元のファイル: ZenKakuGothicNew-{Regular,Medium,Bold}.ttf・OFL_ZenKakuGothicNew.txt、
               IBMPlexMono-{Regular,Medium,SemiBold}.ttf・OFL_IBMPlexMono.txt
               （github.com/google/fonts の ofl/zenkakugothicnew と ofl/ibmplexmono）
"""
import pathlib
import shutil
import sys

from fontTools import subset

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "fonts"

GOTHIC = [("Regular", 400, "Regular"), ("Medium", 500, "Medium"), ("Bold", 700, "Bold")]
MONO = [("Regular", 400, "Regular"), ("Medium", 500, "Medium"), ("SemiBold", 600, "SemiBold")]

ASCII = "".join(chr(c) for c in range(0x20, 0x7F))
# 画面に出しうる記号（文の中の記号・矢印・単位）
SYMBOLS = "　、。・，．：；？！゛゜´｀¨＾￣＿ヽヾゝゞ〃仝々〆〇ー―‐／＼～∥｜…‥‘’“”（）〔〕［］｛｝〈〉《》「」『』【】＋－±×÷＝≠＜＞≦≧∞∴♂♀°′″℃￥＄￠￡％＃＆＊＠§☆★○●◎◇◆□■△▲▽▼※〒→←↑↓〓−–—•·⁄"
KANA = "".join(chr(c) for c in range(0x3041, 0x3097)) + "".join(chr(c) for c in range(0x30A1, 0x30FB)) + "ー"
MONO_EXTRA = "−×±°·…•→←↑↓∞′″’“”"


def used_chars():
    text = []
    for pat in ("web/**/*.html", "web/**/*.js", "web/**/*.css", "android/app/src/main/java/**/*.java"):
        for p in ROOT.glob(pat):
            if "/fonts/" in str(p):
                continue
            text.append(p.read_text(encoding="utf-8", errors="ignore"))
    return {ch for ch in "".join(text) if ord(ch) > 0x7F}


def rename(font, family, style):
    ps = family.replace(" ", "") + "-" + style.replace(" ", "")
    for rec in font["name"].names:
        if rec.nameID in (1, 16):
            rec.string = family
        elif rec.nameID in (2, 17):
            rec.string = style
        elif rec.nameID == 4:
            rec.string = family + " " + style
        elif rec.nameID == 6:
            rec.string = ps
        elif rec.nameID == 3:
            rec.string = ps + ";sunglasses-subset"


def make(src_dir, prefix, family, faces, chars, ofl_name):
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    opts.hinting = False
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    codes = sorted({ord(c) for c in chars})
    for style_file, weight, style in faces:
        src = src_dir / f"{prefix}-{style_file}.ttf"
        font = subset.load_font(str(src), opts)
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=codes)
        sub.subset(font)
        rename(font, family, style)
        out = OUT / f"{family.lower().replace(' ', '-')}-{weight}.woff2"
        subset.save_font(font, str(out), opts)
        print(out.name, out.stat().st_size, "バイト", len(codes), "字")
    shutil.copy(src_dir / ofl_name, OUT / ofl_name.replace("OFL_", "OFL-"))


def main():
    src_dir = pathlib.Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    gothic = set(ASCII) | set(SYMBOLS) | set(KANA) | used_chars()
    make(src_dir, "ZenKakuGothicNew", "SG Gothic", GOTHIC, gothic, "OFL_ZenKakuGothicNew.txt")
    make(src_dir, "IBMPlexMono", "SG Mono", MONO, set(ASCII) | set(MONO_EXTRA), "OFL_IBMPlexMono.txt")


if __name__ == "__main__":
    main()
