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
    version: () => window.__bridgeVersion || 3, appInfo: () => JSON.stringify({ bridge: 3, model: "代わり" }),
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
    // フラッシュをたいて撮る（窓口 版 6）
    cameraCaptureFlash: (s) => {
      rec("captureFlash", s);
      const it = (id, name) => ({ id, volume: "external_primary", name, dateTaken: Date.now(), dateModified: 1, width: 4096, height: 3072, folder: "DCIM/Sunglasses/" });
      setTimeout(() => fire("sunglasses:captured", { ok: true, flash: true, item: it(78, "SG_20261115_120000.dng") }), 300);
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

// ---- 2026-11-26 見た目を作り直した（写真の下に数字の列・目盛り。設定とルックの一覧も写真の下）----
const cellOf = (key) => page.locator(`.cam-pro-cell[data-key="${key}"]`);
const cellInfo = async (key) => ({ 値: await cellOf(key).locator("b").textContent(), 名前: await cellOf(key).locator("small").textContent(), 印: (await cellOf(key).getAttribute("class")).replace("cam-pro-cell rot", "").trim() });
const lookName = () => page.locator("#cam-core").getAttribute("data-name");
const looksOpen = async () => !(await page.locator("#cam-looks").evaluate((el) => el.hidden));
const openLooks = async () => {
  if (!(await looksOpen())) await page.click("#cam-core");
  await page.waitForTimeout(300);
};
const closeLooks = async () => {
  if (await looksOpen()) await page.click("#cam-looks .cam-done");
  await page.waitForTimeout(200);
};
const tile = (id) => page.locator(`.cam-look[data-look="${id}"]`);
const tiles = () => page.evaluate(() => [...document.querySelectorAll(".cam-look")].map((e) => e.textContent + (e.classList.contains("is-on") ? "*" : "")));

// 0. 写真の上に、字や印が無い（本人 11/26）。写真の中にある部品は、枠の線・三分割の線・水平の線・ピントの輪・開けない時の知らせだけ
log.写真の上の部品 = await page.evaluate(() => {
  const v = document.getElementById("cam-view"), r = v.getBoundingClientRect();
  const inside = [...document.querySelectorAll("#camera *")].filter((e) => {
    if (e === v || e.closest("#cam-amb")) return false;
    const b = e.getBoundingClientRect();
    return b.width && b.height && getComputedStyle(e).visibility !== "hidden" && b.left < r.right - 1 && b.right > r.left + 1 && b.top < r.bottom - 1 && b.bottom > r.top + 1;
  });
  return { 部品: inside.map((e) => e.id || e.className), 字のある部品: inside.filter((e) => e.textContent.trim()).map((e) => e.id || e.className) };
});

// 1. 設定の表: 右下の印をたたくと、写真の下が設定に替わる。写真の大きさは変わらない
const viewBox = () => page.evaluate(() => {
  const r = document.getElementById("cam-view").getBoundingClientRect();
  return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
});
const vb0 = await viewBox();
await page.click("#cam-gear");
await page.waitForTimeout(300);
await shot("c1b_設定");
const rows = () => page.evaluate(() => [...document.querySelectorAll("#cam-sets .cam-srow")].map((r) => r.querySelector(".cam-sk").firstChild.textContent + ": " + ([...r.querySelectorAll(".cam-sopt.is-on")].map((o) => o.textContent)[0] ?? (r.querySelector(".cam-sw.is-on") ? "入" : "切"))));
log.設定 = { はじめ: await rows(), 写真の位置は同じ: JSON.stringify(vb0) === JSON.stringify(await viewBox()) };
await clear();
await page.locator(".cam-sopt", { hasText: "3秒" }).click();
await page.locator(".cam-srow", { hasText: "JPEG も保存" }).click();
await page.locator(".cam-srow", { hasText: "白とび警告" }).click();
await page.locator(".cam-sopt", { hasText: "グリッド" }).click();
await page.locator(".cam-sopt", { hasText: "1回" }).click();
await page.waitForTimeout(200);
log.設定.変えたあと = { 行: await rows(), 上のタイマーの印: [await page.locator("#cam-set-timer").getAttribute("class"), await page.locator("#cam-set-timer b").textContent()], ゼブラの呼び出し: await calls("zebra"),
  三分割の線が出た: !(await page.locator("#cam-grid").evaluate((el) => el.hidden)), AF: (await lastManual())?.af ?? (await page.evaluate(() => localStorage.getItem("cameraAf"))) };
await shot("c1c_設定を変えた");
await page.locator(".cam-sopt", { hasText: "オフ" }).last().click();
await page.locator(".cam-srow", { hasText: "JPEG も保存" }).click();
await page.locator(".cam-srow", { hasText: "白とび警告" }).click();
await page.locator(".cam-sopt", { hasText: "1.85:1" }).click();
await page.locator(".cam-sopt", { hasText: "連続" }).click();
await page.click("#cam-sets .cam-done");
await page.waitForTimeout(200);
// 上のタイマーの印: たたくたびに オフ → 3 → 10 → オフ
await page.click("#cam-set-timer");
const t1 = await page.locator("#cam-set-timer b").textContent();
await page.click("#cam-set-timer");
const t2 = await page.locator("#cam-set-timer b").textContent();
await page.click("#cam-set-timer");
log.設定.戻したあと = { 行: (await page.click("#cam-gear"), await rows()), 上のタイマーをたたいた順: [t1, t2, await page.locator("#cam-set-timer b").textContent()] };
await page.click("#cam-sets .cam-done");

// 露出の目盛りを右へなぞる（値が減る向き）→ 手動。麦わら色の露出をもう一度たたくと自動に戻る
await page.evaluate(() => (window.__sceneLevel = 110));
await page.waitForTimeout(2500);
log.露出_自動 = await cellInfo("ev");
await clear();
await drag("#cam-ev .rg", 0, 40);
log.手動にした値 = { 目盛り: await val(0), 項目: await cellInfo("ev") };
log.カメラの露出補正 = (await calls("ev")).slice(-1);
await cellOf("ev").click();
await page.waitForTimeout(600);
log.もう一度たたいて自動へ = await cellInfo("ev");
await drag("#cam-ev .rg", 0, 30);
await doubleTap("#cam-ev .rg", 0);
log.二回たたいて自動へ = await cellInfo("ev");

// Sun Level の項目は、Aftersun を足している時だけ出る。ルックの一覧から Aftersun Blue を足す
log.はじめのルック = { 名前: await lookName(), 上の字: [await page.locator("#cam-core b").textContent(), await page.locator("#cam-core small").textContent()], SunLevelの項目が隠れている: await cellOf("sun").evaluate((el) => el.hidden) };
await openLooks();
await shot("c2a_ルックの一覧");
log.ルックの一覧 = { 並び: await tiles(), カメラ: await page.locator(".cam-kind").allTextContents(), 写真の位置は同じ: JSON.stringify(vb0) === JSON.stringify(await viewBox()), シャッターが見える: await page.locator("#cam-shutter").isVisible() };
await tile("deepblue").click();
await page.waitForTimeout(600);
log.Blueを足した = { 名前: await lookName(), 一覧は開いたまま: await looksOpen(), 並び: await tiles() };
await closeLooks();
log.SunLevelの項目 = await cellInfo("sun");
await cellOf("sun").click();
await page.waitForTimeout(200);
log.切り替えたあとの輪 = await page.evaluate(() => [...document.querySelectorAll("#cam-ev .rg")].map((r) => r.getAttribute("aria-label") + (r.hidden ? "（隠れている）" : "（出ている）")));
await clear();
await drag("#cam-ev .rg", 1, 120);
log.SunLevel = { 値: await val(1), 項目: await cellInfo("sun"), 最後の重み: (await calls("w")).slice(-1) };
await shot("c2_SunLevel");
await cellOf("ev").click();
await page.waitForTimeout(200);

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

// 2. 手で決める撮り方: S をたたいて回す → ISO は自動で決まる
await cellOf("s").click();
await page.waitForTimeout(400);
log.S_開いた = { 目盛りの名前: await page.locator("#cam-ev .rg .rg-label").textContent(), 項目: await cellInfo("s") };
await shot("c3_Sの目盛り_自動");
await clear();
await drag("#cam-ev .rg", 0, -60);
await page.waitForTimeout(2600);
log.S_手で決めた = { 項目: await page.locator(".cam-pro").innerText(), S: await cellInfo("s"), カメラへ: await lastManual() };
await shot("c4_Sを手で決めた");
// ISO も手で決める → 露出は露出計になる
await cellOf("iso").click();
await page.waitForTimeout(400);
await drag("#cam-ev .rg", 0, -48);
await cellOf("ev").click();
await page.waitForTimeout(2600);
log.S_ISO_両方 = { 項目: await page.locator(".cam-pro").innerText(), 露出の項目: await cellInfo("ev"), 露出計の値: await val(0), カメラへ: await lastManual() };
await shot("c5_両方手で決めた_露出計");
// 両方手で決めたまま撮る → 写真の記録の明るさは、露出計の値と同じになるはず
await page.click("#cam-shutter");
await page.waitForTimeout(1200);
log.両方手で決めて撮った記録 = await page.evaluate(() => new Promise((resolve) => {
  const r = indexedDB.open("sunglasses", 1);
  r.onsuccess = () => {
    const g = r.result.transaction("edits").objectStore("edits").get("external_primary:77:1000");
    g.onsuccess = () => resolve(g.result ? g.result.params.exposure : null);
  };
}));
// WB を「くもり」、色温度へ
await cellOf("wb").click();
await page.waitForTimeout(300);
await drag("#cam-ev .rg", 0, -96);
log.WB_くもり = { 値: await page.locator("#cam-ev .rg .rg-val").textContent(), 項目: await cellInfo("wb"), カメラへ: await lastManual() };
await drag("#cam-ev .rg", 0, -330);
await page.waitForTimeout(2200);
log.WB_色温度 = { 値: await page.locator("#cam-ev .rg .rg-val").textContent(), 項目: await cellInfo("wb"), カメラへ: await lastManual() };
await shot("c6_WBの目盛り");
// 麦わら色の S をもう一度たたくと、自動に戻る（ISO だけ手で決めた状態）。目盛りは S のまま
await cellOf("s").click();
await page.waitForTimeout(300);
await cellOf("s").click();
await page.waitForTimeout(2600);
log.Sを自動に戻した = { 項目: await page.locator(".cam-pro").innerText(), S: await cellInfo("s"), カメラへ: await lastManual() };
// 自動の S をもう一度たたくと、露出の目盛りに戻る
await cellOf("s").click();
await page.waitForTimeout(300);
log.自動のSをたたいた = { S: await cellInfo("s"), 露出: await cellInfo("ev") };

// 撮る → 写真ごとの直しの記録
await page.click("#cam-shutter");
await page.waitForTimeout(1200);
log.撮った写真の記録 = await page.evaluate(() => new Promise((resolve) => {
  const r = indexedDB.open("sunglasses", 1);
  r.onsuccess = () => {
    const g = r.result.transaction("edits").objectStore("edits").get("external_primary:77:1000");
    g.onsuccess = () => resolve(g.result ? { core: g.result.params.core, sunLevel: g.result.params.sunLevel, exposure: g.result.params.exposure } : null);
  };
}));
await shot("c6b_撮ったあと");
// ルックの名前の長押しで元の画、たたくと一覧が出て、小さな画をたたくとそのルックになる
const cb = await page.locator("#cam-core").boundingBox();
await clear();
await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
await page.mouse.down();
await page.waitForTimeout(500);
log.長押しの間の重み = (await calls("w")).slice(-1);
await page.mouse.up();
await page.waitForTimeout(200);
log.離したあと = { 重み: (await calls("w")).slice(-1), 一覧は出ていない: !(await looksOpen()) };
await openLooks();
// 一覧を出したまま写真をたたく: 一覧は閉じず、ピントが合う（写真を隠していないので）
await clear();
await page.mouse.click(vb.x + vb.width / 2, vb.y + vb.height / 2);
await page.waitForTimeout(300);
log.一覧を出したまま写真をたたいた = { 一覧は開いたまま: await looksOpen(), ピントの呼び出し: (await calls("focus")).length };
// Aqua に替える
await clear();
await tile("aqua").click();
await page.waitForTimeout(600);
log.選んだあとのルック = { 名前: await lookName(), 上の字: [await page.locator("#cam-core b").textContent(), await page.locator("#cam-core small").textContent()], 並び: await tiles(), 重み: (await calls("w")).slice(-1) };
await shot("c7_Aquaにした");
// Cinema をオフ → Aqua も外す（ルックなし）→ Cinema をオン・Aqua に戻す
await tile("cinema").click();
await page.waitForTimeout(600);
log.Cinemaをオフ = { 名前: await lookName(), 並び: await tiles(), 重み: (await calls("w")).slice(-1) };
await tile("aqua").click();
await page.waitForTimeout(600);
log.どちらもなし = { 名前: await lookName(), 重み: (await calls("w")).slice(-1), SunLevelの項目が隠れている: await cellOf("sun").evaluate((el) => el.hidden) };
await shot("c7b_ルックなし");
await tile("cinema").click();
await page.waitForTimeout(600);
await tile("aqua").click();
await page.waitForTimeout(600);
log.戻したあと = { 名前: await lookName(), 重み: (await calls("w")).slice(-1) };
// 単独のルック（Warm）: 選ぶと Cinema がオフになり、Cinema をオンにすると Warm が外れる。終わったら Cinema・Aqua に戻す
await tile("warm").click();
await page.waitForTimeout(600);
log.Warmを選んだ = { 名前: await lookName(), 並び: await tiles(), 重み: (await calls("w")).slice(-1), SunLevel: await page.evaluate(() => localStorage.getItem("cameraSunSolo")) };
await shot("c7c_Warm");
await tile("cinema").click();
await page.waitForTimeout(600);
log.WarmからCinemaをオン = { 名前: await lookName(), 並び: await tiles() };
await tile("aqua").click();
await page.waitForTimeout(600);
log.Warmのあとに戻した = { 名前: await lookName(), 重み: (await calls("w")).slice(-1) };
// 戻るの操作で、一覧が閉じる（一覧へは戻らない）
await page.evaluate(() => window.__sunglassesBack());
await page.waitForTimeout(300);
log.戻るで一覧が閉じた = { 一覧は閉じた: !(await looksOpen()), 撮る画面のまま: !(await page.locator("#camera").evaluate((el) => el.hidden)) };
await closeLooks();
// 横に倒したとき: 印と数字が、その場で向きを変える。写真の上には何も出ない
await page.evaluate(() => window.dispatchEvent(new CustomEvent("sunglasses:orientation", { detail: { deg: 90 } })));
await page.waitForTimeout(400);
await cellOf("sun").click();
await drag("#cam-ev .rg", 1, 40);
await shot("c8_横");
log.横の回り = await page.evaluate(() => [".cam-pro-cell", ".cam-q", "#cam-back", ".cam-lenses .chip"].map((s) => getComputedStyle(document.querySelector(s)).transform));
await openLooks();
await shot("c8b_横の一覧");
await closeLooks();
await cellOf("ev").click();
log.使っている書体 = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family + " " + f.weight));
// ---- 焦点距離の列: 数字をたたいて拡大、2 本の指でつまむ、撮った写真の切り抜き、開けないレンズからの戻り ----
await page.evaluate(() => window.dispatchEvent(new CustomEvent("sunglasses:orientation", { detail: { deg: 0 } })));
await page.waitForTimeout(400);
const chips = () => page.evaluate(() => [...document.querySelectorAll("#cam-lenses .chip")].map((c) => c.textContent + (c.classList.contains("is-on") ? "*" : "")));
log.拡大 = { はじめの数字: await chips() };
await page.locator("#cam-lenses .cam-zoom", { hasText: "46" }).click();
await page.waitForTimeout(200);
log.拡大.四十六をたたく = { 数字: await chips(), 呼び出し: (await calls("zoom")).slice(-1) };
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
log.拡大.つまんだあと = { 数字: await chips(), 呼び出し: (await calls("zoom")).slice(-2), ピントの呼び出しが増えていない: (await calls("focus")).length };
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
  const e = await getEdit("external_primary:77:1000");
  return e && e.params && e.params.crop;
});
// 望遠の数字（開けないレンズ）をたたく → 元のレンズに戻り、数字が消える
await page.locator("#cam-lenses .chip", { hasText: "100" }).click();
await page.waitForTimeout(700);
log.拡大.開けないレンズ = { 数字: await chips(), 知らせ: await page.locator(".toast-text").last().textContent().catch(() => ""), 開いた順: (await calls("open")).slice(-2).map((c) => c[1]) };
await shot("c10_開けないレンズ");
// ---- 写ルンですのカメラ ----
{
  const pickCam = async (name) => {
    await openLooks();
    await page.locator(".cam-kind", { hasText: name }).click();
    await page.waitForTimeout(900);
  };
  const frameRow = async () => {
    await page.click("#cam-gear");
    await page.waitForTimeout(200);
    const t = await page.locator("#cam-sets .cam-srow").first().innerText();
    await page.click("#cam-sets .cam-done");
    return t.replace(/\s+/g, " ");
  };
  await clear();
  await pickCam("写ルンです");
  await shot("d02_写ルンです_一覧");
  log.写ルンです = {
    名前: await lookName(), 一覧の中: await page.locator("#cam-looks").innerText(), 数字: await chips(), 枠: await page.evaluate(() => document.getElementById("cam-frame").dataset.frame),
    倍率: (await calls("zoom")).slice(-1)[0], 重み: (await calls("w")).slice(-1)[0], 送った手動の値: (await calls("manual")).slice(-1)[0], 送った露出: (await calls("ev")).slice(-1)[0],
    つまみは隠れた: await page.evaluate(() => getComputedStyle(document.getElementById("cam-pro")).visibility === "hidden" && getComputedStyle(document.getElementById("cam-ev")).visibility === "hidden"),
  };
  await closeLooks();
  log.写ルンです.決まりの値 = await page.locator("#cam-fixed").innerText();
  log.写ルンです.設定の枠の行 = await frameRow();
  await page.waitForTimeout(1200);
  await shot("d01_写ルンです");
  await page.evaluate(() => (window.__bridgeVersion = 6));
  // フラッシュは上の印で選ぶ（どのカメラでも同じ）
  await page.click("#cam-set-flash");
  await page.waitForTimeout(300);
  log.写ルンです.フラッシュをたくにした = [await page.locator("#cam-set-flash").getAttribute("class"), await page.locator("#cam-fixed-note").textContent()];
  await shot("d02b_写ルンです_フラッシュ");
  await clear();
  await page.click("#cam-shutter");
  await page.waitForTimeout(1200);
  log.写ルンです.撮る = { 呼んだ物: (await page.evaluate(() => window.__calls.map((c) => c[0]))).filter((n) => n.startsWith("capture")), 保存した値: await page.evaluate(async () => {
    const { getEdit } = await import("/app/store.js");
    const e = await getEdit("external_primary:78:1");
    return e && e.params && { core: e.params.core, exposure: e.params.exposure, flash: e.params.flash, crop: e.params.crop };
  }) };
  await pickCam("Sunglasses");
  await closeLooks();
  log.写ルンです.戻したあと = { 名前: await lookName(), 数字: await chips(), 枠: await page.evaluate(() => document.getElementById("cam-frame").dataset.frame), 倍率: (await calls("zoom")).slice(-1)[0],
    設定の枠の行: await frameRow(), つまみが出た: await page.evaluate(() => getComputedStyle(document.getElementById("cam-pro")).visibility === "visible" && document.getElementById("cam-fixed").hidden) };
  await shot("d03_サングラスへ戻した");
  // サングラス（Cinema・Aftersun）でもフラッシュをたける
  const caps = async () => (await page.evaluate(() => window.__calls.map((c) => c[0]))).filter((n) => n.startsWith("capture"));
  await page.waitForTimeout(1500);
  await clear();
  await page.click("#cam-shutter");
  await page.waitForTimeout(1500);
  log.写ルンです.サングラスでたく = await caps();
  await page.click("#cam-set-flash");
  await page.waitForTimeout(300);
  await clear();
  await page.click("#cam-shutter");
  await page.waitForTimeout(1500);
  log.写ルンです.サングラスでオフ = [await page.locator("#cam-set-flash").getAttribute("class"), await caps()];
  // タイマー: 残りの秒は、シャッターの白い丸の中に出る
  await page.click("#cam-set-timer");
  await clear();
  await page.click("#cam-shutter");
  await page.waitForTimeout(1500);
  log.タイマー = { 丸の中の字: await page.locator("#cam-shutter-core").textContent(), まだ撮っていない: (await caps()).length === 0 };
  await shot("d04_タイマー");
  await page.waitForTimeout(2600);
  log.タイマー.終わったあと = { 丸の中の字: await page.locator("#cam-shutter-core").textContent(), 撮った: await caps() };
}
fs.writeFileSync(path.join(outDir, "記録.json"), JSON.stringify({ log, errors }, null, 1));
console.log(JSON.stringify({ log, errors }, null, 1));
await browser.close();
