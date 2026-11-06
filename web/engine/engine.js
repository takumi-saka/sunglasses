// 画の処理のまとめ役（2026-11-05）。
// RAW を読む（raw-worker.js）→ GPU に載せる → 現像（核とつまみ）→ ぼかし系の部品 → 画面か書き出しへ。
// 式と順番は、パソコンの道具（カメラアプリ/_work/scripts/look_lr.py）と同じ。大きさで効き方が変わる部品
// （テクスチャ・明瞭度・やわらかさ・粒・にじみ・白み）は、どれも「画全体の幅・高さ」に比例させるので、
// 画面で見た画と書き出した画が同じに見える。
import * as C from "./color.js";
import * as S from "./shaders.js";

const HSL_KEYS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"];
const GRADE_ZONES = [["shadows", 25], ["midtones", 20], ["highlights", 25], ["global", 15]];
const zone = () => ({ hue: 0, sat: 0, lum: 0 });

// つまみの初期値（0 が核のまま）
export function defaultParams() {
  return {
    core: "aftersun", sunLevel: 100,
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    curve: { rgb: null, r: null, g: null, b: null },
    param: { shadows: 0, darks: 0, lights: 0, highlights: 0 },
    temp: 0, tint: 0, vibrance: 0, saturation: 0,
    hsl: { hue: new Array(8).fill(0), sat: new Array(8).fill(0), lum: new Array(8).fill(0) },
    grading: { shadows: zone(), midtones: zone(), highlights: zone(), global: zone(), balance: 0 },
    texture: 0, clarity: 0, dehaze: 0, vignette: 0,
    grain: 0, grainSize: 0, halation: 0, bloom: 0, soften: 0,
    sharpen: 0, noise: 0, colorNoise: 0,
    bw: false,
    crop: { cx: 0.5, cy: 0.5, w: 1, h: 1, angle: 0 },
  };
}
export { HSL_KEYS };

