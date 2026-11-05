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

// 核の画（対応表）での真ん中の明るさ
export function medianCore(small, key, ev, lut, ap0ToAp1) {
  const g = (0.18 / key) * Math.pow(2, ev), n = small.length / 3, L = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = mul3(ap0ToAp1, small[i * 3] * g, small[i * 3 + 1] * g, small[i * 3 + 2] * g);
    const o = lut.apply(acescct(Math.max(v[0], 0)), acescct(Math.max(v[1], 0)), acescct(Math.max(v[2], 0)));
    L[i] = lightness(o[0], o[1], o[2]);
  }
  return median(L);
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
