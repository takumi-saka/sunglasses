// 確かめ用: スマホの窓口（SunglassesBridge 版 3）の代わりを入れて、撮る画面を動かす（2026-11-05、2026-11-06 に輪のつまみ・手で決める撮り方・たたいた所の明るさ）
// 代わりの窓口は、カメラが開いた知らせと、0.4 秒ごとの小さな画（明るさを window.__sceneLevel で変えられる。左が暗く右が明るい）を流す。
// 使い方: node dev/camera_ui.mjs <配信の番号> <書き出し先> <playwright の index.mjs> [画面の高さ（既定 915）]
import fs from "node:fs";
import path from "node:path";

const [, , port, outDir, pwPath, vh = "915"] = process.argv;
const { chromium } = await import(pwPath);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 412, height: +vh }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
await ctx.addInitScript(() => {
  window.__calls = [];
  const rec = (n, ...a) => window.__calls.push([n, ...a]);
  const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
  let timer = 0, manual = null;
  const sample = (level) => {
    const n = 64 * 48, a = new Uint8Array(n * 4);
    // 手で決めたシャッター速度×ISO があれば、自動（1/250・ISO 100）より明るさが変わる
    const k = manual && manual.iso && manual.exposure ? (manual.iso * manual.exposure) / (100 / 250) : 1;
    const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const l2s = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
    for (let i = 0; i < n; i++) {
      const x = i % 64, c0 = Math.min(1, (level * (0.25 + (x / 64) * 1.5)) / 255);
      const v = Math.round(Math.min(1, l2s(s2l(c0) * k)) * 255);
      a[i * 4] = v;
      a[i * 4 + 1] = v;
      a[i * 4 + 2] = Math.round(v * 0.95);
      a[i * 4 + 3] = 255;
    }
    let s = "";
    for (const c of a) s += String.fromCharCode(c);
    return btoa(s);
  };
  window.__sceneLevel = 110;
  window.SunglassesBridge = {
    version: () => 3, appInfo: () => JSON.stringify({ bridge: 3, model: "代わり" }),
    mediaPermission: () => "full", listRaw: () => "[]", takeOpened: () => "[]", takeLaunch: () => "",
    cameraPermission: () => "granted", requestCameraPermission: () => rec("reqCam"),
    cameraInfo: () => JSON.stringify({ cameras: [{ id: "0", raw: true, rawSizes: ["4096x3072"], eq35: 23, iso: [50, 6400], exposure: [0.0001, 1], minFocus: 10, manualSensor: true, manualPost: true },
      { id: "3", parent: "0", raw: true, rawSizes: ["4096x3072"], eq35: 100, iso: [50, 6400], exposure: [0.0001, 1], minFocus: 10, manualSensor: true, manualPost: true }] }),
    cameraSetZoom: (z) => rec("zoom", +z.toFixed(2)),
    cameraOpen: (id, x, y, w, h) => {
      rec("open", id, Math.round(w), Math.round(h));
      if (id === "3") return setTimeout(() => fire("sunglasses:camera", { state: "error", message: "カメラを開けませんでした（代わり）" }), 100);
      setTimeout(() => fire("sunglasses:camera", { state: "open", id, raw: true, rawSize: "4096x3072", evMin: -4, evMax: 4, evStep: 1 / 3, zoomMax: 8 }), 100);
      clearInterval(timer);
      timer = setInterval(() => {
        fire("sunglasses:camera-sample", { w: 64, h: 48, raw: sample(window.__sceneLevel), look: "", preset: true });
        const m = manual && manual.iso ? manual : null;
        fire("sunglasses:camera", { state: "info", exposure: m ? m.exposure : 1 / 250, iso: m ? m.iso : 100, focus: 0.8, wbGains: manual && manual.wb === "daylight" ? [2.1, 1, 1, 1.5] : manual && manual.wb === "incandescent" ? [1.3, 1, 1, 2.8] : [1.9, 1, 1, 1.7] });
      }, 400);
    },
    cameraSetRect: (x, y, w, h) => rec("rect", Math.round(w), Math.round(h)),
    cameraClose: () => {
      rec("close");
      clearInterval(timer);
    },
    cameraSetLookParams: () => rec("params"), cameraSetLookSlot: (s) => rec("slot", s), cameraSetLook: () => rec("look1"),
    cameraSetWeights: (n, a, b) => rec("w", +n.toFixed(2), +a.toFixed(2), +b.toFixed(2)),
    cameraSetGains: (a, b) => rec("g", +a.toFixed(3), +b.toFixed(3)), cameraSetGain: (g) => rec("g1", g),
    cameraSetLookOn: (on) => rec("lookOn", on), cameraSetZebra: (on) => rec("zebra", on), cameraSetEv: (v) => rec("ev", +v.toFixed(2)),
    cameraFocus: (...a) => rec("focus", ...a.map((v) => (typeof v === "number" ? +v.toFixed(3) : v))), cameraUnlock: () => rec("unlock"),
    cameraSetManual: (j) => {
      manual = JSON.parse(j);
      rec("manual", manual);
    },
    cameraCapture: (s) => {
      rec("capture", s);
      setTimeout(() => fire("sunglasses:captured", { ok: true, item: { id: 77, volume: "external_primary", name: "SG_test.dng", dateTaken: Date.now(), dateModified: 1, width: 4096, height: 3072, folder: "DCIM/Sunglasses/" } }), 200);
    },
    storageFree: () => String(64e9), keepScreenOn: () => {}, haptic: (k) => rec("haptic", k), openUrl: () => {}, openAppSettings: () => {},
    pickFiles: () => {}, requestMediaPermission: () => {},
  };
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("response", (r) => r.status() >= 400 && errors.push(r.status() + " " + r.url()));
const shot = (n) => page.screenshot({ path: path.join(outDir, n + ".png") });
const log = {};
const calls = async (name) => page.evaluate((n) => window.__calls.filter((c) => c[0] === n), name);
const clear = () => page.evaluate(() => (window.__calls.length = 0));
const val = (i) => page.locator("#cam-ev .rg .rg-val").nth(i).textContent();
const lastManual = async () => (await calls("manual")).slice(-1)[0]?.[1];
// 輪を横になぞる（左へなぞると値が増える）
const drag = async (sel, i, dx) => {
  const b = await page.locator(sel).nth(i).boundingBox();
  const y = b.y + b.height - 12, x0 = b.x + b.width / 2;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  const steps = 8;
  for (let k = 1; k <= steps; k++) await page.mouse.move(x0 + (dx * k) / steps, y);
  await page.mouse.up();
  await page.waitForTimeout(300);
};
const doubleTap = async (sel, i) => {
  const b = await page.locator(sel).nth(i).boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height - 12);
  await page.waitForTimeout(80);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height - 12);
  await page.waitForTimeout(400);
};

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForSelector("#lib-camera");
await shot("c0_一覧");
await page.click("#lib-camera");
await page.waitForTimeout(2200);
await shot("c1_撮る画面");
log.画の大きさ = await page.evaluate(() => {
  const r = document.getElementById("cam-view").getBoundingClientRect();
  return { 画の幅: Math.round(r.width), 画の高さ: Math.round(r.height), 画面: [innerWidth, innerHeight] };
});
log.開いたときの呼び出し = await page.evaluate(() => window.__calls.filter((c) => ["open", "slot", "w", "rect", "manual"].includes(c[0])).slice(0, 8));
log.自動の露出_明るい景色 = await val(0);
await page.evaluate(() => (window.__sceneLevel = 35));
await page.waitForTimeout(2500);
log.自動の露出_暗い景色 = await val(0);

