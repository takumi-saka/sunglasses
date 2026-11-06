// 確かめ用: スマホの大きさ（幅 412）のブラウザで画面を動かし、場面ごとに画を撮る（2026-11-05）
// 使い方: node dev/ui.mjs <配信の番号> <書き出し先> <playwright の index.mjs> [開く写真の名前]
import fs from "node:fs";
import path from "node:path";

const [, , port, outDir, pwPath, pick = "IMG_20240718_140721.dng"] = process.argv;
const { chromium } = await import(pwPath);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));
const shot = async (name) => page.screenshot({ path: path.join(outDir, name + ".png") });
const log = [];
const t0 = Date.now();

await page.goto(`http://127.0.0.1:${port}/?fake=1`);
await page.waitForSelector(".tile.is-ready", { timeout: 60000 });
await page.waitForTimeout(1500);
log.push(["一覧が出るまで", Date.now() - t0]);
await shot("01_一覧");

// 長押しで選ぶ形に入り、もう1枚たたいて、まとめて消す（写真を開く確かめの写真は消さない）
{
  const tiles = page.locator(".tile");
  const n0 = await tiles.count();
  const b0 = await tiles.nth(0).boundingBox();
  await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  await page.waitForTimeout(200);
  await tiles.nth(1).click();
  await page.waitForTimeout(200);
  log.push(["選んだ数", await page.locator("#lib-sel-count").textContent()]);
  await shot("01b_選ぶ");
  await page.click("#lib-sel-delete");
  await page.waitForTimeout(1500);
  log.push(["消したあとの枚数", n0, await page.locator(".tile").count(), await page.locator(".toast-text").textContent().catch(() => "")]);
  await shot("01c_消したあと");
  // スマホの長押しの合図（contextmenu）でも、選ぶ形に入る
  await page.locator(".tile").nth(0).dispatchEvent("contextmenu");
  await page.waitForTimeout(200);
  log.push(["長押しの合図で選ぶ", await page.locator("#lib-sel-count").textContent()]);
  // Android の「戻る」で、選ぶのをやめる（アプリは閉じない）
  const handled = await page.evaluate(() => window.__sunglassesBack());
  await page.waitForTimeout(200);
  log.push(["選んでいる途中の戻る", { 受け取った: handled, 選ぶ形: await page.evaluate(() => document.getElementById("library").classList.contains("is-selecting")), 下の行: await page.evaluate(() => document.getElementById("lib-select").hidden ? "隠れた" : "出ている") }]);
  log.push(["選んでいないときの戻る", await page.evaluate(() => window.__sunglassesBack())]);
}

// 写真を開く
const t1 = Date.now();
await page.evaluate((name) => {
  const t = [...document.querySelectorAll(".tile")].find((x) => x._item && x._item.name === name);
  t.click();
}, pick);
await page.waitForTimeout(150);
await shot("02_開いた直後");
await page.waitForFunction(() => document.getElementById("photo-canvas").style.opacity === "1", null, { timeout: 60000 });
log.push(["開いてから現像の画が出るまで", Date.now() - t1]);
await page.waitForTimeout(300);
await shot("03_編集_よく使う");

const tab = async (name) => {
  await page.evaluate((n) => [...document.querySelectorAll(".tab")].find((t) => t.textContent === n).click(), name);
  await page.waitForTimeout(500);
};
for (const [name, file] of [["ルック", "04_ルック"], ["ライト", "05_ライト"], ["カラー", "06_カラー"], ["カラーミックス", "07_カラーミックス"], ["グレーディング", "08_グレーディング"], ["効果", "09_効果"], ["ディテール", "10_ディテール"], ["切り抜き", "11_切り抜き"]]) {
  await tab(name);
  if (name === "ルック") await page.waitForTimeout(1200);
  await shot(file);
}

// つまみを動かす（よく使う → 露光量を右へ）
await tab("よく使う");
const sl = page.locator(".sl").first();
const box = await sl.boundingBox();
const y = box.y + box.height - 12, x0 = box.x + box.width / 2;
const t2 = Date.now();
await page.mouse.move(x0, y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + i * 8, y);
await page.mouse.up();
await page.waitForTimeout(400);
log.push(["露光量を動かした（10 回動かして離すまで）", Date.now() - t2]);
await shot("12_露光量を動かした");
log.push(["露光量の値", await page.locator(".sl .sl-val").first().textContent()]);

// 写真を押している間は元の画
const ph = await page.locator("#ed-photo").boundingBox();
await page.mouse.move(ph.x + ph.width / 2, ph.y + ph.height / 2);
await page.mouse.down();
await page.waitForTimeout(500);
await shot("13_押している間は元の画");
await page.mouse.up();
await page.waitForTimeout(300);

// 1 つ戻す
await page.click("#ed-undo");
await page.waitForTimeout(300);
log.push(["1つ戻したあとの露光量", await page.locator(".sl .sl-val").first().textContent()]);

// 書き出す
await page.click("#ed-export");
await page.waitForTimeout(400);
await shot("14_書き出し");
const t3 = Date.now();
await page.click(".sheet .btn-primary");
await page.waitForFunction(() => window.__saved, null, { timeout: 120000 });
log.push(["書き出し（元の大きさ）", Date.now() - t3, await page.evaluate(() => window.__saved)]);
await page.waitForTimeout(400);
await shot("15_書き出したあと");

// 2 回たたくと全画面
await page.mouse.click(ph.x + ph.width / 2, ph.y + ph.height / 2);
await page.waitForTimeout(80);
await page.mouse.click(ph.x + ph.width / 2, ph.y + ph.height / 2);
await page.waitForTimeout(500);
await shot("16_全画面");

// 全画面のまま端末を横にすると、写真を回して画面いっぱいに見せる（アプリは縦で固定）
await page.evaluate(() => window.dispatchEvent(new CustomEvent("sunglasses:orientation", { detail: { deg: 90 } })));
await page.waitForTimeout(900);
await shot("17_全画面_横");
log.push(["全画面の横", await page.evaluate(() => ({ 印: document.getElementById("editor").className, 画の大きさ: [document.getElementById("photo-canvas").width, document.getElementById("photo-canvas").height] }))]);
// 横のまま 2 回たたくと全画面を抜け、縦の画面に戻る
await page.mouse.click(206, 450);
await page.waitForTimeout(80);
await page.mouse.click(206, 450);
await page.waitForTimeout(600);
log.push(["横で2回たたいたあと", await page.evaluate(() => document.getElementById("editor").className)]);
await page.evaluate(() => window.dispatchEvent(new CustomEvent("sunglasses:orientation", { detail: { deg: 0 } })));

// 編集の「…」から、この写真を削除 → 一覧に戻る（前の知らせが消えるのを待つ）
await page.waitForFunction(() => !document.querySelector(".toast.is-on"), null, { timeout: 8000 }).catch(() => {});
await page.click("#ed-more");
await page.waitForTimeout(400);
await shot("18_ほかの操作");
const nBefore = await page.evaluate(() => window.__fakeBridge.listRaw().length);
await page.locator(".menu-row.is-danger").click();
await page.waitForTimeout(1500);
log.push(["編集から削除", { 一覧に戻った: await page.evaluate(() => !document.getElementById("library").hidden), 枚数: [nBefore, await page.evaluate(() => window.__fakeBridge.listRaw().length)], 知らせ: await page.locator(".toast-text").textContent().catch(() => "") }]);

fs.writeFileSync(path.join(outDir, "記録.json"), JSON.stringify({ log, errors }, null, 1));
console.log(JSON.stringify({ log, errors }, null, 1));
await browser.close();
