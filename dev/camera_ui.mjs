// 確かめ用: スマホの窓口（SunglassesBridge 版 3）の代わりを入れて、撮る画面を動かす（2026-11-05）
// 代わりの窓口は、カメラが開いた知らせと、0.4 秒ごとの小さな画（明るさを window.__sceneLevel で変えられる）を流す。
// 使い方: node dev/camera_ui.mjs <配信の番号> <書き出し先> <playwright の index.mjs>
import fs from "node:fs";
import path from "node:path";

const [, , port, outDir, pwPath] = process.argv;
const { chromium } = await import(pwPath);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 412, height: 870 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
await ctx.addInitScript(() => {
  window.__calls = [];
  const rec = (n, ...a) => window.__calls.push([n, ...a]);
  const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
  let timer = 0;
  const sample = (level) => {
    const n = 64 * 48, a = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = i % 64, v = Math.min(255, Math.round(level * (0.5 + x / 64)));
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
    cameraInfo: () => JSON.stringify({ cameras: [{ id: "0", raw: true, rawSizes: ["4096x3072"], eq35: 23, iso: [50, 6400], exposure: [0.0001, 1], minFocus: 10, manualSensor: true, manualPost: true }] }),
    cameraOpen: (id, x, y, w, h) => {
      rec("open", id, Math.round(w), Math.round(h));
      setTimeout(() => fire("sunglasses:camera", { state: "open", id, raw: true, rawSize: "4096x3072", evMin: -4, evMax: 4, evStep: 1 / 3 }), 100);
      clearInterval(timer);
      timer = setInterval(() => {
        fire("sunglasses:camera-sample", { w: 64, h: 48, raw: sample(window.__sceneLevel), look: "", preset: false });
        fire("sunglasses:camera", { state: "info", exposure: 1 / 250, iso: 100 });
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
    cameraFocus: (...a) => rec("focus", ...a), cameraUnlock: () => rec("unlock"), cameraSetManual: (j) => rec("manual", j),
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
const val = (i) => page.locator("#cam-ev .sl .sl-val").nth(i).textContent();

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForSelector("#lib-camera");
await page.click("#lib-camera");
await page.waitForTimeout(2200);
await shot("c1_撮る画面");
log.開いたときの呼び出し = await page.evaluate(() => window.__calls.filter((c) => ["open", "slot", "w", "rect"].includes(c[0])).slice(0, 8));
log.自動の明るさ_明るい景色 = await val(0);
await page.evaluate(() => (window.__sceneLevel = 35));
await page.waitForTimeout(2500);
log.自動の明るさ_暗い景色 = await val(0);
log.自動ボタン = await page.locator(".cam-auto").getAttribute("class");

// 明るさのつまみを右へ動かす → 手動
const sl = page.locator("#cam-ev .sl").nth(0), box = await sl.boundingBox();
await clear();
await page.mouse.move(box.x + box.width / 2, box.y + box.height - 10);
await page.mouse.down();
for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.width / 2 + i * 10, box.y + box.height - 10);
await page.mouse.up();
await page.waitForTimeout(300);
log.手動にした値 = await val(0);
log.手動の自動ボタン = await page.locator(".cam-auto").getAttribute("class");
log.カメラの明るさの補正 = (await calls("ev")).slice(-1);
const gFrozen = (await calls("g")).slice(-1);
await page.evaluate(() => (window.__sceneLevel = 120));
await page.waitForTimeout(1600);
log.手動で景色が明るくなったあとの値 = await val(0);
log.手動の倍率は止まったまま = { 止めた時: gFrozen, いま: (await calls("g")).slice(-1) };
await shot("c2_手動");

// 自動に戻す
await clear();
await page.click(".cam-auto");
await page.waitForTimeout(1600);
log.自動に戻した = { ボタン: await page.locator(".cam-auto").getAttribute("class"), 補正: await calls("ev"), 値: await val(0) };

// もう一度手動にしてから、明るさのつまみを 2 回たたく → 自動に戻る
await page.mouse.move(box.x + box.width / 2, box.y + box.height - 10);
await page.mouse.down();
for (let i = 1; i <= 4; i++) await page.mouse.move(box.x + box.width / 2 - i * 10, box.y + box.height - 10);
await page.mouse.up();
await page.waitForTimeout(500);
const before2 = await page.locator(".cam-auto").getAttribute("class");
await clear();
await page.mouse.click(box.x + box.width / 2, box.y + box.height - 10);
await page.waitForTimeout(80);
await page.mouse.click(box.x + box.width / 2, box.y + box.height - 10);
await page.waitForTimeout(1200);
log.二回たたいて自動へ = { 前: before2, 後: await page.locator(".cam-auto").getAttribute("class"), 補正: await calls("ev") };

// Sun Level を 50 付近へ
const lv = page.locator("#cam-ev .sl").nth(1), lb = await lv.boundingBox();
await clear();
await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height - 10);
await page.mouse.down();
for (let i = 1; i <= 12; i++) await page.mouse.move(lb.x + lb.width / 2 - i * 8, lb.y + lb.height - 10);
await page.mouse.up();
await page.waitForTimeout(300);
log.SunLevel = { 値: await val(1), 最後の重み: (await calls("w")).slice(-1), 手応え: (await calls("haptic")).length };

// 上の設定（タイマー）を上へ転がす
const tb = await page.locator("#cam-set-timer").boundingBox();
await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2 - i * 4);
await page.mouse.up();
await page.waitForTimeout(300);
log.タイマーを転がした = await page.locator("#cam-set-timer b").textContent();
await page.click("#cam-set-timer");
await page.click("#cam-set-timer");
log.タイマーをたたいて戻した = await page.locator("#cam-set-timer b").textContent();

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
log.水平の振動 = (await page.evaluate(() => window.__calls.filter((c) => c[0] === "haptic" && c[1] === "tick").length));
await shot("c3_あと");
fs.writeFileSync(path.join(outDir, "記録.json"), JSON.stringify({ log, errors }, null, 1));
console.log(JSON.stringify({ log, errors }, null, 1));
await browser.close();
