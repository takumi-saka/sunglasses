// 確かめ用の小さな配信（この Mac の中だけ）。/ は web/、/dev/ は dev/、/data/ は写真のフォルダ。
// 使い方: node dev/serve.mjs <番号> <web のフォルダ> <dev のフォルダ> <写真のフォルダ>
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [, , port, webRoot, devRoot, dataRoot] = process.argv;
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".wasm": "application/wasm", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
};
http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let root = webRoot, p = u;
  if (u.startsWith("/dev/")) [root, p] = [devRoot, u.slice(4)];
  else if (u.startsWith("/data/")) [root, p] = [dataRoot, u.slice(5)];
  let f = path.join(root, path.normalize(p));
  if (!f.startsWith(path.resolve(root))) {
    res.writeHead(403);
    return res.end();
  }
  if (f.endsWith(path.sep)) f += "index.html";
  fs.readFile(f, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": types[path.extname(f).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
}).listen(+port, "127.0.0.1", () => console.log("ready", port));
