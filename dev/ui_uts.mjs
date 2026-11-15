// 確かめ用: 編集画面で「写ルンですで現像」をオンにし、タブ・ルック名・画・一覧の小さな画を撮る（2026-11-15）
// 使い方: node dev/ui_uts.mjs <配信の番号> <書き出し先> <playwright の index.mjs> [開く写真の名前]
import fs from "node:fs";
import path from "node:path";

const [, , port, outDir, pwPath, pick = "IMG_20240718_140721.dng"] = process.argv;
const { chromium } = await import(pwPath);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));
const shot = async (name) => page.screenshot({ path: path.join(outDir, name + ".png") });
const tabs = () => page.evaluate(() => [...document.querySelectorAll(".tab")].map((t) => t.textContent + (t.classList.contains("is-on") ? "*" : "")));
const tab = async (name) => { await page.evaluate((n) => [...document.querySelectorAll(".tab")].find((t) => t.textContent === n).click(), name); await page.waitForTimeout(700); };
const chip = () => page.evaluate(() => document.querySelector("#ed-core, .core-chip, [id*=core]")?.textContent || "");
const filmToggle = () => page.evaluate(() => { const r = [...document.querySelectorAll(".toggle-row")].find((x) => x.textContent.includes("写ルンです")); r.querySelector(".toggle").click(); });
const log = [];

await page.goto(`http://127.0.0.1:${port}/?fake=1`);
await page.waitForSelector(".tile.is-ready", { timeout: 60000 });
await page.waitForTimeout(1200);
await page.evaluate((name) => [...document.querySelectorAll(".tile")].find((x) => x._item && x._item.name === name).click(), pick);
await page.waitForFunction(() => document.getElementById("photo-canvas").style.opacity === "1", null, { timeout: 60000 });
await page.waitForTimeout(500);
await tab("ライト"); // 写ルンですでは出さないタブを開いておく
await tab("ルック");
log.push(["オンにする前のタブ", await tabs()]);
await shot("01_ルック_オンにする前");
await filmToggle();
await page.waitForTimeout(1500);
log.push(["オンにしたあとのタブ", await tabs()]);
await shot("02_ルック_写ルンです");
await tab("よく使う");
await shot("03_よく使う_写ルンです");
await tab("切り抜き");
await shot("04_切り抜き_写ルンです");
await tab("ルック");
// 一覧に戻り、小さな画が写ルンですで描かれているか
await page.evaluate(() => window.__sunglassesBack && window.__sunglassesBack());
await page.waitForTimeout(2500);
await shot("05_一覧");
// 開き直して、写ルンですのままか。オフにすると Cinema に戻るか
await page.evaluate((name) => [...document.querySelectorAll(".tile")].find((x) => x._item && x._item.name === name).click(), pick);
await page.waitForFunction(() => document.getElementById("photo-canvas").style.opacity === "1", null, { timeout: 60000 });
await page.waitForTimeout(800);
log.push(["開き直したあとのタブ", await tabs()]);
await shot("06_開き直し");
await tab("ルック");
await filmToggle();
await page.waitForTimeout(1500);
log.push(["オフにしたあとのタブ", await tabs()]);
await shot("07_オフにしたあと");
log.push(["エラー", errors]);
fs.writeFileSync(path.join(outDir, "log.json"), JSON.stringify(log, null, 1));
console.log(JSON.stringify(log));
await browser.close();
