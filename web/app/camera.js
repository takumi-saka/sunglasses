// 撮る画面（2026-11-05）。カメラの画は APK が下に描き、この画面はその上に、透かした枠とボタンを重ねる。
// 撮ると、1 枚撮りの生の RAW（DNG）が DCIM/Sunglasses に入る。撮る画面の画には、いまの核と Sun Level をかけて見せる。
//
// 明るさ: 自動と手動がある。
//   自動 … 核の見た目に合わせて、明るさをアプリが決める。つまみは自動で決めた値を指し、一緒に動く。
//   手動 … つまみを動かすと手動になる。自動の決め直しを止め、決めた明るさのままにする（カメラの明るさの補正も動かすので、撮る RAW にも入る）。
//   「自動」を押すと自動に戻る。
// 撮った写真は、撮ったときの核・Sun Level・明るさのまま編集で開く（写真ごとの直しの記録に入れておく）。
import * as C from "../engine/color.js";
import { defaultParams } from "../engine/engine.js";
import * as bridge from "./bridge.js";
import { pref, setEdit } from "./store.js";
import { h, slider, toast } from "./ui.js";

const FRAMES = [["1.85", "1.85:1"], ["thirds", "三分割"], ["off", "なし"]];
const SETTINGS = {
  frame: FRAMES.map((f) => f[0]),
  timer: [0, 3, 10],
  zebra: [true, false],
  sound: [true, false],
  autoJpeg: [false, true],
};
const log2 = (x) => Math.log(x) / Math.LN2;

export class Camera {
  constructor(engine, { onBack, onOpenItem, onCaptured }) {
    this.engine = engine;
    this.onBack = onBack;
    this.onOpenItem = onOpenItem;
    this.onCaptured = onCaptured;
    this.root = document.getElementById("camera");
    this.view = document.getElementById("cam-view");
    this.active = false;
    this.shots = [];
    this.jpegQueue = [];
    this.gains = { A: 1, B: 1 };
    this.base = {};
    this.expo = { auto: true, display: 0, frozen: null, at: 0, remainder: 0 };
    this.settings = { frame: "1.85", timer: 0, zebra: true, sound: true, autoJpeg: false, ...(pref("camera") || {}) };
    this.family = pref("cameraFamily") || "aftersun";
    this.sunLevel = pref("cameraSunLevel") ?? 100;
    this.build();
    window.addEventListener("sunglasses:camera", (e) => this.onCamera(e.detail));
    window.addEventListener("sunglasses:camera-sample", (e) => this.onSample(e.detail));
    window.addEventListener("sunglasses:captured", (e) => this.onCapturedEvent(e.detail));
    window.addEventListener("sunglasses:shutter-key", () => this.active && this.shoot());
    window.addEventListener("sunglasses:orientation", (e) => this.rotate(e.detail.deg));
    window.addEventListener("sunglasses:camera-permission", () => this.active && this.open());
    window.addEventListener("resize", () => this.active && (this.layoutView(), this.sendRect()));
    window.addEventListener("devicemotion", (e) => this.level(e));
  }

  get v3() {
    return bridge.bridgeVersion() >= 3;
  }

