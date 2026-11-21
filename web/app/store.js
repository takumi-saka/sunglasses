// 写真ごとの直しの記録（IndexedDB）。元の RAW は書き換えず、つまみの値だけを持つ（2026-11-05）
const DB = "sunglasses", STORE = "edits";
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode), s = t.objectStore(STORE), req = fn(s);
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}

export const getEdit = (key) => tx("readonly", (s) => s.get(key)).catch(() => undefined);
export const setEdit = (key, value) => tx("readwrite", (s) => s.put({ ...value, updatedAt: Date.now() }, key)).catch(() => undefined);
export const deleteEdit = (key) => tx("readwrite", (s) => s.delete(key)).catch(() => undefined);
// 前の名札（更新時刻が秒）で覚えた直しを、いまの名札（ミリ秒）に付け替える。いまの名札の直しがあれば、そちらを残す（2026-11-21）
export async function migrateKeys() {
  try {
    const keys = await tx("readonly", (s) => s.getAllKeys());
    for (const k of keys) {
      const m = typeof k === "string" && !k.startsWith("opened:") && k.match(/^(.+:\d+):(\d{1,10})$/);
      if (!m || !(+m[2] > 0)) continue;
      const to = `${m[1]}:${+m[2] * 1000}`, v = await tx("readonly", (s) => s.get(k));
      await tx("readwrite", (s) => {
        if (!keys.includes(to) && v) s.put(v, to);
        return s.delete(k);
      });
    }
  } catch {
    // 付け替えられなくても、そのまま動く
  }
}
export async function editedKeys() {
  try {
    return new Set(await tx("readonly", (s) => s.getAllKeys()));
  } catch {
    return new Set();
  }
}

// 小さな設定（前回開いていた写真・案内を見たか など）
export function pref(k, v) {
  try {
    if (v === undefined) return JSON.parse(localStorage.getItem("sg:" + k));
    localStorage.setItem("sg:" + k, JSON.stringify(v));
  } catch {
    return undefined;
  }
  return v;
}
