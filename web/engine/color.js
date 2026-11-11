// 画の処理で使う色の計算のうち、CPU で行う分（2026-11-05）。
// 式はパソコンの道具（カメラアプリ/_work/scripts/look_search.py・look_lr.py）と同じ。

export const M_RGB2XYZ = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];
export const WHITE = [0.95047, 1.0, 1.08883];
export const AP0_Y = [0.3439664543, 0.7281661034, -0.0721325427];
// 8色（レッド・オレンジ・イエロー・グリーン・アクア・ブルー・パープル・マゼンタ）の真ん中の色相（L*a*b* の度）
export const HSL_CENTERS = [25, 55, 90, 135, 190, 250, 295, 340];

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const l2s = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);
const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

export function rgb2lab(r, g, b) {
  const lr = s2l(r), lg = s2l(g), lb = s2l(b), M = M_RGB2XYZ;
  const fx = labF((M[0] * lr + M[1] * lg + M[2] * lb) / WHITE[0]);
  const fy = labF((M[3] * lr + M[4] * lg + M[5] * lb) / WHITE[1]);
  const fz = labF((M[6] * lr + M[7] * lg + M[8] * lb) / WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// 明るさ（L*）だけ
export function lightness(r, g, b) {
  return 116 * labF(0.2126729 * s2l(r) + 0.7151522 * s2l(g) + 0.072175 * s2l(b)) - 16;
}

export const flat3 = (m) => [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]];
export const mul3 = (m, r, g, b) => [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];

export function halfToFloat(u16) {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i], s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    out[i] = e === 0 ? s * f * 5.960464477539063e-8 : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  return out;
}

// ---------- 光の色を残す（2026-11-11 シネマの核で足した）----------
// RAW は、端末が決めた白の基準で現像するので、電球の下でも白い物は白くなる（光の色を全部打ち消す）。
// Chromagraph は電球の光の橙色を残す（作り手の作例のバーのランプ、純正との撮り比べのマリオ）。
// そこで、黄色い光のときだけ、白の基準を「端末が決めた値」と「昼の光の値」のあいだに置き直す。
//   light = { ratio: 昼の基準 ÷ 端末の基準（緑が 1。カメラの色）, cam: カメラの色 → sRGB の光の量の行列 }（raw.cpp が写真の情報に入れる）
//   keep  = { from: 光の黄色さ（下の w）がこの値を超えた分だけ残す, amount: 超えた分のうち残す割合 }（looks.json の keepLight）
//   光の黄色さ w = ln(赤 ÷ 青)。白い物を昼の基準で現像したときの sRGB の光の量で測る
//   （本人の昼の写真 11 枚は 0.14〜0.58、電球の店の 1 枚〈約 3,200K〉は 1.35。from 0.8 は約 4,300K に当たる）
// 返すのは AP0 → AP0 の行列（白い物の明るさは変えない）。残す物が無ければ null
const inv3 = (m) => {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = f * g - d * i, Cc = d * h - e * g, det = a * A + b * B + c * Cc;
  if (!(Math.abs(det) > 1e-9)) return null;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, Cc / det, (b * g - a * h) / det, (a * e - b * d) / det];
};
const mm3 = (x, y) => {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = x[r * 3] * y[c] + x[r * 3 + 1] * y[3 + c] + x[r * 3 + 2] * y[6 + c];
  return o;
};
export function keepLightMatrix(light, keep, ap0ToSrgb, srgbToAp0) {
  if (!light || !keep || !Array.isArray(light.ratio) || !Array.isArray(light.cam) || light.cam.length !== 9) return null;
  const r = light.ratio, cam = light.cam, camInv = inv3(cam);
  if (!camInv || !(r[0] > 0 && r[1] > 0 && r[2] > 0)) return null;
  const ls = mul3(cam, r[0], r[1], r[2]);
  if (!(ls[0] > 0 && ls[2] > 0)) return null;
  const w = Math.log(ls[0] / ls[2]), over = w - (keep.from ?? 0.8);
  if (!(over > 0)) return null;
  const s = Math.min(((keep.amount ?? 0.7) * over) / w, 0.9);
  const d = [Math.pow(r[0], s), 0, 0, 0, Math.pow(r[1], s), 0, 0, 0, Math.pow(r[2], s)];
  const m = mm3(srgbToAp0, mm3(mm3(mm3(cam, d), camInv), ap0ToSrgb));
  // 白い物（sRGB で 1,1,1）の明るさが変わらないようにそろえる（露光の自動合わせを動かさないため）
  const white = mul3(srgbToAp0, 1, 1, 1), kept = mul3(m, white[0], white[1], white[2]);
  const y0 = AP0_Y[0] * white[0] + AP0_Y[1] * white[1] + AP0_Y[2] * white[2], y1 = AP0_Y[0] * kept[0] + AP0_Y[1] * kept[1] + AP0_Y[2] * kept[2];
  if (!(y1 > 0) || m.some((v) => !Number.isFinite(v))) return null;
  return m.map((v) => (v * y0) / y1);
}
// 露光の自動合わせ用の小さな画に、同じ行列を掛けた写しを作る
export function applyMatrix(small, m) {
  const out = new Float32Array(small.length);
  for (let i = 0; i < small.length; i += 3) {
    const v = mul3(m, small[i], small[i + 1], small[i + 2]);
    out[i] = v[0];
    out[i + 1] = v[1];
    out[i + 2] = v[2];
  }
  return out;
}

