// 確かめ用: 全部の画面・全部の板を開いて、見た目の崩れ（字の切れ・はみ出し・重なり・小さすぎる押す所・上に被さって押せない所）を機械で拾い、
// 指の操作（2本指の拡大・2回たたき・長押し）が効くかを見る（2026-11-26）
// 使い方: node dev/audit.mjs <配信の番号> <書き出し先> <playwright の index.mjs> [幅 412] [高さ 915]
import fs from "node:fs";
import path from "node:path";

const [, , port, outDir, pwPath, vw = "412", vh = "915"] = process.argv;
const { chromium } = await import(pwPath);
fs.mkdirSync(outDir, { recursive: true });
const tag = `${vw}x${vh}`;
const found = [], notes = {}, errors = [];

// 画面の中で動かす点検。いま見えている画面（と、出ている板・知らせ）を調べて、気になる所を返す
const AUDIT = () => {
  const W = innerWidth, H = innerHeight, out = [];
  const sheetOn = document.querySelector(".sheet-back.is-on");
  const roots = sheetOn ? [...document.querySelectorAll(".sheet, .sheet-back")] : [...document.querySelectorAll(".screen:not([hidden]), .toast.is-on")];
  const seen = (e) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const name = (e) => (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "") || e.tagName.toLowerCase();
  const ownText = (e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
  // 流れる入れ物の中にあって、入れ物の見える範囲の外にある物は、見えていない（調べない）
  const clipBox = (e) => {
    let box = { l: 0, t: 0, r: W, b: H };
    for (let p = e.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) {
        const r = p.getBoundingClientRect();
        box = { l: Math.max(box.l, r.left), t: Math.max(box.t, r.top), r: Math.min(box.r, r.right), b: Math.min(box.b, r.bottom) };
      }
    }
    return box;
  };
  const scrolls = (e, axis) => {
    for (let p = e.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p), o = axis === "x" ? s.overflowX : s.overflowY;
      if (/(auto|scroll)/.test(o) && (axis === "x" ? p.scrollWidth > p.clientWidth + 1 : p.scrollHeight > p.clientHeight + 1)) return true;
    }
    return false;
  };
  const texts = [];
  for (const root of roots) {
    for (const e of [root, ...root.querySelectorAll("*")]) {
      if (!seen(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const t = ownText(e), s = getComputedStyle(e), who = name(e), box = clipBox(e);
      const inView = r.right > box.l + 2 && r.left < box.r - 2 && r.bottom > box.t + 2 && r.top < box.b - 2;
      if (t && inView) {
        texts.push({ e, r, t, who });
        // 画面の外・入れ物の外にはみ出している字（横に流れる列の中は除く）
        if ((r.left < box.l - 1 || r.right > box.r + 1) && !scrolls(e, "x")) out.push(["字が横にはみ出し", who, t.slice(0, 24), `左${Math.round(r.left)} 右${Math.round(r.right)}（見える範囲 ${Math.round(box.l)}〜${Math.round(box.r)}）`]);
        if (r.bottom > box.b + 1 && !scrolls(e, "y")) out.push(["字が下にはみ出し", who, t.slice(0, 24), `下${Math.round(r.bottom)}（見える範囲の下 ${Math.round(box.b)}）`]);
        if (e.scrollWidth > e.clientWidth + 1 && /(hidden|clip)/.test(s.overflowX)) out.push(["字が切れている", who, t.slice(0, 24), `${e.scrollWidth} > ${e.clientWidth}`]);
        const rg = document.createRange(), tn = [...e.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
        rg.selectNodeContents(tn);
        const lines = new Set([...rg.getClientRects()].filter((q) => q.width > 1).map((q) => Math.round(q.top / 4))).size;
        if (lines >= 2 && t.length <= 16) out.push(["短い言葉が折り返している", who, t, `${lines} 行`]);
        if (parseFloat(s.fontSize) < 10.4) out.push(["字が小さい", who, t.slice(0, 24), s.fontSize]);
        if (!/SG Latin|SG Gothic/.test(s.fontFamily)) out.push(["書体が決めた物でない", who, t.slice(0, 24), s.fontFamily.slice(0, 40)]);
      }
      // 押す所
      if (e.matches("button, input, label.toggle-row, [role=button]") && inView && !e.disabled) {
        const m = Math.min(r.width, r.height);
        if (m < 36) out.push(["押す所が小さい", who, (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 16), `${Math.round(r.width)}×${Math.round(r.height)}`]);
        const cx = Math.min(Math.max(r.left + r.width / 2, box.l + 1), box.r - 1), cy = Math.min(Math.max(r.top + r.height / 2, box.t + 1), box.b - 1);
        const top = document.elementFromPoint(cx, cy);
        if (top && !e.contains(top) && !top.contains(e) && getComputedStyle(e).pointerEvents !== "none") out.push(["別の部品が上に被さっている", who, (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 16), "上にある物: " + name(top)]);
      }
    }
  }
  // 字どうしの重なり（親子は除く）
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const a = texts[i], b = texts[j];
    if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w > 3 && h > 3) out.push(["字が重なっている", a.who + " と " + b.who, a.t.slice(0, 14) + " ／ " + b.t.slice(0, 14), `${Math.round(w)}×${Math.round(h)}`]);
  }
  // 撮る画面: 写真の枠の中に字がないか（本人の決まり）
  const view = document.getElementById("cam-view");
  if (view && seen(view)) {
    const v = view.getBoundingClientRect();
    for (const x of texts) if (x.r.right > v.left + 2 && x.r.left < v.right - 2 && x.r.bottom > v.top + 2 && x.r.top < v.bottom - 2) out.push(["写真の上に字がある", x.who, x.t.slice(0, 24), `上${Math.round(x.r.top)} 下${Math.round(x.r.bottom)}（写真 ${Math.round(v.top)}〜${Math.round(v.bottom)}）`]);
  }
  return out;
};

