import path from "node:path";
const [, , port, outDir, pwPath] = process.argv;
const { chromium } = await import(pwPath);
const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${port}/?fake=1`);
await page.waitForSelector(".tile.is-ready", { timeout: 60000 });
await page.waitForTimeout(1200);
// 縦の写真を探す: 1枚ずつ開いて、写真の入れ物が縦長になる物
const names = await page.evaluate(() => [...document.querySelectorAll(".tile")].map((x) => x._item.name));
let hit = null;
for (const name of names) {
  await page.evaluate((n) => [...document.querySelectorAll(".tile")].find((x) => x._item.name === n).click(), name);
  await page.waitForFunction(() => document.getElementById("photo-canvas").style.opacity === "1", null, { timeout: 60000 });
  await page.waitForTimeout(400);
  const r = await page.locator("#ed-photo").boundingBox();
  if (r.height > r.width + 20) { hit = { name, w: Math.round(r.width), h: Math.round(r.height) }; break; }
  await page.click("#ed-back");
  await page.waitForTimeout(500);
}
console.log("縦の写真", JSON.stringify(hit));
if (hit) {
  for (const g of ["core", "basic", "light", "mix", "grade", "crop"]) {
    await page.evaluate((id) => document.querySelector(`.tab[data-group="${id}"]`).click(), g);
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => { const p = document.getElementById("ed-panel"); return { 板の高さ: p.clientHeight, 板の中身: p.scrollHeight }; });
    console.log(g, JSON.stringify(m));
    await page.screenshot({ path: path.join(outDir, `縦の写真_${g}.png`) });
  }
}
await browser.close();
