// 撮る画面（2026-11-05）。カメラの画は APK が下に描き、この画面はその上に、透かした枠とボタンを重ねる。
// 撮ると、1 枚撮りの生の RAW（DNG）が DCIM/Sunglasses に入る。撮る画面の画には、いま選んでいる核をかけて見せる。
import * as C from "../engine/color.js";
import * as bridge from "./bridge.js";
import { pref } from "./store.js";
import { h, slider, toast } from "./ui.js";

const FRAMES = [["1.85", "1.85:1"], ["thirds", "三分割"], ["off", "なし"]];
const TIMERS = [0, 3, 10];

export class Camera {
  constructor(engine, { onBack, onOpenItem, onCaptured }) {
    this.engine = engine;
    this.onBack = onBack;
    this.onOpenItem = onOpenItem;
    this.onCaptured = onCaptured;
    this.root = document.getElementById("camera");
    this.view = document.getElementById("cam-view");
    this.active = false;
    this.gain = 1;
    this.shots = [];
    this.jpegQueue = [];
    this.settings = { frame: "1.85", timer: 0, zebra: true, sound: true, autoJpeg: false, ...(pref("camera") || {}) };
    this.core = pref("cameraCore") || "aftersun";
    this.build();
    window.addEventListener("sunglasses:camera", (e) => this.onCamera(e.detail));
    window.addEventListener("sunglasses:camera-sample", (e) => this.onSample(e.detail));
    window.addEventListener("sunglasses:captured", (e) => this.onCapturedEvent(e.detail));
    window.addEventListener("sunglasses:shutter-key", () => this.active && this.shoot());
    window.addEventListener("sunglasses:orientation", (e) => this.rotate(e.detail.deg));
    window.addEventListener("sunglasses:camera-permission", () => this.active && this.open());
    window.addEventListener("resize", () => this.active && this.sendRect());
    window.addEventListener("devicemotion", (e) => this.level(e));
  }

