import path from "node:path";
const [, , html, outDir, pwPath] = process.argv;
const { chromium } = await import(pwPath);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 3600 } });
await p.goto("file://" + html);
for (const id of ["softcream", "beach", "orbs"]) await p.locator("#" + id).screenshot({ path: path.join(outDir, `illust_${id}.jpg`), type: "jpeg", quality: 96 });
await b.close();