  // ---------- 画面の組み立て ----------
  build() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      frame: $("cam-frame"), grid: $("cam-grid"), level: $("cam-level"), ring: $("cam-ring"), badge: $("cam-badge"),
      count: $("cam-count"), readout: $("cam-readout"), hist: $("cam-hist"), thumb: $("cam-thumb"), shutter: $("cam-shutter"),
      coreBtn: $("cam-core"), raw: $("cam-raw"), ev: $("cam-ev"), lenses: $("cam-lenses"), msg: $("cam-msg"),
    };
    $("cam-back").onclick = () => this.onBack();
    for (const key of Object.keys(SETTINGS)) this.wheel($("cam-set-" + (key === "autoJpeg" ? "jpeg" : key)), key);
    this.els.shutter.onclick = () => this.shoot();
    this.els.thumb.onclick = () => this.shots[0] && this.onOpenItem(this.shots[0].item, this.shots[0].url);
    this.els.coreBtn.onclick = () => this.nextFamily();
    // 押している間だけ、核をかけない素の画
    const raw = this.els.raw;
    const on = (yes) => {
      if (this.v3) this.sendWeights(yes ? { wN: 1, wA: 0, wB: 0 } : null);
      else bridge.cameraCall("cameraSetLookOn", !yes);
      raw.classList.toggle("is-on", yes);
    };
    raw.addEventListener("pointerdown", () => on(true));
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) raw.addEventListener(ev, () => raw.classList.contains("is-on") && on(false));
    this.viewGestures();
    this.renderSettings();
  }

  // 上の設定: 値の所を上下になぞると、ダイヤルを回すように値が送られる（1 つ進むごとに軽い手応え）。たたくと次の値
  wheel(btn, key) {
    const list = SETTINGS[key];
    let startY = 0, startIdx = 0, moved = false, active = false;
    btn.addEventListener("pointerdown", (e) => {
      active = true;
      moved = false;
      startY = e.clientY;
      startIdx = list.indexOf(this.settings[key]);
      btn.setPointerCapture(e.pointerId);
    });
    btn.addEventListener("pointermove", (e) => {
      if (!active) return;
      const dy = startY - e.clientY;
      if (Math.abs(dy) > 6) moved = true;
      const steps = Math.round(dy / 24);
      const i = (((startIdx + steps) % list.length) + list.length) % list.length;
      if (list[i] !== this.settings[key]) this.setSetting(key, list[i], steps > 0 ? "up" : "down");
    });
    const end = () => {
      if (!active) return;
      active = false;
      if (!moved) {
        const i = list.indexOf(this.settings[key]);
        this.setSetting(key, list[(i + 1) % list.length], "up");
      }
    };
    btn.addEventListener("pointerup", end);
    btn.addEventListener("pointercancel", end);
  }

  setSetting(key, value, dir) {
    this.settings[key] = value;
    pref("camera", this.settings);
    bridge.haptic("tick");
    if (key === "zebra") bridge.cameraCall("cameraSetZebra", value);
    this.renderSettings(key, dir);
  }

  renderSettings(changed, dir) {
    const s = this.settings, $ = (id) => document.getElementById(id);
    const text = {
      frame: FRAMES.find((f) => f[0] === s.frame)[1], timer: s.timer ? s.timer + "秒" : "なし", zebra: s.zebra ? "出す" : "出さない",
      sound: s.sound ? "鳴らす" : "鳴らさない", autoJpeg: s.autoJpeg ? "保存する" : "保存しない",
    };
    for (const key of Object.keys(SETTINGS)) {
      const b = $("cam-set-" + (key === "autoJpeg" ? "jpeg" : key)).querySelector("b");
      b.textContent = text[key];
      if (key === changed) {
        b.classList.remove("roll-up", "roll-down");
        void b.offsetWidth;
        b.classList.add(dir === "down" ? "roll-down" : "roll-up");
      }
    }
    this.els.frame.dataset.frame = s.frame;
    this.els.grid.hidden = s.frame !== "thirds";
    const name = this.family === "mine" ? "自分の好み" : "Aftersun";
    this.els.coreBtn.replaceChildren(h("span", { class: "engrave" }, "核"), h("b", {}, name));
  }

  // ---------- 開く・閉じる ----------
  async open() {
    this.active = true;
    this.root.hidden = false;
    document.documentElement.classList.add("is-camera");
    this.showMsg("");
    if (bridge.bridgeVersion() < 2) {
      this.showMsg("撮る機能を使うには、アプリの入れ直しが必要です。", [["入れ直す", () => bridge.openUrl(bridge.APK_URL)]]);
      return;
    }
    if (bridge.cameraPermission() !== "granted") {
      this.showMsg("撮るには、カメラの許可が要ります。", [["許可する", () => bridge.requestCameraPermission()], ["設定を開く", () => bridge.openAppSettings()]]);
      bridge.requestCameraPermission();
      return;
    }
    const info = JSON.parse(bridge.cameraInfo() || "{}");
    this.cams = (info.cameras || []).filter((c) => c.raw).sort((a, b) => (a.eq35 || 99) - (b.eq35 || 99));
    if (!this.cams.length) {
      this.fallback();
      return;
    }
    const want = pref("cameraId");
    this.cam = this.cams.find((c) => c.id === want) || this.cams.reduce((a, b) => (Math.abs((b.eq35 || 24) - 24) < Math.abs((a.eq35 || 24) - 24) ? b : a));
    this.renderLenses();
    await this.sendLook();
    this.buildControls();
    this.layoutView();
    const r = this.rect();
    this.expo = { auto: true, display: 0, frozen: null, at: 0, remainder: 0 };
    bridge.cameraCall("cameraOpen", this.cam.id, r.x, r.y, r.w, r.h);
    bridge.cameraCall("cameraSetZebra", this.settings.zebra);
    bridge.keepScreenOn(true);
    this.updateCount();
  }

  close() {
    this.active = false;
    this.root.hidden = true;
    document.documentElement.classList.remove("is-camera");
    bridge.cameraCall("cameraClose");
    bridge.keepScreenOn(false);
  }

  // この端末のカメラが、ほかのアプリに RAW を渡さないとき: 純正カメラで撮り、戻ったら、いま撮った RAW を開く
  fallback() {
    this.showMsg("この端末のカメラは、ほかのアプリに RAW を渡しません。純正カメラのプロモードで RAW を撮ってください。戻ってきたら、いま撮った写真をすぐ開きます。",
      [["純正カメラで撮る", () => {
        pref("stockLaunch", Date.now());
        bridge.openStockCamera();
      }]]);
  }

  showMsg(text, actions = []) {
    this.els.msg.hidden = !text;
    this.els.msg.replaceChildren(h("p", {}, text), h("div", { class: "cam-msg-btns" }, actions.map(([t, fn]) => h("button", { class: "pill accent", onClick: fn }, t))));
  }

  // 撮る画面の画の大きさ: 縦横 3:4 のまま、ほかの部品を置いた残りの高さに収める（足りなければ左右を空ける）
  layoutView() {
    const cs = getComputedStyle(this.root);
    const others = [...this.root.children].filter((el) => el !== this.view && !el.hidden).reduce((s, el) => s + el.getBoundingClientRect().height, 0);
    const avail = this.root.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - others;
    const w = Math.max(120, Math.min(this.root.clientWidth, (avail * 3) / 4));
    this.view.style.width = w + "px";
    this.view.style.height = (w * 4) / 3 + "px";
  }

  rect() {
    const r = this.view.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    return { x: r.left * d, y: r.top * d, w: r.width * d, h: r.height * d };
  }
  sendRect() {
    const r = this.rect();
    bridge.cameraCall("cameraSetRect", r.x, r.y, r.w, r.h);
  }

  renderLenses() {
    this.els.lenses.replaceChildren(...(this.cams.length > 1 ? this.cams.map((c) => h("button", {
      class: "chip" + (c.id === this.cam.id ? " is-on" : ""),
      onClick: () => {
        if (c.id === this.cam.id) return;
        this.cam = c;
        pref("cameraId", c.id);
        this.renderLenses();
        const r = this.rect();
        bridge.cameraCall("cameraOpen", c.id, r.x, r.y, r.w, r.h);
      },
    }, c.eq35 ? c.eq35 + "mm" : "レンズ " + c.id)) : []));
  }

  // ---------- 核と Sun Level ----------
  look() {
    return this.engine.lookFor({ core: this.family, sunLevel: this.sunLevel });
  }

  async lutBase64(core) {
    const buf = await (await fetch(new URL(core.file, this.engine.looksBase))).arrayBuffer();
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.readAsDataURL(new Blob([buf]));
    });
  }

  // 撮る画面の画に核をかけるための、核の色の対応表（2 つまで）と曲線を APK へ渡す
  async sendLook() {
    const lk = this.look();
    const m = this.engine.ap0ToAp1, s = this.engine.srgbToAp0, M = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r * 3 + c] = m[r * 3] * s[c] + m[r * 3 + 1] * s[3 + c] + m[r * 3 + 2] * s[6 + c];
    bridge.cameraCall("cameraSetLookParams", JSON.stringify({ m: M, curve: Array.from(this.engine.jpegToLinear) }));
    if (this.v3) {
      for (const [slot, core] of [[0, lk.A], [1, lk.B || lk.A]]) {
        bridge.cameraCall("cameraSetLookSlot", slot, await this.lutBase64(core), core.size, JSON.stringify([...core.lo, ...core.hi]));
      }
      this.sendWeights();
    } else {
      // 古い APK（窓口 版 2）: 核は 1 つだけ（Sun Level は撮る画面には効かない）
      const core = lk.B || lk.A;
      bridge.cameraCall("cameraSetLook", await this.lutBase64(core), core.size, JSON.stringify([...core.lo, ...core.hi]));
    }
  }

  sendWeights(w) {
    const lk = w || this.look();
    if (this.v3) bridge.cameraCall("cameraSetWeights", lk.wN, lk.wA, lk.wB);
  }

  async nextFamily() {
    this.family = this.family === "mine" ? "aftersun" : "mine";
    pref("cameraFamily", this.family);
    bridge.haptic("tick");
    this.renderSettings();
    this.buildControls();
    await this.sendLook();
  }

  // ---------- APK からの知らせ ----------
  onCamera(d) {
    if (!this.active || !d) return;
    if (d.state === "open") {
      this.opened = d;
      this.showMsg("");
      this.buildControls();
      this.updateCount();
    } else if (d.state === "info") {
      const parts = [];
      if (d.exposure) parts.push(d.exposure >= 0.5 ? d.exposure.toFixed(1) + "秒" : "1/" + Math.round(1 / d.exposure));
      if (d.iso) parts.push("ISO " + d.iso);
      if (this.opened && this.opened.rawSize) {
        const [rw, rh] = this.opened.rawSize.split("x").map(Number);
        parts.push("RAW " + Math.round((rw * rh) / 1e6) + "MP");
      }
      this.els.readout.textContent = parts.join("　");
      this.els.badge.textContent = d.locked ? "明るさとピントを固定中" : d.exposure && d.exposure > 1 / 15 ? "手ぶれに注意（" + parts[0] + "）" : "";
      this.els.badge.hidden = !this.els.badge.textContent;
    } else if (d.state === "error" || d.state === "closed") {
      this.showMsg(d.message || "カメラが止まりました。", [["開き直す", () => this.open()]]);
    }
  }

  // 明るさ（自動・手動）と Sun Level のつまみ
  buildControls() {
    const d = this.opened || {};
    this.evRange = { min: d.evMin || 0, max: d.evMax || 0 };
    const autoBtn = h("button", { class: "cam-auto" + (this.expo.auto ? " is-on" : ""), onClick: () => this.setAuto() }, "自動");
    this.autoBtn = autoBtn;
    this.evSlider = slider({
      label: "明るさ", min: -3, max: 3, step: 0.1, def: 0, value: this.expo.display, extra: autoBtn,
      fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(1) + " 段",
      onInput: (v) => this.setManual(v), onCommit: () => {}, onReset: () => this.setAuto(),
    });
    const lv = slider({
      label: "Sun Level", min: 0, max: 100, step: 1, def: 100, value: this.sunLevel, snaps: this.family === "mine" ? [] : [50],
      fmt: (v) => String(Math.round(v)),
      onInput: (v) => {
        this.sunLevel = v;
        pref("cameraSunLevel", v);
        this.sendWeights();
      },
      onCommit: () => {},
    });
    const note = h("p", { class: "cam-note" }, this.v3
      ? (this.family === "mine" ? "0 で素の画、100 で自分の好み" : "0 で素の画、50 で Aftersun 弱め、100 で Aftersun")
      : "撮る画面で Sun Level を見るには、アプリの入れ直しが必要です（撮った写真には効きます）");
    this.els.ev.replaceChildren(this.evSlider.el, lv.el, note);
    if (this.active) {
      this.layoutView();
      this.sendRect();
    }
  }

  setAuto() {
    if (this.expo.auto) return;
    this.expo = { auto: true, display: this.expo.display, frozen: null, at: 0, remainder: 0 };
    bridge.cameraCall("cameraSetEv", 0);
    this.autoBtn.classList.add("is-on");
    bridge.haptic("tick");
  }

  setManual(v) {
    if (this.expo.auto) {
      // 手動に切り替える: いまの自動の明るさで止めて、そこから動かす
      this.expo = { auto: false, display: v, frozen: { ...this.gains }, at: this.expo.display, remainder: 0 };
      this.autoBtn.classList.remove("is-on");
    }
    const want = v - this.expo.at;
    const cEv = C.clamp(want, this.evRange.min, this.evRange.max);
    this.expo.display = v;
    this.expo.remainder = want - cEv; // カメラの補正で届かない分は、画の明るさの倍率で足す
    bridge.cameraCall("cameraSetEv", cEv);
    this.sendGains();
  }

  sendGains() {
    const g = this.expo.auto ? this.gains : this.expo.frozen, k = this.expo.auto ? 1 : Math.pow(2, this.expo.remainder);
    if (this.v3) bridge.cameraCall("cameraSetGains", g.A * k, g.B * k);
    else bridge.cameraCall("cameraSetGain", (this.look().B ? g.B : g.A) * k);
  }

  // 均一な 18% の灰色の景色のときの倍率（自動の明るさを「段」で出すときの 0）
  baseGain(core) {
    if (this.base[core.id] === undefined) {
      const gray = new Float32Array(48).fill(0.18);
      const ev = C.searchEv((e) => C.medianCore(gray, 0.18, e, core.cpu, this.engine.ap0ToAp1), this.engine.targetL + core.lift);
      this.base[core.id] = Math.pow(2, ev);
    }
    return this.base[core.id];
  }

  // 0.4 秒ごとの小さな画: 核をかけるときの明るさ（自動）を決め、明るさの山を描く
  onSample(d) {
    if (!this.active || !d) return;
    const raw = Uint8Array.from(atob(d.raw), (c) => c.charCodeAt(0));
    const n = d.w * d.h, small = new Float32Array(n * 3), toLin = this.engine.jpegToLinear, S = this.engine.srgbToAp0;
    let sl = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const lin = [0, 1, 2].map((k) => {
        const v = raw[i * 4 + k] / 255;
        return d.preset ? C.s2l(v) : C.curveAt(toLin, v);
      });
      const a = C.mul3(S, lin[0], lin[1], lin[2]).map((v) => Math.max(v, 0));
      small.set(a, i * 3);
      const y = C.AP0_Y[0] * a[0] + C.AP0_Y[1] * a[1] + C.AP0_Y[2] * a[2];
      if (y > 0) {
        sl += Math.log(Math.max(y, 1e-6));
        cnt++;
      }
    }
    const key = cnt ? Math.exp(sl / cnt) : 0.18, lk = this.look();
    const gainOf = (core) => (0.18 / key) * Math.pow(2, C.searchEv((e) => C.medianCore(small, key, e, core.cpu, this.engine.ap0ToAp1), this.engine.targetL + core.lift));
    const gA = gainOf(lk.A), gB = lk.B ? gainOf(lk.B) : gA;
    this.gains = { A: this.gains.A * 0.6 + gA * 0.4, B: this.gains.B * 0.6 + gB * 0.4 };
    this.autoNow = { A: gA, B: gB };
    const main = lk.B && lk.wB > 0 ? lk.B : lk.A, gMain = main === lk.B ? this.gains.B : this.gains.A;
    if (this.expo.auto) {
      // 自動: つまみは、自動で決めた明るさ（均一な灰色の景色を 0 とした段）を指して一緒に動く
      this.expo.display = Math.round(C.clamp(log2(gMain / this.baseGain(main)), -3, 3) * 10) / 10;
      if (this.evSlider) this.evSlider.set(this.expo.display);
    }
    this.sendGains();
    this.drawHist(d.look ? Uint8Array.from(atob(d.look), (c) => c.charCodeAt(0)) : raw);
  }

  drawHist(px) {
    const cv = this.els.hist, dpr = window.devicePixelRatio || 1, W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (!W || !H) return;
    if (cv.width !== W) [cv.width, cv.height] = [W, H];
    const bins = new Uint32Array(64);
    for (let i = 0; i < px.length; i += 4) bins[Math.min(63, Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) >> 2)]++;
    const c = cv.getContext("2d"), max = Math.max(1, ...bins.slice(1, 63)) * 1.1;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(236,230,218,.4)";
    c.beginPath();
    c.moveTo(0, H);
    for (let i = 0; i < 64; i++) c.lineTo((i / 63) * W, H - Math.min(1, bins[i] / max) * H);
    c.lineTo(W, H);
    c.fill();
  }

  // ---------- 撮る ----------
  async shoot() {
    if (!this.active || this.busy || !this.opened) return;
    this.busy = true;
    for (let i = this.settings.timer; i > 0; i--) {
      this.els.badge.hidden = false;
      this.els.badge.textContent = i + "";
      bridge.haptic("tick");
      await new Promise((r) => setTimeout(r, 1000));
    }
    // 撮ったときの見た目（核・Sun Level・明るさ）を覚えておく。明るさは、自動のときと比べた差（段）
    const lk = this.look(), main = lk.B && lk.wB > 0 ? "B" : "A";
    const applied = this.expo.auto ? this.gains[main] : this.expo.frozen[main] * Math.pow(2, this.expo.remainder);
    this.pendingLook = {
      core: this.family, sunLevel: Math.round(this.sunLevel),
      exposure: this.expo.auto || !this.autoNow ? 0 : Math.round(C.clamp(log2(applied / this.autoNow[main]), -3, 3) * 100) / 100,
    };
    bridge.haptic("confirm");
    this.view.classList.add("is-flash");
    setTimeout(() => this.view.classList.remove("is-flash"), 140);
    bridge.cameraCall("cameraCapture", this.settings.sound);
    this.capturedTimer = setTimeout(() => (this.busy = false), 4000);
  }

  async onCapturedEvent(d) {
    clearTimeout(this.capturedTimer);
    this.busy = false;
    if (!d) return;
    if (!d.ok) {
      bridge.haptic("reject");
      toast("撮れませんでした。" + (d.error || ""), [], 6000);
      return;
    }
    const item = d.item, look = this.pendingLook || { core: this.family, sunLevel: this.sunLevel, exposure: 0 };
    const params = { ...defaultParams(), ...look };
    await setEdit(bridge.keyOf(item), { params, shot: true });
    const shot = { item, url: null };
    this.shots.unshift(shot);
    if (this.onCaptured) this.onCaptured(item);
    this.updateCount();
    try {
      const res = await fetch(bridge.mediaUrl(item));
      const t = await this.engine.decodeThumb(await res.arrayBuffer(), 256);
      const cv = document.createElement("canvas");
      this.engine.renderThumb(t, look, cv);
      shot.url = cv.toDataURL("image/jpeg", 0.85);
      this.els.thumb.style.backgroundImage = `url(${shot.url})`;
      this.els.thumb.classList.add("is-on");
    } catch {
      this.els.thumb.classList.add("is-on");
    }
    if (this.settings.autoJpeg) this.queueJpeg(item, params);
  }

  // 撮るたびに、核をかけた JPEG もギャラリーに保存する（選んだときだけ）
  queueJpeg(item, params) {
    this.jpegQueue.push({ item, params });
    if (this.jpegBusy) return;
    this.jpegBusy = true;
    (async () => {
      while (this.jpegQueue.length) {
        const { item: it, params: p } = this.jpegQueue.shift();
        try {
          const buf = await (await fetch(bridge.mediaUrl(it))).arrayBuffer();
          await this.engine.openRaw(buf);
          this.engine.setParams(p);
          const blob = await this.engine.exportJpeg({ maxSide: 0, quality: 0.95 });
          await bridge.saveJpeg(blob, { name: it.name.replace(/\.dng$/i, ".jpg"), folder: "DCIM/Camera", item: it });
        } catch (e) {
          toast("JPEG を作れませんでした。（" + e.message + "）");
        }
      }
      this.jpegBusy = false;
    })();
  }

  updateCount() {
    const free = Number(bridge.storageFree());
    const size = this.opened && this.opened.rawSize ? this.opened.rawSize.split("x").reduce((a, b) => a * b, 2) : 25e6;
    this.els.count.textContent = free > 0 ? `あと ${Math.floor(free / (size * 1.05)).toLocaleString()} 枚` : "";
  }

  // ---------- 撮る画面の上の指の動き: たたいてピントと明るさ、長押しで固定 ----------
  viewGestures() {
    const v = this.view;
    let timer = 0, start = null, longDone = false;
    v.addEventListener("pointerdown", (e) => {
      if (!this.opened) return;
      start = { x: e.clientX, y: e.clientY };
      longDone = false;
      timer = setTimeout(() => {
        longDone = true;
        this.focus(e.clientX, e.clientY, true);
      }, 450);
    });
    v.addEventListener("pointermove", (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12) clearTimeout(timer);
    });
    v.addEventListener("pointerup", (e) => {
      clearTimeout(timer);
      if (!start || longDone) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) <= 12) this.focus(e.clientX, e.clientY, false);
      start = null;
    });
  }

  focus(x, y, lock) {
    const r = this.view.getBoundingClientRect(), nx = (x - r.left) / r.width, ny = (y - r.top) / r.height;
    if (!lock && this.locked) bridge.cameraCall("cameraUnlock");
    this.locked = lock;
    bridge.cameraCall("cameraFocus", nx, ny, lock);
    bridge.haptic(lock ? "confirm" : "tick");
    const ring = this.els.ring;
    ring.style.left = x - r.left + "px";
    ring.style.top = y - r.top + "px";
    ring.classList.remove("is-on", "is-lock");
    void ring.offsetWidth;
    ring.classList.add("is-on");
    if (lock) ring.classList.add("is-lock");
  }

  // ---------- 端末の向き・水平（振動はしない。水平になったら線の色が変わるだけ）----------
  rotate(deg) {
    this.deg = deg;
    const r = deg === 90 ? -90 : deg === 270 ? 90 : deg === 180 ? 180 : 0;
    document.documentElement.style.setProperty("--rot", r + "deg");
    this.els.frame.dataset.land = deg === 90 || deg === 270 ? "1" : "0";
  }

  level(e) {
    if (!this.active || !e.accelerationIncludingGravity) return;
    const { x, y } = e.accelerationIncludingGravity;
    if (x === null || y === null) return;
    let a = (Math.atan2(x, y) * 180) / Math.PI;
    a = ((a % 90) + 135) % 90 - 45;
    this.els.level.style.transform = `translate(-50%, -50%) rotate(${-a}deg)`;
    this.els.level.classList.toggle("is-ok", Math.abs(a) < 0.8);
  }
}
