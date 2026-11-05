# サングラス

スマホで撮った RAW（DNG）を、映画『Aftersun』のような色と質感に仕上げる、自分用の写真のアプリ。

- アプリの中身（画面と画の処理）はページ: https://takumi-saka.github.io/sunglasses/
- スマホに入れるファイル（APK）: https://github.com/takumi-saka/sunglasses/releases/download/app-latest/sunglasses.apk
  - APK はページを開くだけの作りなので、ページを新しくすれば、アプリは開き直すだけで新しい版になる。

## 置き場の中身

| 場所 | 中身 |
|---|---|
| `web/` | ページ（画面と画の処理）。main に入れると GitHub Pages に出る |
| `android/` | ページを開く APK と、スマホの機能の窓口（写真の一覧・読み込み・保存・共有・振動） |
| `wasm/` | RAW を読む部品（LibRaw）をページで動く形にする作り方 |
| `.github/workflows/` | ページを出す仕組みと、APK を作る仕組み |

RAW の読み込みには [LibRaw](https://www.libraw.org/)（LGPL 2.1 / CDDL 1.0）を使う。
