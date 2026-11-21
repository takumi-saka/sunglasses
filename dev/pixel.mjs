// 確かめ用: ピクセルアート（ドットの大きさ）とゲームの色味のつまみを動かして、画を撮る（2026-11-21）
// 使い方: node dev/pixel.mjs <配信の番号> <書き出し先> <playwright の index.mjs> [開く写真の名前]
import fs from "node:fs";
import path from "node:path";

const [, , port, outDir, pwPath, pick = "IMG_20240718_140721.dng"] = process.argv;
const { chromium } = await import(pwPath);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [], log = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));
const shot = async (name) => page.screenshot({ path: path.join(outDir, name + ".png") });

await page.goto(`http://127.0.0.1:${port}/?fake=1`);
await page.waitForSelector(".tile.is-ready", { timeout: 60000 });
await page.evaluate((name) => [...document.querySelectorAll(".tile")].find((x) => x._item && x._item.name === name).click(), pick);
await page.waitForFunction(() => document.getElementById("photo-canvas").style.opacity === "1", null, { timeout: 60000 });
await page.evaluate(() => [...document.querySelectorAll(".tab")].find((t) => t.textContent === "効果").click());
await page.waitForTimeout(500);

// つまみを名前で探し、右へ dx だけ引く
const drag = async (label, dx) => {
  const sl = page.locator(".sl", { hasText: label }).first();
  await sl.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const box = await sl.boundingBox(), y = box.y + box.height - 12, x0 = box.x + 30;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + (dx * i) / 10, y);
  await page.mouse.up();
  await page.waitForTimeout(700);
  return sl.locator(".sl-val").textContent();
};
await shot("p0_はじめ");
log.push(["ドットの大きさ", await drag("ドットの大きさ", 150)]);
await shot("p1_ドット");
log.push(["ゲームの色味", await drag("ゲームの色味", 150)]);
await shot("p2_ドットと色味");
// 写真を押している間は元の画（ピクセルアートも外れる）
const ph = await page.locator("#ed-photo").boundingBox();
await page.mouse.move(ph.x + ph.width / 2, ph.y + ph.height / 2);
await page.mouse.down();
await page.waitForTimeout(500);
await shot("p3_押している間は元の画");
await page.mouse.up();
await page.waitForTimeout(300);
// 書き出す（元の大きさ）
await page.click("#ed-export");
await page.waitForTimeout(400);
await page.click(".sheet .btn-primary");
await page.waitForFunction(() => window.__saved, null, { timeout: 120000 });
log.push(["書き出し", await page.evaluate(() => window.__saved)]);
console.log(JSON.stringify({ log, errors }, null, 1));
await browser.close();
