// 編集の画面（2026-11-05）。
// 写真の上: 押している間は元の画、2 回たたくと全画面、2 本指でつまむと拡大、拡大中は 1 本指で動かす。
// 下の板: 核の箱・つまみ（よく使う／明るさ／色／色ごと／グレーディング／効果／細部／切り抜き）。
import { indicator, water } from "./water.js";
import { defaultParams, lookParams, lookState, sunCoreOf, sunGainOf, SUN_CORES } from "../engine/engine.js";
import { shotInfo } from "../engine/exif.js";
import * as bridge from "./bridge.js";
import { cropForAspect, panCrop, rotateCrop, zoomCrop } from "./crop.js";
import { curveEditor } from "./curve.js";
import { ASPECTS, GRADE_ZONES, GROUPS, HSL_COLORS, HSL_NAMES, KNOBS, changed } from "./knobs.js";
import { deleteEdit, getEdit, pref, setEdit } from "./store.js";
import { closeSheet, h, sheet, slider, toast } from "./ui.js";

const CORE_BANDS = { cinema: ["#2f5d62", "#e6cf9a"], aftersun2: ["#9a9a6e", "#d9c7a4"], aftersun3: ["#5f8f7a", "#d9c7a4"], deepblue: ["#1d6f8c", "#d9c7a4"], aqua: ["#62bcb6", "#e8d6b0"], aftersun: ["#3c9c96", "#e3a85f"], mine: ["#cdbb9c", "#6f86a6"], weak: ["#8cc2bd", "#d9c39b"] };
const AUTO_CORE = "cinema"; // 2026-11-10 夜 直していない写真は Cinema（映画の見た目の核）で開く。前は aftersun2
const AUTO = { core: AUTO_CORE, sunLevel: 0 }; // Cinema の Sun Level（Aftersun を足す量）は 0 がはじめの値
const FLIP_DEG = { 3: 180, 5: -90, 6: 90 };
const clone = (o) => JSON.parse(JSON.stringify(o));
const trashIcon = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.innerHTML = '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>';
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
    this.hist = document.getElementById("ed-hist");
    this.coreChip = document.getElementById("ed-core-chip");
    this.oneBtn = document.getElementById("ed-one");
    this.hint = document.getElementById("ed-hint");
    this.group = pref("group") || "basic";
    this.hslIndex = 4;
    this.gradeZone = "shadows";
    this.saveTimer = 0;
    document.getElementById("ed-back").onclick = () => this.onBack();
    document.getElementById("ed-undo").onclick = () => this.undo();
    document.getElementById("ed-redo").onclick = () => this.redo();
    document.getElementById("ed-export").onclick = () => this.exportSheet();
    document.getElementById("ed-more").onclick = () => this.moreSheet();
    // 水の部品（2026-11-13）: 上のボタン、つまみの入る板、タブ
    water(document.getElementById("ed-back"));
    water(document.getElementById("ed-steps"));
    water(document.getElementById("ed-more"));
    water(document.getElementById("ed-export"), { kind: "white" });
    water(document.getElementById("ed-panel-box"), { radius: 28, press: false });
    water(document.getElementById("ed-tabs-box"));
    this.tabInd = indicator(this.tabs);
    this.coreChip.onclick = () => this.showGroup("core");
    this.oneBtn.onclick = () => this.toggleOneToOne();
    // 明るさの山を押している間だけ、白飛び（赤）と黒つぶれ（青）を色で出す
    this.hist.addEventListener("pointerdown", () => engine.setClip(true));
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) this.hist.addEventListener(ev, () => engine.setClip(false));
    new ResizeObserver(() => this.resize()).observe(this.photo);
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
    document.getElementById("ed-name").textContent = item.name || "";
    document.getElementById("ed-bg").style.backgroundImage = thumbSrc ? `url("${thumbSrc}")` : "none"; // 後ろに敷く、ぼかした写真
    // 撮った日時: 2024年7月18日 14:07（普通の写真アプリと同じ書き方）
    const dt = item.dateTaken ? new Date(item.dateTaken) : null;
    document.getElementById("ed-sub").textContent = dt ? `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日 ${dt.getHours()}:${String(dt.getMinutes()).padStart(2, "0")}` : "";
    this.engine.canvas.style.opacity = "0";
    this.preview.style.setProperty("--rot", "0deg");
    this.preview.classList.remove("is-turned");
    // 仮の画は、読み込めてから出す（読み込むまでのあいだ、前の写真の仮の画が残って見えるため）
    this.preview.hidden = true;
    this.preview.onload = () => {
      if (this.item === item && !this.ready) this.preview.hidden = false;
    };
    this.preview.src = thumbSrc || "";
    this.setBadge("現像しています…", true);
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
    this.drawHist(hist);
    const dpr = this.engine.canvas.width / Math.max(1, this.photo.clientWidth);
    Object.assign(this.grid.style, {
      left: layout.dx / dpr + "px", top: layout.dy / dpr + "px", width: layout.rw / dpr + "px", height: layout.rh / dpr + "px",
    });
    this.oneBtn.textContent = this.engine.view.zoom > 1.001 ? "全体" : "等倍";
  }

  setBadge(text, busy) {
    this.badge.textContent = text;
    this.badge.hidden = !text;
    this.badge.classList.toggle("is-busy", !!busy);
  }

  firstHint() {
    if (pref("hint1")) return;
    pref("hint1", true);
    this.setBadge("押している間は元の画・2回たたくと全画面");
    setTimeout(() => this.badge.textContent.startsWith("押している間") && this.setBadge(""), 5000);
  }

  drawHist(b) {
    const cv = this.hist, dpr = window.devicePixelRatio || 1, W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (!W || !H || !b) return;
    if (cv.width !== W) [cv.width, cv.height] = [W, H];
    const c = cv.getContext("2d"), max = Math.max(1, ...b.l.slice(1, 63)) * 1.1;
    c.clearRect(0, 0, W, H);
    const path = (arr, style, fill) => {
      c.beginPath();
      c.moveTo(0, H);
      for (let i = 0; i < 64; i++) c.lineTo((i / 63) * W, H - Math.min(1, arr[i] / max) * H);
      c.lineTo(W, H);
      if (fill) {
        c.fillStyle = style;
        c.fill();
      } else {
        c.strokeStyle = style;
        c.stroke();
      }
    };
    path(b.l, "rgba(236,230,218,.28)", true);
    c.lineWidth = dpr;
    path(b.r, "rgba(224,106,94,.7)");
    path(b.g, "rgba(108,191,106,.7)");
    path(b.b, "rgba(106,149,224,.8)");
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
            this.setBadge("元の画");
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
    this.tabs.replaceChildren(...GROUPS.map((g) => h("button", {
      class: "tab" + (g.id === this.group ? " is-on" : "") + (this.params && this.groupChanged(g) ? " is-changed" : ""),
      onClick: () => this.showGroup(g.id),
    }, g.name)));
    this.tabInd.to(this.tabs.querySelector(".is-on"));
    // 上のルック名: Cinema に Aftersun を足しているときは、足した物と量も出す（例: Cinema ＋ Aftersun Blue 40）。「自動」は、何も選んでいないときだけ
    const p = this.params, st = lookState(p || AUTO);
    const sunName = st.sun ? this.engine.coreById(st.sun).name : "";
    const auto = p && p.core === AUTO_CORE && !st.sun;
    this.coreChip.replaceChildren(h("small", {}, "ルック"), h("b", {}, st.cinema ? "Cinema" : sunName || "なし"),
      st.cinema && st.sun ? h("span", { class: "plus" }, `＋ ${sunName} ${Math.round(st.level)}`) : "", auto ? h("span", { class: "auto" }, "自動") : "");
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

  knob(key, { path = key, label, value, def, min, max, fmt, track, snaps } = {}) {
    const k = KNOBS[key] || {};
    return slider({
      label: label || k.label, min: min ?? k.min, max: max ?? k.max, step: k.step || 1, def: def ?? k.def ?? 0, fmt: fmt || k.fmt, track: track || k.track,
      value: value ?? this.params[key], snaps, onInput: (v) => this.setParam(path, v), onCommit: () => this.commit(),
    }).el;
  }

  renderPanel() {
    if (!this.params) return;
    const g = GROUPS.find((x) => x.id === this.group) || GROUPS[1];
    const body = [];
    if (g.id === "core") body.push(...this.corePanel());
    if (g.id === "basic") body.push(...[this.sunKnob()].filter(Boolean)); // よく使うの一番上に、足した Aftersun の強さ（足していない時は出さない）
    if (g.knobs) body.push(...g.knobs.map((k) => this.knob(k)));
    if (g.curve) body.push(...this.curvePanel());
    if (g.bw) {
      body.push(h("label", { class: "toggle-row" }, h("span", {}, "白黒"), h("input", {
        type: "checkbox", class: "toggle", checked: this.params.bw ? "checked" : null,
        onChange: (e) => (this.setParam("bw", e.target.checked), this.commit()),
      })));
    }
    if (g.id === "mix") body.push(...this.mixPanel());
    if (g.id === "grade") body.push(...this.gradePanel());
    if (g.id === "crop") body.push(...this.cropPanel());
    this.panel.replaceChildren(...body);
    this.panel.scrollTop = 0;
  }

  // ルックの板（2026-11-13 本人の案。仮の形で、見た目はデザインの作り直しの時に整える）:
  // Cinema のオン・オフ ＋ 足す Aftersun（なし／Aftersun／Blue／Aqua）＋ その強さ（Sun Level）
  corePanel() {
    const st = lookState(this.params);
    const apply = (cinema, sun, level) => {
      for (const [k, v] of Object.entries(lookParams(cinema, sun, level))) this.setParam(k, v);
      this.commit();
      bridge.haptic("tick");
      this.renderTabs();
      this.renderPanel();
    };
    const cinemaRow = h("label", { class: "toggle-row" }, h("span", {}, "Cinema"), h("input", {
      type: "checkbox", class: "toggle", checked: st.cinema ? "checked" : null,
      onChange: (e) => apply(e.target.checked, st.sun, st.level),
    }));
    // 前に直した写真が、一覧から外したルック（Nostalgia など）のままなら、その箱も出す（選び直すまでそのまま使える）
    const ids = [null, ...SUN_CORES, ...(st.sun && !SUN_CORES.includes(st.sun) ? [st.sun] : [])];
    const boxes = ids.map((id) => {
      const cv = h("canvas", { class: "core-cv" });
      const [c1, c2] = (id && CORE_BANDS[id]) || ["#555", "#999"];
      const box = h("button", {
        class: "core-box" + (id === st.sun ? " is-on" : ""), style: { "--c1": c1, "--c2": c2 },
        onClick: () => id !== st.sun && apply(st.cinema, id, st.sun && st.level > 0 ? st.level : 100), // なしから選んだ時は 100 から
      }, h("div", { class: "core-window" }, cv), h("div", { class: "core-band" }), h("div", { class: "core-name" }, id ? this.engine.coreById(id).name : "なし"),
      h("div", { class: "core-auto" }, ""));
      box.dataset.sun = id || "";
      return box;
    });
    const row = h("div", { class: "cores" }, boxes);
    // ルックを選び直しても、横の並びの位置は動かさない。タブに入った直後は、選んでいるルックを真ん中に出す
    row.addEventListener("scroll", () => (this.coreScroll = row.scrollLeft), { passive: true });
    requestAnimationFrame(() => {
      const on = row.querySelector(".is-on");
      if (this.coreScroll !== undefined) row.scrollLeft = this.coreScroll;
      else if (on) row.scrollLeft = Math.max(0, on.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft - (row.clientWidth - on.offsetWidth) / 2);
      this.drawCoreThumbs(row);
    });
    const head = h("p", { class: "note" }, "Aftersun を足す");
    if (!st.sun) return [cinemaRow, head, row, h("p", { class: "note" }, st.cinema ? "Cinema だけの画です。" : "ルックなし（素の画）です。")];
    const core = this.engine.coreById(st.sun), name = core.name, sc = sunCoreOf(core);
    const note = st.cinema ? `Sun Level は、0 で Cinema そのまま、100 で ${name} の色。明るさ・明暗は Cinema のままです。`
      : sc >= 100 ? `Sun Level は、0 で素の画、100 で ${name} そのまま。`
        : `Sun Level は、0 で素の画、${sc} で ${name} そのまま、100 でその ${sunGainOf(core)} 倍。${sc} で軽く止まります。`;
    return [cinemaRow, head, row, this.sunKnob(), h("p", { class: "note" }, note)];
  }

  // 足した Aftersun の強さのつまみ（Sun Level）。足していない時は null
  sunKnob() {
    const st = lookState(this.params);
    if (!st.sun) return null;
    const sc = sunCoreOf(this.engine.coreById(st.sun));
    return this.knob("sunLevel", { value: st.level, def: 100, snaps: !st.cinema && sc < 100 ? [sc] : [] });
  }

  // いまのルックを言葉にする（例: Cinema ＋ Aftersun Blue 40）
  lookLabel(p) {
    const st = lookState(p), n = st.sun ? `${this.engine.coreById(st.sun).name} ${Math.round(st.level)}` : "";
    return st.cinema ? (n ? `Cinema ＋ ${n}` : "Cinema") : n || "ルックなし";
  }

  // 核の箱の中に、いまの写真をその核で描いた小さな画を出す
  drawCoreThumbs(row) {
    if (!this.engine.image || !this.ready) {
      setTimeout(() => this.group === "core" && row.isConnected && this.drawCoreThumbs(row), 300);
      return;
    }
    const keep = this.engine.params;
    for (const box of row.querySelectorAll(".core-box")) {
      this.engine.params = { ...defaultParams(), ...lookParams(lookState(keep).cinema, box.dataset.sun || null, 100), crop: keep.crop };
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
    const pk = [["shadows", "シャドウの範囲"], ["darks", "暗い所の範囲"], ["lights", "明るい所の範囲"], ["highlights", "ハイライトの範囲"]];
    return [h("div", { class: "sub-title" }, "トーンカーブ", h("span", { class: "sub-note" }, "たたいて点を足す・枠の外へ出すと消える・2回たたくと戻す")), ed.el,
      ...pk.map(([k, label]) => this.knob(k, { path: ["param", k], label, value: this.params.param[k], min: -100, max: 100, def: 0 }))];
  }

  mixPanel() {
    const i = this.hslIndex, p = this.params;
    const chips = h("div", { class: "chips colors" }, HSL_NAMES.map((n, j) => h("button", {
      class: "chip color" + (j === i ? " is-on" : "") + (p.hsl.hue[j] || p.hsl.sat[j] || p.hsl.lum[j] ? " is-changed" : ""),
      style: { "--chip": HSL_COLORS[j] }, "aria-label": n, onClick: () => ((this.hslIndex = j), this.renderPanel()),
    })));
    return [chips, h("div", { class: "sub-title" }, HSL_NAMES[i]),
      this.knob("hue", { path: ["hsl", "hue", i], label: "色相", value: p.hsl.hue[i], min: -100, max: 100, def: 0 }),
      this.knob("sat", { path: ["hsl", "sat", i], label: "彩度", value: p.hsl.sat[i], min: -100, max: 100, def: 0 }),
      this.knob("lum", { path: ["hsl", "lum", i], label: "輝度", value: p.hsl.lum[i], min: -100, max: 100, def: 0 })];
  }

  gradePanel() {
    const z = this.gradeZone, g = this.params.grading;
    const chips = h("div", { class: "chips" }, GRADE_ZONES.map(([k, name]) => h("button", {
      class: "chip" + (k === z ? " is-on" : "") + (g[k].sat || g[k].lum ? " is-changed" : ""), onClick: () => ((this.gradeZone = k), this.renderPanel()),
    }, name)));
    return [chips,
      this.knob("ghue", { path: ["grading", z, "hue"], label: "色相", value: g[z].hue, min: 0, max: 360, def: 0, track: "hue", fmt: (v) => Math.round(v) + "°" }),
      this.knob("gsat", { path: ["grading", z, "sat"], label: "彩度", value: g[z].sat, min: 0, max: 100, def: 0 }),
      this.knob("glum", { path: ["grading", z, "lum"], label: "輝度", value: g[z].lum, min: -100, max: 100, def: 0 }),
      this.knob("balance", { path: ["grading", "balance"], label: "バランス", value: g.balance, min: -100, max: 100, def: 0 })];
  }

  cropPanel() {
    const W = this.engine.src ? this.engine.src.w : 1, H = this.engine.src ? this.engine.src.h : 1, c = this.params.crop;
    const chips = h("div", { class: "chips" }, ASPECTS.map(([name, a]) => h("button", {
      class: "chip" + ((c.aspect || 0) === a ? " is-on" : ""),
      onClick: () => {
        this.setParam("crop", cropForAspect({ ...this.params.crop, cx: 0.5, cy: 0.5 }, a, W, H));
        this.commit();
        this.renderPanel();
      },
    }, name)));
    const straighten = slider({
      label: "傾き", min: -45, max: 45, step: 0.1, def: 0, value: c.angle, fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(1) + "°",
      onInput: (v) => {
        const base = cropForAspect({ ...this.params.crop, angle: 0 }, this.params.crop.aspect || 0, W, H);
        this.setParam("crop", rotateCrop({ ...base, cx: this.params.crop.cx, cy: this.params.crop.cy }, v, W, H));
      },
      onCommit: () => this.commit(),
    }).el;
    const reset = h("button", {
      class: "text-btn", onClick: () => {
        this.setParam("crop", { cx: 0.5, cy: 0.5, w: 1, h: 1, angle: 0 });
        this.commit();
        this.renderPanel();
      },
    }, "切り抜きをやめる");
    return [chips, straighten, h("p", { class: "note" }, "写真を指で動かす・つまむと、枠の中の写り方が変わります。"), reset];
  }

  // ---------- ほかの操作（直しのコピー・貼り付け、すべて戻す）----------
  moreSheet() {
    if (!this.params) return;
    const clip = pref("clipboard");
    const row = (label, sub, fn, disabled) => h("button", { class: "menu-row", disabled: disabled ? "disabled" : null, onClick: () => (closeSheet(), fn()) }, label, h("small", {}, sub));
    sheet("ほかの操作", h("div", { class: "sheet-body" },
      row("直しをコピー", "ルック・つまみの値を覚える（切り抜きは含めない）", () => {
        const { crop, ...rest } = clone(this.params);
        pref("clipboard", rest);
        toast("直しをコピーしました。ほかの写真で「貼り付け」できます");
      }),
      row("直しを貼り付け", clip ? `${this.lookLabel(clip)} ほか、コピーした値にする（切り抜きはこの写真のまま）` : "まだコピーしていません", () => {
        this.params = { ...mergeParams(clip), crop: this.params.crop };
        this.engine.setParams(this.params);
        this.commit();
        this.renderPanel();
        bridge.haptic("confirm");
      }, !clip),
      row("すべて戻す", "ルックとつまみを最初の状態に戻す（1つ戻すで取り消せる）", () => {
        this.params = { ...defaultParams(), ...AUTO };
        this.engine.setParams(this.params);
        this.commit();
        this.renderPanel();
        bridge.haptic("detent");
      }),
      // ゴミ箱: この写真をスマホから消す（Android の確認が1回出る）。読み込んだファイル（一覧に無い写真）は消せない
      h("button", {
        class: "menu-row is-danger", disabled: this.item && this.item.id !== undefined ? null : "disabled",
        onClick: () => (closeSheet(), this.deleteThis()),
      }, h("span", { class: "menu-ic" }, trashIcon()), "この写真を削除", h("small", {}, "スマホから元の RAW（DNG）を消します。元に戻せません"))));
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
    const c = this.engine._cropPx(), full = `${Math.round(c.w)}×${Math.round(c.h)}`;
    let size = pref("exportSize") ?? 0, loc = false;
    const opt = (v, label, sub) => h("label", { class: "radio-row" }, h("input", {
      type: "radio", name: "size", checked: size === v ? "checked" : null, onChange: () => ((size = v), pref("exportSize", v)),
    }), h("span", {}, label, h("small", {}, sub)));
    const body = h("div", { class: "sheet-body" },
      opt(0, "元の大きさ", full), opt(2048, "長い辺 2048", "SNS 向け"), opt(1080, "長い辺 1080", "LINE で送る向け"),
      h("label", { class: "toggle-row" }, h("span", {}, "撮影場所も入れる", h("small", {}, "送った相手に場所が伝わらないよう、ふつうは入れません")),
        h("input", { type: "checkbox", class: "toggle", onChange: (e) => (loc = e.target.checked) })),
      h("p", { class: "note" }, "カメラの写真と同じ所（DCIM/Camera）に、撮った日時のまま保存します。元の RAW はそのままです。"),
      h("button", { class: "btn-primary", onClick: () => (closeSheet(), this.doExport(size, loc)) }, "ギャラリーに書き出す"));
    sheet("書き出し", body);
  }

  async doExport(maxSide, copyLocation) {
    const item = this.item;
    toast("書き出しています…", [], 0);
    await new Promise((r) => setTimeout(r, 40));
    try {
      const blob = await this.engine.exportJpeg({ maxSide, quality: 0.95 });
      const name = (item.name || "photo").replace(/\.[^.]+$/, "") + "_sunglasses.jpg";
      const p = this.params;
      const note = `Sunglasses: ${this.lookLabel(p)}, exposure ${p.exposure >= 0 ? "+" : ""}${p.exposure.toFixed(2)}`;
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