const launch = async (init) => {
  const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: +vw, height: +vh }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
  if (init) await ctx.addInitScript({ content: init });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && !/404|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  return { browser, page, cdp };
};
let n = 0;
const check = async (page, state, shot = true) => {
  await page.waitForTimeout(350);
  const file = `${tag}_${String(++n).padStart(2, "0")}_${state}.png`;
  if (shot) await page.screenshot({ path: path.join(outDir, file) });
  for (const f of await page.evaluate(AUDIT)) found.push({ 画面: state, 種類: f[0], 部品: f[1], 字: f[2], 数字: f[3], 画: file });
};
// 2本指でつまむ・広げる（中心 x,y、指の間を d0 → d1）
const pinch = async (cdp, x, y, d0, d1) => {
  const pts = (d) => [{ x: x - d / 2, y, id: 0 }, { x: x + d / 2, y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(d0) });
  for (let k = 1; k <= 8; k++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d0 + ((d1 - d0) * k) / 8) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
const tap = async (cdp, x, y, hold = 40) => {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 0 }] });
  await new Promise((r) => setTimeout(r, hold));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};

// ---------- 一覧と編集 ----------
{
  const { browser, page, cdp } = await launch();
  await page.goto(`http://127.0.0.1:${port}/?fake=1`);
  await page.waitForSelector(".tile.is-ready", { timeout: 60000 });
  await page.waitForTimeout(1500);
  await check(page, "一覧");
  await page.locator("#lib-list").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await check(page, "一覧_いちばん下");
  await page.locator("#lib-list").evaluate((el) => el.scrollTo(0, 0));
  await page.click("#lib-sel-start");
  await check(page, "一覧_選ぶ形（0枚）");
  await page.click("#lib-sel-all");
  await check(page, "一覧_すべて選択");
  await page.click("#lib-sel-cancel");
  // 写真を開く
  await page.evaluate(() => [...document.querySelectorAll(".tile")].find((x) => x._item && x._item.name === "IMG_20240718_140721.dng").click());
  await page.waitForFunction(() => document.getElementById("photo-canvas").style.opacity === "1", null, { timeout: 60000 });
  await page.waitForTimeout(600);
  const tabs = await page.evaluate(() => [...document.querySelectorAll(".tab[data-group]")].map((t) => t.dataset.group));
  notes.編集のタブ = tabs;
  for (const id of tabs) {
    await page.evaluate((g) => document.querySelector(`.tab[data-group="${g}"]`).click(), id);
    await check(page, "編集_" + id);
    // 値の名前の列を、全部たたいて回る（名前が長い物・単位のある物の崩れを拾う）
    const tools = await page.locator("#ed-panel .ed-tool").count();
    for (let i = 1; i < tools; i++) {
      await page.locator("#ed-panel .ed-tool").nth(i).evaluate((el) => el.click());
      await check(page, `編集_${id}_値${i + 1}`, i === tools - 1);
    }
    // 板のいちばん下
    const more = await page.locator("#ed-panel").evaluate((el) => { const m = el.scrollHeight > el.clientHeight + 2; el.scrollTo(0, el.scrollHeight); return m; });
    if (more) await check(page, `編集_${id}_板の下`);
    await page.locator("#ed-panel").evaluate((el) => el.scrollTo(0, 0));
  }
  // 指の操作: 2本指で拡大 → 等倍のボタンの字が変わる → 2回たたきで全画面 → 長押しで補正前
  await page.evaluate(() => document.querySelector('.tab[data-group="light"]').click());
  await page.waitForTimeout(300);
  const ph = await page.locator("#ed-photo").boundingBox();
  const cx = ph.x + ph.width / 2, cy = ph.y + ph.height / 2;
  const one = () => page.locator("#ed-one").textContent();
  const g = { 拡大の前: await one() };
  await pinch(cdp, cx, cy, 80, 260);
  await page.waitForTimeout(500);
  g.広げたあと = await one();
  await check(page, "編集_2本指で拡大したあと");
  await pinch(cdp, cx, cy, 260, 60);
  await page.waitForTimeout(500);
  g.つまんだあと = await one();
  await page.click("#ed-one");
  await page.waitForTimeout(400);
  g.ボタンで等倍 = await one();
  await page.click("#ed-one");
  await page.waitForTimeout(400);
  g.ボタンで戻す = await one();
  await tap(cdp, cx, cy);
  await new Promise((r) => setTimeout(r, 120));
  await tap(cdp, cx, cy);
  await page.waitForTimeout(600);
  g["2回たたきで全画面"] = await page.evaluate(() => document.getElementById("editor").classList.contains("is-full"));
  await check(page, "編集_全画面");
  await pinch(cdp, +vw / 2, +vh / 2, 80, 260);
  await page.waitForTimeout(500);
  await check(page, "編集_全画面で拡大");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: +vw / 2, y: +vh / 2, id: 0 }] });
  await page.waitForTimeout(700);
  g.全画面で長押しの間の知らせ = await page.evaluate(() => { const r = document.getElementById("editor"); return getComputedStyle(r, "::after").content + " / " + r.dataset.badge; });
  await page.screenshot({ path: path.join(outDir, `${tag}_全画面で長押し.png`) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(300);
  await tap(cdp, +vw / 2, +vh / 2);
  await new Promise((r) => setTimeout(r, 120));
  await tap(cdp, +vw / 2, +vh / 2);
  await page.waitForTimeout(600);
  g.もう一度で戻る = !(await page.evaluate(() => document.getElementById("editor").classList.contains("is-full")));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy, id: 0 }] });
  await page.waitForTimeout(700);
  g.長押しの間のバッジ = await page.evaluate(() => { const b = document.getElementById("ed-badge"); return b.hidden ? "（出ない）" : b.textContent; });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // 切り抜き: 2本指で枠の中の写り方を変える
  await page.evaluate(() => document.querySelector('.tab[data-group="crop"]').click());
  await page.waitForTimeout(500);
  const crop0 = await page.evaluate(() => JSON.stringify(window.__editor ? window.__editor.params.crop : null));
  const p2 = await page.locator("#ed-photo").boundingBox();
  await pinch(cdp, p2.x + p2.width / 2, p2.y + p2.height / 2, 80, 220);
  await page.waitForTimeout(500);
  g.切り抜きでつまんだ = { 前: crop0, 後: await page.evaluate(() => JSON.stringify(window.__editor ? window.__editor.params.crop : null)) };
  await check(page, "編集_切り抜きを広げたあと");
  notes.編集の指の操作 = g;
  // 書き出しの板
  await page.click("#ed-export");
  await check(page, "編集_書き出しの板");
  await browser.close();
}

