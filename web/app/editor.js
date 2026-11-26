// 編集の画面（2026-11-05。見た目は 2026-11-26 に作り直し）。
// 写真の上: 押している間は元の画、2 回たたくと全画面、2 本指でつまむと拡大、拡大中は 1 本指で動かす。
// 写真の下: ルックの名前、動かす値（名前を横に並べ、選んだ 1 つを大きな数字と目盛りで動かす）、言葉のタブ。
import { defaultParams, lookParams, lookState, sunCoreOf, sunGainOf, SOLO_CORES, SUN_CORES } from "../engine/engine.js";
import { shotInfo } from "../engine/exif.js";
import { UTSURUN_CORE } from "../engine/utsurun.js";
import * as bridge from "./bridge.js";
import { cropForAspect, panCrop, rotateCrop, zoomCrop } from "./crop.js";
import { curveEditor } from "./curve.js";
import { ASPECTS, GRADE_ZONES, GROUPS, HSL_COLORS, HSL_NAMES, KNOBS, L, changed, num, signed } from "./knobs.js";
import { deleteEdit, getEdit, pref, setEdit } from "./store.js";
import { closeSheet, h, sheet, slider, toast } from "./ui.js";

const UNDER_MIN = 382; // 写真の下に必ず残す高さ（名前の行・値の名前・大きな数字・目盛り・タブ）。縦の写真でも、カラーミキサーの目盛りまで切れずに入る高さ
const HIST_GROUPS = ["basic", "light", "color", "effect", "detail"]; // 目盛りの下に明るさの山を出すタブ
const AUTO_CORE = "cinema"; // 2026-11-10 夜 直していない写真は Cinema（映画の見た目の核）で開く。前は aftersun2
const AUTO = { core: AUTO_CORE, sunLevel: 0 }; // Cinema の Sun Level（Aftersun を足す量）は 0 がはじめの値
const FLIP_DEG = { 3: 180, 5: -90, 6: 90 };
const clone = (o) => JSON.parse(JSON.stringify(o));
const checkIcon = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.innerHTML = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
  return svg;
};

export function mergeParams(saved) {
  const p = defaultParams();
  const walk = (dst, src) => {
    for (const [k, v] of Object.entries(src || {})) {
      if (v && typeof v === "object" && !Array.isArray(v) && dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k])) walk(dst[k], v);
      else if (k in dst) dst[k] = v;
    }
  };
  walk(p, saved);
  // 前の形（核の強さ・Aftersun 弱めの核）で直した写真は、Sun Level に読み替える
  if (saved && saved.sunLevel === undefined && saved.strength !== undefined) p.sunLevel = saved.strength;
  if (saved && saved.core === "weak") {
    p.core = "aftersun";
    if (saved.sunLevel === undefined) p.sunLevel = 50;
  }
  return p;
}