// 65³ の対応表を CPU で引く（立方体の8点で直線に混ぜる。露光量の自動合わせに使う）
export class CpuLut {
  constructor(n, lo, hi, data) {
    Object.assign(this, { n, lo, hi, data });
  }
  apply(c0, c1, c2) {
    const { n, lo, hi, data } = this, i0 = [0, 0, 0], f = [0, 0, 0], c = [c0, c1, c2];
    for (let k = 0; k < 3; k++) {
      const t = clamp((c[k] - lo[k]) / (hi[k] - lo[k]), 0, 1) * (n - 1);
      i0[k] = Math.min(Math.floor(t), n - 2);
      f[k] = t - i0[k];
    }
    const out = [0, 0, 0];
    const at = (r, g, b, ch) => data[((b * n + g) * n + r) * 3 + ch];
    for (let ch = 0; ch < 3; ch++) {
      const c00 = at(i0[0], i0[1], i0[2], ch) * (1 - f[0]) + at(i0[0] + 1, i0[1], i0[2], ch) * f[0];
      const c10 = at(i0[0], i0[1] + 1, i0[2], ch) * (1 - f[0]) + at(i0[0] + 1, i0[1] + 1, i0[2], ch) * f[0];
      const c01 = at(i0[0], i0[1], i0[2] + 1, ch) * (1 - f[0]) + at(i0[0] + 1, i0[1], i0[2] + 1, ch) * f[0];
      const c11 = at(i0[0], i0[1] + 1, i0[2] + 1, ch) * (1 - f[0]) + at(i0[0] + 1, i0[1] + 1, i0[2] + 1, ch) * f[0];
      out[ch] = clamp((c00 * (1 - f[1]) + c10 * f[1]) * (1 - f[2]) + (c01 * (1 - f[1]) + c11 * f[1]) * f[2], 0, 1);
    }
    return out;
  }
}

// 0〜1 を等分した点の曲線を引く（np.interp と同じ）
export function curveAt(curve, x) {
  const p = clamp(x, 0, 1) * (curve.length - 1);
  const i = Math.min(Math.floor(p), curve.length - 2), t = p - i;
  return curve[i] * (1 - t) + curve[i + 1] * t;
}

export const acescct = (v) => (v <= 0.0078125 ? 10.5402377416545 * v + 0.0729055341958355 : (Math.log2(v) + 9.72) / 17.52);

