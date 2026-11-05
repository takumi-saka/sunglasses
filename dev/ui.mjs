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

fs.writeFileSync(path.join(outDir, "記録.json"), JSON.stringify({ log, errors }, null, 1));
console.log(JSON.stringify({ log, errors }, null, 1));
await browser.close();
