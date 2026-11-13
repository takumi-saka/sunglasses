// 水の部品（2026-11-13）。押すとへこみ、離すと輪郭が波打ってすぐ戻る。後ろの絵は水ごしに曲がって見える。
// 動きと見た目の数字は、本人が試し場で決めたもの（動き＝A きりっと、見た目＝暗く＋幅 1.5 倍）。
// お手本: _work/デザイン_見本/water6_20261113.html の左から 3 つ目。数字を変える時は、先にお手本で確かめる。

// ===== 水の性格 =====
// f0: 大きなゆがみ（だ円）が 1 秒に揺れる回数　zeta: 揺れの減り方　grow: 細かいゆがみほど早く消える度合い
// nMax: どこまで細かいゆがみを入れるか　amp: 押した時のへこみの深さ　p: 細かいゆがみの弱め方
// m1: 全体が指から逃げる量　slosh: 動いた時に水が遅れてゆれる強さ　lead/tail: 移るつぶの前と後ろのふちの速さ
export const MOVE = { f0: 5.5, zeta: 0.17, grow: 0.5, nMax: 4, amp: 0.22, p: 1.0, m1: 0.25, slosh: 1.2, lead: 520, tail: 260, zl: 0.75, zt: 0.55 };
// ===== 水の見た目 =====
// bez: 曲がりの幅（半径に対する割合）　pow: 曲がりの立ち上がり　scale: 曲がりの強さ　chroma: ふちで色が分かれる量
// bright・tint: 水ごしの絵の暗さ　wide: ふちの暗さ・明るさの帯の幅　sat: 水ごしの絵のあざやかさ
export const LOOK = { pow: 1.8, sat: 1.15, chroma: 0.22, tint: "rgba(6,16,22,.08)", bez: 0.9, scale: 66, bright: 0.9, wide: 1.5 };

// 曲がりを使うか。SVG の地図で後ろを曲げる作りは Chrome 系だけ。重い・崩れる時は、localStorage の sg-water を flat にすると曲がりだけ外せる
let stored = "";
try { stored = localStorage.getItem("sg-water") || ""; } catch {}
export const REFRACT = stored !== "flat" && typeof CSS !== "undefined" && CSS.supports("backdrop-filter", "url(#a)");

export class Spring {
  constructor(x, k, z) { this.x = this.to = x; this.v = 0; this.set(k, z); }
  set(k, z) { this.k = k; this.c = 2 * z * Math.sqrt(k); }
  step(dt) { this.v += (-this.k * (this.x - this.to) - this.c * this.v) * dt; this.x += this.v * dt; }
  get still() { return Math.abs(this.v) < 0.4 && Math.abs(this.x - this.to) < 0.04; }
}

// 角の丸い四角（幅 w・高さ h・角の半径 r）のふちを、まわりの長さで等間隔に N 点とる。0 番が右の辺のまん中、時計回り。
// r が高さの半分なら、横長の丸（カプセル）になる
const N = 72;
function outline(w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const sx = w - 2 * r, sy = h - 2 * r, q = (Math.PI * r) / 2, P = 2 * sx + 2 * sy + 4 * q, out = new Float32Array(N * 4);
  const X = w / 2 - r, Y = h / 2 - r; // 角の円のまん中
  for (let i = 0; i < N; i++) {
    let d = (i / N) * P, x, y, nx, ny, a;
    const arc = (cx, cy, a0) => { a = a0 + d / r; nx = Math.cos(a); ny = Math.sin(a); x = cx + r * nx; y = cy + r * ny; };
    if (d < sy / 2) x = w / 2, y = d, nx = 1, ny = 0;
    else if ((d -= sy / 2) < q) arc(X, Y, 0);
    else if ((d -= q) < sx) x = X - d, y = h / 2, nx = 0, ny = 1;
    else if ((d -= sx) < q) arc(-X, Y, Math.PI / 2);
    else if ((d -= q) < sy) x = -w / 2, y = Y - d, nx = -1, ny = 0;
    else if ((d -= sy) < q) arc(-X, -Y, Math.PI);
    else if ((d -= q) < sx) x = -X + d, y = -h / 2, nx = 0, ny = -1;
    else if ((d -= sx) < q) arc(X, -Y, 1.5 * Math.PI);
    else x = w / 2, y = -Y + (d - q), nx = 1, ny = 0;
    out.set([x, y, nx, ny], i * 4);
  }
  return out;
}

