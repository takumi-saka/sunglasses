// 2026-11-15 写ルンですの模型（フィルムと写真屋の処理）。Mac 上の試作（_work/写ルンです/scripts/utsurun.py）と同じ式。
// 流れ: RAW（光の量）→ 写ルンですがフィルムに当てる光の量（32mm・F10・1/140 秒・感度 400 で固定）→ レンズ（四隅・にじみ・かぶり）
//       → フィルム（ネガの濃さ）→ 粒 → 写真屋の機械（コマごとの明るさと色の自動補正 → 印画紙の線）→ 輪郭強調
// このファイルは、決まりの値と、1 コマにつき 1 回だけ CPU で計算する物（光の量の倍率・白の直し・コマごとの統計）を持つ。
// 1 画素ずつの計算は shaders.js の FS_UTS_*、描く順は engine.js の _renderUtsurun

export const UTSURUN_CORE = "utsurun";

export const CAM = { t: 1 / 140, N: 10, focal: 32 };
// 富士 SUPERIA X-TRA 400 の公式の線から読んだ値（仮の土台。中のフィルムの銘柄は公表が無い）
export const FILM = { gamma: [0.645, 0.69, 0.715], x0: -2.73, toe: 0.25, dmax: 2.7, xgray: -1.6, rms: 0.004 };
export const GRAY = Math.pow(10, FILM.xgray); // 18% の灰色がちょうどよく写る光の量（lux 秒）

// 決まり v7（_work/写ルンです/決まり_v7.json。お手本の写真の数字に合わせて決めた値）
export const P = {
  cal: 0.0, vig: 0.34, flare: 0.05899944388504911, blur: [0.55, 2.2],
  mix: 0.033778077048339177, gb: 0.04, rg: 0.0, bg: 0.0, sharp: 0.5,
  grain: 2.35, grain_rho: 0.5, toe_d: [-0.04151081452044375, -0.08614265828803996],
  wm: 0.5, hi_off: 0.45, kd: 0.9, lift_max: 0.8744212962962958, dark_max: 1.2, bias: -0.0004220561119493123,
  kc: 0.45, kc_max: 0.2, crange: 0.6, cmax: 1.6,
  range: 2.6, s: 1.2729885029297487, e0: -0.1103631455373254, nu: 0.21525091350431153,
  rng_rb: [0.0035504287350343233, 0.4932813362833631], sat: 0.7115008110329925,
  warm: [-0.023125444165213636, -0.010393906437545702], hi_cap: [0.5, 0.65],
};
// ネガの濃さごとの粒の強さ（濃さ 0〜2.4 を 0.05 刻みにした 49 点。薄い所ほど強く、濃い所（明るい所）は弱い）
export const GRAIN_SHAPE = Float32Array.of(1.35, 1.3167, 1.2833, 1.25, 1.3429, 1.4357, 1.5286, 1.6214, 1.7143, 1.8071, 1.9, 2.0, 2.1, 2.2, 2.3, 2.4, 2.5, 2.225, 1.95, 1.675, 1.4, 1.2433, 1.0867, 0.93, 0.8845, 0.8391, 0.6833, 0.5, 0.3722, 0.2625, 0.225, 0.1875, 0.15, 0.1481, 0.1462, 0.1444, 0.1425, 0.1406, 0.1388, 0.1369, 0.135, 0.1331, 0.1312, 0.1294, 0.1275, 0.1256, 0.1237, 0.1219, 0.12);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mul3 = (m, r, g, b) => [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];
const mm3 = (x, y) => {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = x[r * 3] * y[c] + x[r * 3 + 1] * y[3 + c] + x[r * 3 + 2] * y[6 + c];
  return o;
};
const inv3 = (m) => {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = f * g - d * i, Cc = d * h - e * g, det = a * A + b * B + c * Cc;
  if (!(Math.abs(det) > 1e-9)) return null;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, Cc / det, (b * g - a * h) / det, (a * e - b * d) / det];
};

// 層の色の混ざりの行列（行 = 層）
export function mixMatrix(Q = P) {
  const m = Q.mix, M = [1 + 2 * m, -m, -m, -m, 1 + 2 * m, -m, -m, -m, 1 + 2 * m];
  M[4] -= Q.gb; M[5] += Q.gb; M[0] -= Q.rg; M[1] += Q.rg; M[8] -= Q.bg; M[7] += Q.bg;
  return M;
}