// 1. 上の設定の幅: 値を変えても、4 つの位置と幅（シャッター音の項目は 2026-11-13 になくした）が変わらない
const boxes = () => page.evaluate(() => [...document.querySelectorAll(".cam-set")].map((e) => {
  const r = e.getBoundingClientRect();
  return [Math.round(r.left), Math.round(r.width)];
}));
const before = await boxes();
await page.click("#cam-set-jpeg");
await page.click("#cam-set-timer");
log.上の設定の値 = await page.evaluate(() => [...document.querySelectorAll(".cam-set b")].map((b) => b.textContent));
log.上の設定の幅は同じ = JSON.stringify(before) === JSON.stringify(await boxes());
log.上の設定の位置と幅 = before;
await page.click("#cam-set-jpeg");
await page.click("#cam-set-timer");
await page.click("#cam-set-timer");

// 露出の輪を右へなぞる（値が減る向き）→ 手動
await page.evaluate(() => (window.__sceneLevel = 110));
await page.waitForTimeout(2500);
await clear();
await drag("#cam-ev .rg", 0, 40);
log.手動にした値 = await val(0);
log.手動の自動ボタン = await page.locator(".cam-auto").getAttribute("class");
log.カメラの露出補正 = (await calls("ev")).slice(-1);
await page.click(".cam-auto");
await page.waitForTimeout(600);
log.自動に戻した = await page.locator(".cam-auto").getAttribute("class");
await drag("#cam-ev .rg", 0, 30);
await doubleTap("#cam-ev .rg", 0);
log.二回たたいて自動へ = await page.locator(".cam-auto").getAttribute("class");

