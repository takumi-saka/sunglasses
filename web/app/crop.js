// 切り抜きの計算（2026-11-05）。切り抜きは「元の画の中の真ん中の位置・幅・高さ（0〜1）・傾き（度）」で持つ。
// 傾けても枠が画からはみ出さないよう、はみ出す分は小さくし、真ん中を内側へ寄せる。
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function fitCrop(c, W, H) {
  const th = (c.angle * Math.PI) / 180, cs = Math.abs(Math.cos(th)), sn = Math.abs(Math.sin(th));
  let cw = c.w * W, ch = c.h * H;
  const s = Math.min(1, W / (cw * cs + ch * sn), H / (cw * sn + ch * cs));
  cw *= s;
  ch *= s;
  const ex = (cw * cs + ch * sn) / 2, ey = (cw * sn + ch * cs) / 2;
  return { ...c, w: cw / W, h: ch / H, cx: clamp(c.cx * W, ex, W - ex) / W, cy: clamp(c.cy * H, ey, H - ey) / H };
}

// 縦横の比 a（幅 ÷ 高さ）の、いちばん大きい枠。縦向きの写真では横長の比を縦長に読み替える
export function cropForAspect(c, a, W, H) {
  let ratio = a || W / H;
  if (a && H > W && ratio > 1) ratio = 1 / ratio;
  let cw = W, ch = W / ratio;
  if (ch > H) {
    ch = H;
    cw = H * ratio;
  }
  return fitCrop({ ...c, w: cw / W, h: ch / H, aspect: a }, W, H);
}

// 画面の上で指を動かした分（画面の画素）だけ、枠の中の写真を動かす（枠の向きに合わせて回す）
export function panCrop(c, dx, dy, pxPerSrc, W, H) {
  const th = (c.angle * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
  const ux = -dx / pxPerSrc, uy = -dy / pxPerSrc;
  return fitCrop({ ...c, cx: c.cx + (cs * ux - sn * uy) / W, cy: c.cy + (sn * ux + cs * uy) / H }, W, H);
}

// つまんだ分だけ枠の大きさを変える（大きくつまむと寄る）
export function zoomCrop(c, scale, W, H) {
  const minW = 64 / W;
  const w = Math.max(minW, c.w / scale), h = (w / c.w) * c.h;
  return fitCrop({ ...c, w, h }, W, H);
}

// 傾きを変える（はみ出す分は小さくする）
export function rotateCrop(c, angle, W, H) {
  return fitCrop({ ...c, angle }, W, H);
}