const live = new Set();
let last = 0;
function tick(t) {
  const dt = Math.min(0.034, (t - last) / 1000 || 0.016); last = t;
  const n = Math.ceil(dt / 0.002);
  for (const b of live) { for (let i = 0; i < n; i++) b.step(dt / n); b.render(); if (b.asleep()) live.delete(b); }
  if (live.size) requestAnimationFrame(tick); else last = 0;
}
export const wake = (b) => { if (!live.size) requestAnimationFrame((t) => { last = t; tick(t); }); live.add(b); };

let uid = 0, defs = null;
const SVG = "http://www.w3.org/2000/svg";

export class Blob {
  // host: この水を入れる箱。box: 箱の中で水が動ける範囲。shape: その中での形（まん中 cx,cy・幅 w・高さ h・角の半径 r・lens＝水滴）
  // kind: glass（透明な水）／white（白い水のつぶ）／solid（透けない濃い水。撮る画面用）
  constructor(host, box, shape, kind = "glass") {
    const P = this.P = MOVE, L = LOOK;
    this.shape = shape; this.kind = kind; this.box = box;
    if (shape.r == null) shape.r = shape.h / 2;
    const pad = box.pad ?? 18; this.pad = pad; // 影と揺れのための余白
    const el = this.el = document.createElement("div"); el.className = "wt-wrap";
    el.style.cssText = `left:${box.x - pad}px;top:${box.y - pad}px;width:${box.w + pad * 2}px;height:${box.h + pad * 2}px`;
    const id = this.id = "wt" + uid++, w = shape.w, h = shape.h, r = Math.min(shape.r, w / 2, h / 2), u = (n) => `url(#${id}${n})`;
    if (kind === "white") {
      el.innerHTML = `<svg class="wt-soft"><path fill="#000"/></svg><svg><path fill="rgba(255,255,255,.94)"/></svg>`;
    } else {
      // ふちの光：左上のふちだけ細く暗い／右下の内側に光がたまる／左上に小さく鋭い光。位置は、ふちの長さに対する割合で決める
      const per = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r, c = ((Math.PI * r) / 2 / per) * 100, br = ((h / 2 - r) / per) * 100, tl = 50 + br, k = L.wide, ext = Math.min(5, 3600 / per); // まっすぐな辺へのびる長さ。大きい板で長くなりすぎないよう 36px まで
      const arc = (from, len, attrs) => `<path fill="none" pathLength="100" stroke-dasharray="${len.toFixed(2)} 100" stroke-dashoffset="${(-from).toFixed(2)}" ${attrs}/>`;
      const body = kind === "solid" ? `<svg><path fill="#16191b"/></svg>` : `<div class="clip"><div class="gl"></div></div>`;
      el.innerHTML = `<svg class="wt-shadow"><defs><mask id="${id}o" maskUnits="userSpaceOnUse" x="-40" y="-40" width="${box.w + pad * 2 + 80}" height="${box.h + pad * 2 + 80}"><rect x="-40" y="-40" width="${box.w + pad * 2 + 80}" height="${box.h + pad * 2 + 80}" fill="#fff"/><path fill="#000"/></mask>
          <filter id="${id}f" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter></defs>
          <g mask="${u("o")}"><path fill="#000" fill-opacity=".3" transform="translate(0 6)" filter="${u("f")}"/></g></svg>${body}
        <svg><defs>
          <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".5" stop-color="#fff" stop-opacity=".2"/><stop offset="1" stop-color="#fff" stop-opacity=".7"/></linearGradient>
          <filter id="${id}b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${(2.2 * k).toFixed(2)}"/></filter>
          <filter id="${id}s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${(1 * k).toFixed(2)}"/></filter>
          <clipPath id="${id}k"><path/></clipPath></defs>
          <g clip-path="${u("k")}">` +
            arc(tl - 0.9 * c, 2.2 * c + ext, `stroke="#001018" stroke-opacity=".34" stroke-width="${(3 * k).toFixed(1)}" filter="${u("s")}"`) +
            arc(br + 0.1 * c, 1.2 * c + ext, `stroke="#fff" stroke-opacity="${kind === "solid" ? 0.22 : 0.5}" stroke-width="${(Math.min(9, h * 0.22) * k).toFixed(1)}" filter="${u("b")}"`) +
            arc(tl + 0.32 * c, 0.42 * c, `stroke="#fff" stroke-opacity=".95" stroke-width="${Math.min(3.4, h * 0.09).toFixed(1)}" stroke-linecap="round"`) +
            arc(tl + 1.0 * c, 0.01, `stroke="#fff" stroke-opacity=".9" stroke-width="${Math.min(3, h * 0.08).toFixed(1)}" stroke-linecap="round"`) +
          `</g><path fill="none" stroke="${u("")}" stroke-width="1.3"/></svg>`;
    }
    if (kind === "glass") {
      const inner = this.inner = el.querySelector(".gl");
      inner.style.background = L.tint;
      if (REFRACT) {
        // 後ろの絵を曲げる地図（止まっている時の形で 1 回だけ作る。揺れている間は、切り抜きだけが動く）。赤＝横、緑＝縦のずれ
        const mg = 8, W = Math.round(w + mg * 2), H = Math.round(h + mg * 2), lens = shape.lens;
        const bezel = Math.min(r, 30) * L.bez, scale = lens ? Math.min(44, r * 2.2) : Math.min(L.scale, r * 2.4);
        const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
        const g = cv.getContext("2d"), im = g.createImageData(W, H), d = im.data;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const px = x + 0.5 - W / 2, py = y + 0.5 - H / 2, qx = Math.abs(px) - (w / 2 - r), qy = Math.abs(py) - (h / 2 - r);
          let dist, nx = 0, ny = 0;
          if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy) || 1; dist = r - l; nx = -Math.sign(px) * qx / l; ny = -Math.sign(py) * qy / l; }
          else if (qx > qy) { dist = r - qx; nx = -Math.sign(px); }
          else { dist = r - qy; ny = -Math.sign(py); }
          let m = dist > 0 && dist < bezel ? Math.pow(1 - dist / bezel, L.pow) : 0;
          if (lens && dist > 0) { const l = Math.hypot(px, py) || 1, rho = l / r; m = Math.max(m, Math.pow(rho, 1.4) * 0.75); nx = -px / l; ny = -py / l; } // 水滴：まん中ほど大きく見える
          const i = (y * W + x) * 4;
          d[i] = 128 + nx * m * 127; d[i + 1] = 128 + ny * m * 127; d[i + 2] = 128; d[i + 3] = 255;
        }
        g.putImageData(im, 0, 0);
        if (!defs) { defs = document.createElementNS(SVG, "svg"); defs.setAttribute("width", 0); defs.setAttribute("height", 0); defs.style.cssText = "position:absolute;width:0;height:0"; defs.setAttribute("color-interpolation-filters", "sRGB"); document.body.prepend(defs); }
        const f = this.filter = document.createElementNS(SVG, "filter");
        f.setAttribute("id", id + "m"); f.setAttribute("x", "0"); f.setAttribute("y", "0"); f.setAttribute("width", "100%"); f.setAttribute("height", "100%");
        const dm = (kk, res) => `<feDisplacementMap in="SourceGraphic" in2="map" scale="${(scale * kk).toFixed(1)}" xChannelSelector="R" yChannelSelector="G" result="${res}"/>`;
        const only = (src, ch, res) => `<feColorMatrix in="${src}" type="matrix" values="${ch === 0 ? 1 : 0} 0 0 0 0  0 ${ch === 1 ? 1 : 0} 0 0 0  0 0 ${ch === 2 ? 1 : 0} 0 0  0 0 0 1 0" result="${res}"/>`;
        f.innerHTML = `<feImage href="${cv.toDataURL()}" x="0" y="0" width="${W}" height="${H}" result="map"/>` +
          dm(1 - L.chroma, "d0") + only("d0", 0, "c0") + dm(1, "d1") + only("d1", 1, "c1") + dm(1 + L.chroma, "d2") + only("d2", 2, "c2") +
          `<feBlend in="c0" in2="c1" mode="screen" result="c01"/><feBlend in="c01" in2="c2" mode="screen" result="d"/><feColorMatrix in="d" type="saturate" values="${L.sat}"/>`;
        defs.append(f);
        inner.style.width = W + "px"; inner.style.height = H + "px";
        inner.style.backdropFilter = `url(#${id}m) brightness(${L.bright})`;
        this.mg = mg;
      } else {
        inner.style.width = w + "px"; inner.style.height = h + "px";
        inner.style.backdropFilter = `brightness(${L.bright}) saturate(${L.sat})`;
        this.mg = 0;
      }
    }
    this.w0 = w; this.h0 = h;
    host.prepend(el);
    this.paths = [...el.querySelectorAll("path")]; this.gl = el.querySelector(".clip");
    // ゆがみの成分。n ごとに、右向きの成分（c）と下向きの成分（s）を持つ
    this.m = [];
    let sum = 0; for (let n = 2; n <= P.nMax; n++) sum += Math.pow(n, -P.p);
    for (let n = 1; n <= P.nMax; n++) {
      const om = 2 * Math.PI * P.f0 * (n === 1 ? 0.75 : Math.sqrt((n * (n - 1) * (n + 2)) / 8));
      this.m.push({ n, om, z: P.zeta * (1 + P.grow * Math.max(0, n - 2)), w: n === 1 ? P.m1 : Math.pow(n, -P.p) / sum, c: 0, s: 0, vc: 0, vs: 0, tc: 0, ts: 0 });
    }
    this.held = false; this.motion = null; this.pv = 0;
    this.render();
  }
  destroy() { live.delete(this); this.el.remove(); if (this.filter) this.filter.remove(); }
  // ゆがみの大きさの物差し（大きな板でも、へこみが大きくなりすぎないように上限を付ける）
  get rr() { return Math.min(this.shape.h / 2, this.shape.w / 2, 46); }
  // 箱の中の点 (x,y) を押した。いちばん近いふちの所をへこませる
  press(x, y) {
    const s = this.shape, lx = x - this.box.x - s.cx, ly = y - this.box.y - s.cy, o = outline(s.w, s.h, s.r);
    let best = 0, bd = 1e9;
    for (let i = 0; i < N; i++) { const d = (o[i * 4] - lx) ** 2 + (o[i * 4 + 1] - ly) ** 2; if (d < bd) bd = d, best = i; }
    const depth = Math.min(1, Math.hypot(lx, ly) / (this.rr * 0.9)) * 0.75 + 0.25; // まん中に近いほど浅い
    const th = (best / N) * 2 * Math.PI;
    for (const m of this.m) { m.tc = -this.P.amp * m.w * Math.cos(m.n * th) * depth; m.ts = -this.P.amp * m.w * Math.sin(m.n * th) * depth; }
    if (depth < 0.5) { const m2 = this.m[1]; m2.tc = this.P.amp * 0.5; m2.ts = 0; } // まん中を押すと、全体が広がる向き
    this.held = true; wake(this);
  }
  release() { if (!this.held) return; this.held = false; for (const m of this.m) m.tc = m.ts = 0; wake(this); }
  // 強さ a でゆさぶる（動き出し・止まる時の、水の遅れ）
  slosh(a, dt) {
    for (const m of this.m) m.vc += (m.n === 1 ? -1 : Math.pow(-1, m.n)) * this.P.slosh * a * m.w * dt * (m.n === 1 ? 0.6 : 1);
  }
  // ぽんと 1 回ゆらす（押さずに選んだ時など）
  nudge(a = 1) { for (const m of this.m) m.vc += a * 2.2 * m.w * (m.n % 2 ? 1 : -1); wake(this); }
  step(dt) {
    if (this.motion) {
      const { L, R, H } = this.motion; L.step(dt); R.step(dt); if (H) { H.step(dt); this.shape.h = H.x; this.shape.r = H.x / 2; }
      const v = (L.v + R.v) / 2; this.slosh((v - this.pv) / dt / 1000 / (this.shape.h / 2) * 14, dt); this.pv = v;
      this.shape.cx = (L.x + R.x) / 2; this.shape.w = Math.max(this.shape.h * 0.7, R.x - L.x);
    }
    for (const m of this.m) {
      const z = this.held ? 0.75 : m.z, k = m.om * m.om, c = 2 * z * m.om;
      m.vc += (-k * (m.c - m.tc) - c * m.vc) * dt; m.c += m.vc * dt;
      m.vs += (-k * (m.s - m.ts) - c * m.vs) * dt; m.s += m.vs * dt;
    }
  }
  asleep() {
    if (this.held) return false;
    if (this.motion && !(this.motion.L.still && this.motion.R.still && (!this.motion.H || this.motion.H.still))) return false;
    return this.m.every((m) => Math.abs(m.c) < 0.0006 && Math.abs(m.s) < 0.0006 && Math.abs(m.vc) < 0.01 && Math.abs(m.vs) < 0.01);
  }
  render() {
    const s = this.shape, r = this.rr, o = outline(Math.max(s.w, 1), Math.max(s.h, 1), s.r), m1 = this.m[0], pad = this.pad;
    const ox = s.cx + pad + m1.c * r, oy = s.cy + pad + m1.s * r, pts = [];
    for (let i = 0; i < N; i++) {
      const t = (i / N) * 2 * Math.PI; let d = 0;
      for (let j = 1; j < this.m.length; j++) { const m = this.m[j]; d += m.c * Math.cos(m.n * t) + m.s * Math.sin(m.n * t); }
      d = Math.max(-0.6, Math.min(0.9, d)) * r;
      pts.push(ox + o[i * 4] + o[i * 4 + 2] * d, oy + o[i * 4 + 1] + o[i * 4 + 3] * d);
    }
    let p = "";
    for (let i = 0; i < N; i++) {
      const a = i * 2, b = ((i + 1) % N) * 2, mx = ((pts[a] + pts[b]) / 2).toFixed(1), my = ((pts[a + 1] + pts[b + 1]) / 2).toFixed(1);
      p += i ? `Q${pts[a].toFixed(1)} ${pts[a + 1].toFixed(1)} ${mx} ${my}` : `M${mx} ${my}`;
    }
    p += `Q${pts[0].toFixed(1)} ${pts[1].toFixed(1)} ${((pts[0] + pts[2]) / 2).toFixed(1)} ${((pts[1] + pts[3]) / 2).toFixed(1)}Z`;
    for (const el of this.paths) el.setAttribute("d", p);
    if (this.gl) this.gl.style.clipPath = `path('${p}')`;
    if (this.inner) { const k = s.h / this.h0, kw = s.w / this.w0; this.inner.style.transform = `translate(${(ox - (this.w0 / 2 + this.mg) * kw).toFixed(1)}px,${(oy - (this.h0 / 2 + this.mg) * k).toFixed(1)}px) scale(${kw.toFixed(3)},${k.toFixed(3)})`; }
    this.center = { x: this.box.x + s.cx + m1.c * r, y: this.box.y + s.cy + m1.s * r };
    if (this.onRender) this.onRender();
  }
}