// Sun Level を左へ（値が増える向き）、右へ（減る向き）。露出と Sun Level は見出しで切り替える
// 2026-11-13 Sun Level の輪は、Aftersun を足している時だけ出る。先に、ルックの一覧から Aftersun Blue を足す
log.はじめのルック = { 名前: await page.locator("#cam-core b").textContent(), SunLevelの見出しが隠れている: await page.locator(".cam-tab", { hasText: "Sun Level" }).first().evaluate((el) => el.hidden) };
await page.locator("#cam-core").click();
await page.waitForTimeout(300);
await page.locator(".cam-look", { hasText: "Aftersun Blue" }).click();
await page.waitForTimeout(600);
await page.locator(".cam-tab:visible", { hasText: "Sun Level" }).click();
await page.waitForTimeout(200);
log.切り替えたあとの輪 = await page.evaluate(() => [...document.querySelectorAll("#cam-ev .rg")].map((r) => r.getAttribute("aria-label") + (r.hidden ? "（隠れている）" : "（出ている）")));
await clear();
await drag("#cam-ev .rg", 1, 120);
log.SunLevel = { 値: await val(1), 最後の重み: (await calls("w")).slice(-1) };
await shot("c2_露出とSunLevel");

// 3. たたいた所の明るさ: 左（暗い所）をたたくと、自動の露出が明るい向きに動く
await page.evaluate(() => (window.__sceneLevel = 110));
await page.waitForTimeout(2500);
const evMid = await val(0);
const vb = await page.locator("#cam-view").boundingBox();
await clear();
await page.mouse.click(vb.x + vb.width * 0.08, vb.y + vb.height * 0.5);
await page.waitForTimeout(3000);
const evLeft = await val(0);
await page.mouse.click(vb.x + vb.width * 0.92, vb.y + vb.height * 0.5);
await page.waitForTimeout(3000);
const evRight = await val(0);
log.たたいた所の明るさ = { 真ん中で測ったとき: evMid, 左の暗い所をたたいた: evLeft, 右の明るい所をたたいた: evRight, ピントの呼び出し: (await calls("focus")).slice(-2) };

// 2. 手で決める撮り方: S を開いて回す → ISO は自動で決まる
await page.click(".cam-pro-cell >> nth=0");
await page.waitForTimeout(400);
log.S_開いた輪 = { 名前: await page.locator("#cam-ev .rg .rg-label").textContent(), 値: await page.locator("#cam-ev .rg .rg-val").textContent() };
await shot("c3_Sの輪_自動");
await clear();
await drag("#cam-ev .rg", 0, -60);
await page.waitForTimeout(2600);
log.S_手で決めた = { 値: await page.locator("#cam-ev .rg .rg-val").textContent(), 項目: await page.locator(".cam-pro").innerText(), カメラへ: await lastManual() };
await shot("c4_Sを手で決めた");
// ISO も手で決める → 露出計
await page.click(".cam-pro-cell >> nth=1");
await page.waitForTimeout(400);
await drag("#cam-ev .rg", 0, -48);
await page.click(".cam-pro-cell >> nth=1");
await page.waitForTimeout(2600);
log.S_ISO_両方 = { 項目: await page.locator(".cam-pro").innerText(), 露出の札: await page.locator("#cam-ev .rg .rg-head").first().innerText(), 露出計の値: await val(0), カメラへ: await lastManual() };
await shot("c5_両方手で決めた_露出計");
// 両方手で決めたまま撮る → 写真の記録の明るさは、露出計の値と同じになるはず
await page.click("#cam-shutter");
await page.waitForTimeout(1200);
log.両方手で決めて撮った記録 = await page.evaluate(() => new Promise((resolve) => {
  const r = indexedDB.open("sunglasses", 1);
  r.onsuccess = () => {
    const g = r.result.transaction("edits").objectStore("edits").get("external_primary:77:1");
    g.onsuccess = () => resolve(g.result ? g.result.params.exposure : null);
  };
}));
// WB を「くもり」、色温度へ
await page.click(".cam-pro-cell >> nth=2");
await page.waitForTimeout(300);
await drag("#cam-ev .rg", 0, -96);
log.WB_くもり = { 値: await page.locator("#cam-ev .rg .rg-val").textContent(), カメラへ: await lastManual() };
await drag("#cam-ev .rg", 0, -330);
await page.waitForTimeout(2200);
log.WB_色温度 = { 値: await page.locator("#cam-ev .rg .rg-val").textContent(), カメラへ: await lastManual() };
await shot("c6_WBの輪");
// S の輪を 2 回たたいて自動へ（ISO だけ手で決めた状態）
await page.click(".cam-pro-cell >> nth=0");
await page.waitForTimeout(300);
await doubleTap("#cam-ev .rg", 0);
await page.waitForTimeout(2600);
log.Sを自動に戻した = { 項目: await page.locator(".cam-pro").innerText(), カメラへ: await lastManual() };
await page.click(".cam-pro-cell >> nth=0");
await page.waitForTimeout(300);