// 元の画（ACES AP0、端末が決めた白）→ 昼の光の白の sRGB の原色（光の量に比例）。
// フィルムは昼の光に合わせて作ってあり、撮る時に白を合わせない。電球の下は橙に、日かげは青く写る
export function toDaylightSrgb(light, ap0ToSrgb) {
  if (!light || !Array.isArray(light.ratio) || !Array.isArray(light.cam) || light.cam.length !== 9) return ap0ToSrgb;
  const r = light.ratio, camInv = inv3(light.cam);
  if (!camInv || !(r[0] > 0 && r[1] > 0 && r[2] > 0)) return ap0ToSrgb;
  const m = mm3(mm3(mm3(light.cam, [r[0], 0, 0, 0, r[1], 0, 0, 0, r[2]]), camInv), ap0ToSrgb);
  return m.some((v) => !Number.isFinite(v)) ? ap0ToSrgb : m;
}

// 元の画の値（センサーがあふれる量 = 1）→ フィルムに当たる光の量（lux 秒）の倍率。
// 写ルンですは明るさを合わせないので、場面の本当の明るさで決まる。
// 撮った時の感度・シャッター・絞りが分からない写真（JPEG など）は、画面の平均が灰色に写る量と置く
export function exposureScale(image, Q = P) {
  const m = image.meta || {};
  if (image.kind === "raw" && m.iso > 0 && m.shutter > 0 && m.aperture > 0) {
    return (78 / m.iso) * (CAM.t / m.shutter) * Math.pow(m.aperture / CAM.N, 2) * Math.pow(10, Q.cal);
  }
  return GRAY / Math.max(image.key || 0.18, 1e-6);
}

// 写ルンですの画角（32mm 相当・3:2）の切り抜き。ratio = 撮ったレンズの焦点距離 ÷ 32（メインの 23mm なら 23/32。1 なら縦横の比だけ）
export function frameCrop(w, h, ratio = 1) {
  const k = clamp(ratio, 0.05, 1), cw = w * k, ch = h * k;
  let nw, nh;
  if (cw >= ch) {
    nh = Math.min(ch, (cw * 2) / 3);
    nw = Math.min(cw, (nh * 3) / 2);
  } else {
    nw = Math.min(cw, (ch * 2) / 3);
    nh = Math.min(ch, (nw * 3) / 2);
  }
  return { cx: 0.5, cy: 0.5, w: nw / w, h: nh / h, angle: 0 };
}

// ネガの濃さ（素の濃さより上の分）。h = 光の量（灰色 = 1）を層の混ざりに通したあとの 3 つ
function density(h, Q) {
  const d = [0, 0, 0], td = [Q.toe_d[0], 0, Q.toe_d[1]];
  for (let c = 0; c < 3; c++) {
    const x = Math.log10(Math.max(h[c] * GRAY, 1e-7));
    const t = (x - FILM.x0 - td[c]) / FILM.toe;
    const v = FILM.gamma[c] * FILM.toe * (Math.max(t, 0) + Math.log10(1 + Math.pow(10, -Math.abs(t))));
    d[c] = v / Math.cbrt(1 + Math.pow(v / FILM.dmax, 3));
  }
  return d;
}

function percentile(sorted, q) {
  const p = (q / 100) * (sorted.length - 1), i = Math.floor(p), j = Math.min(i + 1, sorted.length - 1);
  return sorted[i] + (sorted[j] - sorted[i]) * (p - i);
}

