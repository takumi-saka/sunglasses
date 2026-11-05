// スマホの機能の窓口（APK の SunglassesBridge）へのつなぎ（2026-11-05）。
// ブラウザで開いたとき（確かめ用）は、できる範囲の代わりの動きをする。窓口は使うときに探す（確かめ用の代わりを後から差し込めるように）
const real = () => window.SunglassesBridge || null;
const fake = () => window.__fakeBridge || null;
export const REQUIRED_BRIDGE = 1; // このページが必要とする窓口の版
export const APK_URL = "https://github.com/takumi-saka/sunglasses/releases/download/app-latest/sunglasses.apk";

export const inApp = () => !!real();
export const bridgeVersion = () => (real() ? real().version() : 0);
export const appInfo = () => (real() ? JSON.parse(real().appInfo()) : { bridge: 0, model: "ブラウザ" });

const base = () => new URL(".", document.baseURI).href;

export function permission() {
  if (fake()) return "full";
  return real() ? real().mediaPermission() : "none";
}
export function requestPermission() {
  if (real()) real().requestMediaPermission();
}
export function openAppSettings() {
  if (real()) real().openAppSettings();
}

// RAW の一覧（新しい順）。項目: { id, volume, name, dateTaken, dateModified, size, width, height, folder }
export function listRaw() {
  if (fake()) return fake().listRaw();
  return real() ? JSON.parse(real().listRaw()) : [];
}
export function keyOf(item) {
  return item.token ? `opened:${item.name}:${item.size}` : `${item.volume}:${item.id}:${item.dateModified}`;
}
export function mediaUrl(item) {
  if (item.url) return item.url; // ブラウザで選んだファイル（確かめ用）
  if (fake()) return fake().mediaUrl(item);
  if (item.token) return `${base()}__local/opened/${item.token}`;
  return `${base()}__local/media/${encodeURIComponent(item.volume)}/${item.id}`;
}
export function thumbUrl(item, size = 384) {
  if (fake()) return fake().thumbUrl(item);
  return `${base()}__local/thumb/${encodeURIComponent(item.volume)}/${item.id}?s=${size}`;
}

export function pickFiles() {
  if (real()) real().pickFiles();
}
// ほかのアプリから渡された・選んだファイル（{ token, name, mime, size }）
export function takeOpened() {
  return real() ? JSON.parse(real().takeOpened()) : [];
}

// 書き出した JPEG を保存する。item は元の写真（撮影日時と撮影の情報を写すため）
export async function saveJpeg(blob, { name, folder, item, copyLocation = false, note = "" }) {
  const B = real();
  if (!B) {
    if (fake() && fake().save) return fake().save(blob, name);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return { ok: true, uri: null };
  }
  const token = B.saveBegin();
  const CHUNK = 1 << 20;
  for (let i = 0; i < blob.size; i += CHUNK) {
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob.slice(i, i + CHUNK));
    });
    if (!B.saveAppend(token, b64)) {
      B.saveCancel(token);
      return { ok: false, error: "書き出しのデータを渡せませんでした" };
    }
  }
  const source = item.token
    ? { kind: "opened", token: item.token, copyLocation }
    : { kind: "media", volume: item.volume, id: item.id, dateTaken: item.dateTaken, copyLocation };
  return JSON.parse(B.saveFinish(token, name, folder, JSON.stringify(source), note));
}

export function share(uri) {
  if (real() && uri) real().share(uri);
}
export function view(uri) {
  if (real() && uri) real().view(uri);
}
export function haptic(kind) {
  if (real()) real().haptic(kind);
  else if (navigator.vibrate) navigator.vibrate(kind === "detent" ? 8 : 4);
}
export function keepScreenOn(on) {
  if (real()) real().keepScreenOn(on);
}
export function openUrl(url) {
  if (real()) real().openUrl(url);
  else window.open(url, "_blank");
}