const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function mul33(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

export class Engine {
  static async create(canvas, opts = {}) {
    const e = new Engine(canvas, opts);
    await e._init();
    return e;
  }

  constructor(canvas, { looksBase } = {}) {
    this.canvas = canvas;
    this.looksBase = looksBase || new URL("../looks/", import.meta.url).href;
    this.params = defaultParams();
    this.view = { zoom: 1, cx: 0.5, cy: 0.5 };
    this.compare = false;
    this.clip = false;
    this.image = null;
    this.evCache = {};
    this.seed = 1;
    this.pool = new Map();
    this.noiseCache = null;
    this.curveKey = "";
    this.onRendered = null;
    this._raf = 0;
  }

  async _init() {
    const gl = this.canvas.getContext("webgl2", {
      antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false,
      preserveDrawingBuffer: false, powerPreference: "high-performance",
    });
    if (!gl) throw new Error("この端末では、画の処理（WebGL2）が使えません。");
    this.gl = gl;
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("この端末では、細かい色の計算（浮動小数点の画）が使えません。");
    gl.getExtension("OES_texture_float_linear");
    this.vao = gl.createVertexArray();
    const fs = {
      raw2f: S.FS_RAW2F, jpeg2f: S.FS_JPEG2F, develop: S.FS_DEVELOP, blur: S.FS_BLUR, copy: S.FS_COPY, nr: S.FS_NR,
      texture: S.FS_TEXTURE, clarity: S.FS_CLARITY, sharpen: S.FS_SHARPEN, noise: S.FS_NOISE, finish: S.FS_FINISH,
      halSrc: S.FS_HAL_SRC, halAdd: S.FS_HAL_ADD, bloomSrc: S.FS_BLOOM_SRC, final: S.FS_FINAL,
    };
    this.progs = {};
    for (const [k, src] of Object.entries(fs)) this.progs[k] = this._program(S.VS, src, k);
    await this._loadLooks();
    this.worker = new Worker(new URL("./raw-worker.js", import.meta.url), { type: "module" });
    this.thumbWorker = null; // 一覧の小さな画を作る係（使うときに作る）
    this.jobs = new Map();
    this.jobId = 0;
    this.onWorker = (e) => {
      const j = this.jobs.get(e.data.id);
      if (!j) return;
      if (e.data.stage === "thumb") {
        if (j.onThumb) j.onThumb(e.data.thumb, e.data.flip);
        return;
      }
      this.jobs.delete(e.data.id);
      if (e.data.stage === "done") j.resolve(e.data);
      else j.reject(new Error(e.data.error));
    };
    this.worker.onmessage = this.onWorker;
  }

  // 一覧の小さな画: RAW を半分の大きさで読み、長い辺 size に縮めた光の量の画を返す（編集と同じ流れで核をかけるため）
  decodeThumb(buf, size = 384) {
    if (!this.thumbWorker) {
      this.thumbWorker = new Worker(new URL("./raw-worker.js", import.meta.url), { type: "module" });
      this.thumbWorker.onmessage = this.onWorker;
    }
    const id = ++this.jobId;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.thumbWorker.postMessage({ id, cmd: "thumb", buf, size }, [buf]);
    });
  }

  // ---------- 核（色の対応表）と、決まった曲線 ----------
  async _loadLooks() {
    const gl = this.gl;
    const looks = await (await fetch(new URL("looks.json", this.looksBase))).json();
    this.targetL = looks.targetL;
    this.ap0ToAp1 = C.flat3(looks.ap0ToAp1);
    this.ap0ToSrgb = C.flat3(looks.ap0ToSrgb);
    this.srgbToAp0 = C.flat3(looks.srgbToAp0);
    this.neutralCurve = Float32Array.from(looks.neutralCurve);
    this.neutralCurveTex = this._curveTex([this.neutralCurve]);
    this.jpegToLinear = Float32Array.from(looks.jpegToLinear);
    this.jpegToLinearTex = this._curveTex([this.jpegToLinear]);
    this.cores = await Promise.all(looks.cores.map(async (c) => {
      const half = new Uint16Array(await (await fetch(new URL(c.file, this.looksBase))).arrayBuffer());
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, c.size, c.size, c.size, 0, gl.RGB, gl.HALF_FLOAT, half);
      for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
        [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, p, v);
      return { ...c, tex, cpu: new C.CpuLut(c.size, c.lo, c.hi, C.halfToFloat(half)) };
    }));
    this.curvesTex = this._curveTex([0, 1, 2, 3].map(() => C.pchip([])));
  }

  coreById(id) {
    return this.cores.find((c) => c.id === id) || this.cores[0];
  }

  // Sun Level（0〜100）から、混ぜる核と重みを決める（2026-11-06 に核を3つにした）。
  // Aftersun+（id aftersun、最初の形）は 0 が素の画・50 が弱め・100 が Aftersun+（あいだはなめらかに混ぜる）。
  // Aftersun（id aftersun2、逆算の形）と Nostalgia（id mine）は、0 が素の画・100 がその核
  lookFor(p) {
    const L = C.clamp((p.sunLevel ?? p.strength ?? 100) / 100, 0, 1);
    if (p.core !== "aftersun") return { A: this.coreById(p.core), wA: L, B: null, wB: 0, wN: 1 - L };
    const A = this.coreById("weak"), B = this.coreById("aftersun");
    return L <= 0.5 ? { A, wA: 2 * L, B, wB: 0, wN: 1 - 2 * L } : { A, wA: 2 - 2 * L, B, wB: 2 * L - 1, wN: 0 };
  }

  // 核ごとの値（にじみ・白み・やわらかさ・粒）を重みで混ぜる。素の画は 0（フィルムらしさも素に戻る）
  _mixedCore(lk) {
    const sum = (k) => lk.wA * lk.A[k] + (lk.B ? lk.wB * lk.B[k] : 0);
    const w = lk.wA + lk.wB || 1, avg = (k) => sum(k) / w;
    return { soften: sum("soften"), grain: sum("grain"), grainSize: avg("grainSize"), halation: sum("halation"), bloom: sum("bloom"), bloomWarm: avg("bloomWarm") };
  }

  _lookUniforms(lk, gain) {
    const B = lk.B || lk.A;
    return {
      uLutA: { tex: lk.A.tex }, uLoA: lk.A.lo, uHiA: lk.A.hi, uNA: lk.A.size, uGainA: lk.wA > 0 ? gain(lk.A) : 1, uWA: lk.wA,
      uLutB: { tex: B.tex }, uLoB: B.lo, uHiB: B.hi, uNB: B.size, uGainB: lk.B && lk.wB > 0 ? gain(lk.B) : 1, uWB: lk.wB, uWN: lk.wN,
    };
  }

  _curveTex(rows) {
    const gl = this.gl, n = rows[0].length, data = new Float32Array(n * rows.length);
    rows.forEach((r, i) => data.set(r, i * n));
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, n, rows.length, 0, gl.RED, gl.FLOAT, data);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
    return t;
  }

  // ---------- 写真を開く ----------
  decodeRaw(buf, { onThumb } = {}) {
    const id = ++this.jobId;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, onThumb });
      this.worker.postMessage({ id, cmd: "decode", buf, wantThumb: !!onThumb }, [buf]);
    });
  }

  async openRaw(buf, { onThumb } = {}) {
    const d = await this.decodeRaw(buf, { onThumb });
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16UI, d.w, d.h, 0, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, d.pixels);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
    this._makeSource(d.w, d.h, "raw2f", { uRaw: t });
    gl.deleteTexture(t);
    this._setImage({ kind: "raw", w: d.w, h: d.h, meta: d.meta, small: d.small, key: d.key });
    return this.image;
  }

  // JPEG（ほかのアプリから渡されたもの）。素直な現像の逆で光の量に戻してから、RAW と同じ流れに通す
  async openBitmap(bitmap, meta = {}) {
    const gl = this.gl, t = this._uploadBitmap(bitmap);
    this._makeSource(bitmap.width, bitmap.height, "jpeg2f", { uJpeg: t, uToLinear: this.jpegToLinearTex, uSrgbToAp0: this.srgbToAp0 });
    gl.deleteTexture(t);
    const { small, key } = this._smallFromBitmap(bitmap);
    this._setImage({ kind: "jpeg", w: bitmap.width, h: bitmap.height, meta, small, key });
    return this.image;
  }

  _uploadBitmap(bitmap) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
    return t;
  }

  _smallFromBitmap(bitmap) {
    const sw = 160, sh = Math.max(1, Math.round((bitmap.height * sw) / bitmap.width));
    const cv = new OffscreenCanvas(sw, sh), cx = cv.getContext("2d");
    cx.imageSmoothingQuality = "high";
    cx.drawImage(bitmap, 0, 0, sw, sh);
    const px = cx.getImageData(0, 0, sw, sh).data, small = new Float32Array(sw * sh * 3);
    let sl = 0, cnt = 0;
    for (let i = 0; i < sw * sh; i++) {
      const lin = [0, 1, 2].map((k) => C.curveAt(this.jpegToLinear, px[i * 4 + k] / 255));
      const a = C.mul3(this.srgbToAp0, lin[0], lin[1], lin[2]).map((v) => Math.max(v, 0));
      small.set(a, i * 3);
      const y = C.AP0_Y[0] * a[0] + C.AP0_Y[1] * a[1] + C.AP0_Y[2] * a[2];
      if (y > 0) {
        sl += Math.log(Math.max(y, 1e-6));
        cnt++;
      }
    }
    return { small, key: cnt ? Math.exp(sl / cnt) : 0.18 };
  }

  _makeSource(w, h, prog, uniforms) {
    const gl = this.gl;
    if (this.src) {
      gl.deleteTexture(this.src.tex);
      gl.deleteFramebuffer(this.src.fb);
    }
    const tex = gl.createTexture(), levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, w, h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this._pass(prog, { fb, w, h }, uniforms);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
    this.src = { tex, fb, w, h };
  }

  _setImage(im) {
    this.image = im;
    this.evCache = {};
    this.noiseCache = null;
    this.seed = (Math.random() * 1e9) >>> 0;
    this.view = { zoom: 1, cx: 0.5, cy: 0.5 };
    this.requestRender();
  }

  // 露光量の自動合わせ（核ごと・素直な現像。一度求めたら覚えておく）
  autoEv(id) {
    if (!this.image) return 0;
    if (this.evCache[id] === undefined) {
      const im = this.image;
      if (id === "neutral") {
        this.evCache[id] = C.searchEv((ev) => C.medianNeutral(im.small, im.key, ev, this.ap0ToSrgb, this.neutralCurve), this.targetL);
      } else {
        const c = this.coreById(id);
        this.evCache[id] = C.searchEv((ev) => C.medianCore(im.small, im.key, ev, c.cpu, this.ap0ToAp1), this.targetL + c.lift);
      }
    }
    return this.evCache[id];
  }

  // ---------- つまみ・見え方 ----------
  setParams(p) {
    this.params = p;
    this.requestRender();
  }
  setView(v) {
    this.view = { ...this.view, ...v };
    this.view.zoom = C.clamp(this.view.zoom, 1, this.maxZoom());
    this.requestRender();
  }
  setCompare(on) {
    this.compare = on;
    this.requestRender();
  }
  setClip(on) {
    this.clip = on;
    this.requestRender();
  }
  // 画面いっぱいに合わせたときの倍率から、元の大きさの 2 倍まで寄れる
  maxZoom() {
    const l = this.layout();
    return l ? Math.max(1, (2 * this._cropPx().w) / (l.VW / this.view.zoom)) : 1;
  }

  requestRender() {
    if (this._raf || !this.image) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._renderView();
    });
  }

  _cropPx() {
    const c = this.params.crop;
    return { w: c.w * this.src.w, h: c.h * this.src.h };
  }

  // 切り抜きの中の位置（0〜1）→ 元の画の位置（0〜1）
  _cropToSrc() {
    const c = this.params.crop, { w: cw, h: ch } = this._cropPx(), th = (c.angle * Math.PI) / 180;
    const sw = this.src.w, sh = this.src.h, cs = Math.cos(th), sn = Math.sin(th);
    const toPx = [cw, 0, -cw / 2, 0, ch, -ch / 2, 0, 0, 1];
    const rot = [cs, -sn, 0, sn, cs, 0, 0, 0, 1];
    const toSrc = [1 / sw, 0, c.cx, 0, 1 / sh, c.cy, 0, 0, 1];
    return mul33(toSrc, mul33(rot, toPx));
  }

  layout() {
    if (!this.image) return null;
    const cw = this.canvas.width, ch = this.canvas.height, { w: pw, h: ph } = this._cropPx();
    const fit = Math.min(cw / pw, ch / ph);
    const VW = Math.max(1, Math.round(pw * fit * this.view.zoom)), VH = Math.max(1, Math.round(ph * fit * this.view.zoom));
    const rw = Math.min(cw, VW), rh = Math.min(ch, VH);
    const x0 = C.clamp(Math.round(this.view.cx * VW - rw / 2), 0, VW - rw), y0 = C.clamp(Math.round(this.view.cy * VH - rh / 2), 0, VH - rh);
    return { VW, VH, x0, y0, rw, rh, dx: Math.round((cw - rw) / 2), dy: Math.round((ch - rh) / 2), fit };
  }

  _renderView() {
    const gl = this.gl, l = this.layout();
    if (!l) return;
    const zoomed = l.VW > l.rw || l.VH > l.rh;
    const m = zoomed ? Math.min(512, Math.ceil(0.09 * l.VH)) : 0;
    const bx0 = Math.max(0, l.x0 - m), by0 = Math.max(0, l.y0 - m);
    const bw = Math.min(l.VW, l.x0 + l.rw + m) - bx0, bh = Math.min(l.VH, l.y0 + l.rh + m) - by0;
    const r = this._renderRegion(l.VW, l.VH, bx0, by0, bw, bh, { compare: this.compare });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // 画面の下が vUv.y = 0。画は 1 行目が上なので、上下を返して、余白の内側だけを出す
    const xf = [l.rw / bw, 0, (l.x0 - bx0) / bw, 0, -l.rh / bh, (l.y0 - by0 + l.rh) / bh, 0, 0, 1];
    this._final(r, { fb: null, x: l.dx, y: this.canvas.height - l.dy - l.rh, w: l.rw, h: l.rh }, xf, this.clip);
    if (this.onRendered) {
      const hist = this._histogram(r);
      this.onRendered({ layout: l, hist });
    }
    this._release(r.used);
  }

  _final(r, target, xf, clip) {
    const p = this.params;
    this._pass("final", target, {
      uRgb: r.rgb, uGlow: r.glow || r.rgb, uBloomOn: r.glow ? 1 : 0, uBloom: r.bloom, uWarm: r.warm, uXf: xf,
      uBw: p.bw && !this.compare ? 1 : 0, uClip: clip ? 1 : 0,
    });
  }

  // 画の一部（全体の大きさ VW×VH のうち、左上 x0,y0 から bw×bh）を描く。
  // 途中の画は使い終わったらすぐ返して使い回す（元の大きさで書き出すとき、同時に持つのを 3〜4 枚に抑える）
  _renderRegion(VW, VH, x0, y0, bw, bh, { compare = false } = {}) {
    const P = this.params, im = this.image;
    const lk = compare ? { A: this.coreById("aftersun"), wA: 0, B: null, wB: 0, wN: 1 } : this.lookFor(P);
    const core = this._mixedCore(lk);
    const rt = () => this._rt(bw, bh);
    const toCrop = [bw / VW, 0, x0 / VW, 0, bh / VH, y0 / VH, 0, 0, 1];
    const gain = (c) => (0.18 / im.key) * Math.pow(2, this.autoEv(c.id) + P.exposure);
    const gainN = (0.18 / im.key) * Math.pow(2, this.autoEv("neutral") + P.exposure);
    let cur = rt();
    this._pass("develop", cur, {
      uSrc: this.src.tex, uXf: mul33(this._cropToSrc(), toCrop), ...this._lookUniforms(lk, gain),
      uAp0ToAp1: this.ap0ToAp1, uAp0ToSrgb: this.ap0ToSrgb, uNeutralCurve: this.neutralCurveTex,
      uGainN: gainN, uKnobs: compare ? 0 : 1, ...this._knobUniforms(),
    });
    const swap = (o) => {
      this._give(cur);
      cur = o;
    };
    if (!compare) {
      if (P.noise > 0 || P.colorNoise > 0) {
        const o = rt();
        this._pass("nr", o, { uLab: cur, uTexel: [1 / bw, 1 / bh], uStep: Math.max(1, VW / 4096), uLuma: (P.noise / 100) * 6, uChroma: P.colorNoise / 100 });
        swap(o);
      }
      const sc = VW / 512;
      if (P.texture) {
        const b = this._blur(cur, 1.0 * sc), o = rt();
        this._pass("texture", o, { uLab: cur, uBlur: b, uAmt: P.texture / 100 });
        this._give(b);
        swap(o);
      }
      if (P.clarity) {
        const b1 = this._blur(cur, 1.5 * sc), b2 = this._blur(cur, 8.0 * sc), o = rt();
        this._pass("clarity", o, { uLab: cur, uSmall: b1, uLarge: b2, uAmt: P.clarity / 100 });
        this._release([b1, b2]);
        swap(o);
      }
      const soften = core.soften * (1 + P.soften / 100);
      if (soften > 0) swap(this._blur(cur, (soften * VW) / 2048));
      if (P.sharpen > 0) {
        const b = this._blur(cur, Math.max(0.7, VW / 2048)), o = rt();
        this._pass("sharpen", o, { uLab: cur, uBlur: b, uAmt: (P.sharpen / 100) * 1.5, uThreshold: 0.4 });
        this._give(b);
        swap(o);
      }
    }
    const grain = compare ? 0 : Math.max(0, core.grain * (1 + P.grain / 100));
    let noise = null, amp = 0;
    if (grain > 0) {
      const size = C.clamp(core.grainSize + P.grainSize, 0, 100);
      const n = this._noise(x0, y0, bw, bh, Math.max(((0.5 + (size / 100) * 2) * VW) / 2048, 0.3));
      noise = n.tex;
      amp = ((grain / 100) * 10 * Math.min(1, Math.sqrt(VW / 2048))) / n.norm;
    }
    const rgb = rt();
    this._pass("finish", rgb, { uLab: cur, uNoise: noise || cur, uGrainOn: noise ? 1 : 0, uGrainAmp: amp, uVignette: compare ? 0 : P.vignette, uToCrop: toCrop });
    this._give(cur);
    const out = { rgb, glow: null, bloom: 0, warm: core.bloomWarm };
    if (!compare) {
      const hal = core.halation * (1 + P.halation / 100);
      if (hal > 0) {
        const s = rt();
        this._pass("halSrc", s, { uRgb: out.rgb });
        const g = this._blurBig(s, 0.01 * VH);
        this._give(s);
        const o = rt();
        this._pass("halAdd", o, { uRgb: out.rgb, uGlow: g, uAmt: hal, uOn: 1 });
        this._release([g, out.rgb]);
        out.rgb = o;
      }
      const bloom = core.bloom * (1 + P.bloom / 100);
      if (bloom > 0) {
        const s = rt();
        this._pass("bloomSrc", s, { uRgb: out.rgb });
        out.glow = this._blurBig(s, 0.03 * VH);
        this._give(s);
        out.bloom = bloom;
      }
    }
    out.used = [out.rgb, out.glow].filter(Boolean);
    return out;
  }

  _knobUniforms() {
    const P = this.params;
    const ck = JSON.stringify(P.curve);
    if (ck !== this.curveKey) {
      this.curveKey = ck;
      this.gl.deleteTexture(this.curvesTex);
      this.curvesTex = this._curveTex(["rgb", "r", "g", "b"].map((k) => C.pchip(P.curve[k] || [])));
    }
    const curveOn = ["rgb", "r", "g", "b"].some((k) => P.curve[k] && P.curve[k].length);
    const hslOn = ["hue", "sat", "lum"].some((k) => P.hsl[k].some((v) => v));
    const g = P.grading, ab = [], lum = [];
    let gradeOn = false;
    for (const [z, K] of GRADE_ZONES) {
      const w = C.wheel(g[z].hue);
      ab.push(w[0] * (g[z].sat / 100) * K, w[1] * (g[z].sat / 100) * K);
      lum.push((g[z].lum / 100) * 10);
      if (g[z].sat || g[z].lum) gradeOn = true;
    }
    return {
      uContrast: P.contrast, uHighlights: P.highlights, uShadows: P.shadows, uWhites: P.whites, uBlacks: P.blacks,
      uTemp: P.temp, uTint: P.tint, uDehaze: P.dehaze,
      uParam: [P.param.shadows, P.param.darks, P.param.lights, P.param.highlights].map((v) => (v / 100) * 0.08),
      uCurveOn: curveOn ? 1 : 0, uCurves: this.curvesTex, uSat: P.saturation, uVib: P.vibrance,
      uHslOn: hslOn ? 1 : 0, uHslH: P.hsl.hue.map((v) => (v / 100) * 30), uHslS: P.hsl.sat.map((v) => v / 100),
      uHslL: P.hsl.lum.map((v) => (v / 100) * 15),
      uGradeOn: gradeOn ? 1 : 0, uBalance: g.balance, uGradeAB: ab, uGradeLum: lum,
    };
  }

  // ---------- ぼかし（新しい画を返す。渡した画はそのまま）----------
  _blur(tex, sigma) {
    const w = C.gaussWeights(sigma);
    if (w.length > 49) return this._blurBig(tex, sigma);
    const a = this._rt(tex.w, tex.h), b = this._rt(tex.w, tex.h);
    if (w.length === 1) {
      this._pass("copy", b, { uTex: tex, uXf: I3 });
    } else {
      const W = new Float32Array(49);
      W.set(w);
      this._pass("blur", a, { uTex: tex, uDir: [1 / tex.w, 0], uRadius: w.length - 1, uW: W });
      this._pass("blur", b, { uTex: a, uDir: [0, 1 / tex.h], uRadius: w.length - 1, uW: W });
    }
    this._give(a);
    return b;
  }

  // 大きいぼかしは、画を縮めてからぼかし、元の大きさに広げる
  _blurBig(tex, sigma) {
    let k = 0;
    while (sigma / 2 ** k > 6) k++;
    if (k === 0) return this._blur(tex, sigma);
    let cur = tex;
    const tmp = [];
    for (let i = 0; i < k; i++) {
      const o = this._rt(Math.max(1, Math.ceil(cur.w / 2)), Math.max(1, Math.ceil(cur.h / 2)));
      this._pass("copy", o, { uTex: cur, uXf: I3 });
      if (cur !== tex) tmp.push(cur);
      cur = o;
    }
    const bl = this._blur(cur, sigma / 2 ** k);
    tmp.push(cur);
    const up = this._rt(tex.w, tex.h);
    this._pass("copy", up, { uTex: bl, uXf: I3 });
    tmp.push(bl);
    this._release(tmp);
    return up;
  }

  // 粒のもと（場所と大きさが同じなら作り直さない）
  _noise(x0, y0, w, h, sigma) {
    const key = [x0, y0, w, h, sigma.toFixed(4), this.seed].join(",");
    if (this.noiseCache && this.noiseCache.key === key) return this.noiseCache;
    if (this.noiseCache) this._release(this.noiseCache.own);
    const raw = this._rt(w, h);
    this._pass("noise", raw, { uOrigin: [x0, y0], uSize: [w, h], uSeed: this.seed });
    const wts = C.gaussWeights(sigma);
    const s1 = wts.reduce((s, v, i) => s + (i ? 2 : 1) * v * v, 0);
    const tex = this._blur(raw, sigma);
    this._give(raw);
    this.noiseCache = { key, tex, norm: s1, own: [tex] };
    return this.noiseCache;
  }

  // ---------- 明るさの山（ヒストグラム）----------
  _histogram(r) {
    const gl = this.gl, w = 128, h = Math.max(1, Math.round((128 * r.rgb.h) / r.rgb.w));
    const t = this._rt(w, h, true);
    this._final(r, t, I3, false);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this._release([t]);
    const bins = { r: new Uint32Array(64), g: new Uint32Array(64), b: new Uint32Array(64), l: new Uint32Array(64), n: w * h };
    for (let i = 0; i < px.length; i += 4) {
      bins.r[px[i] >> 2]++;
      bins.g[px[i + 1] >> 2]++;
      bins.b[px[i + 2] >> 2]++;
      bins.l[Math.min(63, Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) >> 2)]++;
    }
    return bins;
  }

  // ---------- 書き出し ----------
  // 元の大きさ（maxSide を決めればその長さまで縮める）で描き、JPEG にする
  async exportJpeg({ maxSide = 0, quality = 0.95 } = {}) {
    const gl = this.gl, c = this._cropPx();
    let VW = Math.round(c.w), VH = Math.round(c.h);
    if (maxSide && Math.max(VW, VH) > maxSide) {
      const s = maxSide / Math.max(VW, VH);
      VW = Math.round(VW * s);
      VH = Math.round(VH * s);
    }
    const r = this._renderRegion(VW, VH, 0, 0, VW, VH, {});
    const t = this._rt(VW, VH, true);
    this._final(r, t, I3, false);
    const px = new Uint8ClampedArray(VW * VH * 4);
    gl.readPixels(0, 0, VW, VH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this._release([t, ...r.used]);
    this._afterBig();
    const cv = new OffscreenCanvas(VW, VH);
    cv.getContext("2d").putImageData(new ImageData(px, VW, VH), 0, 0);
    return cv.convertToBlob({ type: "image/jpeg", quality });
  }

  // 確かめ用: 元の大きさ（または幅 width）で描き、画素の値（RGBA、1 行目が上）を返す
  renderPixels(width = 0, { compare = false } = {}) {
    const gl = this.gl, c = this._cropPx();
    const VW = width || Math.round(c.w), VH = Math.round((VW * c.h) / c.w);
    const r = this._renderRegion(VW, VH, 0, 0, VW, VH, { compare });
    const t = this._rt(VW, VH, true);
    this._final(r, t, I3, false);
    const px = new Uint8Array(VW * VH * 4);
    gl.readPixels(0, 0, VW, VH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this._release([t, ...r.used]);
    this._afterBig();
    return { width: VW, height: VH, pixels: px };
  }

  // ---------- 一覧の小さな画（RAW から作った小さな光の量の画に、核だけをかける）----------
  // look は { core, sunLevel }（核の名前だけを渡すと Sun Level 100）
  renderThumb(t, look, canvas) {
    const lk = this.lookFor(typeof look === "string" ? { core: look === "weak" ? "aftersun" : look, sunLevel: look === "weak" ? 50 : 100 } : look);
    const gl = this.gl, w = t.tw, h = t.th, used = [];
    const up = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, up);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, w, h, 0, gl.RGB, gl.FLOAT, t.thumb);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
    const src = { tex: up };
    const { small, key } = t;
    const gain = (c) => (0.18 / key) * Math.pow(2, C.searchEv((e) => C.medianCore(small, key, e, c.cpu, this.ap0ToAp1), this.targetL + c.lift));
    const gainN = lk.wN > 0 ? (0.18 / key) * Math.pow(2, C.searchEv((e) => C.medianNeutral(small, key, e, this.ap0ToSrgb, this.neutralCurve), this.targetL)) : 1;
    const lab = this._rt(w, h), rgb = this._rt(w, h), out = this._rt(w, h, true);
    used.push(lab, rgb, out);
    this._pass("develop", lab, {
      uSrc: src, uXf: I3, ...this._lookUniforms(lk, gain),
      uAp0ToAp1: this.ap0ToAp1, uAp0ToSrgb: this.ap0ToSrgb, uNeutralCurve: this.neutralCurveTex,
      uGainN: gainN, uKnobs: 0, ...this._knobUniforms(),
    });
    this._pass("finish", rgb, { uLab: lab, uNoise: lab, uGrainOn: 0, uGrainAmp: 0, uVignette: 0, uToCrop: I3 });
    this._pass("final", out, { uRgb: rgb, uGlow: rgb, uBloomOn: 0, uBloom: 0, uWarm: 0, uXf: I3, uBw: 0, uClip: 0 });
    const px = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this._release(used);
    gl.deleteTexture(up);
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
  }

  // ---------- GPU の下回り ----------
  _program(vsSrc, fsSrc, name) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`式 ${name} が組み立てられません: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`式 ${name} をつなげません: ${gl.getProgramInfoLog(p)}`);
    const uniforms = {};
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      const u = gl.getActiveUniform(p, i);
      uniforms[u.name.replace(/\[0\]$/, "")] = { loc: gl.getUniformLocation(p, u.name), type: u.type, size: u.size };
    }
    return { p, uniforms };
  }

  _pass(name, target, values) {
    const gl = this.gl, prog = this.progs[name];
    gl.useProgram(prog.p);
    gl.bindVertexArray(this.vao);
    let unit = 0;
    for (const [k, v] of Object.entries(values)) {
      const u = prog.uniforms[k];
      if (!u || v === undefined) continue;
      switch (u.type) {
        case gl.SAMPLER_2D:
        case gl.UNSIGNED_INT_SAMPLER_2D:
        case gl.SAMPLER_3D:
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(u.type === gl.SAMPLER_3D ? gl.TEXTURE_3D : gl.TEXTURE_2D, v.tex || v);
          gl.uniform1i(u.loc, unit++);
          break;
        case gl.FLOAT:
          if (u.size > 1) gl.uniform1fv(u.loc, v);
          else gl.uniform1f(u.loc, v);
          break;
        case gl.FLOAT_VEC2:
          gl.uniform2fv(u.loc, v);
          break;
        case gl.FLOAT_VEC3:
          gl.uniform3fv(u.loc, v);
          break;
        case gl.FLOAT_VEC4:
          gl.uniform4fv(u.loc, v);
          break;
        case gl.FLOAT_MAT3:
          gl.uniformMatrix3fv(u.loc, true, v);
          break;
        case gl.UNSIGNED_INT:
          gl.uniform1ui(u.loc, v);
          break;
        default:
          gl.uniform1i(u.loc, v);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(target.x || 0, target.y || 0, target.w, target.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // 描く先の画（浮動小数点。bytes=true なら 8 ビット）。使い回す
  _rt(w, h, bytes = false) {
    const gl = this.gl, key = `${w}x${h}:${bytes ? 8 : 16}`, free = this.pool.get(key);
    if (free && free.length) return free.pop();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, bytes ? gl.RGBA8 : gl.RGBA16F, w, h);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h, key };
  }

  _give(t) {
    if (t && t.key) this._release([t]);
  }

  _release(list) {
    for (const t of list) {
      if (!t || !t.key) continue;
      if (!this.pool.has(t.key)) this.pool.set(t.key, []);
      const free = this.pool.get(t.key);
      if (!free.includes(t)) free.push(t);
    }
  }

  // 元の大きさで描いたあと: 粒のもとと、画面より大きい使っていない画を捨てる
  _afterBig() {
    if (this.noiseCache) {
      this._release(this.noiseCache.own);
      this.noiseCache = null;
    }
    const keep = this.canvas.width * this.canvas.height * 1.5;
    for (const [k, free] of this.pool) {
      const [w, h] = k.split(":")[0].split("x").map(Number);
      if (w * h <= keep) continue;
      for (const t of free.splice(0)) {
        this.gl.deleteTexture(t.tex);
        this.gl.deleteFramebuffer(t.fb);
      }
    }
  }
}