export function median(arr) {
  const v = Float64Array.from(arr).sort();
  const n = v.length;
  return n % 2 ? v[n >> 1] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

// 露光量の自動合わせ: 真ん中の明るさが目安になる段を、二分で 9 回探す（パソコンの道具の match_ev と同じ）
export function searchEv(medianAt, target) {
  let lo = -6, hi = 6;
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2;
    if (medianAt(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// 重みつきの真ん中（重みを足していって半分を超えた所）
export function weightedMedian(L, w) {
  const idx = Array.from(L.keys()).sort((a, b) => L[a] - L[b]);
  let total = 0;
  for (let i = 0; i < w.length; i++) total += w[i];
  let acc = 0;
  for (const i of idx) {
    acc += w[i];
    if (acc >= total / 2) return L[i];
  }
  return L[idx[idx.length - 1]];
}

// 核の画（対応表）での真ん中の明るさ。weights を渡すと、重みつきの真ん中（撮る画面で、たたいた所を重く測るとき）
export function medianCore(small, key, ev, lut, ap0ToAp1, weights = null) {
  const g = (0.18 / key) * Math.pow(2, ev), n = small.length / 3, L = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = mul3(ap0ToAp1, small[i * 3] * g, small[i * 3 + 1] * g, small[i * 3 + 2] * g);
    const o = lut.apply(acescct(Math.max(v[0], 0)), acescct(Math.max(v[1], 0)), acescct(Math.max(v[2], 0)));
    L[i] = lightness(o[0], o[1], o[2]);
  }
  return weights ? weightedMedian(L, weights) : median(L);
}

// 素直な現像（sRGB の光の量 → 明るい所の肩 → sRGB の曲線 → 中くらいのコントラストの曲線）
export const shoulder = (v) => (v <= 0.8 ? v : 0.8 + 0.2 * (1 - Math.exp(-(v - 0.8) / 0.2)));
export function neutralPixel(ap0ToSrgb, curve, r, g, b) {
  const v = mul3(ap0ToSrgb, r, g, b);
  return v.map((c) => curveAt(curve, clamp(l2s(shoulder(Math.max(c, 0))), 0, 1)));
}
export function medianNeutral(small, key, ev, ap0ToSrgb, curve) {
  const g = (0.18 / key) * Math.pow(2, ev), n = small.length / 3, L = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = neutralPixel(ap0ToSrgb, curve, small[i * 3] * g, small[i * 3 + 1] * g, small[i * 3 + 2] * g);
    L[i] = lightness(o[0], o[1], o[2]);
  }
  return median(L);
}

// ---------- 露光の決まり（2026-11-10 シネマの核で足した。パソコンの道具の direction_samples.meter_ev と同じ）----------
// 核に meter が無ければ今までどおり: 仕上がりの真ん中の明るさを targetL + lift に合わせる。
// meter がある核（シネマ）:
//   1. 素直な現像で「青くて明るい所（空）」を skyWeight の重みで軽く見た、重みつきの真ん中の明るさを target に合わせる
//      （空の大きい写真で、空に引っぱられて地面が真っ黒になるのを防ぐ）
//   2. 仕上がりの明るさの上の方（下から whiteRank % の所）が whiteRange に入るように露光を止める
//      （雲の白飛びと、白が低すぎる画を防ぐ）。明暗の差が小さい景色で明るくなりすぎないよう、
//      白のために上げるのは、真ん中の明るさが target + liftLimit になる所まで。
//      白飛びした面が広い写真（逆光・くもり空）で画全体が真っ暗にならないよう、白のために下げるのは target - dropLimit になる所まで
// 速さのため、meter のある核は小さな画を 1 つおきに測り、真ん中と順位は 0.1 刻みの山（ヒストグラム）で出す
const METER_STEP = 2, HIST_N = 1001;
function meterHist(small, key, ev, lut, ap0ToAp1, w) {
  const g = (0.18 / key) * Math.pow(2, ev), n = small.length / 3, hist = new Float64Array(HIST_N);
  for (let i = 0, j = 0; i < n; i += METER_STEP, j++) {
    const v = mul3(ap0ToAp1, small[i * 3] * g, small[i * 3 + 1] * g, small[i * 3 + 2] * g);
    const o = lut.apply(acescct(Math.max(v[0], 0)), acescct(Math.max(v[1], 0)), acescct(Math.max(v[2], 0)));
    hist[Math.round(clamp(lightness(o[0], o[1], o[2]), 0, 100) * 10)] += w ? w[j] : 1;
  }
  return hist;
}
function histAt(hist, q) {
  let total = 0;
  for (let i = 0; i < HIST_N; i++) total += hist[i];
  let acc = 0;
  for (let i = 0; i < HIST_N; i++) {
    acc += hist[i];
    if (acc >= total * q) return i / 10;
  }
  return 100;
}
// 空を軽く見る重み（測る画素だけ。base は、撮る画面でたたいた所を重く測る重み）
function skyWeights(small, key, ap0ToSrgb, curve, skyWeight, base) {
  const g = 0.18 / key, n = small.length / 3, w = new Float32Array(Math.ceil(n / METER_STEP));
  const c01 = (v) => clamp(v, 0, 1);
  for (let i = 0, j = 0; i < n; i += METER_STEP, j++) {
    const o = neutralPixel(ap0ToSrgb, curve, small[i * 3] * g, small[i * 3 + 1] * g, small[i * 3 + 2] * g);
    const [L, a, b] = rgb2lab(o[0], o[1], o[2]);
    const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360, chroma = Math.hypot(a, b);
    const sky = c01((hue - 185) / 30) * c01((310 - hue) / 20) * c01((chroma - 6) / 6) * c01((L - 30) / 15);
    w[j] = (1 - (1 - skyWeight) * sky) * (base ? base[i] : 1);
  }
  return w;
}
// 核の露光量（段）。env は { ap0ToAp1, ap0ToSrgb, neutralCurve, targetL }（engine をそのまま渡せる）
export function coreEv(small, key, core, env, weights = null) {
  const m = core.meter;
  if (!m) return searchEv((e) => medianCore(small, key, e, core.cpu, env.ap0ToAp1, weights), env.targetL + core.lift);
  const w = skyWeights(small, key, env.ap0ToSrgb, env.neutralCurve, m.skyWeight ?? 1, weights);
  const mid = (e) => histAt(meterHist(small, key, e, core.cpu, env.ap0ToAp1, w), 0.5);
  const top = (e) => histAt(meterHist(small, key, e, core.cpu, env.ap0ToAp1, null), (m.whiteRank ?? 97) / 100);
  const ev = searchEv(mid, m.target);
  if (!m.whiteRange) return ev;
  const t = top(ev);
  if (t > m.whiteRange[1]) return Math.max(searchEv(top, m.whiteRange[1]), searchEv(mid, m.target - (m.dropLimit ?? 100)));
  if (t < m.whiteRange[0]) {
    let up = Math.min(searchEv(top, m.whiteRange[0]), searchEv(mid, m.target + (m.liftLimit ?? 100)));
    if (m.liftWhole) {
      // 2026-11-11 足した。白のために上げる時は、空を軽く見ない「画面全体の真ん中の明るさ」も target + liftLimit で止める。
      // 青空が大半の景色で、地面に合わせて上げると空が明るくなりすぎ、深い青がクリーム色にくすむ
      // （Chromagraph の作り手本人たちの作例は、空を明るさ 41〜46 に置いて地面を暗く落としている）
      const wAll = skyWeights(small, key, env.ap0ToSrgb, env.neutralCurve, 1, weights);
      const midAll = (e) => histAt(meterHist(small, key, e, core.cpu, env.ap0ToAp1, wAll), 0.5);
      up = Math.min(up, searchEv(midAll, m.target + (m.liftLimit ?? 100)));
    }
    return Math.max(ev, up);
  }
  return ev;
}

// 曲線の点からなめらかな曲線を作る（scipy の PchipInterpolator と同じ作り方。行き過ぎない）
export function pchip(points, n = 1025) {
  const m = new Map([[0, 0], [255, 255]]);
  for (const [x, y] of points) m.set(+x, +y);
  const pts = [...m.entries()].sort((a, b) => a[0] - b[0]);
  const xs = pts.map((p) => p[0] / 255), ys = pts.map((p) => p[1] / 255);
  const k = xs.length, h = [], d = [];
  for (let i = 0; i < k - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const dd = new Array(k).fill(0);
  if (k === 2) {
    dd[0] = dd[1] = d[0];
  } else {
    for (let i = 1; i < k - 1; i++) {
      if (d[i - 1] * d[i] <= 0) continue;
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      dd[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
    const edge = (h0, h1, m0, m1) => {
      let v = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
      if (Math.sign(v) !== Math.sign(m0)) v = 0;
      else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(v) > Math.abs(3 * m0)) v = 3 * m0;
      return v;
    };
    dd[0] = edge(h[0], h[1], d[0], d[1]);
    dd[k - 1] = edge(h[k - 2], h[k - 3], d[k - 2], d[k - 3]);
  }
  const out = new Float32Array(n);
  let s = 0;
  for (let j = 0; j < n; j++) {
    const x = j / (n - 1);
    while (s < k - 2 && x > xs[s + 1]) s++;
    const t = (x - xs[s]) / h[s], t2 = t * t, t3 = t2 * t;
    const v = (2 * t3 - 3 * t2 + 1) * ys[s] + (t3 - 2 * t2 + t) * h[s] * dd[s] + (-2 * t3 + 3 * t2) * ys[s + 1] + (t3 - t2) * h[s] * dd[s + 1];
    out[j] = clamp(v, 0, 1);
  }
  return out;
}

export function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
}

// カラーグレーディングの色の輪の向き（0 赤、60 黄、120 緑、180 シアン、240 青、300 マゼンタ）を a*b* の向きにする
export function wheel(hue) {
  const [r, g, b] = hsvToRgb((((hue % 360) + 360) % 360) / 360, 1, 1);
  const [, a, bb] = rgb2lab(r, g, b);
  const n = Math.hypot(a, bb) + 1e-6;
  return [a / n, bb / n];
}

// OpenCV の GaussianBlur（浮動小数点の画）と同じ大きさ・重みのぼかしの重み（中心から片側）。大きさ 1 ならぼかさない
export function gaussWeights(sigma) {
  const ksize = Math.round(sigma * 8 + 1) | 1;
  if (ksize <= 1) return [1];
  const r = (ksize - 1) / 2, w = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    w.push(v);
    sum += v;
  }
  return w.slice(r).map((v) => v / sum);
}
