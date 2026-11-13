// 一覧の画面（2026-11-05）。RAW だけを新しい順に、撮った日ごとに並べる。小さな画にも核をかける。
import * as bridge from "./bridge.js";
import { deleteEdit, editedKeys, getEdit } from "./store.js";
import { h, toast } from "./ui.js";

const THUMB_CACHE = "sg-thumbs-v2"; // v2: RAW から作る形に変えた（2026-11-05）
const LONG_PRESS_MS = 400; // Android の長押しの標準（ViewConfiguration.getLongPressTimeout の既定）
const TOUCH_SLOP = 8; // Android のタッチの許し幅の標準（8dp。ページの 1px はおよそ 1dp）
const AUTO_CORE = "cinema"; // 2026-11-10 夜 直していない写真は Cinema（映画の見た目の核）で見せる。前は aftersun2
const AUTO_SUN = 0; // Cinema の Sun Level（Aftersun を足す量）のはじめの値

export class Library {
  constructor(engine, { onOpen, version }) {
    this.engine = engine;
    this.onOpen = onOpen;
    this.version = version;
    this.root = document.getElementById("library");
    this.list = document.getElementById("lib-list");
    this.banner = document.getElementById("lib-banner");
    this.count = document.getElementById("lib-count");
    this.urls = new Map();
    this.queue = [];
    this.busy = false;
    document.getElementById("lib-open").onclick = () => this.openFile();
    // 写真を選んでまとめて消す（長押しで選ぶ形に入る。2026-11-06）
    this.selecting = false;
    this.selected = new Set();
    this.selBar = document.getElementById("lib-select");
    document.getElementById("lib-sel-cancel").onclick = () => this.endSelect();
    document.getElementById("lib-sel-all").onclick = () => this.selectAll();
    document.getElementById("lib-sel-delete").onclick = () => this.deleteSelected();
    window.addEventListener("sunglasses:deleted", (e) => this.onDeleted(e.detail || {}));
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        this.io.unobserve(e.target);
        this.queue.unshift(e.target);
      }
      this.pump();
    }, { rootMargin: "400px 0px" });
  }

  show() {
    this.root.hidden = false;
    this.pump();
  }
  hide() {
    this.root.hidden = true;
  }

  openFile() {
    if (bridge.inApp()) return bridge.pickFiles();
    const input = h("input", { type: "file", accept: ".dng,.DNG,image/jpeg,image/x-adobe-dng" });
    input.onchange = () => {
      const f = input.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      this.onOpen({ token: "file", name: f.name, size: f.size, mime: f.type, url }, null);
    };
    input.click();
  }

  async refresh() {
    const perm = bridge.permission();
    this.renderBanner(perm);
    const items = perm === "none" ? [] : bridge.listRaw();
    this.items = items;
    this.edited = await editedKeys();
    this.count.textContent = items.length ? `RAW ${items.length} 枚` : "";
    const groups = new Map();
    for (const it of items) {
      const d = new Date(it.dateTaken || 0);
      const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!groups.has(k)) groups.set(k, { d, arr: [] });
      groups.get(k).arr.push(it);
    }
    const frag = [];
    const num = (v) => h("span", { class: "num" }, String(v));
    for (const { d, arr } of groups.values()) {
      // 日付の見出し: 2024年8月3日 土曜日 と、その日の枚数
      frag.push(h("h3", { class: "day" },
        h("span", { class: "day-date" }, num(d.getFullYear()), "年", num(d.getMonth() + 1), "月", num(d.getDate()), "日",
          h("span", { class: "day-wk" }, "日月火水木金土"[d.getDay()] + "曜日")),
        h("span", { class: "day-n" }, num(arr.length), "枚")));
      frag.push(h("div", { class: "grid" }, arr.map((it) => this.tile(it))));
    }
    if (!items.length && perm !== "none") {
      frag.push(h("div", { class: "empty" }, h("p", {}, "RAW（DNG）の写真が見つかりませんでした。"),
        h("p", { class: "note" }, "純正カメラのプロモードで RAW をオンにして撮ると、ここに新しい順に並びます。")));
    }
    frag.push(h("footer", { class: "lib-foot" }, `サングラス　版 ${this.version}　窓口 ${bridge.bridgeVersion() || "なし"}`));
    this.queue = [];
    this.list.replaceChildren(...frag);
  }

  renderBanner(perm) {
    const b = [];
    if (bridge.inApp() && bridge.bridgeVersion() < bridge.REQUIRED_BRIDGE) {
      b.push(h("div", { class: "banner" }, h("span", {}, "アプリの入れ直しが必要な更新があります。"),
        h("button", { class: "banner-btn", onClick: () => bridge.openUrl(bridge.APK_URL) }, "入れ直す")));
    }
    if (perm === "none" && bridge.inApp()) {
      b.push(h("div", { class: "banner" }, h("span", {}, "写真の一覧を出すには、写真へのアクセスを許可してください。"),
        h("button", { class: "banner-btn", onClick: () => bridge.requestPermission() }, "許可する"),
        h("button", { class: "banner-btn sub", onClick: () => bridge.openAppSettings() }, "設定を開く")));
    } else if (perm === "partial") {
      b.push(h("div", { class: "banner" }, h("span", {}, "選んだ写真だけが見えています。全部を並べるには、許可を「すべて」にしてください。"),
        h("button", { class: "banner-btn", onClick: () => bridge.requestPermission() }, "選び直す"),
        h("button", { class: "banner-btn sub", onClick: () => bridge.openAppSettings() }, "設定を開く")));
    } else if (!bridge.inApp() && perm === "none") {
      b.push(h("div", { class: "banner" }, h("span", {}, "スマホのアプリで開くと、写真の一覧が出ます。ここでは「読み込み」で試せます。")));
    }
    this.banner.replaceChildren(...b);
  }

  tile(it) {
    const key = bridge.keyOf(it);
    // まずスマホの小さな画（核なし）をすぐ出し、RAW から核をかけた画ができたら差し替える
    const img = h("img", { class: "thumb", alt: "", decoding: "async", loading: "lazy", draggable: "false", src: bridge.thumbUrl(it) });
    img.onload = () => el.classList.add("is-ready");
    const el = h("button", {
      class: "tile" + (this.edited.has(key) ? " is-edited" : "") + (this.selected.has(key) ? " is-selected" : ""),
      onClick: () => {
        if (el._long) return (el._long = false);
        if (this.selecting) this.toggle(el);
        else this.onOpen(it, img.src || null);
      },
    }, img, h("span", { class: "mark" }), h("span", { class: "check" }));
    el._item = it;
    el._img = img;
    el._key = key;
    // 長押し: 押している時間と、スマホが出す長押しの合図（contextmenu。Android の設定どおりに出る）の、早い方で選ぶ形に入る。
    // 値は Android の標準にそろえる（本人 11/6）: 押している時間 400 ミリ秒（ViewConfiguration の長押しの標準）、
    // 指の動きの許し幅 8dp（タッチの許し幅の標準。これを超えると一覧のスクロールに切り替わる）
    let timer = 0, sx = 0, sy = 0;
    const onLong = () => {
      clearTimeout(timer);
      if (el._long) return;
      el._long = true;
      bridge.haptic("confirm");
      if (!this.selecting) this.startSelect();
      this.toggle(el, true);
    };
    el.addEventListener("pointerdown", (e) => {
      el._long = false;
      sx = e.clientX;
      sy = e.clientY;
      clearTimeout(timer);
      timer = setTimeout(onLong, LONG_PRESS_MS);
    });
    el.addEventListener("pointermove", (e) => Math.hypot(e.clientX - sx, e.clientY - sy) > TOUCH_SLOP && clearTimeout(timer));
    for (const ev of ["pointerup", "pointercancel"]) el.addEventListener(ev, () => clearTimeout(timer));
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      onLong();
    });
    this.io.observe(el);
    return el;
  }

  startSelect() {
    this.selecting = true;
    this.selected.clear();
    this.root.classList.add("is-selecting");
    this.selBar.hidden = false;
    this.renderSelect();
  }
  endSelect() {
    this.selecting = false;
    this.selected.clear();
    this.root.classList.remove("is-selecting");
    this.selBar.hidden = true;
    for (const t of this.list.querySelectorAll(".tile.is-selected")) t.classList.remove("is-selected");
  }
  toggle(el, on) {
    const k = el._key, now = on === undefined ? !this.selected.has(k) : on;
    if (now) this.selected.add(k);
    else this.selected.delete(k);
    el.classList.toggle("is-selected", now);
    if (on === undefined) bridge.haptic("tick");
    this.renderSelect();
  }
  selectAll() {
    const tiles = [...this.list.querySelectorAll(".tile")];
    const all = tiles.length && tiles.every((t) => this.selected.has(t._key));
    for (const t of tiles) this.toggle(t, !all);
    bridge.haptic("tick");
  }
  renderSelect() {
    const n = this.selected.size;
    document.getElementById("lib-sel-count").textContent = n ? `${n}枚を選択` : "写真を選んでください";
    document.getElementById("lib-sel-delete").disabled = !n;
  }
  // 選んだ写真を消す。Android の確認が1回出て、許可するとまとめて消える（元の RAW がスマホから消える）
  deleteSelected() {
    const items = (this.items || []).filter((it) => this.selected.has(bridge.keyOf(it)));
    if (!items.length) return;
    this.deleting = items;
    if (!bridge.deleteMedia(items)) {
      this.deleting = null;
      toast("写真を消すには、アプリの入れ直しが必要です。", [["入れ直す", () => bridge.openUrl(bridge.APK_URL)]], 8000);
    }
  }
  async onDeleted(d) {
    const items = this.deleting || [];
    this.deleting = null;
    if (!d.ok) {
      if (d.error) toast("消せませんでした。（" + d.error + "）");
      return;
    }
    for (const it of items) await deleteEdit(bridge.keyOf(it));
    toast(`${d.count || items.length}枚を削除しました`);
    this.endSelect();
    await this.refresh();
  }

  markEdited(key) {
    if (!this.edited) return;
    this.edited.add(key);
    for (const t of this.list.querySelectorAll(".tile")) if (bridge.keyOf(t._item) === key) {
      t.classList.add("is-edited");
      this.urls.delete(key);
      this.queue.unshift(t);
    }
    this.pump();
  }

  // 核をかけた小さな画を 1 枚ずつ作る（画面に近いものから）。作った画は端末に覚えておく。
  // 編集の画面を開いている間は止める（編集の読み込みと計算の邪魔をしない）
  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length && !this.root.hidden) {
      const el = this.queue.shift();
      if (!el.isConnected) continue;
      try {
        el._img.src = await this.thumb(el._item);
        el.classList.add("is-ready", "is-cored");
      } catch {
        el.classList.add("is-failed");
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    this.busy = false;
  }

  async thumb(it) {
    const key = bridge.keyOf(it);
    const edit = this.edited.has(key) ? await getEdit(key) : null;
    const ep = (edit && edit.params) || {};
    const look = ep.core === "weak" ? { core: "aftersun", sunLevel: 50 } : { core: ep.core || AUTO_CORE, sun: ep.sun || null, sunLevel: ep.sunLevel ?? ep.strength ?? (ep.core ? 100 : AUTO_SUN) };
    const ck = `${key}:${look.core}:${Math.round(look.sunLevel)}${look.sun ? ":" + look.sun : ""}`; // sun = Cinema に足した Aftersun の種類（2026-11-13）
    if (this.urls.has(ck)) return this.urls.get(ck);
    const req = new Request(new URL(`thumb/${encodeURIComponent(ck)}.jpg`, document.baseURI));
    let cache = null;
    try {
      cache = await caches.open(THUMB_CACHE);
      const hit = await cache.match(req);
      if (hit) {
        const u = URL.createObjectURL(await hit.blob());
        this.urls.set(ck, u);
        return u;
      }
    } catch {
      cache = null;
    }
    const res = await fetch(bridge.mediaUrl(it));
    if (!res.ok) throw new Error("raw");
    const t = await this.engine.decodeThumb(await res.arrayBuffer(), 384);
    const cv = document.createElement("canvas");
    this.engine.renderThumb(t, look, cv);
    const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.86));
    if (cache) cache.put(req, new Response(blob, { headers: { "Content-Type": "image/jpeg" } })).catch(() => {});
    const u = URL.createObjectURL(blob);
    this.urls.set(ck, u);
    return u;
  }
}
