// 撮る画面（2026-11-05、2026-11-06 に見た目と手で決める撮り方）。カメラの画は APK が下に描き、この画面はその上に、透かした枠とボタンを重ねる。
// 撮ると、1 枚撮りの生の RAW（DNG）が DCIM/Sunglasses に入る。撮る画面の画には、いまのルック（核）と Sun Level をかけて見せる。
//
// 露出: 自動と手動がある。
//   自動 … ルックの見た目に合わせて、明るさをアプリが決める。輪は自動で決めた値を指し、一緒に動く。
//   手動 … 輪を回すと手動になる。自動の決め直しを止め、決めた明るさのままにする（カメラの露出補正も動かすので、撮る RAW にも入る）。
//   「自動」を押すか、輪を 2 回たたくと自動に戻る。
// たたいた所: ピントを合わせ、明るさもそこを重く測る（カメラの測り方と、ルックの明るさの自動の両方）。長押しで AE/AF ロック。
// 手で決める撮り方（S・ISO・WB・F・AF。シャオミのプロモードと同じ作り）:
//   S だけ手で決めたら ISO を、ISO だけなら S を、このページが小さな画の明るさから決める（APK は 2 つそろったときだけ手動にするため）。
//   S と ISO を両方手で決めたら、画面は写る明るさのとおりに変わり、露出の輪は「自動より何段明るく写るか」を指す露出計になる。
//   S・ISO・ピントは、アプリを開き直すと自動に戻す（覚えない）。WB と AF は覚える。
// 撮った写真は、撮ったときのルック・Sun Level・明るさのまま編集で開く（写真ごとの直しの記録に入れておく）。
import * as C from "../engine/color.js";
import { defaultParams, lookParams, sunCoreOf, SUN_CORES } from "../engine/engine.js";
import * as bridge from "./bridge.js";
import { pref, setEdit } from "./store.js";
import { h, ring, sheet, toast } from "./ui.js";
import { water } from "./water.js";

const FRAMES = [["1.85", "1.85:1"], ["thirds", "三分割"], ["off", "オフ"]];
const SETTINGS = {
  frame: FRAMES.map((f) => f[0]),
  timer: [0, 3, 10],
  zebra: [true, false],
  sound: [true, false],
  autoJpeg: [false, true],
};
const log2 = (x) => Math.log(x) / Math.LN2;
// 拡大（2026-11-13）。倍率の札と、つまんで拡大できる上の倍率。RAW を切り抜く拡大なので、2 倍で画素は 4 分の 1、4 倍で 16 分の 1 になる
const ZOOM_STEPS = [1, 2, 3], ZOOM_LIMIT = 4;
const onOff = (b) => (b ? "オン" : "オフ");
// 右下のルックで、たたくたびに替わる順（2026-11-06）。名前は looks.json の核の名前を使う
// 2026-11-10 型のフィルム（deepblue＝Aftersun Blue、aqua＝Aftersun Aqua）を Aftersun の次に足した
// 2026-11-10 夜 aftersun3（Aftersun のコマを測った数に合わせた形）を足し、名前を Aftersun にした。前の Aftersun（aftersun2）は「Aftersun（前の版）」
// 2026-11-10 夜 cinema（映画の見た目の核。Chromagraph Camera の作例を測った形）を足して、主のルックにした。
// cinema では、Sun Level の輪は「Aftersun をどれだけ足すか」になる（0 でシネマそのまま。値はほかのルックと別に覚える）
// 並びは、Cinema → 新しい Aftersun の 3 つ → 前からのルック（一覧に出る順）
// 2026-11-13 ルックの選び方を「Cinema のオン・オフ」と「足す Aftersun（なし／Aftersun／Blue／Aqua）」に分けた（本人の案）。
// 前からのルック（Aftersun（前の版）・Aftersun+・Nostalgia）は一覧から外した。輪の Sun Level は、足した Aftersun の強さ
const FAMILY_NAMES = { cinema: "Cinema", aftersun2: "Aftersun（前の版）", aftersun3: "Aftersun", deepblue: "Aftersun Blue", aqua: "Aftersun Aqua", aftersun: "Aftersun+", mine: "Nostalgia" }; // looks.json を読む前に使う控え

// シャッター速度と ISO の 1/3 段の目盛り（端末が出せる範囲だけを使う）。手応えは 1 段ごと
const S_STOPS = [1 / 8000, 1 / 6400, 1 / 5000, 1 / 4000, 1 / 3200, 1 / 2500, 1 / 2000, 1 / 1600, 1 / 1250, 1 / 1000, 1 / 800, 1 / 640, 1 / 500, 1 / 400, 1 / 320, 1 / 250, 1 / 200, 1 / 160,
  1 / 125, 1 / 100, 1 / 80, 1 / 60, 1 / 50, 1 / 40, 1 / 30, 1 / 25, 1 / 20, 1 / 15, 1 / 13, 1 / 10, 1 / 8, 1 / 6, 1 / 5, 1 / 4, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.3, 1.6, 2, 2.5, 3.2, 4, 5, 6, 8, 10, 13, 15, 20, 25, 30];
const S_FULL = [1 / 8000, 1 / 4000, 1 / 2000, 1 / 1000, 1 / 500, 1 / 250, 1 / 125, 1 / 60, 1 / 30, 1 / 15, 1 / 8, 1 / 4, 0.5, 1, 2, 4, 8, 15, 30];
const ISO_STOPS = [25, 32, 40, 50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800, 16000, 20000, 25600];
const ISO_FULL = [25, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600];
const WB_PRESETS = [["daylight", "晴れ"], ["cloudy", "くもり"], ["shade", "日陰"], ["incandescent", "電球"], ["fluorescent", "蛍光灯"]];
const FOCUS_M = [0.1, 0.15, 0.2, 0.3, 0.5, 0.7, 1, 1.5, 2, 3, 5, 10, Infinity];
const FOCUS_MAJOR = [0.1, 0.2, 0.5, 1, 2, 5, Infinity];
const PRO = [["s", "S", "シャッター速度"], ["iso", "ISO", "ISO感度"], ["wb", "WB", "ホワイトバランス"], ["focus", "F", "ピント"], ["af", "AF", "AF"]];
const near = (a, b) => Math.abs(log2(a / b)) < 0.02;
const fmtS = (s) => (s >= 0.3 ? String(+s.toFixed(1)) + "秒" : "1/" + Math.round(1 / s));
const fmtF = (m) => (m === Infinity ? "∞" : m < 1 ? Math.round(m * 100) + "cm" : String(+m.toFixed(1)) + "m");
const fmtEv = (v) => (v > 0.04 ? "+" : v < -0.04 ? "−" : "") + Math.abs(v).toFixed(1);
const fmtWb = (w) => (typeof w === "number" ? w + "K" : (WB_PRESETS.find((p) => p[0] === w) || [0, "自動"])[1]);

