// 確かめ用の代わりの窓口（この Mac のブラウザで、スマホのアプリの代わりをする。2026-11-05）
// ?fake=1 を付けて開いたときだけ読まれる。写真は dev/serve.mjs の /data/、一覧と小さな画は /dev/_data/（公開しない）
const list = await (await fetch("/dev/_data/list.json")).json();
window.__fakeBridge = {
  listRaw: () => list,
  deleteMedia: (items) => {
    const ids = new Set(items.map((x) => x.volume + ":" + x.id));
    const before = list.length;
    for (let i = list.length - 1; i >= 0; i--) if (ids.has(list[i].volume + ":" + list[i].id)) list.splice(i, 1);
    setTimeout(() => window.dispatchEvent(new CustomEvent("sunglasses:deleted", { detail: { ok: true, count: before - list.length } })), 200);
  },
  mediaUrl: (it) => "/data/" + encodeURIComponent(it.name),
  thumbUrl: (it) => "/dev/_data/thumbs/" + encodeURIComponent(it.name.replace(/\.dng$/i, ".jpg")),
  save: async (blob, name) => {
    window.__saved = { name, size: blob.size, at: performance.now() };
    return { ok: true, uri: null };
  },
};