// 箱 el の後ろに水を敷く。箱の大きさが変わったら作り直す。箱の中を押すと、押した所がへこむ。
// o.kind: glass／white／solid　o.radius: 角の半径（なければカプセル）　o.inset: 箱より内側へ小さくする量　o.lens: 水滴　o.press: false で押しても動かさない
export function water(el, o = {}) {
  let b = null, w0 = 0, h0 = 0;
  prep(el);
  const build = () => {
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h || (w === w0 && h === h0)) return;
    w0 = w; h0 = h; if (b) b.destroy();
    const [ix, iy] = [].concat(o.inset || 0, o.inset || 0), sw = w - ix * 2, sh = h - iy * 2; // inset は数か [横, 縦]
    b = new Blob(el, { x: 0, y: 0, w, h }, { cx: w / 2, cy: h / 2, w: sw, h: sh, r: o.radius != null ? Math.min(o.radius, sw / 2, sh / 2) : Math.min(sw, sh) / 2, lens: o.lens }, o.kind || "glass");
    if (o.onBuild) o.onBuild(b);
  };
  new ResizeObserver(build).observe(el); build();
  // 箱の中身を丸ごと入れ替えられると水が外れるので、戻す
  new MutationObserver(() => { if (b && !b.el.isConnected) el.prepend(b.el); }).observe(el, { childList: true });
  if (o.press !== false) {
    const pos = (e) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    el.addEventListener("pointerdown", (e) => b && b.press(...pos(e)));
    el.addEventListener("pointermove", (e) => b && b.held && b.press(...pos(e)));
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(ev, () => b && b.release());
  }
  return { get blob() { return b; }, nudge: (a) => b && b.nudge(a), slosh: (a) => { if (b) { b.slosh(a, 0.016); wake(b); } } };
}

