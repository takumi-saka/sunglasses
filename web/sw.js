// 電波がなくても動くように、ページの部品を端末に覚えておく係（サービスワーカー、2026-11-05）。
// 版の番号とファイルの一覧は、GitHub でページを出すときに書き込まれる（.github/workflows/pages.yml）。
// 新しい版が出たら、次に開いたときに部品を入れ替える。スマホのファイル（__local/）は扱わない。
const VERSION = "__VERSION__";
const FILES = __FILES__;
const CACHE = "sg-app-" + VERSION;

self.addEventListener("install", (e) => {
  // 部品は手元の写し（HTTP のキャッシュ）を使わず、必ずサーバーから取り直す。
  // GitHub のページは 10 分の写しを許すので、写しを使うと、新しい版の係が古いページを覚え直してしまう
  // （2026-11-06 に本人の「更新されない」を Chromium で再現して直した。Workbox などと同じ形）
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("sg-app-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.includes("/__local/")) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok && u.pathname.startsWith(new URL("./", self.registration.scope).pathname)) c.put(e.request, res.clone());
      return res;
    }),
  );
});
