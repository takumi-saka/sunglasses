// RAW を裏で読む係（2026-11-05）。画面を止めないように、別の流れ（Worker）で LibRaw を動かす。
// 受け取る: { id, cmd: "decode", buf: ArrayBuffer, wantThumb: bool }
// 返す: { id, stage: "thumb", thumb }（RAW の中の見本の画。先に出すため）
//       { id, stage: "done", pixels, w, h, meta, small, sw, sh, key }
//       { id, stage: "error", error }
import createRaw from "./raw.js";

const SMALL_W = 160; // 露光量の自動合わせに使う小さな画の幅（パソコンの道具の MATCH_W と同じ）
let M = null;

self.onmessage = async (e) => {
  const { id, cmd } = e.data;
  try {
    if (!M) M = await createRaw();
    if (cmd !== "decode" && cmd !== "thumb") throw new Error("知らない指示: " + cmd);
    const bytes = new Uint8Array(e.data.buf);
    const p = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, p);
    try {
      let r = M._sg_open(p, bytes.length);
      if (r) throw new Error(M.UTF8ToString(M._sg_error(r)));
      if (e.data.wantThumb && M._sg_thumb() === 0) {
        const tp = M._sg_thumb_data(), ts = M._sg_thumb_size();
        const thumb = M.HEAPU8.slice(tp, tp + ts).buffer;
        self.postMessage({ id, stage: "thumb", thumb, flip: M._sg_flip() }, [thumb]);
      }
      r = M._sg_develop(cmd === "thumb" ? 1 : 0);
      if (r) throw new Error(M.UTF8ToString(M._sg_error(r)));
      const w = M._sg_width(), h = M._sg_height();
      const pixels = new Uint16Array(M.HEAPU16.buffer, M._sg_pixels(), w * h * 3).slice();
      const meta = JSON.parse(M.UTF8ToString(M._sg_meta()));
      M._sg_close();
      if (cmd === "thumb") {
        // 一覧の小さな画: 長い辺を size に縮めた光の量の画（0〜1 の浮動小数点）と、露光量の自動合わせ用の値
        const size = e.data.size || 384, s = size / Math.max(w, h);
        const tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
        const thumb = shrink(pixels, w, h, tw, th);
        const { small, key } = makeSmall(pixels, w, h);
        self.postMessage({ id, stage: "done", thumb, tw, th, small, key, meta }, [thumb.buffer, small.buffer]);
        return;
      }
      const { small, sw, sh, key } = makeSmall(pixels, w, h);
      self.postMessage({ id, stage: "done", pixels, w, h, meta, small, sw, sh, key }, [pixels.buffer, small.buffer]);
    } finally {
      M._free(p);
    }
  } catch (err) {
    self.postMessage({ id, stage: "error", error: String((err && err.message) || err) });
  }
};

// 面積で平均して縮める（光の量、0〜1）
function shrink(px, w, h, sw, sh) {
  const small = new Float32Array(sw * sh * 3);
  for (let y = 0; y < sh; y++) {
    const y0 = Math.floor((y * h) / sh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / sh));
    for (let x = 0; x < sw; x++) {
      const x0 = Math.floor((x * w) / sw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / sw));
      let r = 0, g = 0, b = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * w + x0) * 3;
        for (let xx = x0; xx < x1; xx++, i += 3) {
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0) * 65535, o = (y * sw + x) * 3;
      small[o] = r / n;
      small[o + 1] = g / n;
      small[o + 2] = b / n;
    }
  }
  return small;
}

// 露光量の自動合わせに使う小さな画と、光の量の対数平均（key）
function makeSmall(px, w, h) {
  const sw = SMALL_W, sh = Math.max(1, Math.round((h * sw) / w));
  const small = shrink(px, w, h, sw, sh);
  let sl = 0, cnt = 0;
  for (let i = 0; i < small.length; i += 3) {
    const v = 0.3439664543 * small[i] + 0.7281661034 * small[i + 1] - 0.0721325427 * small[i + 2];
    if (v > 0) {
      sl += Math.log(Math.max(v, 1e-6));
      cnt++;
    }
  }
  return { small, sw, sh, key: cnt ? Math.exp(sl / cnt) : 0.18 };
}