// 撮る → 写真ごとの直しの記録
await page.click("#cam-shutter");
await page.waitForTimeout(1200);
log.撮った写真の記録 = await page.evaluate(() => new Promise((resolve) => {
  const r = indexedDB.open("sunglasses", 1);
  r.onsuccess = () => {
    const g = r.result.transaction("edits").objectStore("edits").get("external_primary:77:1");
    g.onsuccess = () => resolve(g.result ? { core: g.result.params.core, sunLevel: g.result.params.sunLevel, exposure: g.result.params.exposure } : null);
  };
}));
// ルックの長押しで元の画、たたくと一覧が出て、名前をたたくとそのルックになる
const cb = await page.locator("#cam-core").boundingBox();
await clear();
await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
await page.mouse.down();
await page.waitForTimeout(500);
log.長押しの間の重み = (await calls("w")).slice(-1);
await page.mouse.up();
await page.waitForTimeout(200);
log.離したあとの重み = (await calls("w")).slice(-1);
await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
await page.waitForTimeout(300);
log.ルックの一覧 = { 出ている: !(await page.locator("#cam-looks").evaluate((el) => el.hidden)), 並び: await page.locator(".cam-look").allTextContents(), 印: await page.locator(".cam-look.is-on").allTextContents() };
await shot("c7a_ルックの一覧");
// 一覧の外（写真の上）をたたくと閉じる。ピント合わせには流れない
await clear();
await page.mouse.click(60, 200);
await page.waitForTimeout(300);
log.外をたたいた = { 一覧は閉じた: await page.locator("#cam-looks").evaluate((el) => el.hidden), ルック: await page.locator("#cam-core b").textContent(), ピントの呼び出し: (await calls("focus")).length };
// もう一度出して、5 番目（Aftersun Aqua。名前が長くなる）を選ぶ
await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
await page.waitForTimeout(300);
await page.locator(".cam-look >> nth=4").click();
await page.waitForTimeout(600);
log.選んだあとのルック = { 名前: await page.locator("#cam-core b").textContent(), 一覧は閉じた: await page.locator("#cam-looks").evaluate((el) => el.hidden), 長い名前の印: await page.locator("#cam-core").evaluate((el) => el.classList.contains("is-long")), 重み: (await calls("w")).slice(-1) };
const cb2 = await page.locator("#cam-core").boundingBox(), sb = await page.locator("#cam-shutter").boundingBox();
log.ルック名とシャッターのすき間 = Math.round(cb2.x - (sb.x + sb.width));
await shot("c7_あと");
// 2026-11-13 Cinema をオフ（一覧は開いたまま）→ なし（ルックなし）→ Cinema をオン・Aftersun Aqua に戻す
await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
await page.waitForTimeout(300);
await page.locator(".cam-look >> nth=0").click();
await page.waitForTimeout(600);
log.Cinemaをオフ = { 名前: await page.locator("#cam-core b").textContent(), 一覧は開いたまま: !(await page.locator("#cam-looks").evaluate((el) => el.hidden)), 並び: await page.locator(".cam-look").allTextContents(), 重み: (await calls("w")).slice(-1) };
await page.locator(".cam-look >> nth=1").click();
await page.waitForTimeout(600);
log.どちらもなし = { 名前: await page.locator("#cam-core b").textContent(), 重み: (await calls("w")).slice(-1), SunLevelの見出しが隠れている: await page.locator(".cam-tab", { hasText: "Sun Level" }).first().evaluate((el) => el.hidden) };
await shot("c7b_ルックなし");
await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
await page.waitForTimeout(300);
await page.locator(".cam-look >> nth=0").click();
await page.waitForTimeout(600);
await page.locator(".cam-look >> nth=4").click();
await page.waitForTimeout(600);
log.戻したあと = { 名前: await page.locator("#cam-core b").textContent(), 重み: (await calls("w")).slice(-1) };
// 横に倒したときの一覧
await page.evaluate(() => window.dispatchEvent(new CustomEvent("sunglasses:orientation", { detail: { deg: 90 } })));
await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
await page.waitForTimeout(500);
await shot("c7b_横の一覧");
await page.mouse.click(60, 200);
await page.evaluate(() => window.dispatchEvent(new CustomEvent("sunglasses:orientation", { detail: { deg: 0 } })));
await page.waitForTimeout(300);
// 横に倒したとき: 字の出る所が回り、回している値が吹き出しに出る
await page.evaluate(() => window.dispatchEvent(new CustomEvent("sunglasses:orientation", { detail: { deg: 90 } })));
await page.waitForTimeout(400);
await drag("#cam-ev .rg", 1, 40);
log.横の吹き出し = { 見出し: await page.locator("#cam-bubble small").textContent(), 値: await page.locator("#cam-bubble b").textContent(), 出ている: await page.locator("#cam-bubble").getAttribute("class") };
await shot("c8_横");
log.横の回り = await page.evaluate(() => [".cam-pro-cell", "#cam-badge", ".cam-set"].map((s) => getComputedStyle(document.querySelector(s)).transform));
log.使っている書体 = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family + " " + f.weight));
// ---- 拡大（2026-11-13）: 倍率の札、2 本の指でつまむ、撮った写真の切り抜き、開けないレンズからの戻り ----
await page.evaluate(() => window.dispatchEvent(new CustomEvent("sunglasses:orientation", { detail: { deg: 0 } })));
await page.waitForTimeout(400);
const chips = () => page.evaluate(() => [...document.querySelectorAll("#cam-lenses .chip")].map((c) => c.textContent + (c.classList.contains("is-on") ? "*" : "")));
log.拡大 = { はじめの札: await chips() };
await page.locator("#cam-lenses .cam-zoom", { hasText: "2×" }).click();
await page.waitForTimeout(200);
log.拡大.二倍をたたく = { 札: await chips(), 呼び出し: (await calls("zoom")).slice(-1) };
// 2 本の指でつまむ: 指のあいだを 100px → 150px に広げる（2 倍 → 3 倍）
await page.evaluate(() => {
  const v = document.getElementById("cam-view"), r = v.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const ev = (type, id, x) => v.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: cy, bubbles: true, pointerType: "touch", isPrimary: id === 11 }));
  ev("pointerdown", 11, cx - 50);
  ev("pointerdown", 12, cx + 50);
  for (let i = 1; i <= 5; i++) ev("pointermove", 12, cx + 50 + i * 10);
  ev("pointerup", 12, cx + 100);
  ev("pointerup", 11, cx - 50);
});
await page.waitForTimeout(300);
log.拡大.つまんだあと = { 札: await chips(), 呼び出し: (await calls("zoom")).slice(-2), ピントの呼び出しが増えていない: (await calls("focus")).length };
await shot("c9_拡大");
log.拡大.画素数の字 = await page.locator("#cam-readout").textContent();
// 画素数の字をたたく → レンズの情報が出る
await page.click("#cam-readout");
await page.waitForTimeout(500);
log.拡大.レンズの情報 = (await page.locator(".cam-lensinfo pre").textContent().catch(() => "（出ない）")).split("\n").slice(0, 6);
await shot("c9b_レンズの情報");
await page.click(".sheet-back");
await page.waitForTimeout(400);
// 拡大したまま撮る → 保存した編集に切り抜きが入る
await page.click("#cam-shutter");
await page.waitForTimeout(900);
log.拡大.撮った写真の切り抜き = await page.evaluate(async () => {
  const { getEdit } = await import("/app/store.js");
  const e = await getEdit("external_primary:77:1");
  return e && e.params && e.params.crop;
});
// 望遠の札（開けないレンズ）をたたく → 元のレンズに戻り、札が消える
await page.locator("#cam-lenses .chip", { hasText: "100mm" }).click();
await page.waitForTimeout(700);
log.拡大.開けないレンズ = { 札: await chips(), 知らせ: await page.locator(".toast-text").last().textContent().catch(() => ""), 開いた順: (await calls("open")).slice(-2).map((c) => c[1]) };
await shot("c10_開けないレンズ");
fs.writeFileSync(path.join(outDir, "記録.json"), JSON.stringify({ log, errors }, null, 1));
console.log(JSON.stringify({ log, errors }, null, 1));
await browser.close();
