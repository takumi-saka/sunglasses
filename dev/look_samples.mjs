// ルックの見本の画づくり（撮る画面のルックの一覧に出す、決まった写真の画。2026-11-26）
// 写真を編集で開き、ルックを 1 つずつ選んで、現像した写真の画を撮って保存する（本物のルックの色）。
// 使い方: node dev/look_samples.mjs <配信の番号> <書き出し先> <playwright の index.mjs> <写真の名前>
//   そのあと: uv run --with pillow python dev/look_tiles.py <書き出し先> web/looks/tiles   （真ん中を四角に切って 204px の JPEG にする）
import fs from "node:fs";
import path from "node:path";

const [, , port, outDir, pwPath, name] = process.argv;
const { chromium } = await import(pwPath);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("エラー", e.message));
await page.goto(`http://127.0.0.1:${port}/?fake=1`);
await page.waitForSelector(".tile.is-ready", { timeout: 60000 });
await page.waitForTimeout(1500);
await page.evaluate((n) => [...document.querySelectorAll(".tile")].find((x) => x._item && x._item.name === n).click(), name);
await page.waitForFunction(() => document.getElementById("photo-canvas").style.opacity === "1", null, { timeout: 90000 });
await page.evaluate(() => document.querySelector('.tab[data-group="core"]').click());
await page.waitForTimeout(1500);
const on = () => page.evaluate(() => [...document.querySelectorAll(".ed-lk.is-on")].map((b) => b.dataset.look));
const tap = async (look) => { await page.locator(`.ed-lk[data-look="${look}"]`).click(); await page.waitForTimeout(1200); };
const shot = (look) => page.locator("#ed-photo").screenshot({ path: path.join(outDir, look + ".png") });
// はじめの形を覚えておき、いったん全部外す
const first = await on();
for (const l of first) await tap(l);
const looks = await page.evaluate(() => [...document.querySelectorAll(".ed-lk")].map((b) => b.dataset.look));
for (const l of looks) {
  await tap(l);
  console.log(l, await on());
  await shot(l);
  await tap(l);
}
// 元のルックへ戻してから閉じる（直した中身を残さない）
for (const l of first) await tap(l);
await browser.close();
