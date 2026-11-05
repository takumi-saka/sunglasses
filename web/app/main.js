// サングラスの入口（2026-11-05）。一覧と編集を切り替え、スマホの戻る操作・共有から開く・更新を受け持つ
import { Engine } from "../engine/engine.js";
import * as bridge from "./bridge.js";
import { Camera } from "./camera.js";
import { Editor } from "./editor.js";
import { Library } from "./library.js";
import { pref } from "./store.js";
import { h, toast } from "./ui.js";

const META = document.querySelector('meta[name="sg-version"]').content;
const VERSION = META.startsWith("__") ? "開発中" : META;

function fatal(msg) {
  document.body.replaceChildren(h("div", { class: "fatal" }, h("p", {}, "サングラスを始められませんでした。"), h("p", { class: "note" }, msg)));
}

async function boot() {
  if (new URLSearchParams(location.search).has("fake")) await import(new URL("../../dev/fake-bridge.js", import.meta.url).href);
  let engine;
  try {
    engine = await Engine.create(document.getElementById("photo-canvas"));
  } catch (e) {
    fatal(e.message);
    return;
  }
  let screen = "library", updateReady = false;
  const library = new Library(engine, { onOpen: (item, thumb) => openItem(item, thumb), version: VERSION });
  const editor = new Editor(engine, {
    onBack: () => showLibrary(),
    onSaved: (key) => library.markEdited(key),
  });
  let shotSinceList = false;
  const camera = new Camera(engine, {
    onBack: () => showLibrary(),
    onOpenItem: (item, thumb) => {
      camera.close();
      openItem(item, thumb);
    },
    onCaptured: () => (shotSinceList = true),
  });
  document.getElementById("lib-camera").onclick = () => showCamera();

  function showCamera() {
    editor.close();
    library.hide();
    screen = "camera";
    camera.open();
  }

  function showLibrary() {
    editor.close();
    if (screen === "camera") camera.close();
    library.show();
    screen = "library";
    if (shotSinceList) {
      shotSinceList = false;
      library.refresh();
    }
    if (updateReady) location.reload();
  }
  function openItem(item, thumb) {
    library.hide();
    screen = "editor";
    editor.open(item, thumb);
  }

  // スマホの戻る操作（APK から呼ばれる）。true を返すと、ページの中で受け止めたことになる
  window.__sunglassesBack = () => {
    if (screen === "editor") return editor.back();
    if (screen === "camera") {
      showLibrary();
      return true;
    }
    return false;
  };
  window.addEventListener("sunglasses:open-camera", () => showCamera());
  window.addEventListener("sunglasses:resume", async () => {
    if (screen === "camera") camera.open();
    if (screen === "library") await library.refresh();
    // 純正カメラで撮って戻ってきた: いま撮った RAW をすぐ開く
    const t = pref("stockLaunch");
    if (t && Date.now() - t < 15 * 60 * 1000) {
      pref("stockLaunch", 0);
      const newest = bridge.listRaw().find((it) => it.dateTaken >= t - 5000);
      if (newest) {
        if (screen === "camera") camera.close();
        openItem(newest, null);
      }
    }
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
    }
  });
  window.addEventListener("sunglasses:permission", () => library.refresh());
  window.addEventListener("sunglasses:opened", () => {
    const list = bridge.takeOpened();
    if (list.length) openItem(list[0], null);
  });

  await library.refresh();
  if (bridge.takeLaunch() === "camera") showCamera();
  const opened = bridge.takeOpened();
  if (opened.length) openItem(opened[0], null);
  if (pref("updated") && pref("updated") !== VERSION) toast(`新しい版（${VERSION}）にしました`);
  pref("updated", VERSION);

  // 電波がなくても動くように、ページの部品を端末に覚えておく（GitHub のページで開いたときだけ）
  if ("serviceWorker" in navigator && location.hostname.endsWith("github.io")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    let had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!had) {
        had = true;
        return;
      }
      // 新しい版が届いた。編集中は待ち、一覧に戻ったら入れ替える
      updateReady = true;
      if (screen === "library") location.reload();
    });
  }
}

boot();