  // ---------- 画面の組み立て ----------
  build() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      frame: $("cam-frame"), grid: $("cam-grid"), level: $("cam-level"), ring: $("cam-ring"), badge: $("cam-badge"),
      count: $("cam-count"), readout: $("cam-readout"), left: $("cam-left"), hist: $("cam-hist"), thumb: $("cam-thumb"),
      shutter: $("cam-shutter"), coreBtn: $("cam-core"), raw: $("cam-raw"), ev: $("cam-ev"), lenses: $("cam-lenses"), msg: $("cam-msg"),
    };
    $("cam-back").onclick = () => this.onBack();
    $("cam-set-frame").onclick = () => this.cycle("frame", FRAMES.map((f) => f[0]));
    $("cam-set-timer").onclick = () => this.cycle("timer", TIMERS);
    $("cam-set-zebra").onclick = () => this.cycle("zebra", [true, false]);
    $("cam-set-sound").onclick = () => this.cycle("sound", [true, false]);
    $("cam-set-jpeg").onclick = () => this.cycle("autoJpeg", [false, true]);
    this.els.shutter.onclick = () => this.shoot();
    this.els.thumb.onclick = () => this.shots[0] && this.onOpenItem(this.shots[0].item, this.shots[0].url);
    this.els.coreBtn.onclick = () => this.nextCore();
    // 押している間だけ、核をかけない素の画
    const raw = this.els.raw;
    raw.addEventListener("pointerdown", () => (bridge.cameraCall("cameraSetLookOn", false), raw.classList.add("is-on")));
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) raw.addEventListener(ev, () => (bridge.cameraCall("cameraSetLookOn", true), raw.classList.remove("is-on")));
    this.viewGestures();
    this.renderSettings();
  }

  cycle(key, list) {
    const i = list.indexOf(this.settings[key]);
    this.settings[key] = list[(i + 1) % list.length];
    pref("camera", this.settings);
    bridge.haptic("tick");
    if (key === "zebra") bridge.cameraCall("cameraSetZebra", this.settings.zebra);
    this.renderSettings();
  }

  renderSettings() {
    const s = this.settings, $ = (id) => document.getElementById(id);
    $("cam-set-frame").querySelector("b").textContent = FRAMES.find((f) => f[0] === s.frame)[1];
    $("cam-set-timer").querySelector("b").textContent = s.timer ? s.timer + "秒" : "なし";
    $("cam-set-zebra").querySelector("b").textContent = s.zebra ? "出す" : "出さない";
    $("cam-set-sound").querySelector("b").textContent = s.sound ? "鳴らす" : "鳴らさない";
    $("cam-set-jpeg").querySelector("b").textContent = s.autoJpeg ? "保存する" : "保存しない";
    this.els.frame.dataset.frame = s.frame;
    this.els.grid.hidden = s.frame !== "thirds";
    const core = this.engine.coreById(this.core);
    this.els.coreBtn.replaceChildren(h("span", { class: "engrave" }, "核"), h("b", {}, core.name));
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
    this.info = info;
    if (!this.cams.length) {
      this.fallback();
      return;
    }
    const want = pref("cameraId");
    this.cam = this.cams.find((c) => c.id === want) || this.cams.reduce((a, b) => (Math.abs((b.eq35 || 24) - 24) < Math.abs((a.eq35 || 24) - 24) ? b : a));
    this.renderLenses();
    await this.sendLook();
    const r = this.rect();
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

  // 撮る画面の画に核をかけるための、核の色の対応表と曲線を APK へ渡す
  async sendLook() {
    const core = this.engine.coreById(this.core);
    const buf = await (await fetch(new URL(core.file, this.engine.looksBase))).arrayBuffer();
    const b64 = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.readAsDataURL(new Blob([buf]));
    });
    bridge.cameraCall("cameraSetLook", b64, core.size, JSON.stringify([...core.lo, ...core.hi]));
    const m = this.engine.ap0ToAp1, s = this.engine.srgbToAp0, M = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r * 3 + c] = m[r * 3] * s[c] + m[r * 3 + 1] * s[3 + c] + m[r * 3 + 2] * s[6 + c];
    bridge.cameraCall("cameraSetLookParams", JSON.stringify({ m: M, curve: Array.from(this.engine.jpegToLinear) }));
  }

  async nextCore() {
    const ids = this.engine.cores.map((c) => c.id), i = ids.indexOf(this.core);
    this.core = ids[(i + 1) % ids.length];
    pref("cameraCore", this.core);
    bridge.haptic("tick");
    this.renderSettings();
    await this.sendLook();
  }

  // ---------- APK からの知らせ ----------
  onCamera(d) {
    if (!this.active || !d) return;
    if (d.state === "open") {
      this.opened = d;
      this.showMsg("");
      this.buildEv(d);
      this.updateCount();
    } else if (d.state === "info") {
      const parts = [];
      if (d.exposure) parts.push(d.exposure >= 0.5 ? d.exposure.toFixed(1) + "秒" : "1/" + Math.round(1 / d.exposure));
      if (d.iso) parts.push("ISO " + d.iso);
      if (this.opened && this.opened.rawSize) parts.push("RAW " + this.opened.rawSize.replace("x", "×"));
      this.els.readout.textContent = parts.join("　");
      this.els.badge.textContent = d.locked ? "明るさとピントを固定中" : d.exposure && d.exposure > 1 / 15 ? "手ぶれに注意（" + parts[0] + "）" : "";
      this.els.badge.hidden = !this.els.badge.textContent;
    } else if (d.state === "error" || d.state === "closed") {
      this.showMsg(d.message || "カメラが止まりました。", [["開き直す", () => this.open()]]);
    }
  }

  buildEv(d) {
    const max = Math.max(0, Math.min(2, d.evMax || 0)), min = Math.max(-2, d.evMin || 0);
    if (!max && !min) {
      this.els.ev.replaceChildren();
      return;
    }
    const s = slider({
      label: "明るさの補正", min, max, step: d.evStep || 1 / 3, def: 0, value: 0,
      fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(1) + " 段",
      onInput: (v) => bridge.cameraCall("cameraSetEv", v), onCommit: () => {},
    });
    this.els.ev.replaceChildren(s.el);
  }

  // 0.4 秒ごとの小さな画: 核をかけるときの露光量を決め、明るさの山を描く
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
    const key = cnt ? Math.exp(sl / cnt) : 0.18, core = this.engine.coreById(this.core);
    const ev = C.searchEv((e) => C.medianCore(small, key, e, core.cpu, this.engine.ap0ToAp1), this.engine.targetL + core.lift);
    const g = (0.18 / key) * Math.pow(2, ev);
    this.gain = this.gain * 0.6 + g * 0.4;
    bridge.cameraCall("cameraSetGain", this.gain);
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
    const t = this.settings.timer;
    for (let i = t; i > 0; i--) {
      this.els.badge.hidden = false;
      this.els.badge.textContent = i + "";
      bridge.haptic("tick");
      await new Promise((r) => setTimeout(r, 1000));
    }
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
    const item = d.item, shot = { item, url: null };
    this.shots.unshift(shot);
    if (this.onCaptured) this.onCaptured(item);
    this.updateCount();
    try {
      const res = await fetch(bridge.mediaUrl(item));
      const t = await this.engine.decodeThumb(await res.arrayBuffer(), 256);
      const cv = document.createElement("canvas");
      this.engine.renderThumb(t, this.core, cv);
      shot.url = cv.toDataURL("image/jpeg", 0.85);
      this.els.thumb.style.backgroundImage = `url(${shot.url})`;
      this.els.thumb.classList.add("is-on");
    } catch {
      this.els.thumb.classList.add("is-on");
    }
    if (this.settings.autoJpeg) this.queueJpeg(item);
  }

  // 撮るたびに、核をかけた JPEG もギャラリーに保存する（選んだときだけ）
  queueJpeg(item) {
    this.jpegQueue.push({ item, core: this.core });
    if (this.jpegBusy) return;
    this.jpegBusy = true;
    (async () => {
      while (this.jpegQueue.length) {
        const { item: it, core } = this.jpegQueue.shift();
        try {
          const buf = await (await fetch(bridge.mediaUrl(it))).arrayBuffer();
          await this.engine.openRaw(buf);
          this.engine.setParams({ ...this.engine.params, core, strength: 100 });
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
    const free = Number(bridge.storageFree ? bridge.storageFree() : -1);
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
    if (!lock && this.locked) {
      bridge.cameraCall("cameraUnlock");
    }
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

  // ---------- 端末の向き・水平 ----------
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
    const ok = Math.abs(a) < 0.8;
    this.els.level.style.transform = `translate(-50%, -50%) rotate(${-a}deg)`;
    this.els.level.classList.toggle("is-ok", ok);
    if (ok && !this.wasLevel) bridge.haptic("tick");
    this.wasLevel = ok;
  }
}