export class Editor {
  constructor(engine, { onBack, onSaved }) {
    this.engine = engine;
    this.onBack = onBack;
    this.onSaved = onSaved;
    window.addEventListener("sunglasses:deleted", (e) => this.onDeleted(e.detail || {}));
    window.addEventListener("sunglasses:orientation", (e) => {
      this.deviceDeg = e.detail.deg;
      this.updateLand();
    });
    this.root = document.getElementById("editor");
    this.photo = document.getElementById("ed-photo");
    this.preview = document.getElementById("ed-preview");
    this.badge = document.getElementById("ed-badge");
    this.grid = document.getElementById("ed-grid");
    this.panel = document.getElementById("ed-panel");
    this.tabs = document.getElementById("ed-tabs");
    // 明るさの山。目盛りの下に出す（出すタブは HIST_GROUPS）
    this.hist = h("canvas", { class: "ed-hist", "aria-label": "明るさの山。押している間は白飛びと黒つぶれを色で出す" });
    this.histBox = h("div", { class: "ed-histbox" }, this.hist);
    this.coreChip = document.getElementById("ed-core-chip");
    this.oneBtn = document.getElementById("ed-one");
    this.group = pref("group") || "basic";
    this.toolAt = {}; // タブごとに、選んでいる値の名前
    this.hslIndex = 4;
    this.gradeZone = "shadows";
    this.saveTimer = 0;
    document.getElementById("ed-back").onclick = () => this.onBack();
    document.getElementById("ed-undo").onclick = () => this.undo();
    document.getElementById("ed-redo").onclick = () => this.redo();
    document.getElementById("ed-export").onclick = () => this.exportSheet();
    // 見比べの印: 押している間は元の画（写真の長押しと同じ）
    const cmp = document.getElementById("ed-cmp");
    const compare = (on) => {
      if (!this.ready || this.comparing === on) return;
      this.comparing = on;
      this.engine.setCompare(on);
      this.setBadge(on ? L("Original", "補正前") : "");
      if (on) bridge.haptic("tick");
    };
    cmp.addEventListener("pointerdown", (e) => (cmp.setPointerCapture(e.pointerId), compare(true)));
    for (const ev of ["pointerup", "pointercancel"]) cmp.addEventListener(ev, () => compare(false));
    this.coreChip.onclick = () => this.showGroup("core");
    this.oneBtn.onclick = () => this.toggleOneToOne();
    // 明るさの山を押している間だけ、白飛び（赤）と黒つぶれ（青）を色で出す
    this.hist.addEventListener("pointerdown", () => engine.setClip(true));
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) this.hist.addEventListener(ev, () => engine.setClip(false));
    new ResizeObserver(() => this.resize()).observe(this.photo);
    window.addEventListener("resize", () => this.layoutPhoto());
    this.gestures();
    engine.onRendered = (info) => this.rendered(info);
  }

  // ---------- 開く ----------
  async open(item, thumbSrc) {
    this.item = item;
    this.key = bridge.keyOf(item);
    this.ready = false;
    this.loading = true; // 新しい写真がエンジンに入るまで。その間に描かれるのは前の写真なので、表に出さない（2026-11-13）
    this.root.hidden = false;
    this.root.classList.remove("is-full");
    this.updateLand();
    document.getElementById("ed-bg").style.backgroundImage = thumbSrc ? `url("${thumbSrc}")` : "none"; // 後ろに敷く、ぼかした写真
    // 撮った日時とファイルの名前（ルックのタブのいちばん下に出す）: 2024年7月18日 14:07
    const dt = item.dateTaken ? new Date(item.dateTaken) : null;
    this.shot = [dt ? `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日 ${dt.getHours()}:${String(dt.getMinutes()).padStart(2, "0")}` : "", item.name || ""].filter(Boolean).join("　");
    this.engine.canvas.style.opacity = "0";
    this.preview.style.setProperty("--rot", "0deg");
    this.preview.classList.remove("is-turned");
    // 仮の画は、読み込めてから出す（読み込むまでのあいだ、前の写真の仮の画が残って見えるため）
    this.preview.hidden = true;
    this.preview.onload = () => {
      if (this.item !== item || this.ready) return;
      // 写真の入れ物を、仮の画の縦横の比に合わせる（現像の画が出たら、その比に合わせ直す）
      const w = this.preview.naturalWidth, hgt = this.preview.naturalHeight;
      if (w && hgt) this.setAspect(this.preview.classList.contains("is-turned") ? hgt / w : w / hgt);
      this.preview.hidden = false;
    };
    this.preview.src = thumbSrc || "";
    this.setBadge("現像しています…", true);
    this.layoutPhoto();
    this.resize();
    const saved = await getEdit(this.key);
    this.params = saved && saved.params ? mergeParams(saved.params) : { ...defaultParams(), ...AUTO };
    this.committed = JSON.stringify(this.params);
    this.history = [];
    this.future = [];
    this.updateUndo();
    this.renderTabs();
    this.renderPanel();
    bridge.keepScreenOn(true);
    try {
      const res = await fetch(bridge.mediaUrl(item));
      if (!res.ok) throw new Error(`ファイルを読めませんでした（${res.status}）`);
      const buf = await res.arrayBuffer();
      if (this.item !== item) return;
      const isJpeg = /\.jpe?g$/i.test(item.name || "") || (item.mime || "").includes("jpeg");
      if (isJpeg) {
        const bmp = await createImageBitmap(new Blob([buf]), { imageOrientation: "from-image", colorSpaceConversion: "none" });
        await this.engine.openBitmap(bmp, shotInfo(buf));
        bmp.close();
      } else {
        await this.engine.openRaw(buf, {
          onThumb: (jpg, flip) => {
            // 一覧の小さな画（ルックも編集もかかっている）が出ている時は、差し替えない（見た目が 2 回切り替わるため）。
            // 差し替える時は、いったん隠してから向きと画を入れ、読み込めたら出す（前の画が新しい向きで一瞬出るため）
            if (this.item !== item || this.ready || !this.preview.hidden) return;
            this.preview.src = URL.createObjectURL(new Blob([jpg], { type: "image/jpeg" }));
            const deg = FLIP_DEG[flip] || 0;
            this.preview.style.setProperty("--rot", deg + "deg");
            this.preview.classList.toggle("is-turned", Math.abs(deg) === 90);
          },
        });
      }
      if (this.item !== item) return;
      this.engine.setParams(this.params);
      this.loading = false;
      this.coreThumbsDirty = true;
      if (this.group === "core") this.renderPanel();
    } catch (e) {
      this.setBadge("");
      const raw = !/\.jpe?g$/i.test(item.name || "");
      toast(raw ? `この RAW は読めませんでした。純正カメラのプロモードで撮った DNG か確かめてください。（${e.message}）`
        : `この写真は読めませんでした。（${e.message}）`, [["一覧へ", () => this.onBack()]], 0);
    }
  }

  close() {
    this.root.hidden = true;
    this.item = null;
    closeSheet();
    bridge.keepScreenOn(false);
  }

  // 写真の入れ物を、写真の縦横の比に合わせる（左右に 8px の余白、角は丸い）。下には UNDER_MIN の高さを必ず残す
  setAspect(a) {
    if (!(a > 0) || Math.abs(a - (this.aspect || 0)) < 0.002) return;
    this.aspect = a;
    this.layoutPhoto();
  }
  layoutPhoto() {
    if (this.root.hidden || this.isFull()) return;
    const a = this.aspect || 4 / 3, W = this.root.clientWidth - 16, avail = Math.max(160, this.root.clientHeight - this.photo.offsetTop - UNDER_MIN);
    let w = W, hgt = W / a;
    if (hgt > avail) [w, hgt] = [avail * a, avail];
    this.photo.style.width = Math.round(w) + "px";
    this.photo.style.height = Math.round(hgt) + "px";
  }

  resize() {
    // 回したとき（全画面の横）も、回す前の大きさで描く（getBoundingClientRect は回したあとの外枠を返すので使わない）
    const r = { width: this.photo.clientWidth, height: this.photo.clientHeight }, dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width * dpr)), hgt = Math.max(1, Math.round(r.height * dpr));
    this.photo.style.setProperty("--pw", r.width + "px");
    this.photo.style.setProperty("--ph", r.height + "px");
    const c = this.engine.canvas;
    if (c.width !== w || c.height !== hgt) {
      c.width = w;
      c.height = hgt;
      this.engine.requestRender();
    }
  }

  rendered({ layout, hist }) {
    if (!this.item || this.loading) return;
    if (!this.ready) {
      this.ready = true;
      this.engine.canvas.style.opacity = "1";
      this.preview.hidden = true;
      this.setBadge("");
      this.firstHint();
    }
    this.layout = layout;
    const c = this.engine._cropPx();
    this.setAspect(c.w / c.h);
    this.lastHist = hist;
    this.drawHist(hist);
    const dpr = this.engine.canvas.width / Math.max(1, this.photo.clientWidth);
    Object.assign(this.grid.style, {
      left: layout.dx / dpr + "px", top: layout.dy / dpr + "px", width: layout.rw / dpr + "px", height: layout.rh / dpr + "px",
    });
    this.oneBtn.textContent = this.engine.view.zoom > 1.001 ? L("Fit", "全体表示") : L("100%", "100%");
  }

  setBadge(text, busy) {
    this.badge.textContent = text;
    this.badge.hidden = !text;
    this.badge.classList.toggle("is-busy", !!busy);
    this.root.dataset.badge = text || ""; // 全画面の間は、写真の上の端に出す（CSS）
  }

  firstHint() {
    if (pref("hint1")) return;
    pref("hint1", true);
    this.setBadge("長押しで補正前・2回たたくと全画面");
    setTimeout(() => this.badge.textContent.startsWith("長押しで") && this.setBadge(""), 5000);
  }

  drawHist(b) {
    const cv = this.hist, dpr = window.devicePixelRatio || 1, W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (!W || !H || !b) return;
    if (cv.width !== W) [cv.width, cv.height] = [W, H];
    const c = cv.getContext("2d"), max = Math.max(1, ...b.l.slice(1, 63)) * 1.1;
    c.clearRect(0, 0, W, H);
    // 白 1 色の薄い山（色は使わない）
    c.beginPath();
    c.moveTo(0, H);
    for (let i = 0; i < 64; i++) c.lineTo((i / 63) * W, H - Math.min(1, b.l[i] / max) * H);
    c.lineTo(W, H);
    c.fillStyle = "rgba(255,255,255,.22)";
    c.fill();
  }

  // ---------- 写真の上の指の動き ----------
  gestures() {
    const el = this.photo, pts = new Map();
    let start = null, pinch = null, longTimer = 0, comparing = false, moved = false, lastTap = { t: 0, x: 0, y: 0 };
    // 全画面の横で入れ物を回しているときは、指の位置を回す前の向きに戻して読む
    const P = (e) => {
      const a = this.landDeg || 0;
      if (!a) return { x: e.clientX, y: e.clientY };
      const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const t = (-a * Math.PI) / 180, dx = e.clientX - cx, dy = e.clientY - cy;
      return { x: cx + dx * Math.cos(t) - dy * Math.sin(t), y: cy + dx * Math.sin(t) + dy * Math.cos(t) };
    };
    const mid = () => {
      const a = [...pts.values()];
      return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1 };
    };
    el.addEventListener("pointerdown", (e) => {
      if (!this.ready) return;
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: P(e).x, y: P(e).y });
      if (pts.size === 1) {
        start = { x: P(e).x, y: P(e).y, t: performance.now(), view: { ...this.engine.view }, crop: { ...this.params.crop } };
        moved = false;
        if (this.group !== "crop") {
          longTimer = setTimeout(() => {
            if (moved || pts.size !== 1) return;
            comparing = true;
            this.engine.setCompare(true);
            this.setBadge(L("Original", "補正前"));
            bridge.haptic("tick");
          }, 260);
        }
      } else if (pts.size === 2) {
        clearTimeout(longTimer);
        const m = mid();
        pinch = { ...m, view: { ...this.engine.view }, crop: { ...this.params.crop } };
      }
    });
    el.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      pts.set(e.pointerId, { x: P(e).x, y: P(e).y });
      if (!start) return;
      if (Math.hypot(P(e).x - start.x, P(e).y - start.y) > 8) {
        moved = true;
        clearTimeout(longTimer);
      }
      const l = this.layout;
      if (!l) return;
      const dpr = this.engine.canvas.width / Math.max(1, el.clientWidth), W = this.engine.src.w, H = this.engine.src.h;
      if (pinch && pts.size >= 2) {
        const m = mid(), scale = m.d / pinch.d;
        if (this.group === "crop") {
          let c = zoomCrop(pinch.crop, scale, W, H);
          const pxPerSrc = l.VW / dpr / (c.w * W);
          c = panCrop(c, m.x - pinch.x, m.y - pinch.y, pxPerSrc, W, H);
          this.setParam("crop", c);
        } else {
          const zoom = pinch.view.zoom * scale;
          const VW = (l.VW / this.engine.view.zoom) * zoom, VH = (l.VH / this.engine.view.zoom) * zoom;
          this.engine.setView({ zoom, cx: pinch.view.cx - ((m.x - pinch.x) * dpr) / VW, cy: pinch.view.cy - ((m.y - pinch.y) * dpr) / VH });
        }
        return;
      }
      if (pts.size !== 1 || !moved || comparing) return;
      const dx = P(e).x - prev.x, dy = P(e).y - prev.y;
      if (this.group === "crop") {
        this.setParam("crop", panCrop(this.params.crop, dx, dy, l.VW / dpr / (this.params.crop.w * W), W, H));
      } else if (this.engine.view.zoom > 1.001) {
        this.engine.setView({ cx: this.engine.view.cx - (dx * dpr) / l.VW, cy: this.engine.view.cy - (dy * dpr) / l.VH });
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      clearTimeout(longTimer);
      if (comparing && pts.size === 0) {
        comparing = false;
        this.engine.setCompare(false);
        this.setBadge("");
        return;
      }
      if (pts.size < 2) pinch = null;
      if (pts.size > 0) return;
      if (this.group === "crop" && moved) this.commit();
      const now = performance.now();
      if (!moved && start && now - start.t < 260) {
        if (now - lastTap.t < 320 && Math.hypot(P(e).x - lastTap.x, P(e).y - lastTap.y) < 40) {
          lastTap.t = 0;
          this.toggleFull();
        } else {
          lastTap = { t: now, x: P(e).x, y: P(e).y };
        }
      }
      start = null;
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  toggleFull() {
    this.root.classList.toggle("is-full");
    bridge.haptic("tick");
    this.updateLand();
    this.layoutPhoto();
  }

  // 全画面のときに端末を横にしたら、写真の入れ物ごと回して、横長の写真を画面いっぱいに見せる（アプリは縦で固定）
  updateLand() {
    const d = this.deviceDeg || 0, land = this.isFull() && (d === 90 || d === 270);
    this.landDeg = land ? (d === 90 ? -90 : 90) : 0;
    this.root.classList.toggle("is-land", land);
    this.photo.style.setProperty("--land-rot", this.landDeg + "deg");
  }
  isFull() {
    return this.root.classList.contains("is-full");
  }

  toggleOneToOne() {
    const l = this.layout;
    if (!l) return;
    if (this.engine.view.zoom > 1.001) this.engine.setView({ zoom: 1, cx: 0.5, cy: 0.5 });
    else this.engine.setView({ zoom: 1 / l.fit / this.engine.view.zoom });
  }

  // ---------- つまみの値 ----------
  setParam(path, value) {
    const p = clone(this.params), keys = Array.isArray(path) ? path : [path];
    let o = p;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys[keys.length - 1]] = value;
    this.params = p;
    this.engine.setParams(p);
  }

  commit() {
    const now = JSON.stringify(this.params);
    if (now === this.committed) return;
    this.history.push(this.committed);
    if (this.history.length > 100) this.history.shift();
    this.future = [];
    this.committed = now;
    this.updateUndo();
    this.renderTabs();
    this.save();
  }

  undo() {
    if (!this.history.length) return;
    this.future.push(this.committed);
    this.committed = this.history.pop();
    this.applyCommitted();
  }
  redo() {
    if (!this.future.length) return;
    this.history.push(this.committed);
    this.committed = this.future.pop();
    this.applyCommitted();
  }
  applyCommitted() {
    this.params = JSON.parse(this.committed);
    this.engine.setParams(this.params);
    this.updateUndo();
    this.renderTabs();
    this.renderPanel();
    this.save();
    bridge.haptic("tick");
  }
  updateUndo() {
    document.getElementById("ed-undo").disabled = !this.history.length;
    document.getElementById("ed-redo").disabled = !this.future.length;
  }

  save() {
    clearTimeout(this.saveTimer);
    const key = this.key, params = clone(this.params);
    this.saveTimer = setTimeout(async () => {
      await setEdit(key, { params });
      if (this.onSaved) this.onSaved(key);
    }, 400);
  }

  // ---------- 下の板 ----------
  groupChanged(g) {
    const p = this.params;
    // 「よく使う」には、足した Aftersun の強さのつまみ（Sun Level。はじめは 100）も置いてある
    const st = lookState(p), sunMoved = g.id === "basic" && !!st.sun && Math.round(st.level) !== 100;
    if (g.knobs) return sunMoved || g.knobs.some((k) => changed(p, k)) || (g.curve && (Object.values(p.curve).some((c) => c && c.length) || Object.values(p.param).some((v) => v))) || (g.bw && p.bw);
    if (g.id === "core") return p.core !== AUTO_CORE || (p.sunLevel ?? AUTO.sunLevel) !== AUTO.sunLevel;
    if (g.id === "mix") return ["hue", "sat", "lum"].some((k) => p.hsl[k].some((v) => v));
    if (g.id === "grade") return p.grading.balance !== 0 || GRADE_ZONES.some(([z]) => p.grading[z].sat || p.grading[z].lum);
    if (g.id === "crop") return p.crop.w < 0.999 || p.crop.h < 0.999 || p.crop.angle !== 0;
    return false;
  }

  renderTabs() {
    if (!this.groups().some((g) => g.id === this.group)) this.group = "basic"; // 出していないタブを開いたままにしない（写ルンですの現像に替えた時など）
    this.tabs.replaceChildren(...this.groups().map((g) => {
      const t = h("button", {
        class: "tab" + (g.id === this.group ? " is-on" : "") + (this.params && this.groupChanged(g) ? " is-changed" : ""),
        onClick: () => this.showGroup(g.id),
      }, g.name);
      t.dataset.group = g.id;
      return t;
    }));
    // 写真の下のルック名（例: Cinema ＋ Aftersun Blue 40）。たたくとルックのタブへ
    this.coreChip.textContent = this.lookLabel(this.params || AUTO);
  }

  // 下に出すタブ。写ルンですの現像は、明るさと色のつまみを通さないので、効くものだけを出す
  groups() {
    return this.params && lookState(this.params).film ? GROUPS.filter((g) => ["core", "basic", "crop"].includes(g.id)) : GROUPS;
  }

  showGroup(id) {
    if (id === "core" && this.group !== "core") this.coreScroll = undefined; // ルックのタブに入り直したら、選んでいるルックが見える位置から
    this.group = id;
    pref("group", id);
    this.root.classList.toggle("is-crop", id === "crop");
    if (id === "crop") this.engine.setView({ zoom: 1, cx: 0.5, cy: 0.5 });
    this.renderTabs();
    this.renderPanel();
    const on = this.tabs.querySelector(".is-on");
    if (on) on.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }

  // 値 1 つ分の決まり（名前・範囲・初期値・書き方・動かした時にすること）
  spec(key, { path = key, label, value, def, min, max, fmt, track, snaps = [] } = {}) {
    const k = KNOBS[key] || {};
    // 2026-11-15 粒・にじみ・白み・やわらかさは、いまのルックが元から持つ量が 0 なら、下げる側を出さない（動かしても何も起きないため）
    if (min === undefined && ["grain", "halation", "bloom", "soften"].includes(key) && this.engine && this.params) {
      const base = this.engine._mixedCore(this.engine.lookFor(this.params))[key];
      if (!(base > 0)) min = 0;
    }
    return {
      key, label: label || k.label, min: min ?? k.min ?? -100, max: max ?? k.max ?? 100, step: k.step || 1, def: def ?? k.def ?? 0, fmt: fmt || k.fmt || num, track: track || k.track,
      value: value ?? this.params[key], snaps, onInput: (v) => this.setParam(path, v),
    };
  }

  // 1 行に収めた小さなつまみ（名前・細い線・値）
  rowKnob(spec) {
    return slider({ ...spec, row: true, onCommit: () => this.commit() }).el;
  }

  // 値を 1 つずつ動かす部品: 名前を横に並べ、選んだ 1 つの値を大きな数字で出し、下の目盛りで動かす。
  // 選んでいない値は、名前の下に小さく値を出す（初期値のままなら薄い字）。大きな数字を 2 回たたくと初期値に戻る。
  dial(id, specs) {
    specs = specs.filter(Boolean);
    const vals = specs.map((s) => s.value);
    // 選んでいる値は、名前で覚える（値が 1 つ増えても、選んでいた値がずれない）
    let i = Math.max(0, specs.findIndex((s, j) => (s.key || j) === this.toolAt[id])), lastTap = 0;
    const tools = specs.map((s, j) => {
      const t = h("button", { class: "ed-tool", onClick: () => j !== i && pick(j, true) }, h("span", {}, s.label), h("b", { class: "num" }));
      t.dataset.key = s.key || "";
      return t;
    });
    const row = h("div", { class: "ed-tools" }, tools);
    const big = h("div", { class: "ed-big num" });
    const rule = h("div", { class: "ed-rule" });
    const paint = (j) => {
      const s = specs[j], text = s.fmt(vals[j]);
      tools[j].lastChild.textContent = text;
      tools[j].classList.toggle("is-changed", Math.abs(vals[j] - s.def) > 1e-9);
      if (j === i) big.textContent = text;
    };
    const center = (smooth) => row.scrollTo({ left: tools[i].offsetLeft - (row.clientWidth - tools[i].offsetWidth) / 2, behavior: smooth ? "smooth" : "auto" });
    const pick = (j, byUser) => {
      i = j;
      this.toolAt[id] = specs[j].key || j;
      tools.forEach((t, k) => t.classList.toggle("is-on", k === j));
      const s = specs[j];
      rule.replaceChildren(slider({
        ...s, value: vals[j], onCommit: () => this.commit(),
        onInput: (v) => {
          vals[j] = v;
          paint(j);
          s.onInput(v);
        },
      }).el);
      paint(j);
      if (byUser) {
        center(true);
        bridge.haptic("tick");
      }
    };
    big.addEventListener("pointerdown", () => {
      const now = performance.now(), s = specs[i];
      if (now - lastTap > 320 || vals[i] === s.def) {
        lastTap = now;
        return;
      }
      lastTap = 0;
      vals[i] = s.def;
      s.onInput(s.def);
      this.commit();
      pick(i, false);
      bridge.haptic("detent");
    });
    specs.forEach((_, j) => paint(j));
    pick(i, false);
    requestAnimationFrame(() => center(false));
    return h("div", { class: "ed-dial" + (specs.length === 1 ? " is-one" : "") }, row, big, rule);
  }

  // 言葉を横に並べて選ぶ部品。items は [名前, 選んでいるか, たたいた時にすること, { 変えた印, 使えない }]
  words(items, cls = "") {
    return h("div", { class: "ed-words " + cls }, items.map(([name, on, fn, o = {}]) => h("button", {
      class: "ed-word" + (on ? " is-on" : "") + (o.changed ? " is-changed" : "") + (o.act ? " is-act" : ""), disabled: o.disabled ? "disabled" : null, onClick: fn,
    }, name)));
  }

  // 入り切りの行（名前・説明・スイッチ）
  switchRow(name, sub, on, fn) {
    return h("label", { class: "toggle-row" }, h("span", {}, name, sub ? h("small", {}, sub) : null), h("input", {
      type: "checkbox", class: "toggle", checked: on ? "checked" : null, onChange: (e) => fn(e.target.checked),
    }));
  }

  renderPanel() {
    if (!this.params) return;
    const film = lookState(this.params).film;
    const g = this.groups().find((x) => x.id === this.group) || GROUPS[1];
    const body = [];
    if (g.id === "core") body.push(...this.corePanel());
    else if (g.id === "mix") body.push(...this.mixPanel());
    else if (g.id === "grade") body.push(...this.gradePanel());
    else if (g.id === "crop") body.push(...this.cropPanel());
    else if (film) {
      // 写ルンですの現像で効くのは、プリントの明るさ（露光量のつまみ）と、あとからかけるピクセルアート（2026-11-21）だけ
      body.push(this.dial("film", [this.spec("exposure", { label: L("Print", "プリントの明るさ") }), this.spec("pixel"), this.spec("gameColor"), this.spec("pixelLine")]), this.histBox,
        h("p", { class: "note" }, "Print は、写真屋がプリントを明るく・暗く焼く量です。色や明暗のつまみは、写ルンですの現像では使いません。"));
    } else {
      // よく使うのいちばん左に、足した Aftersun の強さ（足していない時は出さない）
      body.push(this.dial(g.id, [g.id === "basic" ? this.sunSpec() : null, ...g.knobs.map((k) => this.spec(k))]), this.histBox);
      if (g.curve) body.push(...this.curvePanel());
      if (g.bw) body.push(h("div", { class: "ed-ln" }), this.switchRow(L("Black & White", "白黒"), "", this.params.bw, (on) => (this.setParam("bw", on), this.commit())));
    }
    const keep = this.panelGroup === g.id ? this.panel.scrollTop : 0;
    this.panelGroup = g.id;
    this.panel.replaceChildren(...body);
    this.panel.scrollTop = keep;
    // ルックのタブに入った時は、選んでいる札を見える所へ寄せる
    if (g.id === "core" && !keep) {
      const on = this.panel.querySelector(".ed-lk.is-on"), row = on && on.parentElement;
      if (row) row.scrollLeft = on.offsetLeft - row.offsetLeft - (row.clientWidth - on.offsetWidth) / 2;
    }
    if (HIST_GROUPS.includes(g.id)) requestAnimationFrame(() => this.drawHist(this.lastHist));
  }

  // ルックのタブ: 写真つきの札（Cinema と、足す Aftersun・Warm）。白い枠が使っているルック。使っている札をもう一度たたくと外れる。
  // その下に、足した Aftersun の強さ（Sun Level）、現像の切り替え（写ルンです）、直しのコピー・貼り付け・すべて戻す、写真の削除を置く。
  corePanel() {
    const st = lookState(this.params);
    const redraw = () => {
      this.commit();
      this.renderTabs();
      this.renderPanel();
    };
    const apply = (cinema, sun, level) => {
      for (const [k, v] of Object.entries(lookParams(cinema, sun, level))) this.setParam(k, v);
      bridge.haptic("tick");
      redraw();
    };
    // 写ルンですの現像（2026-11-15）: オンの間は Cinema・Aftersun を通さず、フィルムと写真屋の処理で描く。オフにすると Cinema に戻る
    const setFilm = (on) => {
      for (const [k, v] of Object.entries(on ? { core: UTSURUN_CORE, sun: null, sunLevel: 0 } : { core: AUTO_CORE, sun: null, sunLevel: AUTO.sunLevel })) this.setParam(k, v);
      bridge.haptic("tick");
      redraw();
    };
    const line = (name, ...kids) => h("div", { class: "ed-row" }, h("span", { class: "ed-row-k" }, name), ...kids);
    const clip = pref("clipboard");
    const tail = [
      h("div", { class: "ed-ln" }),
      line(L("Camera", "現像"), this.words([["Sunglasses", !st.film, () => st.film && setFilm(false)], ["写ルンです", st.film, () => !st.film && setFilm(true)]])),
      line(L("Edits", "設定"), this.words([
        [L("Copy", "コピー"), false, () => {
          const { crop, ...rest } = clone(this.params);
          pref("clipboard", rest);
          toast("直しをコピーしました。ほかの写真で貼り付けできます（切り抜きは含めません）");
          this.renderPanel();
        }, { act: true }],
        [L("Paste", "ペースト"), false, () => {
          this.params = { ...mergeParams(clip), crop: this.params.crop };
          this.engine.setParams(this.params);
          bridge.haptic("confirm");
          redraw();
        }, { act: true, disabled: !clip }],
        [L("Reset all", "すべて初期化"), false, () => {
          this.params = { ...defaultParams(), ...AUTO };
          this.engine.setParams(this.params);
          bridge.haptic("detent");
          redraw();
        }, { act: true }],
      ])),
      // この写真をスマホから消す（Android の確認が 1 回出る）。読み込んだファイル（一覧に無い写真）は消せない
      h("button", { class: "ed-row ed-row-btn", id: "ed-delete", disabled: this.item && this.item.id !== undefined ? null : "disabled", onClick: () => this.deleteThis() },
        h("span", { class: "ed-row-k" }, L("Delete this photo", "この写真を削除")), h("small", {}, "元の RAW を消します。元に戻せません")),
      h("p", { class: "ed-shot num" }, this.shot || ""),
    ];
    if (st.film) return [h("p", { class: "note ed-film-note" }, "写ルンですで現像しています。フィルムと写真屋の処理で描きます。明るい外は、撮った時の光の量のまま写ります。暗い所は、写る明るさまで持ち上げます。"), ...tail];
    // 前に直した写真が、一覧から外したルック（Nostalgia など）のままなら、その札も出す（選び直すまでそのまま使える）
    const listed = [...SUN_CORES, ...SOLO_CORES];
    const ids = [...listed, ...(st.sun && !listed.includes(st.sun) ? [st.sun] : [])];
    const card = (name, on, data, fn) => {
      const b = h("button", { class: "ed-lk" + (on ? " is-on" : ""), onClick: fn }, h("span", { class: "ed-lk-win" }, h("canvas")), h("span", { class: "ed-lk-n" }, name));
      Object.assign(b.dataset, data);
      return b;
    };
    const level = st.sun && st.level > 0 ? st.level : 100; // 足していない所から選んだ時は 100 から
    const cards = [
      // 単独のルック（Warm）の時に Cinema をオンにしたら、Warm を外す
      card("Cinema", st.cinema, { look: "cinema" }, () => apply(!st.cinema, SOLO_CORES.includes(st.sun) ? null : st.sun, st.level)),
      ...ids.map((id) => card(this.engine.coreById(id).name.replace(/^Aftersun (?=\S)/, ""), id === st.sun, { look: id, sun: id }, () => apply(st.cinema, id === st.sun ? null : id, level))),
    ];
    const row = h("div", { class: "ed-lks" }, cards);
    // ルックを選び直しても、横の並びの位置は動かさない
    row.addEventListener("scroll", () => (this.coreScroll = row.scrollLeft), { passive: true });
    requestAnimationFrame(() => {
      if (this.coreScroll !== undefined) row.scrollLeft = this.coreScroll;
      this.drawCoreThumbs(row);
    });
    if (!st.sun) return [row, ...tail];
    const core = this.engine.coreById(st.sun), name = core.name, sc = sunCoreOf(core);
    const note = SOLO_CORES.includes(st.sun) ? `Sun Level は、0 で素の画、100 で ${name} そのまま。${name} は Cinema と一緒には使えません（Cinema を選ぶと外れます）。`
      : st.cinema ? `Sun Level は、0 で Cinema そのまま、100 で ${name} の色。明るさ・明暗は Cinema のままです。`
      : sc >= 100 ? `Sun Level は、0 で素の画、100 で ${name} そのまま。`
        : `Sun Level は、0 で素の画、${sc} で ${name} そのまま、100 でその ${sunGainOf(core)} 倍。${sc} で軽く止まります。`;
    return [row, this.rowKnob(this.sunSpec()), h("p", { class: "note" }, note), ...tail];
  }

  // 足した Aftersun の強さ（Sun Level）。足していない時は null
  sunSpec() {
    const st = lookState(this.params);
    if (!st.sun) return null;
    const sc = sunCoreOf(this.engine.coreById(st.sun));
    return this.spec("sunLevel", { value: st.level, def: 100, snaps: !st.cinema && sc < 100 ? [sc] : [] });
  }

  // いまのルックを言葉にする（例: Cinema ＋ Aftersun Blue 40）
  lookLabel(p) {
    const st = lookState(p), n = st.sun ? `${this.engine.coreById(st.sun).name} ${Math.round(st.level)}` : "";
    if (st.film) return "写ルンです";
    return st.cinema ? (n ? `Cinema ＋ ${n}` : "Cinema") : n || L("No look", "ルックなし");
  }

  // ルックの札の中に、いまの写真をそのルックで描いた小さな画を出す（Cinema の札は Cinema だけ、ほかは今の Cinema の入り切りに足した画）
  drawCoreThumbs(row) {
    if (!this.engine.image || !this.ready) {
      setTimeout(() => this.group === "core" && row.isConnected && this.drawCoreThumbs(row), 300);
      return;
    }
    const keep = this.engine.params;
    for (const box of row.querySelectorAll(".ed-lk")) {
      const look = box.dataset.sun ? lookParams(lookState(keep).cinema, box.dataset.sun, 100) : lookParams(true, null, 100);
      this.engine.params = { ...defaultParams(), ...look, crop: keep.crop };
      const r = this.engine.renderPixels(220);
      const cv = box.querySelector("canvas");
      cv.width = r.width;
      cv.height = r.height;
      cv.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(r.pixels.buffer), r.width, r.height), 0, 0);
    }
    this.engine.params = keep;
    this.engine.requestRender();
  }

  curvePanel() {
    const ed = curveEditor(() => this.params.curve, (c) => this.setParam("curve", c), () => this.commit());
    const pk = [["shadows", L("Shadows", "シャドウ")], ["darks", L("Darks", "ダーク")], ["lights", L("Lights", "ライト")], ["highlights", L("Highlights", "ハイライト")]];
    return [h("div", { class: "ed-ln" }), h("div", { class: "sub-title" }, L("Tone Curve", "トーンカーブ")), h("p", { class: "note" }, "たたいて点を足す・枠の外へ出すと消える・2回たたくと戻す"), ed.el,
      ...pk.map(([k, label]) => this.rowKnob(this.spec(k, { path: ["param", k], label, value: this.params.param[k], min: -100, max: 100, def: 0 })))];
  }

  // カラーミックス: 8 つの色の丸から 1 つ選び、色相・彩度・輝度のうち 1 つを動かす
  mixPanel() {
    const i = this.hslIndex, p = this.params;
    const dots = h("div", { class: "ed-dots" }, HSL_NAMES.map((n, j) => h("button", {
      class: "ed-dot" + (j === i ? " is-on" : "") + (p.hsl.hue[j] || p.hsl.sat[j] || p.hsl.lum[j] ? " is-changed" : ""),
      style: { "--c": HSL_COLORS[j] }, "aria-label": n, onClick: () => ((this.hslIndex = j), this.renderPanel()),
    })));
    const one = (k, label) => this.spec(k, { path: ["hsl", k, i], label, value: p.hsl[k][i], min: -100, max: 100, def: 0 });
    return [dots, this.dial("mix", [one("hue", L("Hue", "色相")), one("sat", L("Saturation", "彩度")), one("lum", L("Luminance", "輝度"))]), h("div", { class: "ed-cap" }, HSL_NAMES[i])];
  }

  // グレーディング: 範囲を言葉で選び、色の輪の中の丸を動かして色を足す（向きが色相、真ん中からの遠さが彩度）。2 回たたくと色を外す
  gradePanel() {
    const z = this.gradeZone, g = this.params.grading;
    const zones = this.words(GRADE_ZONES.map(([k, name]) => [name, k === z, () => ((this.gradeZone = k), this.renderPanel()), { changed: !!(g[k].sat || g[k].lum) }]), "is-spread");
    const puck = h("i", { class: "ed-puck" }), wheel = h("div", { class: "ed-wheel", role: "slider", "aria-label": L("Hue and saturation", "色相と彩度") }, puck);
    const read = h("div", { class: "ed-read num" });
    const place = () => {
      const { hue, sat } = this.params.grading[z], a = (hue * Math.PI) / 180, r = sat / 2;
      puck.style.left = 50 + r * Math.cos(a) + "%";
      puck.style.top = 50 - r * Math.sin(a) + "%";
      puck.classList.toggle("is-zero", !sat);
      read.replaceChildren(h("span", {}, L("Hue", "色相"), h("b", {}, Math.round(hue) + "°")), h("span", {}, L("Saturation", "彩度"), h("b", {}, String(Math.round(sat)))));
    };
    const setHS = (hue, sat) => {
      const gr = clone(this.params.grading);
      gr[z].hue = hue;
      gr[z].sat = sat;
      this.setParam("grading", gr);
      place();
    };
    // 色か輝度を変えた範囲の言葉に、小さな点を付ける
    const mark = () => GRADE_ZONES.forEach(([k], n) => zones.children[n].classList.toggle("is-changed", !!(this.params.grading[k].sat || this.params.grading[k].lum)));
    let drag = null, lastTap = 0;
    wheel.addEventListener("pointerdown", (e) => {
      const now = performance.now(), { hue, sat } = this.params.grading[z], a = (hue * Math.PI) / 180;
      if (now - lastTap < 320) {
        lastTap = 0;
        drag = null;
        if (sat) {
          setHS(hue, 0);
          this.commit();
          bridge.haptic("detent");
          mark();
        }
        return;
      }
      wheel.setPointerCapture(e.pointerId);
      // 指を動かした分だけ丸が動く（置いた所へ飛ばない）
      drag = { x: e.clientX, y: e.clientY, px: sat * Math.cos(a), py: sat * Math.sin(a), k: 100 / (wheel.clientWidth / 2), moved: false };
    });
    wheel.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      const x = drag.px + dx * drag.k, y = drag.py - dy * drag.k, sat = Math.min(100, Math.round(Math.hypot(x, y)));
      setHS(sat ? Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360) : this.params.grading[z].hue, sat);
    });
    const end = () => {
      if (drag && drag.moved) this.commit();
      // 動かさずに離した時だけ「たたいた」と数える（動かした直後に触り直しても、彩度を 0 に戻さない）
      lastTap = drag && !drag.moved ? performance.now() : 0;
      drag = null;
      mark();
    };
    wheel.addEventListener("pointerup", end);
    wheel.addEventListener("pointercancel", end);
    place();
    return [zones, wheel, read,
      this.rowKnob(this.spec("glum", { path: ["grading", z, "lum"], label: L("Luminance", "輝度"), value: g[z].lum, min: -100, max: 100, def: 0 })),
      this.rowKnob(this.spec("balance", { path: ["grading", "balance"], label: L("Balance", "バランス"), value: g.balance, min: -100, max: 100, def: 0 }))];
  }

  // 切り抜き: 比は言葉で選び、傾きは目盛りで動かす。写り方は、写真を指で動かす・つまむ
  cropPanel() {
    const W = this.engine.src ? this.engine.src.w : 1, H = this.engine.src ? this.engine.src.h : 1, c = this.params.crop;
    const ratios = this.words(ASPECTS.map(([name, a]) => [name, (c.aspect || 0) === a, () => {
      this.setParam("crop", cropForAspect({ ...this.params.crop, cx: 0.5, cy: 0.5 }, a, W, H));
      this.commit();
      this.renderPanel();
    }]), "is-scroll");
    const reset = h("button", {
      class: "ed-word is-act", id: "ed-crop-reset", onClick: () => {
        this.setParam("crop", { cx: 0.5, cy: 0.5, w: 1, h: 1, angle: 0 });
        this.commit();
        this.renderPanel();
      },
    }, L("Reset", "初期化"));
    const straighten = {
      key: "angle", label: L("Straighten", "角度補正"), min: -45, max: 45, step: 0.1, def: 0, value: c.angle, fmt: (v) => signed(v, v.toFixed(1)) + "°", snaps: [],
      onInput: (v) => {
        const base = cropForAspect({ ...this.params.crop, angle: 0 }, this.params.crop.aspect || 0, W, H);
        this.setParam("crop", rotateCrop({ ...base, cx: this.params.crop.cx, cy: this.params.crop.cy }, v, W, H));
      },
    };
    return [h("div", { class: "ed-crop-head" }, ratios, reset), this.dial("crop", [straighten]), h("p", { class: "note ed-center" }, "写真を指で動かす・つまむと、枠の中の写り方が変わります。")];
  }

  deleteThis() {
    const it = this.item;
    if (!it) return;
    this.deleting = it;
    if (!bridge.deleteMedia([it])) {
      this.deleting = null;
      toast("写真を消すには、アプリの入れ直しが必要です。", [["入れ直す", () => bridge.openUrl(bridge.APK_URL)]], 8000);
    }
  }

  // 消せたら、直しの記録も消して一覧に戻る（一覧の側で「〇枚を削除しました」と出す）
  async onDeleted(d) {
    const it = this.deleting;
    this.deleting = null;
    if (!it || !d.ok) return;
    await deleteEdit(bridge.keyOf(it));
    if (this.item === it) this.onBack();
  }

  // ---------- 書き出し ----------
  exportSheet() {
    if (!this.ready) return;
    const c = this.engine._cropPx(), full = `${Math.round(c.w)} × ${Math.round(c.h)}`;
    let size = pref("exportSize") ?? 0, loc = false;
    const opts = [[0, L("Original size", "元のサイズ"), full], [2048, L("Long edge 2048", "長辺 2048px"), "SNS 向け"], [1080, L("Long edge 1080", "長辺 1080px"), "LINE で送る向け"]].map(([v, label, sub]) => {
      const b = h("button", {
        class: "ed-opt" + (size === v ? " is-on" : ""), onClick: () => {
          size = v;
          pref("exportSize", v);
          opts.forEach((o) => o.classList.toggle("is-on", o === b));
        },
      }, h("span", {}, label, h("small", { class: "num" }, sub)), checkIcon());
      return b;
    });
    const body = h("div", { class: "sheet-body" }, ...opts,
      this.switchRow(L("Include location", "位置情報を含める"), "相手に場所が伝わるので、ふつうは入れません", false, (on) => (loc = on)),
      h("p", { class: "note" }, "カメラの写真と同じ所（DCIM/Camera）に、撮った日時のまま保存します。元の RAW はそのままです。"),
      h("button", { class: "btn-primary", onClick: () => (closeSheet(), this.doExport(size, loc)) }, L("Save to gallery", "デバイスに保存")));
    sheet(L("Export", "書き出し"), body);
  }

  async doExport(maxSide, copyLocation) {
    const item = this.item;
    toast("書き出しています…", [], 0);
    await new Promise((r) => setTimeout(r, 40));
    try {
      const blob = await this.engine.exportJpeg({ maxSide, quality: 0.95 });
      const name = (item.name || "photo").replace(/\.[^.]+$/, "") + "_sunglasses.jpg";
      const p = this.params;
      const note = bridge.recordNote(`Sunglasses: ${this.lookLabel(p)}, exposure ${p.exposure >= 0 ? "+" : ""}${p.exposure.toFixed(2)}`, p);
      const res = await bridge.saveJpeg(blob, { name, folder: "DCIM/Camera", item, copyLocation, note });
      if (!res.ok) throw new Error(res.error || "保存できませんでした");
      bridge.haptic("confirm");
      toast("書き出しました", res.uri ? [["見る", () => bridge.view(res.uri)], ["送る", () => bridge.share(res.uri)]] : [], 6000);
      setEdit(this.key, { params: clone(this.params), exported: res.uri || true });
    } catch (e) {
      bridge.haptic("reject");
      toast(`書き出せませんでした。（${e.message}）`, [], 8000);
    }
  }

  // 戻る操作: 板 → 全画面 → 一覧 の順に閉じる
  back() {
    if (closeSheet()) return true;
    if (this.isFull()) {
      this.toggleFull();
      return true;
    }
    if (this.engine.view.zoom > 1.001) {
      this.engine.setView({ zoom: 1, cx: 0.5, cy: 0.5 });
      return true;
    }
    this.onBack();
    return true;
  }
}