// ---------- 撮る ----------
{
  const src = fs.readFileSync(new URL("./camera_ui.mjs", import.meta.url), "utf8");
  const a = src.indexOf("await ctx.addInitScript(") + "await ctx.addInitScript(".length, b = src.indexOf("\n});", a);
  const { browser, page, cdp } = await launch("(" + src.slice(a, b) + "\n})();");
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("#lib-camera");
  await check(page, "一覧_写真なし");
  await page.click("#lib-camera");
  await page.waitForTimeout(2200);
  await check(page, "撮る");
  const keys = await page.evaluate(() => [...document.querySelectorAll(".cam-pro-cell[data-key]")].map((c) => c.dataset.key));
  notes.撮る画面の数字の列 = keys;
  for (const k of keys) {
    await page.locator(`.cam-pro-cell[data-key="${k}"]`).evaluate((el) => el.click());
    await check(page, "撮る_目盛り_" + k);
  }
  await page.click("#cam-core");
  await check(page, "撮る_ルックの一覧");
  const kinds = await page.locator(".cam-kind").count();
  if (kinds > 1) {
    await page.locator(".cam-kind").nth(1).click();
    await check(page, "撮る_写ルンですの一覧");
    await page.click("#cam-looks .cam-done").catch(() => {});
    await check(page, "撮る_写ルンです");
    await page.click("#cam-core");
    await page.waitForTimeout(300);
    await page.locator(".cam-kind").nth(0).click();
    await page.waitForTimeout(600);
  }
  await page.click("#cam-looks .cam-done").catch(() => {});
  await page.click("#cam-gear");
  await check(page, "撮る_設定");
  await page.click("#cam-sets .cam-done").catch(() => {});
  // 2本指で拡大
  const v = await page.locator("#cam-view").boundingBox();
  const before = await page.evaluate(() => window.__calls.length);
  await pinch(cdp, v.x + v.width / 2, v.y + v.height / 2, 80, 240);
  await page.waitForTimeout(600);
  notes.撮る画面でつまんだ時の呼び出し = await page.evaluate((n0) => [...new Set(window.__calls.slice(n0).map((c) => c[0]))], before);
  await check(page, "撮る_2本指で拡大したあと");
  // 写真をたたく（ピントと明るさを合わせる）
  const b2 = await page.evaluate(() => window.__calls.length);
  await tap(cdp, v.x + v.width * 0.3, v.y + v.height * 0.4);
  await page.waitForTimeout(500);
  notes.撮る画面をたたいた時の呼び出し = await page.evaluate((n0) => [...new Set(window.__calls.slice(n0).map((c) => c[0]))], b2);
  await check(page, "撮る_たたいたあと");
  // 長押し（AE/AF ロック）
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: v.x + v.width * 0.6, y: v.y + v.height * 0.5, id: 0 }] });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await check(page, "撮る_長押ししたあと");
  // 横に倒す
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sunglasses:orientation", { detail: { deg: 90 } })));
  await check(page, "撮る_横");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sunglasses:orientation", { detail: { deg: 0 } })));
  // 撮る
  const b3 = await page.evaluate(() => window.__calls.length);
  await page.click("#cam-shutter");
  await page.waitForTimeout(1500);
  notes.シャッターを押した時の呼び出し = await page.evaluate((n0) => [...new Set(window.__calls.slice(n0).map((c) => c[0]))], b3);
  await check(page, "撮る_撮ったあと");
  await browser.close();
}

fs.writeFileSync(path.join(outDir, `点検_${tag}.json`), JSON.stringify({ 大きさ: tag, 見つかった数: found.length, notes, errors, found }, null, 1));
const by = {};
for (const f of found) (by[f.種類] = by[f.種類] || []).push(f);
console.log(tag, "見つかった数", found.length, Object.entries(by).map(([k, v]) => `${k} ${v.length}`).join("／"), "エラー", errors.length);