// 色温度（K）の白い光の色（sRGB の光の量）。プランクの軌跡の近似（Kim ほか 2002）
function kelvinRgb(t) {
  const x = t <= 4000 ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991 : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  const y = t <= 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
    : t <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867 : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  const X = x / y, Z = (1 - x - y) / y;
  return [3.2406 * X - 1.5372 - 0.4986 * Z, -0.9689 * X + 1.8758 + 0.0415 * Z, 0.0557 * X - 0.204 + 1.057 * Z];
}

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
    this.cEvNow = 0;
    this.live = {};
    this.sens = null; // S か ISO を手で決めている間、カメラへ渡しているシャッター速度と ISO
    this.meterAt = null; // たたいた所（撮る画面の枠の中の 0〜1）。明るさをそこで重く測る
    this.openKey = null; // 手で決める撮り方のうち、輪を出している項目
    this.pro = { s: null, iso: null, focus: null, wb: pref("cameraWb") || "auto", af: pref("cameraAf") || "continuous" };
    this.settings = { frame: "1.85", timer: 0, zebra: true, sound: true, autoJpeg: false, ...(pref("camera") || {}) };
    // 核を3つにしたとき（2026-11-06）、前の Aftersun を選んでいた人は、1回だけ新しい Aftersun に移す
    if (!pref("cameraFamilyV2")) {
      if ((pref("cameraFamily") || "aftersun") === "aftersun") pref("cameraFamily", "aftersun2");
      pref("cameraFamilyV2", 1);
    }
    // シネマを足したとき（2026-11-10）、1回だけ、撮る画面のルックをシネマにする（ルックのボタンで前のルックに戻せる）
    if (!pref("cameraFamilyV3")) {
      pref("cameraFamily", "cinema");
      pref("cameraFamilyV3", 1);
    }
    // ルックを Cinema のオン・オフと足す Aftersun に分けたとき（2026-11-13）、1回だけ、前の覚えから移す
    if (!pref("cameraLookV4")) {
      const f = pref("cameraFamily") || "cinema", mix = pref("cameraSunMix") || 0;
      pref("cameraCinema", SUN_CORES.includes(f) ? 0 : 1);
      pref("cameraSun", SUN_CORES.includes(f) ? f : f === "cinema" && mix > 0 ? SUN_CORES[0] : "");
      if (!(mix > 0)) pref("cameraSunMix", 100); // Cinema に足す量のはじめの値は 100（前は「足さない」を 0 で表していた）
      pref("cameraLookV4", 1);
    }
    this.cinema = pref("cameraCinema") !== 0;
    this.sun = SUN_CORES.includes(pref("cameraSun")) ? pref("cameraSun") : null;
    this.sunLevel = pref(this.sunKey()) ?? this.sunDef();
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
      coreBtn: $("cam-core"), looks: $("cam-looks"), ev: $("cam-ev"), pro: $("cam-pro"), lenses: $("cam-lenses"), msg: $("cam-msg"), bubble: $("cam-bubble"),
    };
    this.els.readout.addEventListener("click", () => this.lensInfo());
    // 水の部品（2026-11-13）。撮る画面は、透けない濃い水（映像には何も重ねない）
    const solid = { kind: "solid" };
    water($("cam-back"), solid);
    for (const el of this.root.querySelectorAll(".cam-set")) water(el, { ...solid, radius: 18 }); // 項目ごとに 1 つのつぶ
    water(this.els.shutter, solid);
    water($("cam-shutter-core"), { kind: "white" });
    water(this.els.coreBtn, { ...solid, radius: 22 });
    $("cam-back").onclick = () => this.onBack();
    for (const key of Object.keys(SETTINGS)) this.wheel($("cam-set-" + (key === "autoJpeg" ? "jpeg" : key)), key);
    this.els.shutter.onclick = () => this.shoot();
    this.els.thumb.onclick = () => this.shots[0] && this.onOpenItem(this.shots[0].item, this.shots[0].url);
    this.lookButton();
    this.buildPro();
    this.viewGestures();
    this.renderSettings();
  }

  // 右下のルック: たたくとルックの一覧が出る（名前をたたいて選ぶ）、長押ししている間だけ、ルックをかけない素の画
  lookButton() {
    const btn = this.els.coreBtn;
    let timer = 0, holding = false;
    const raw = (yes) => {
      if (this.v3) this.sendWeights(yes ? { wN: 1, wA: 0, wB: 0 } : null);
      else bridge.cameraCall("cameraSetLookOn", !yes);
      btn.classList.toggle("is-raw", yes);
    };
    btn.addEventListener("pointerdown", () => {
      holding = false;
      timer = setTimeout(() => {
        holding = true;
        raw(true);
      }, 260);
    });
    const up = (tap) => {
      clearTimeout(timer);
      if (holding) {
        holding = false;
        raw(false);
      } else if (tap) this.toggleLooks();
    };
    btn.addEventListener("pointerup", () => up(true));
    btn.addEventListener("pointercancel", () => up(false));
    btn.addEventListener("pointerleave", () => holding && up(false));
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
    // 一覧の外（写真の上）をたたいたら閉じる。写真をたたく操作（ピント・明るさ）には流さない
    const looks = this.els.looks;
    for (const t of ["pointerdown", "pointermove", "pointerup"]) looks.addEventListener(t, (e) => e.stopPropagation());
    looks.addEventListener("click", (e) => e.target === looks && this.toggleLooks(false));
  }

  familyName(id) {
    return (this.engine.cores && this.engine.cores.find((c) => c.id === id) || {}).name || FAMILY_NAMES[id];
  }

  // ルックの一覧（写真の上に、選ぶ間だけ出す）。いまのルックに印
  toggleLooks(open = this.els.looks.hidden) {
    const el = this.els.looks;
    if (!open) {
      el.hidden = true;
      return;
    }
    const list = h("div", { class: "cam-looks-list" }, h("small", {}, "ルック"),
      h("button", { class: "cam-look" + (this.cinema ? " is-on" : ""), onClick: () => this.setLook(!this.cinema, this.sun, true) }, "Cinema　" + (this.cinema ? "オン" : "オフ")),
      h("small", {}, "Aftersun を足す"),
      ...[null, ...SUN_CORES].map((id) => h("button", { class: "cam-look" + (id === this.sun ? " is-on" : ""), onClick: () => this.setLook(this.cinema, id) }, id ? this.familyName(id) : "なし")));
    el.replaceChildren(list);
    water(list, { kind: "solid", radius: 22, press: false });
    el.hidden = false;
    bridge.haptic("tick");
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
      frame: FRAMES.find((f) => f[0] === s.frame)[1], timer: s.timer ? s.timer + "秒" : "オフ", zebra: onOff(s.zebra),
      sound: onOff(s.sound), autoJpeg: onOff(s.autoJpeg),
    };
    for (const key of Object.keys(SETTINGS)) {
      const b = $("cam-set-" + (key === "autoJpeg" ? "jpeg" : key)).querySelector("b");
      b.textContent = text[key];
      b.classList.toggle("num", key === "frame" && s.frame === "1.85");
      if (key === changed) {
        b.classList.remove("roll-up", "roll-down");
        void b.offsetWidth;
        b.classList.add(dir === "down" ? "roll-down" : "roll-up");
      }
    }
    this.els.frame.dataset.frame = s.frame;
    this.els.grid.hidden = s.frame !== "thirds";
    const name = this.lookName();
    this.els.coreBtn.classList.toggle("is-long", name.length > 12); // 長い名前は字を小さくして、シャッターに寄らないようにする
    this.els.coreBtn.replaceChildren(h("small", {}, "ルック"), h("b", {}, name), h("span", { class: "cam-core-hint" }, "長押しで元の画"));
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
    this.camInfo = info;
    const bad = pref("cameraBadLens") || [];
    const all = (info.cameras || []).filter((c) => c.raw);
    const listed = all.filter((c) => !c.parent);
    // 個別のレンズ（超広角・望遠など。版 5 の APK が知らせる）は、同じ画角のカメラがもう出ている時と、前に開けなかった時は出さない
    const extra = all.filter((c) => c.parent && !bad.includes(c.id) && !listed.some((m) => Math.abs((m.eq35 || 0) - (c.eq35 || 0)) <= 2));
    this.cams = [...listed, ...extra.filter((c, i) => extra.findIndex((x) => Math.abs((x.eq35 || 0) - (c.eq35 || 0)) <= 2) === i)].sort((a, b) => (a.eq35 || 99) - (b.eq35 || 99));
    if (!this.cams.length) {
      this.fallback();
      return;
    }
    const want = pref("cameraId");
    this.cam = this.cams.find((c) => c.id === want) || this.cams.reduce((a, b) => (Math.abs((b.eq35 || 24) - 24) < Math.abs((a.eq35 || 24) - 24) ? b : a));
    this.renderLenses();
    await this.sendLook();
    this.meterAt = null;
    this.expo = { auto: true, display: 0, frozen: null, at: 0, remainder: 0 };
    this.cEvNow = 0;
    this.zoom = 1;
    this.fitPro();
    this.buildControls();
    this.layoutView();
    const r = this.rect();
    bridge.cameraCall("cameraOpen", this.cam.id, r.x, r.y, r.w, r.h);
    bridge.cameraCall("cameraSetZebra", this.settings.zebra);
    bridge.keepScreenOn(true);
    this.updateCount();
  }

  close() {
    this.active = false;
    this.toggleLooks(false);
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

  // 拡大できる上の倍率。APK（版 5 から）が知らせる値と ZOOM_LIMIT の小さいほう。古い APK・拡大できないカメラは 1
  zoomMax() {
    return Math.min(ZOOM_LIMIT, (this.opened && this.opened.zoomMax) || 1);
  }

  // 拡大（普通のカメラアプリと同じ: 2 本の指でつまむ・倍率の札をたたく）。RAW は全体が写り、開いた時にこの倍率で切り抜かれる（切り抜きの画面で戻せる）
  setZoom(z, quiet = false) {
    const max = this.zoomMax();
    z = Math.round(C.clamp(z, 1, max) * 10) / 10;
    if (z === this.zoom) return;
    const crossed = ZOOM_STEPS.some((v) => (this.zoom < v) !== (z < v));
    this.zoom = z;
    bridge.cameraCall("cameraSetZoom", z);
    if (!quiet || crossed) bridge.haptic("detent");
    this.renderLenses();
  }

  // レンズの情報（「RAW ◯MP」の字をたたくと出る）。このスマホで、アプリから見えるカメラと、開けなかったレンズを字で出す。
  // 実機でしか分からないので、望遠などが使えない時に、ここの字を写して調べる
  lensInfo() {
    const info = this.camInfo || {}, bad = pref("cameraBadLens") || [];
    const lines = [
      `窓口の版 ${bridge.bridgeVersion()}`,
      `一覧に出るカメラ: ${(info.listed || []).join("、") || "（古い APK では出ません）"}`,
      `今のカメラ: ${this.cam ? this.cam.id : "-"}／拡大できる上の倍率: ${(this.opened && this.opened.zoomMax) || "（なし）"}`,
      `前に開けなかったレンズ: ${bad.join("、") || "なし"}`,
      "",
      ...(info.cameras || []).map((c) => [
        `カメラ ${c.id}${c.parent ? `（${c.parent} の中の個別のレンズ）` : ""}`,
        `  35mm 換算 ${c.eq35 || "?"}mm／RAW ${c.raw ? "撮れる" : "撮れない"}（${(c.rawSizes || []).join("、") || "大きさなし"}）`,
        `  まとめカメラ ${c.logical ? "はい" : "いいえ"}／中のレンズ ${(c.physical || []).join("、") || "なし"}／高画素 ${c.ultraHighRes ? "はい" : "いいえ"}／拡大の幅 ${(c.zoomRange || []).join("〜") || "?"}`,
      ].join("\n")),
    ];
    if (info.error) lines.push("読めなかった理由: " + info.error);
    const text = lines.join("\n");
    sheet("レンズの情報", h("div", { class: "cam-lensinfo" },
      h("pre", {}, text),
      h("div", { class: "sheet-actions" },
        h("button", { class: "chip", onClick: () => navigator.clipboard && navigator.clipboard.writeText(text).then(() => toast("写しました"), () => toast("写せませんでした")) }, "字を写す"),
        bad.length ? h("button", { class: "chip", onClick: () => {
          pref("cameraBadLens", []);
          toast("開けなかったレンズの覚えを消しました。撮る画面を開き直すと、札がまた出ます。");
        } }, "開けなかったレンズをもう一度試す") : null)));
  }

  renderLenses() {
    const max = this.zoomMax();
    const steps = max > 1 ? ZOOM_STEPS.filter((v) => v <= max + 0.01) : [];
    // 今の倍率にいちばん近い札を光らせ、ちょうどでない時はその札に今の倍率を出す（1.4× など）
    const near = steps.reduce((a, v) => (v <= this.zoom + 0.001 ? v : a), steps[0]);
    const fmt = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : v.toFixed(1)) + "×";
    const zoomChips = steps.map((v) => h("button", {
      class: "chip num cam-zoom" + (v === near ? " is-on" : ""),
      onClick: () => this.setZoom(v),
    }, v === near ? fmt(this.zoom) : fmt(v)));
    this.els.lenses.replaceChildren(...zoomChips, ...(this.cams.length > 1 ? this.cams.map((c) => h("button", {
      class: "chip num" + (c.id === this.cam.id ? " is-on" : ""),
      onClick: () => {
        if (c.id === this.cam.id) return;
        this.prevCam = this.cam;
        this.cam = c;
        this.zoom = 1;
        pref("cameraId", c.id);
        this.renderLenses();
        // レンズごとに出せる範囲が違うので、S・ISO・ピントは自動に戻す
        this.meterAt = null;
        this.fitPro(true);
        this.buildControls();
        const r = this.rect();
        bridge.cameraCall("cameraOpen", c.id, r.x, r.y, r.w, r.h);
      },
    }, c.eq35 ? c.eq35 + "mm" : "レンズ " + c.id)) : []));
  }

  // ---------- ルックと Sun Level ----------
  // 輪の Sun Level は、足した Aftersun の強さ（はじめは 100）。Cinema がオンの時（Cinema に足す量）とオフの時で、値は別々に覚える
  sunKey() {
    return this.cinema ? "cameraSunMix" : "cameraSunLevel";
  }

  sunDef() {
    return 100;
  }

  sunName() {
    return "Sun Level";
  }

  // いまのルックを、保存する値の形（core・sun・sunLevel）にする
  lookP() {
    return lookParams(this.cinema, this.sun, Math.round(this.sunLevel));
  }

  lookName() {
    const n = this.sun ? this.familyName(this.sun) : "";
    return this.cinema ? (n ? `Cinema ＋ ${n}` : "Cinema") : n || "ルックなし";
  }

  look() {
    return this.engine.lookFor(lookParams(this.cinema, this.sun, this.sunLevel));
  }

  async lutBase64(core) {
    const buf = await (await fetch(new URL(core.file, this.engine.looksBase))).arrayBuffer();
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.readAsDataURL(new Blob([buf]));
    });
  }

  // 撮る画面の画にルックをかけるための、色の対応表（2 つまで）と曲線を APK へ渡す
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

  // 輪を回している間とルックを替えたときに、値や名前を画の上に大きく出す（端末の向きに合わせて回る）
  bubble(label, text, ms = 700) {
    const b = this.els.bubble;
    b.querySelector("small").textContent = label;
    b.querySelector("b").textContent = text;
    b.classList.toggle("is-name", label === "ルック");
    b.classList.add("is-on");
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = setTimeout(() => b.classList.remove("is-on"), ms);
  }

  // ルックを替える。Cinema のオン・オフは、続けて Aftersun を選べるよう、一覧を開いたままにする
  async setLook(cinema, sun, keepOpen = false) {
    this.toggleLooks(false);
    if (cinema === this.cinema && sun === this.sun) return;
    this.cinema = cinema;
    this.sun = sun;
    pref("cameraCinema", cinema ? 1 : 0);
    pref("cameraSun", sun || "");
    if (keepOpen) this.toggleLooks(true);
    this.sunLevel = pref(this.sunKey()) ?? this.sunDef();
    bridge.haptic("tick");
    this.renderSettings();
    this.bubble("ルック", this.els.coreBtn.querySelector("b").textContent, 1100);
    this.buildControls();
    await this.sendLook();
  }

  // ---------- APK からの知らせ ----------
  onCamera(d) {
    if (!this.active || !d) return;
    if (d.state === "open") {
      this.opened = d;
      this.prevCam = null;
      this.zoom = 1;
      this.renderLenses();
      this.showMsg("");
      this.buildControls();
      this.updateCount();
      // 開くたびに、手で決めた値を渡し直す（全部自動のときも、前のレンズで手で決めた値が残らないように）
      this.sendManual();
    } else if (d.state === "info") {
      this.live = { exposure: d.exposure, iso: d.iso, focus: d.focus, wbGains: d.wbGains };
      // 「晴れ」と「電球」のときの白の倍率を覚える（色温度を K で決めるときの物差し）。切り替えた直後の画は前の色なので使わない
      const mode = this.measuringMode || (typeof this.pro.wb === "string" ? this.pro.wb : null);
      if ((mode === "daylight" || mode === "incandescent") && Array.isArray(d.wbGains) && this.cam && performance.now() - (this.wbChangedAt || 0) > 450) {
        const all = pref("cameraWbRef") || {};
        all[this.cam.id] = { ...(all[this.cam.id] || {}), [mode]: d.wbGains };
        pref("cameraWbRef", all);
      }
      if (this.opened && this.opened.rawSize) {
        const [rw, rh] = this.opened.rawSize.split("x").map(Number);
        // 拡大している時は、切り抜いたあとに残る画素数を出す（2 倍で 4 分の 1）
        const mp = (rw * rh) / 1e6 / (this.zoom * this.zoom);
        this.els.readout.textContent = "RAW " + (mp >= 10 ? Math.round(mp) : mp.toFixed(1)) + "MP";
      }
      const s = this.sens ? this.sens.s : d.exposure;
      this.els.badge.textContent = d.locked ? "AE/AFロック" : s && s > 1 / 15 ? "手ぶれに注意（" + fmtS(s) + "）" : "";
      this.els.badge.hidden = !this.els.badge.textContent;
      this.renderPro();
    } else if (d.state === "error" && this.cam && this.cam.parent && this.prevCam) {
      // 個別のレンズ（超広角・望遠など）が、このスマホではアプリから開けなかった。覚えておいて、元のレンズに戻す
      pref("cameraBadLens", [...new Set([...(pref("cameraBadLens") || []), this.cam.id])]);
      const name = this.cam.eq35 ? this.cam.eq35 + "mm" : "このレンズ";
      this.cams = this.cams.filter((c) => c.id !== this.cam.id);
      this.cam = this.prevCam;
      this.prevCam = null;
      pref("cameraId", this.cam.id);
      this.renderLenses();
      toast(`${name} は、このスマホではアプリから使えませんでした。元のレンズに戻しました。倍率の札か、2 本の指でつまんで拡大できます。`, [], 7000);
      const r = this.rect();
      bridge.cameraCall("cameraOpen", this.cam.id, r.x, r.y, r.w, r.h);
    } else if (d.state === "error" || d.state === "closed") {
      this.showMsg(d.message || "カメラが止まりました。", [["開き直す", () => this.open()]]);
    }
  }

  // ---------- 手で決める撮り方（S・ISO・WB・F・AF）----------
  sensorManual() {
    return this.pro.s !== null || this.pro.iso !== null;
  }
  fullManual() {
    return this.pro.s !== null && this.pro.iso !== null;
  }
  caps() {
    const c = this.cam || {};
    return {
      sensor: c.manualSensor !== false, post: c.manualPost !== false,
      sMin: (c.exposure || [])[0] || 1 / 8000, sMax: Math.min((c.exposure || [])[1] || 1, 30),
      isoMin: (c.iso || [])[0] || 50, isoMax: (c.iso || [])[1] || 3200, minFocus: c.minFocus || 0,
    };
  }
  sList() {
    const k = this.caps();
    return S_STOPS.filter((s) => s >= k.sMin * 0.97 && s <= k.sMax * 1.03);
  }
  isoList() {
    const k = this.caps();
    return ISO_STOPS.filter((v) => v >= k.isoMin * 0.97 && v <= k.isoMax * 1.03);
  }
  focusList() {
    const k = this.caps();
    return k.minFocus > 0 ? FOCUS_M.filter((m) => 1 / m <= k.minFocus * 1.001) : [];
  }
  nearestOf(list, v) {
    return list.reduce((a, b) => (Math.abs(log2(b / v)) < Math.abs(log2(a / v)) ? b : a), list[0]);
  }

  // 開いたレンズで出せない値を自動に戻す。all なら S・ISO・ピントを全部自動に戻す
  fitPro(all = false) {
    const p = this.pro, k = this.caps();
    if (all || !k.sensor) [p.s, p.iso, p.focus] = [null, null, null];
    if (p.s !== null) p.s = this.nearestOf(this.sList(), p.s);
    if (p.iso !== null) p.iso = this.nearestOf(this.isoList(), p.iso);
    if (p.focus !== null && !this.focusList().length) p.focus = null;
    if (typeof p.wb === "number" && !k.post) p.wb = "auto";
    this.sens = this.sensorManual() ? { s: p.s ?? 1 / 60, iso: p.iso ?? 100 } : null;
    if (this.openKey && ["s", "iso", "focus"].includes(this.openKey) && !k.sensor) this.openKey = null;
    this.renderPro();
  }

  buildPro() {
    this.proCells = {};
    this.els.pro.replaceChildren(...PRO.map(([key, label]) => {
      const b = h("b");
      const cell = h("button", { class: "cam-pro-cell rot", onClick: () => this.toggleProRing(key) }, h("small", {}, label), b);
      water(cell, { kind: "solid", radius: 18 });
      this.proCells[key] = { cell, b };
      return cell;
    }));
    this.renderPro();
  }

  // 項目の値: 手で決めた値は琥珀色、自動の項目は、いま決まっている値を薄い字で
  proText(key) {
    const p = this.pro, l = this.live || {};
    if (key === "s") {
      if (p.s !== null) return [fmtS(p.s), "man"];
      const s = this.sens ? this.sens.s : l.exposure;
      return [s ? fmtS(s) : "自動", "auto"];
    }
    if (key === "iso") {
      if (p.iso !== null) return [String(p.iso), "man"];
      const v = this.sens ? this.sens.iso : l.iso;
      return [v ? String(Math.round(v)) : "自動", "auto"];
    }
    if (key === "wb") return p.wb === "auto" ? ["自動", "auto"] : [fmtWb(p.wb), "man"];
    if (key === "focus") {
      if (p.focus !== null) return [fmtF(p.focus), "man"];
      return [l.focus > 0 ? fmtF(1 / l.focus) : l.focus === 0 ? "∞" : "自動", "auto"];
    }
    return [p.af === "single" ? "1回" : "連続", "mode"];
  }

  renderPro() {
    if (!this.proCells) return;
    const k = this.caps();
    for (const [key] of PRO) {
      const { cell, b } = this.proCells[key];
      const [text, kind] = this.proText(key);
      b.textContent = text;
      b.classList.toggle("num", /^[0-9∞1/]/.test(text) && kind !== "mode");
      cell.classList.toggle("is-man", kind === "man");
      cell.classList.toggle("is-auto", kind === "auto");
      cell.classList.toggle("is-open", this.openKey === key);
      cell.disabled = ["s", "iso", "focus"].includes(key) && (!k.sensor || (key === "focus" && !this.focusList().length));
    }
    // 輪を出している項目が自動なら、輪はいまの自動の値を指して一緒に動く
    if (this.proRing && this.openKey && !this.proRing.isDragging()) {
      const [text, kind] = this.proText(this.openKey);
      if (kind === "auto") {
        const i = this.proAutoIndex(this.openKey);
        if (i !== null) this.proRing.set(i);
        this.proRing.setText("自動" + (text !== "自動" ? "（" + text + "）" : ""));
      }
    }
  }

  toggleProRing(key) {
    bridge.haptic("tick");
    this.openKey = this.openKey === key ? null : key;
    this.buildControls();
    this.renderPro();
  }

  proStops(key) {
    if (key === "s") return [{ v: null, label: "A", mark: "major", gap: 34 }, ...this.sList().map((s) => {
      const full = S_FULL.some((f) => near(f, s));
      return { v: s, mark: full ? "major" : "minor", label: full ? fmtS(s).replace("秒", "") : null, gap: 24 };
    })];
    if (key === "iso") return [{ v: null, label: "A", mark: "major", gap: 34 }, ...this.isoList().map((v) => {
      const full = ISO_FULL.includes(v);
      return { v, mark: full ? "major" : "minor", label: full ? String(v) : null, gap: 24 };
    })];
    if (key === "wb") {
      const list = [{ v: "auto", label: "A", mark: "major", gap: 48 }, ...WB_PRESETS.map(([v, l]) => ({ v, label: l, mark: "major", gap: 48 }))];
      if (this.caps().post) for (let t = 2500; t <= 9000; t += 100) list.push({ v: t, mark: t % 500 ? "minor" : "major", label: t % 1000 ? null : String(t), gap: 8 });
      return list;
    }
    if (key === "focus") return [{ v: null, label: "A", mark: "major", gap: 40 }, ...this.focusList().map((m) => {
      const major = FOCUS_MAJOR.includes(m);
      return { v: m === Infinity ? 0 : 1 / m, m, mark: major ? "major" : "minor", label: major ? fmtF(m) : null, gap: 30 };
    })];
    return [{ v: "continuous", label: "連続", mark: "major", gap: 64 }, { v: "single", label: "1回", mark: "major" }];
  }

  // 自動のとき、輪が指す所（いまの自動の値に一番近い目盛り）
  proAutoIndex(key) {
    const stops = this.proRingStops || [], l = this.live || {};
    const v = key === "s" ? (this.sens ? this.sens.s : l.exposure) : key === "iso" ? (this.sens ? this.sens.iso : l.iso) : key === "focus" ? l.focus : null;
    if (v === null || v === undefined) return key === "wb" ? 0 : null;
    if (key === "focus") {
      let best = null, bd = Infinity;
      stops.forEach((s, i) => i > 0 && Math.abs(s.v - v) < bd && ((bd = Math.abs(s.v - v)), (best = i)));
      return best;
    }
    let best = null, bd = Infinity;
    stops.forEach((s, i) => i > 0 && Math.abs(log2(s.v / v)) < bd && ((bd = Math.abs(log2(s.v / v))), (best = i)));
    return best;
  }

  buildProRing(key) {
    const name = PRO.find((p) => p[0] === key)[2], stops = this.proStops(key), p = this.pro;
    this.proRingStops = stops;
    const cur = key === "af" ? p.af : key === "wb" ? p.wb : p[key];
    const isAuto = key === "wb" ? cur === "auto" : key !== "af" && cur === null;
    // 自動のときは、いまカメラが決めている値の所から回し始める（左の端の A からではなく）
    let index = isAuto ? -1 : stops.findIndex((s) => (key === "focus" ? Math.abs(s.v - cur) < 1e-6 : s.v === cur || (typeof cur === "number" && typeof s.v === "number" && near(s.v, cur))));
    if (index < 0) index = this.proAutoIndex(key) ?? 0;
    const fmt = (v) => {
      if (key === "s") return v === null ? "自動" : fmtS(v);
      if (key === "iso") return v === null ? "自動" : String(v);
      if (key === "wb") return fmtWb(v);
      if (key === "focus") return v === null ? "自動" : fmtF(v === 0 ? Infinity : 1 / v);
      return v === "single" ? "1回" : "連続";
    };
    const r = ring({
      label: name, stops, index, fmt,
      tick: (i) => stops[i].mark === "major",
      onInput: (v) => {
        this.setPro(key, key === "wb" && v === "auto" ? "auto" : v);
        this.bubble(name, fmt(v));
      },
      onReset: () => {
        if (key === "af") return;
        this.setPro(key, key === "wb" ? "auto" : null);
        this.buildControls();
      },
    });
    r.el.classList.add(isAuto ? "is-auto" : "is-man");
    this.proRing = r;
    return [r.el];
  }

  setPro(key, v) {
    const p = this.pro, wasSensor = this.sensorManual(), wasFull = this.fullManual();
    // 片方だけ手で決めたときに、明るさが変わらないよう、いまのシャッター速度×ISO を保つ
    const product = wasSensor && this.sens ? this.sens.s * this.sens.iso : (this.live.exposure || 1 / 60) * (this.live.iso || 100);
    p[key] = v;
    if (key === "wb") {
      pref("cameraWb", v);
      this.wbChangedAt = performance.now();
      // 色温度を K で決めるのに、この端末の晴れと電球の倍率がまだ無ければ、裏で 1 回測る（終わったら送り直す）
      const refs = this.wbRefs();
      if (typeof v === "number" && !(refs.daylight && refs.incandescent)) this.measureWb();
    }
    if (key === "af") pref("cameraAf", v);
    if (key === "s" || key === "iso") {
      if (this.sensorManual()) {
        const s = p.s !== null ? p.s : this.nearestOf(this.sList(), product / p.iso);
        const iso = p.iso !== null ? p.iso : this.nearestOf(this.isoList(), product / p.s);
        this.sens = { s, iso };
        if (!wasSensor) {
          bridge.cameraCall("cameraSetEv", 0);
          this.cEvNow = 0;
        }
        if (this.fullManual() && !wasFull && this.expo.auto) {
          // S と ISO を両方手で決めた: 画面は写る明るさのとおりに出す（ルックの明るさの自動を止める）
          this.expo = { auto: false, display: this.expo.display, frozen: { ...this.gains }, at: this.expo.display, remainder: 0 };
        }
      } else {
        this.sens = null;
        this.applyExpo();
      }
    }
    this.sendManual();
    this.renderPro();
    const r = this.proRing;
    if (r) {
      r.el.classList.toggle("is-auto", v === null || v === "auto");
      r.el.classList.toggle("is-man", !(v === null || v === "auto"));
    }
  }

  sendManual() {
    if (!this.v3) return;
    const p = this.pro, j = { af: p.af, wb: typeof p.wb === "number" ? "auto" : p.wb };
    if (this.measuringMode) j.wb = this.measuringMode;
    else if (typeof p.wb === "number") j.wbGains = this.kelvinGains(p.wb);
    if (p.focus !== null) j.focus = p.focus;
    if (this.sens) {
      j.iso = Math.round(this.sens.iso);
      j.exposure = this.sens.s;
    }
    bridge.cameraCall("cameraSetManual", JSON.stringify(j));
  }

  // 色温度（K）→ カメラの白の倍率。この端末の「晴れ」（約 5500K）と「電球」（約 2850K）の倍率を測っておき、
  // その間をミレッド（100 万 ÷ K）で割り振る（外側はそのまま伸ばす）。測れるまでは、白い光の色の比を弱めて使う
  // （カメラの色の受け方は sRGB より幅が広いので、比をそのまま使うと効きすぎる）
  wbRefs() {
    return this.cam ? (pref("cameraWbRef") || {})[this.cam.id] || {} : {};
  }
  kelvinGains(t) {
    const { daylight: day, incandescent: inc } = this.wbRefs();
    if (day && inc) {
      const f = (1e6 / t - 1e6 / 5500) / (1e6 / 2850 - 1e6 / 5500);
      const mix = (a, b) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * f);
      return [mix(day[0], inc[0]), day[1], day[2], mix(day[3], inc[3])];
    }
    const ref = day || this.live.wbGains || [2, 1, 1, 1.6], a = kelvinRgb(5500), b = kelvinRgb(t), soft = 0.55;
    return [ref[0] * ((a[0] / a[1]) / (b[0] / b[1])) ** soft, ref[1], ref[2], ref[3] * ((a[2] / a[1]) / (b[2] / b[1])) ** soft];
  }
  async measureWb() {
    if (!this.v3 || this.measuring) return;
    this.measuring = true;
    for (const mode of ["daylight", "incandescent"]) {
      if (this.wbRefs()[mode]) continue;
      this.measuringMode = mode;
      this.wbChangedAt = performance.now();
      this.sendManual();
      for (let i = 0; i < 14 && !this.wbRefs()[mode]; i++) await new Promise((r) => setTimeout(r, 150));
    }
    this.measuringMode = null;
    this.measuring = false;
    this.sendManual();
  }

  // ---------- 露出（自動・手動）と Sun Level の輪 ----------
  buildControls() {
    const d = this.opened || {};
    this.evRange = { min: d.evMin || 0, max: d.evMax || 0 };
    this.proRing = null;
    if (this.openKey) {
      this.els.ev.replaceChildren(...this.buildProRing(this.openKey));
    } else {
      const full = this.fullManual();
      const autoBtn = full ? h("span", { class: "cam-meter" }, "露出計") : h("button", { class: "cam-auto" + (this.expo.auto ? " is-on" : ""), onClick: () => this.setAuto() }, "自動");
      this.autoBtn = full ? null : autoBtn;
      // 露出と Sun Level は同時に動かさないので、1本の輪にして見出しで切り替える（画を大きくするため）
      const dial = this.sun && pref("cameraDial") === "sun" ? "sun" : "ev"; // Aftersun を足していない時は、Sun Level の輪は出さない
      const tabs = (cur) => h("span", { class: "cam-tabs" },
        h("button", { class: "cam-tab" + (cur === "ev" ? " is-on" : ""), onClick: () => this.setDial("ev") }, "露出"),
        h("button", { class: "cam-tab" + (cur === "sun" ? " is-on" : ""), hidden: !this.sun, onClick: () => this.setDial("sun") }, this.sunName()));
      const evStops = [];
      for (let k = -9; k <= 9; k++) evStops.push({ v: k / 3, mark: k % 3 ? "minor" : "major", label: k % 3 ? null : (k > 0 ? "+" : k < 0 ? "−" : "") + Math.abs(k / 3), gap: 17 });
      this.evStops = evStops;
      this.evRing = ring({
        label: "", stops: evStops, index: 9, extra: h("span", { class: "cam-dial-extra" }, tabs("ev"), autoBtn), fmt: (v) => fmtEv(v),
        tick: (i) => evStops[i].mark === "major",
        onInput: (v) => {
          this.setManual(v);
          this.bubble("露出", fmtEv(v));
        },
        onReset: () => this.setAuto(),
      });
      this.evRing.setReadonly(full);
      this.showEv(this.expo.display);
      const lvStops = [];
      // 核そのものの所（多くの核は 67。100 はその 1.5 倍）に印を付けて、軽く止まる。型のフィルムは 100 が核そのもの（2026-11-10）
      const sc = this.cinema || !this.sun ? 100 : sunCoreOf(this.engine.cores ? this.engine.coreById(this.sun) : null);
      for (let v = 0; v <= 100; v++) lvStops.push({ v, mark: v % 50 === 0 || v === sc ? "major" : v % 10 === 0 ? "minor" : null, label: v % 50 === 0 ? String(v) : null, gap: 3.4 });
      const lv = ring({
        label: "", extra: h("span", { class: "cam-dial-extra" }, tabs("sun")), stops: lvStops, index: Math.round(this.sunLevel), fmt: (v) => String(v), snaps: sc < 100 ? [sc] : [],
        onInput: (v) => {
          this.sunLevel = v;
          pref(this.sunKey(), v);
          this.sendWeights();
          this.bubble(this.sunName(), String(v));
        },
        onReset: () => {
          this.sunLevel = this.sunDef();
          pref(this.sunKey(), this.sunLevel);
          lv.set(this.sunLevel);
          this.sendWeights();
        },
      });
      this.evRing.el.setAttribute("aria-label", "露出");
      lv.el.setAttribute("aria-label", this.sunName());
      this.evRing.el.hidden = dial !== "ev";
      lv.el.hidden = dial !== "sun";
      this.dialEls = { ev: this.evRing.el, sun: lv.el };
      const kids = [this.evRing.el, lv.el];
      if (!this.v3) kids.push(h("p", { class: "cam-note" }, "撮る画面で Sun Level を見るには、アプリの入れ直しが必要です（撮った写真には効きます）"));
      this.els.ev.replaceChildren(...kids);
    }
    if (this.active) {
      this.layoutView();
      this.sendRect();
    }
  }

  setDial(k) {
    if (!this.dialEls || this.dialEls[k].hidden === false) return;
    pref("cameraDial", k);
    this.dialEls.ev.hidden = k !== "ev";
    this.dialEls.sun.hidden = k !== "sun";
    bridge.haptic("tick");
  }

  // 露出の輪に値を出す（自動の値や露出計の値は、目盛りの途中も指す）
  showEv(v) {
    if (!this.evRing) return;
    this.evRing.set(C.clamp(v, -3, 3) * 3 + 9);
    this.evRing.setText(fmtEv(v));
  }

  setAuto() {
    if (this.expo.auto || this.fullManual()) return;
    this.expo = { auto: true, display: this.expo.display, frozen: null, at: 0, remainder: 0 };
    bridge.cameraCall("cameraSetEv", 0);
    this.cEvNow = 0;
    if (this.autoBtn) this.autoBtn.classList.add("is-on");
    bridge.haptic("tick");
  }

  setManual(v) {
    if (this.fullManual()) return;
    if (this.expo.auto) {
      // 手動に切り替える: いまの自動の明るさで止めて、そこから動かす
      this.expo = { auto: false, display: v, frozen: { ...this.gains }, at: this.expo.display, remainder: 0 };
      if (this.autoBtn) this.autoBtn.classList.remove("is-on");
    }
    this.expo.display = v;
    this.applyExpo();
  }

  // 手動の露出をカメラへ渡す。カメラの自動露出が動いているときは露出補正で、S か ISO を手で決めているときは、このページの合わせ（priority）で
  applyExpo() {
    if (this.expo.auto) {
      if (!this.sensorManual()) {
        bridge.cameraCall("cameraSetEv", 0);
        this.cEvNow = 0;
      }
      this.sendGains();
      return;
    }
    const want = this.expo.display - this.expo.at;
    if (this.sensorManual()) {
      this.expo.remainder = 0;
    } else {
      const cEv = C.clamp(want, this.evRange.min, this.evRange.max);
      this.expo.remainder = want - cEv; // カメラの補正で届かない分は、画の明るさの倍率で足す
      bridge.cameraCall("cameraSetEv", cEv);
      this.cEvNow = cEv;
    }
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
      // 重みを渡すのは、輪の 0 の位置を、ふつうの景色で 0 付近のままにするため（重みなしだと、均一な灰色は「白が足りない画」として大きく上がる）
      const ev = C.coreEv(gray, 0.18, core, this.engine, new Float32Array(16).fill(1));
      this.base[core.id] = Math.pow(2, ev);
    }
    return this.base[core.id];
  }

  // たたいた所のまわりを重く測る重み（ない所も少しは見る）。小さな画は撮る画面と同じ向きで、GL の読み出しは下の行から
  meterWeights(w, hgt) {
    if (!this.meterAt) return null;
    const { nx, ny } = this.meterAt, n = w * hgt, wts = new Float32Array(n), s2 = 2 * 0.12 * 0.12;
    for (let i = 0; i < n; i++) {
      const x = ((i % w) + 0.5) / w, y = 1 - (Math.floor(i / w) + 0.5) / hgt;
      const dx = x - nx, dy = (y - ny) * (4 / 3);
      wts[i] = 1 + 19 * Math.exp(-(dx * dx + dy * dy) / s2);
    }
    return wts;
  }

  // 0.4 秒ごとの小さな画: ルックをかけるときの明るさ（自動）を決め、明るさの山を描く。S か ISO を手で決めているときは、もう片方を決める
  onSample(d) {
    if (!this.active || !d) return;
    const raw = Uint8Array.from(atob(d.raw), (c) => c.charCodeAt(0));
    const n = d.w * d.h, small = new Float32Array(n * 3), toLin = this.engine.jpegToLinear, S = this.engine.srgbToAp0;
    const wts = this.meterWeights(d.w, d.h);
    let sl = 0, sw = 0;
    for (let i = 0; i < n; i++) {
      const lin = [0, 1, 2].map((k) => {
        const v = raw[i * 4 + k] / 255;
        return d.preset ? C.s2l(v) : C.curveAt(toLin, v);
      });
      const a = C.mul3(S, lin[0], lin[1], lin[2]).map((v) => Math.max(v, 0));
      small.set(a, i * 3);
      const y = C.AP0_Y[0] * a[0] + C.AP0_Y[1] * a[1] + C.AP0_Y[2] * a[2];
      if (y > 0) {
        const w = wts ? wts[i] : 1;
        sl += w * Math.log(Math.max(y, 1e-6));
        sw += w;
      }
    }
    const key = sw ? Math.exp(sl / sw) : 0.18, lk = this.look();
    if (!this.sensorManual() && !this.locked) {
      // カメラの自動露出が目指す明るさを覚えておく（S か ISO を手で決めたときの、もう片方の合わせの目当て）
      const k0 = key / Math.pow(2, this.cEvNow || 0);
      this.aeKey = this.aeKey ? this.aeKey * 0.8 + k0 * 0.2 : k0;
    } else if (this.sensorManual() && !this.fullManual()) this.priorityStep(key);
    // 場面そのものの明るさ（夜の決まり用）。絞りは APK から来ないので、このレンズで撮った RAW から覚えた値（無ければ f/1.8）を使う
    const ap = (this.cam && (pref("cameraAperture") || {})[this.cam.id]) || 1.8;
    const lv = this.live || {}, scene = C.sceneOf({ iso: lv.iso, shutter: lv.exposure, aperture: ap }, key);
    const gainOf = (core) => (0.18 / key) * Math.pow(2, C.coreEv(small, key, core, this.engine, wts, scene));
    const gA = gainOf(lk.A), gB = lk.B ? gainOf(lk.B) : gA;
    this.gains = { A: this.gains.A * 0.6 + gA * 0.4, B: this.gains.B * 0.6 + gB * 0.4 };
    this.autoNow = { A: gA, B: gB };
    const main = lk.B && lk.wB > 0 ? lk.B : lk.A, mk = main === lk.B ? "B" : "A";
    if (this.expo.auto) {
      // 自動: 輪は、自動で決めた明るさ（均一な灰色の景色を 0 とした段）を指して一緒に動く
      this.expo.display = Math.round(C.clamp(log2(this.gains[mk] / this.baseGain(main)), -3, 3) * 10) / 10;
      if (!this.openKey) this.showEv(this.expo.display);
    } else if (this.fullManual() && !this.openKey) {
      // 露出計: 自動のときより何段明るく写るか
      this.showEv(log2((this.expo.frozen[mk] * Math.pow(2, this.expo.remainder)) / this.autoNow[mk]));
    }
    this.sendGains();
    this.drawHist(d.look ? Uint8Array.from(atob(d.look), (c) => c.charCodeAt(0)) : raw);
  }

  // S か ISO の片方だけを手で決めているとき: もう片方を、カメラの自動露出が目指す明るさ（＋露出の輪）に合うよう 1/3 段ずつ動かす
  priorityStep(key) {
    const p = this.pro, ev = this.expo.auto ? 0 : this.expo.display - this.expo.at;
    const stops = log2(((this.aeKey || 0.12) * Math.pow(2, ev)) / Math.max(key, 1e-6));
    if (Math.abs(stops) < 0.2 || !this.sens) return;
    const k = Math.pow(2, stops * 0.8);
    if (p.s !== null) {
      const iso = this.nearestOf(this.isoList(), this.sens.iso * k);
      if (iso === this.sens.iso) return;
      this.sens.iso = iso;
    } else {
      const s = this.nearestOf(this.sList(), this.sens.s * k);
      if (s === this.sens.s) return;
      this.sens.s = s;
    }
    this.sendManual();
    this.renderPro();
  }

  drawHist(px) {
    const cv = this.els.hist, dpr = window.devicePixelRatio || 1, W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (!W || !H) return;
    if (cv.width !== W) [cv.width, cv.height] = [W, H];
    const bins = new Uint32Array(64);
    for (let i = 0; i < px.length; i += 4) bins[Math.min(63, Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) >> 2)]++;
    const c = cv.getContext("2d"), max = Math.max(1, ...bins.slice(1, 63)) * 1.1;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(238,234,226,.34)";
    c.beginPath();
    c.moveTo(0, H);
    for (let i = 0; i < 64; i++) c.lineTo((i / 63) * W, H - Math.min(1, bins[i] / max) * H);
    c.lineTo(W, H);
    c.fill();
  }

  // ---------- 撮る ----------
  async shoot() {
    if (!this.active || this.busy || !this.opened) return;
    this.toggleLooks(false);
    this.busy = true;
    for (let i = this.settings.timer; i > 0; i--) {
      this.els.badge.hidden = false;
      this.els.badge.textContent = i + "";
      bridge.haptic("tick");
      await new Promise((r) => setTimeout(r, 1000));
    }
    // 撮ったときの見た目（ルック・Sun Level・明るさ）を覚えておく。明るさは、自動のときと比べた差（段）
    const lk = this.look(), main = lk.B && lk.wB > 0 ? "B" : "A";
    const applied = this.expo.auto ? this.gains[main] : this.expo.frozen[main] * Math.pow(2, this.expo.remainder);
    this.pendingLook = {
      ...this.lookP(),
      exposure: this.expo.auto || !this.autoNow ? 0 : Math.round(C.clamp(log2(applied / this.autoNow[main]), -3, 3) * 100) / 100,
      // 拡大して撮った写真は、開いた時にその倍率で真ん中を切り抜く（RAW には全体が残る。切り抜きの画面で戻せる）
      ...(this.zoom > 1 ? { crop: { cx: 0.5, cy: 0.5, w: 1 / this.zoom, h: 1 / this.zoom, angle: 0 } } : {}),
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
    const item = d.item, look = this.pendingLook || { ...this.lookP(), exposure: 0 };
    const params = { ...defaultParams(), ...look };
    await setEdit(bridge.keyOf(item), { params, shot: true });
    const shot = { item, url: null };
    this.shots.unshift(shot);
    if (this.onCaptured) this.onCaptured(item);
    this.updateCount();
    try {
      const res = await fetch(bridge.mediaUrl(item));
      const t = await this.engine.decodeThumb(await res.arrayBuffer(), 256);
      // このレンズの絞りを覚える（撮る前の画面で、場面そのものの明るさを出すのに使う）
      if (t.meta && t.meta.aperture > 0 && this.cam) {
        const all = pref("cameraAperture") || {};
        if (all[this.cam.id] !== t.meta.aperture) pref("cameraAperture", { ...all, [this.cam.id]: t.meta.aperture });
      }
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

  // 撮るたびに、ルックをかけた JPEG もギャラリーに保存する（選んだときだけ）
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
    this.els.count.replaceChildren(...(free > 0 ? ["あと ", h("span", { class: "num" }, Math.floor(free / (size * 1.05)).toLocaleString()), " 枚"] : []));
  }

  // ---------- 撮る画面の上の指の動き: たたいてピントと明るさ、長押しで AE/AF ロック ----------
  viewGestures() {
    const v = this.view;
    let timer = 0, start = null, longDone = false;
    // 2 本の指でつまんで拡大（指どうしの距離の比で倍率を変える）。つまんでいる間は、たたく・長押しを止める
    const pts = new Map();
    let pinch = null;
    const dist = () => {
      const [a, b] = [...pts.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const drop = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
    };
    v.addEventListener("pointerdown", (e) => {
      if (!this.opened) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        clearTimeout(timer);
        start = null;
        pinch = { d: Math.max(dist(), 1), z: this.zoom };
      }
    }, true);
    v.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) this.setZoom(pinch.z * (dist() / pinch.d), true);
    }, true);
    v.addEventListener("pointerup", drop, true);
    v.addEventListener("pointercancel", drop, true);
    v.addEventListener("pointerdown", (e) => {
      if (!this.opened || pts.size > 1) return;
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
    this.meterAt = { nx: C.clamp(nx, 0, 1), ny: C.clamp(ny, 0, 1) };
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
    document.documentElement.classList.toggle("is-land-cam", deg === 90 || deg === 270);
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
