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

const tab = async (id) => {
  await page.evaluate((n) => document.querySelector(`.tab[data-group="${n}"]`).click(), id);
  await page.waitForTimeout(500);
};
// 写真の入れ物の大きさと、下の板が縦にあふれているか
const box = () => page.evaluate(() => {
  const r = document.getElementById("ed-photo").getBoundingClientRect(), pn = document.getElementById("ed-panel");
  return { 写真: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], 板の高さ: pn.clientHeight, 板の中身: pn.scrollHeight };
});
log.push(["写真の入れ物", await box()]);
for (const [id, file] of [["core", "04_ルック"], ["light", "05_ライト"], ["color", "06_カラー"], ["mix", "07_カラーミックス"], ["grade", "08_グレーディング"], ["effect", "09_効果"], ["detail", "10_ディテール"], ["crop", "11_切り抜き"]]) {
  await tab(id);
  if (id === "core") await page.waitForTimeout(1200);
  await shot(file);
  log.push(["板 " + id, await box()]);
  if (id === "core") {
    // 札をたたいて、Cinema の入り切りと、足す Aftersun（Aftersun／Blue／Aqua／Warm）を切り替える
    const state = () => page.evaluate(() => ({
      上の名前: document.getElementById("ed-core-chip").textContent, 札: [...document.querySelectorAll(".ed-lk .ed-lk-n")].map((e) => e.textContent),
      使っている札: [...document.querySelectorAll(".ed-lk.is-on .ed-lk-n")].map((e) => e.textContent), SunLevelの行: [...document.querySelectorAll("#ed-panel .sl-row .sl-val")].map((e) => e.textContent),
    }));
    const pick = async (look) => { await page.locator(`.ed-lk[data-look="${look}"]`).click(); await page.waitForTimeout(900); };
    const looks = { はじめ: await state() };
    await pick("deepblue");
    looks.Blueを足した = await state();
    await shot("04b_ルック_CinemaとBlue");
    await pick("cinema");
    looks.Cinemaを外した = await state();
    await shot("04c_ルック_Blueだけ");
    await pick("deepblue");
    looks.どちらもなし = await state();
    await pick("cinema");
    looks.Cinemaに戻した = await state();
    // 単独のルック（Warm）: 選ぶと Cinema が外れ、Cinema を選ぶと Warm が外れる
    await pick("warm");
    looks.Warmを選んだ = await state();
    await shot("04d_ルック_Warm");
    await pick("cinema");
    looks.WarmからCinema = await state();
    log.push(["ルックの切り替え", looks]);
    // 直しのコピーと貼り付け、すべて戻す
    const word = async (t) => { await page.locator("#ed-panel .ed-word", { hasText: t }).click(); await page.waitForTimeout(700); };
    await pick("aqua");
    await word("コピー");
    await word("すべて初期化");
    const afterReset = (await state()).上の名前;
    await word("ペースト");
    log.push(["コピー → すべて戻す → 貼り付け", { 戻したあと: afterReset, 貼ったあと: (await state()).上の名前 }]);
    await pick("aqua");
    // 写ルンですで現像
    await word("写ルンです");
    await shot("04e_ルック_写ルンです");
    log.push(["写ルンですで現像", { 上の名前: (await state()).上の名前, タブ: await page.evaluate(() => [...document.querySelectorAll(".tab")].map((t) => t.textContent)) }]);
    await tab("basic");
    await shot("04f_写ルンです_よく使う");
    await tab("core");
    await word("Sunglasses");
    log.push(["Sunglasses に戻した", (await state()).上の名前]);
  }
  if (id === "mix") {
    // 色を選び、彩度を動かす
    await page.locator(".ed-dot").nth(3).click();
    await page.waitForTimeout(300);
    await page.locator('.ed-tool[data-key="sat"]').click();
    await page.waitForTimeout(400);
    const r = await page.locator(".ed-rule .sl").boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + 22);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(r.x + r.width / 2 - i * 8, r.y + 22);
    await page.mouse.up();
    await page.waitForTimeout(400);
    log.push(["カラーミックス（グリーンの彩度を下げた）", await page.evaluate(() => ({ 色: document.querySelector(".ed-cap").textContent, 選んだ値: document.querySelector(".ed-tool.is-on span").textContent, 大きな数字: document.querySelector(".ed-big").textContent, ほかの値: [...document.querySelectorAll(".ed-tool:not(.is-on)")].map((t) => t.textContent) }))]);
    await shot("07b_カラーミックス_動かした");
  }
  if (id === "grade") {
    // 色の輪の丸を右上へ動かす
    const w = await page.locator(".ed-wheel").boundingBox();
    await page.mouse.move(w.x + w.width / 2, w.y + w.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(w.x + w.width / 2 + i * 5, w.y + w.height / 2 - i * 3);
    await page.mouse.up();
    await page.waitForTimeout(400);
    log.push(["グレーディング（丸を右上へ）", await page.evaluate(() => ({ 読み: document.querySelector(".ed-read").textContent, 範囲: document.querySelector(".ed-words .is-on").textContent, 印: [...document.querySelectorAll(".ed-words .is-changed")].map((e) => e.textContent) }))]);
    await shot("08b_グレーディング_動かした");
  }
  if (id === "crop") {
    await page.locator("#ed-panel .ed-word", { hasText: "1:1" }).click();
    await page.waitForTimeout(700);
    log.push(["切り抜き 1:1", await box()]);
    await shot("11b_切り抜き_1対1");
    // 縦長（4:5）にした時に、下の部品が収まるか
    await page.locator("#ed-panel .ed-word", { hasText: "4:5" }).click();
    await page.waitForTimeout(700);
    log.push(["切り抜き 4:5（縦長）", await box()]);
    await shot("11c_切り抜き_縦長");
    await tab("light");
    log.push(["縦長でライト", await box()]);
    await shot("11d_縦長でライト");
    await tab("crop");
    await page.locator("#ed-crop-reset").click();
    await page.waitForTimeout(700);
    log.push(["切り抜きをやめた", await box()]);
  }
}