// コマごとの統計（写真屋の機械が、コマ全体を見て決める量）。
// small: 元の画を小さくした物（AP0、光の量に比例、sw×sh）。cropToSrc: 切り抜きの中の位置 → 元の画の位置。
// toRgb・k: toDaylightSrgb と exposureScale の値。aspect: 切り抜きの横 ÷ 縦。exposure: 露出のつまみ（段。プリントを明るく・暗く焼く）
// 返す物: flare（かぶりとして全体に足す光の量、灰色 = 1）、gain（薄いネガの明暗を引き伸ばす倍率）、
//         offset（明るさと色の合わせ。log10、3 色）、shift・col・key（確かめ用）
export function frameStats(small, sw, sh, cropToSrc, toRgb, k, aspect, exposure = 0, Q = P) {
  const GW = aspect >= 1 ? 96 : 64, GH = aspect >= 1 ? 64 : 96, n = GW * GH;
  const H = new Float32Array(n * 3), M = mixMatrix(Q), kk = k / GRAY;
  const r2den = (aspect * aspect) / 4 + 0.25;
  const sum = [0, 0, 0];
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const u = (i + 0.5) / GW, v = (j + 0.5) / GH;
      const sx = clamp((cropToSrc[0] * u + cropToSrc[1] * v + cropToSrc[2]) * sw - 0.5, 0, sw - 1);
      const sy = clamp((cropToSrc[3] * u + cropToSrc[4] * v + cropToSrc[5]) * sh - 0.5, 0, sh - 1);
      const xa = Math.floor(sx), ya = Math.floor(sy), xb = Math.min(xa + 1, sw - 1), yb = Math.min(ya + 1, sh - 1), fx = sx - xa, fy = sy - ya;
      const at = (x, y, c) => small[(y * sw + x) * 3 + c];
      const ap0 = [0, 1, 2].map((c) => (at(xa, ya, c) * (1 - fx) + at(xb, ya, c) * fx) * (1 - fy) + (at(xa, yb, c) * (1 - fx) + at(xb, yb, c) * fx) * fy);
      const rgb = mul3(toRgb, ap0[0], ap0[1], ap0[2]);
      const r2 = ((u - 0.5) * (u - 0.5) * aspect * aspect + (v - 0.5) * (v - 0.5)) / r2den;
      const f = kk / Math.pow(1 + Q.vig * r2, 2);
      for (let c = 0; c < 3; c++) {
        const hv = Math.max(rgb[c], 0) * f;
        H[(j * GW + i) * 3 + c] = hv;
        sum[c] += hv;
      }
    }
  }
  const flare = sum.map((s) => (Q.flare * s) / n);
  // 18% の灰色がちょうどよく写った時を 0 とした、光の量の見積もり（log10）
  const lum = new Float32Array(n), td = [Q.toe_d[0], 0, Q.toe_d[1]], chan = [0, 0, 0];
  let ws = 0, wl = 0;
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const p = j * GW + i, h = [H[p * 3] + flare[0], H[p * 3 + 1] + flare[1], H[p * 3 + 2] + flare[2]];
      const d = density(mul3(M, h[0], h[1], h[2]), Q);
      let l = 0;
      for (let c = 0; c < 3; c++) {
        const e = d[c] / FILM.gamma[c] + FILM.x0 + td[c] - FILM.xgray;
        chan[c] += e;
        l += e / 3;
      }
      lum[p] = l;
      const wt = Math.exp(-(Math.pow((i - GW / 2) / (GW / 2), 2) + Math.pow((j - GH / 2) / (GH / 2), 2)) * 0.8); // まん中を重く見る
      ws += wt;
      wl += wt * l;
    }
  }
  const sorted = Float32Array.from(lum).sort();
  const mean = wl / ws, p5 = percentile(sorted, 5), p95 = percentile(sorted, 95), p99 = percentile(sorted, 99);
  const key = Q.wm * mean + (1 - Q.wm) * (p95 - Q.hi_off);
  let shift = clamp(Q.kd * (key - Q.bias), -Q.lift_max, Q.dark_max);
  const floor = FILM.x0 - FILM.xgray;
  if (Q.hi_cap) {
    // 白飛びの守り: いちばん明るい所（上位 1%）が決めた値より明るく仕上がらないように、コマ全体を暗くする。
    // 暗い背景（ほぼ光が当たっていない所）が画面の 3 割を超えたコマ（夜のフラッシュ）では、強く守る
    let dark = 0;
    for (let p = 0; p < n; p++) if (lum[p] < floor + 0.3) dark++;
    const cap = Q.hi_cap[1] + (Q.hi_cap[0] - Q.hi_cap[1]) * Math.min(dark / n / 0.3, 1);
    shift = Math.max(shift, p99 - cap);
  }
  const all = (chan[0] + chan[1] + chan[2]) / 3 / n;
  const col = chan.map((s) => clamp(Q.kc * (s / n - all), -Q.kc_max, Q.kc_max));
  // 薄いネガ（暗いコマ）は、フィルムの素の濃さを黒の床にして、明暗を引き伸ばす
  const gain = 1 + (clamp(Q.crange / Math.max(p95 - p5, 1e-3), 1, Q.cmax) - 1) * clamp(-shift / 0.5, 0, 1);
  const warm = [Q.warm[0] / 2 - Q.warm[1] / 2, Q.warm[1], -Q.warm[0] / 2 - Q.warm[1] / 2];
  const print = shift - exposure * Math.log10(2);
  return { flare, gain, offset: [0, 1, 2].map((c) => -print - col[c] + warm[c]), shift, col, key, mean, p5, p95, p99 };
}