// 箱の後ろに水を敷くための下ごしらえ（水を、箱の字の後ろ・箱の外の物の手前に置く）
function prep(el) {
  const cs = getComputedStyle(el);
  if (cs.position === "static") el.style.position = "relative";
  if (cs.zIndex === "auto") el.style.zIndex = "0";
}

// 選んでいる所を示す白い水のつぶ。host（横に流れる行でもよい）の中を、選んだ子の所へ移る。前のふちが先に着き、後ろのふちが遅れて付いてくる
export function indicator(host, { height = 38 } = {}) {
  let b = null;
  prep(host);
  return {
    to(el) {
      if (!el || !el.offsetWidth) return;
      const x = el.offsetLeft, w = el.offsetWidth, W = host.scrollWidth, H = host.clientHeight;
      if (!b || b.box.w !== W || b.box.h !== H) {
        if (b) b.destroy();
        b = new Blob(host, { x: 0, y: 0, w: W, h: H, pad: 0 }, { cx: x + w / 2, cy: H / 2, w, h: Math.min(height, H - 8) }, "white");
        b.motion = { L: new Spring(x, MOVE.lead, MOVE.zl), R: new Spring(x + w, MOVE.lead, MOVE.zl) };
        return;
      }
      if (!b.el.isConnected) host.prepend(b.el); // 行の中身を入れ替えた時に外れるので、戻す
      const { L, R } = b.motion;
      if (L.to === x && R.to === x + w) return;
      const right = x > L.to;
      (right ? R : L).set(MOVE.lead, MOVE.zl); (right ? L : R).set(MOVE.tail, MOVE.zt);
      L.to = x; R.to = x + w; wake(b);
    },
  };
}
