// 画面の部品（2026-11-05）: 小さな DOM の作り方、つまみ、知らせ、下から出る板
import { haptic } from "./bridge.js";

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [sk, sv] of Object.entries(v)) sk.startsWith("--") ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

// ---------- つまみ ----------
// 指を動かした分だけ値が変わる（置いた所へ飛ばない）。指を下へずらすと 4 分の 1 の速さ（細かく合わせる）。
// 初期値の近くで手応えとともに止まる。2 回たたくと初期値に戻る。
export function slider({ label, min, max, step = 1, value, def = 0, fmt, track = "", onInput, onCommit, onReset = null, snaps = [], extra = null }) {
  let v = value, dragging = false, startX = 0, startY = 0, startV = 0, fine = false, moved = false, lastTap = 0, inSnap = false;
  const valEl = h("span", { class: "sl-val" });
  const dot = h("span", { class: "sl-dot" });
  const fill = h("div", { class: "sl-fill" });
  const thumb = h("div", { class: "sl-thumb" });
  const ticks = h("div", { class: "sl-ticks" });
  const trackEl = h("div", { class: `sl-track ${track ? "sl-track-" + track : ""}` }, ticks, fill, h("div", { class: "sl-zero" }), thumb);
  const hint = h("span", { class: "sl-hint" }, "細かく");
  const el = h("div", { class: "sl" }, h("div", { class: "sl-head" }, dot, h("span", { class: "sl-label" }, label), extra, hint, valEl), trackEl);
  const stops = [def, ...snaps];
  const span = max - min, zeroAt = (def - min) / span;
  trackEl.style.setProperty("--zero", zeroAt * 100 + "%");

  function render() {
    const t = (v - min) / span;
    thumb.style.left = t * 100 + "%";
    fill.style.left = Math.min(t, zeroAt) * 100 + "%";
    fill.style.width = Math.abs(t - zeroAt) * 100 + "%";
    valEl.textContent = fmt ? fmt(v) : String(v);
    el.classList.toggle("is-changed", Math.abs(v - def) > 1e-9);
  }
  function setValue(nv, emit) {
    nv = Math.min(max, Math.max(min, Math.round(nv / step) * step));
    if (nv === v) return;
    v = nv;
    render();
    if (emit && onInput) onInput(v);
  }
  el.addEventListener("pointerdown", (e) => {
    // 見出しの横に置いたボタン（撮る画面の「自動」など）は、つまみの操作にしない（指をつかむと、ボタンが押せなくなる）
    if (extra && extra.contains(e.target)) return;
    const now = performance.now();
    if (now - lastTap < 320) {
      // 2 回たたいた: 初期値に戻す（onReset があれば、そちらに任せる）
      lastTap = 0;
      if (onReset) {
        onReset();
        return;
      }
      if (v !== def) {
        setValue(def, true);
        haptic("detent");
        if (onCommit) onCommit(v);
      }
      return;
    }
    lastTap = now;
    dragging = true;
    moved = false;
    fine = false;
    startX = e.clientX;
    startY = e.clientY;
    startV = v;
    inSnap = stops.some((s) => Math.abs(v - s) < 1e-9);
    el.setPointerCapture(e.pointerId);
    el.classList.add("is-active");
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const w = trackEl.getBoundingClientRect().width || 1;
    const nowFine = Math.abs(e.clientY - startY) > 44;
    if (nowFine !== fine) {
      // 速さが変わる所で、いまの値から数え直す（値が跳ねないように）
      fine = nowFine;
      startX = e.clientX;
      startV = v;
      el.classList.toggle("is-fine", fine);
    }
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 3) moved = true;
    if (!moved) return;
    let nv = startV + (dx / w) * span * (fine ? 0.25 : 1);
    const snap = span * 0.012;
    const to = stops.find((s) => Math.abs(nv - s) < snap);
    const near = to !== undefined;
    if (near && !inSnap) haptic("detent");
    inSnap = near;
    if (near) nv = to;
    setValue(nv, true);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("is-active", "is-fine");
    if (moved && onCommit) onCommit(v);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  render();
  return { el, set: (nv) => ((v = nv), render()), get: () => v };
}

// ---------- 知らせ ----------
let toastEl = null, toastTimer = 0;
export function toast(text, actions = [], ms = 4000) {
  if (!toastEl) {
    toastEl = h("div", { class: "toast" });
    document.body.append(toastEl);
  }
  toastEl.replaceChildren(h("span", { class: "toast-text" }, text), ...actions.map(([t, fn]) => h("button", { class: "toast-btn", onClick: fn }, t)));
  toastEl.classList.add("is-on");
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), ms);
}

// ---------- 下から出る板 ----------
let openSheet = null;
export function sheet(title, body, { onClose } = {}) {
  closeSheet();
  const back = h("div", { class: "sheet-back", onClick: () => closeSheet() });
  const el = h("div", { class: "sheet", role: "dialog" }, h("div", { class: "sheet-grip" }), h("div", { class: "sheet-title" }, title), body);
  document.body.append(back, el);
  requestAnimationFrame(() => {
    back.classList.add("is-on");
    el.classList.add("is-on");
  });
  openSheet = { back, el, onClose };
  return el;
}
export function closeSheet() {
  if (!openSheet) return false;
  const { back, el, onClose } = openSheet;
  openSheet = null;
  back.classList.remove("is-on");
  el.classList.remove("is-on");
  setTimeout(() => {
    back.remove();
    el.remove();
  }, 220);
  if (onClose) onClose();
  return true;
}
