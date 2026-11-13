// 確かめ用: 不具合 2 つを再現する（2026-11-13）
//  1. 写真 A を開いて一覧に戻り、写真 B を開いた時に、A の画が一瞬出るか（開いた直後の画を細かく撮り、A の仕上がりとの近さを測る）
//  2. つまみで編集した写真が、一覧の小さな画に出るか（編集を保存して一覧を作り直し、編集前の小さな画と比べる）
// 使い方: node dev/open_flash.mjs <配信の番号> <書き出し先> <playwright の index.mjs> <写真 A の名前> <写真 B の名前>
import fs from "node:fs";
import path from "node:path";

const [, , port, outDir, pwPath, nameA, nameB] = process.argv;
const { chromium } = await import(pwPath);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const out = {};

await page.goto(`http://127.0.0.1:${port}/?fake=1`);
await page.waitForSelector(".tile.is-ready", { timeout: 60000 });
await page.waitForTimeout(2500);
const clickTile = (name) => page.evaluate((n) => [...document.querySelectorAll(".tile")].find((x) => x._item && x._item.name === n).click(), name);
const ready = () => page.waitForFunction(() => document.querySelector("#editor canvas").style.opacity === "1", null, { timeout: 60000 });
const box = async () => page.locator("#ed-photo").boundingBox();
const shotPhoto = async () => page.screenshot({ clip: await box() });
// 画どうしの近さ（0〜255 の平均の差）をページの中で測る
const diff = (a, b) => page.evaluate(async ([x, y]) => {
  const load = async (b64) => {
    const im = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
    const c = new OffscreenCanvas(103, 150), g = c.getContext("2d");
    g.drawImage(im, 0, 0, 103, 150);
    return g.getImageData(0, 0, 103, 150).data;
  };
  const p = await load(x), q = await load(y);
  let s = 0;
  for (let i = 0; i < p.length; i += 4) s += Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
  return Math.round((s / (p.length / 4) / 3) * 10) / 10;
}, [a.toString("base64"), b.toString("base64")]);

// ---- 1. 前の写真が一瞬出るか ----
await clickTile(nameA);
await ready();
await page.waitForTimeout(1500);
const finalA = await shotPhoto();
fs.writeFileSync(path.join(outDir, "A_仕上がり.png"), finalA);
await page.click("#ed-back");
await page.waitForTimeout(800);
await clickTile(nameB);
const frames = [];
const t0 = Date.now();
for (let i = 0; i < 14; i++) {
  const st = await page.evaluate(() => ({ 画: document.querySelector("#editor canvas").style.opacity, 仮の画: !document.getElementById("ed-preview").hidden }));
  frames.push({ ms: Date.now() - t0, ...st, png: await shotPhoto() });
}
await ready();
await page.waitForTimeout(1500);
const finalB = await shotPhoto();
fs.writeFileSync(path.join(outDir, "B_仕上がり.png"), finalB);
out["AとBの仕上がりの差"] = await diff(finalA, finalB);
out["Bを開いた直後"] = [];
fs.writeFileSync(path.join(outDir, "B_開いた直後.png"), frames[0].png);
fs.writeFileSync(path.join(outDir, "B_開いて少しあと.png"), frames[frames.length - 1].png);
for (const [i, f] of frames.entries()) {
  const dA = await diff(f.png, finalA), dB = await diff(f.png, finalB);
  out["Bを開いた直後"].push({ ms: f.ms, 画が表: f.画 === "1", 仮の画が表: f.仮の画, Aとの差: dA, Bとの差: dB });
  if (dA < 3 && dA < dB) fs.writeFileSync(path.join(outDir, `前の写真が出た_${f.ms}ms.png`), f.png);
}
out["前の写真が出たコマ"] = out["Bを開いた直後"].filter((f) => f.Aとの差 < 3 && f.Aとの差 < f.Bとの差).length;

// ---- 2. 編集が一覧の画に出るか ----
await page.click("#ed-back");
await page.waitForTimeout(1500);
const tileShot = async (name) => {
  const h = await page.evaluateHandle((n) => [...document.querySelectorAll(".tile")].find((x) => x._item && x._item.name === n), name);
  return h.asElement().screenshot();
};
const before = await tileShot(nameB);
fs.writeFileSync(path.join(outDir, "一覧_編集前.png"), before);
await page.evaluate(async (n) => {
  const { getEdit, setEdit } = await import("/app/store.js");
  const { keyOf } = await import("/app/bridge.js");
  const { defaultParams } = await import("/engine/engine.js");
  const it = [...document.querySelectorAll(".tile")].find((x) => x._item && x._item.name === n)._item, key = keyOf(it);
  const old = await getEdit(key);
  await setEdit(key, { params: { ...defaultParams(), ...((old && old.params) || { core: "cinema", sunLevel: 0 }), exposure: 1.5, saturation: -100 } });
}, nameB);
await page.reload();
await page.waitForSelector(".tile.is-ready", { timeout: 60000 });
await page.waitForTimeout(4000);
const after = await tileShot(nameB);
fs.writeFileSync(path.join(outDir, "一覧_編集後.png"), after);
out["一覧の画の、編集前と後の差（露光 +1.5・彩度 −100）"] = await diff(before, after);
out.errors = errors;
fs.writeFileSync(path.join(outDir, "結果.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await browser.close();
