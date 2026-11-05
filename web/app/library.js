// 一覧の画面（2026-11-05）。RAW だけを新しい順に、撮った日ごとに並べる。小さな画にも核をかける。
import * as bridge from "./bridge.js";
import { editedKeys, getEdit } from "./store.js";
import { h } from "./ui.js";

const THUMB_CACHE = "sg-thumbs-v2"; // v2: RAW から作る形に変えた（2026-11-05）
const AUTO_CORE = "aftersun";

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
      const k = d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const frag = [];
    for (const [day, arr] of groups) {
      frag.push(h("h3", { class: "day" }, day));
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
      b.push(h("div", { class: "banner" }, h("span", {}, "スマホのアプリで開くと、写真の一覧が出ます。ここでは「ファイルから開く」で試せます。")));
    }
    this.banner.replaceChildren(...b);
  }

  tile(it) {
    const key = bridge.keyOf(it);
    // まずスマホの小さな画（核なし）をすぐ出し、RAW から核をかけた画ができたら差し替える
    const img = h("img", { class: "thumb", alt: "", decoding: "async", loading: "lazy", src: bridge.thumbUrl(it) });
    img.onload = () => el.classList.add("is-ready");
    const el = h("button", { class: "tile" + (this.edited.has(key) ? " is-edited" : ""), onClick: () => this.onOpen(it, img.src || null) }, img, h("span", { class: "mark" }));
    el._item = it;
    el._img = img;
    this.io.observe(el);
    return el;
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
    const core = (edit && edit.params && edit.params.core) || AUTO_CORE;
    const ck = `${key}:${core}`;
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
    this.engine.renderThumb(t, core, cv);
    const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.86));
    if (cache) cache.put(req, new Response(blob, { headers: { "Content-Type": "image/jpeg" } })).catch(() => {});
    const u = URL.createObjectURL(blob);
    this.urls.set(ck, u);
    return u;
  }
}
