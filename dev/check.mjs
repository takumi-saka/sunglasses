// 確かめ用: ブラウザ（Playwright の Chromium）でページの画の処理を動かし、描いた画を PNG で保存する。
// 使い方: node dev/check.mjs <配信の番号> <写真の URL（/data/…）> <幅> <書き出し先> <playwright の index.mjs>
import fs from "node:fs";
import path from "node:path";

const [, , port, dngUrl, width, outDir, pwPath] = process.argv;
const { chromium } = await import(pwPath);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
page.on("console", (m) => console.log("[ページ]", m.text()));
page.on("pageerror", (e) => console.log("[ページの間違い]", e.message));
await page.goto(`http://127.0.0.1:${port}/dev/check.html`);
await page.waitForFunction(() => window.__ready === true);
const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const d = gl && gl.getExtension("WEBGL_debug_renderer_info");
  return gl ? (d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "webgl2") : "なし";
});
console.log("GPU:", gpu);
// 描き方の一覧。7 番目に JSON のファイルを渡せば、それを使う（つまみの確かめなど）
let modes = [];
if (process.argv[7]) {
  modes = JSON.parse(fs.readFileSync(process.argv[7], "utf-8"));
} else {
  for (const core of ["aftersun", "mine", "weak"]) for (const kind of ["lut", "nograin", "full"]) modes.push({ core, kind });
  modes.push({ core: "aftersun", kind: "neutral" });
}
const out = await page.evaluate(async ([u, w, m]) => await window.__run(u, w, m), [dngUrl, +width, modes]);
for (const r of out.results) {
  const f = path.join(outDir, `${r.core}_${r.kind}${r.tag ? "_" + r.tag : ""}.png`);
  fs.writeFileSync(f, Buffer.from(r.png.split(",")[1], "base64"));
  delete r.png;
}
fs.writeFileSync(path.join(outDir, "結果.json"), JSON.stringify({ gpu, ...out }, null, 1));
console.log(JSON.stringify({ decodeMs: Math.round(out.decodeMs), key: out.key, size: [out.w, out.h], results: out.results.map((r) => [r.core, r.kind, r.ev.toFixed(4), Math.round(r.ms)]) }));
await browser.close();