// 値を動かす（よく使う → 露光量を右へ）
await tab("basic");
await page.locator('.ed-tool[data-key="exposure"]').click();
await page.waitForTimeout(400);
const sl = page.locator(".ed-rule .sl");
const sb = await sl.boundingBox();
const y = sb.y + sb.height / 2, x0 = sb.x + sb.width / 2;
const t2 = Date.now();
await page.mouse.move(x0, y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + i * 8, y);
await page.mouse.up();
await page.waitForTimeout(400);
log.push(["露光量を動かした（10 回動かして離すまで）", Date.now() - t2]);
await shot("12_露光量を動かした");
const big = () => page.locator(".ed-big").textContent();
log.push(["露光量の値", await big()]);
// 隣の値（白み）を選び、戻る
await page.locator('.ed-tool[data-key="bloom"]').click();
await page.waitForTimeout(500);
log.push(["隣の値を選んだ", await page.evaluate(() => ({ 選んだ値: document.querySelector(".ed-tool.is-on span").textContent, 大きな数字: document.querySelector(".ed-big").textContent, 露光量の小さい字: document.querySelector('.ed-tool[data-key="exposure"] b').textContent }))]);
await shot("12b_隣の値");
await page.locator('.ed-tool[data-key="exposure"]').click();
await page.waitForTimeout(400);
// 大きな数字を 2 回たたくと初期値に戻る → 1 つ戻すで元の値に
await page.locator(".ed-big").click();
await page.waitForTimeout(80);
await page.locator(".ed-big").click();
await page.waitForTimeout(400);
log.push(["大きな数字を2回たたいた", await big()]);
await page.click("#ed-undo");
await page.waitForTimeout(300);
log.push(["1つ戻したあと", await big()]);
// 使っている書体と、写真の上にある字
log.push(["書体と写真の上", await page.evaluate(() => ({
  書体: [...new Set([...document.querySelectorAll("#editor *")].filter((e) => e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => getComputedStyle(e).fontFamily.split(",")[0]))],
  写真の上の字: [...document.querySelectorAll("#ed-photo *")].filter((e) => !e.hidden && e.textContent.trim()).map((e) => e.textContent),
}))]);

// 写真を押している間は元の画
const ph = await page.locator("#ed-photo").boundingBox();
await page.mouse.move(ph.x + ph.width / 2, ph.y + ph.height / 2);
await page.mouse.down();
await page.waitForTimeout(500);
await shot("13_押している間は元の画");
await page.mouse.up();
await page.waitForTimeout(300);

// 見比べの印を押している間も元の画
{
  const c = await page.locator("#ed-cmp").boundingBox();
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(300);
  log.push(["見比べの印を押している間", await page.evaluate(() => document.getElementById("ed-badge").hidden ? "" : document.getElementById("ed-badge").textContent)]);
  await page.mouse.up();
  await page.waitForTimeout(200);
}

// 1 つ戻す
await page.click("#ed-undo");
await page.waitForTimeout(300);
log.push(["1つ戻したあとの露光量", await big()]);

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

// ルックのタブのいちばん下から、この写真を削除 → 一覧に戻る（前の知らせが消えるのを待つ）
await page.waitForFunction(() => !document.querySelector(".toast.is-on"), null, { timeout: 8000 }).catch(() => {});
await tab("core");
await page.evaluate(() => (document.getElementById("ed-panel").scrollTop = 9999));
await page.waitForTimeout(400);
await shot("18_ルックの下の行");
const nBefore = await page.evaluate(() => window.__fakeBridge.listRaw().length);
await page.locator("#ed-delete").click();
await page.waitForTimeout(1500);
log.push(["編集から削除", { 一覧に戻った: await page.evaluate(() => !document.getElementById("library").hidden), 枚数: [nBefore, await page.evaluate(() => window.__fakeBridge.listRaw().length)], 知らせ: await page.locator(".toast-text").textContent().catch(() => "") }]);

fs.writeFileSync(path.join(outDir, "記録.json"), JSON.stringify({ log, errors }, null, 1));
console.log(JSON.stringify({ log, errors }, null, 1));
await browser.close();
