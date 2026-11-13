// 画面の部品（2026-11-05）: 小さな DOM の作り方、つまみ、知らせ、下から出る板
import { haptic } from "./bridge.js";
import { water } from "./water.js";

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

  // つまむ所は水滴。動かすと、水が遅れてゆれる
  const drop = water(thumb, { lens: true, press: false });
  let lastT = null;
  function render() {
    const t = (v - min) / span;
    if (lastT !== null && t !== lastT) drop.slosh((t - lastT) * 260);
    lastT = t;
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

// ---------- 輪のつまみ（撮る画面、2026-11-06）----------
// レンズの鏡筒の輪を回すように、刻んだ目盛りの帯が左右に動き、真ん中の琥珀色の印は動かない。
// 値は stops（[{ v, label, mark: "major" | "minor" | null, gap }]）の中から選ぶ。gap は次の目盛りまでの幅（ピクセル）。
// 指を動かした分だけ回る（置いた所へ飛ばない）。tick(i) が真の目盛りを越えたときだけ手応え。snaps の所で軽く止まる。
// 2 回たたくと onReset。set() は、自動の値を指すときのように、目盛りの途中（小数）も指せる。
export function ring({ label, stops, index = 0, px = 16, fmt, extra = null, onInput, onReset = null, tick = () => false, snaps = [] }) {
  let cur = index, dragging = false, startX = 0, startPos = 0, moved = false, lastTap = 0, readonly = false, inSnap = false;
  const xs = [0];
  for (let i = 1; i < stops.length; i++) xs.push(xs[i - 1] + (stops[i - 1].gap || px));
  const xAt = (p) => {
    const i = Math.max(0, Math.min(stops.length - 1, Math.floor(p)));
    return i >= stops.length - 1 ? xs[i] : xs[i] + (xs[i + 1] - xs[i]) * (p - i);
  };
  const posAt = (x) => {
    if (x <= 0) return 0;
    for (let i = 0; i < stops.length - 1; i++) if (x < xs[i + 1]) return i + (x - xs[i]) / (xs[i + 1] - xs[i]);
    return stops.length - 1;
  };
  const valEl = h("span", { class: "rg-val" });
  const labelEl = h("span", { class: "rg-label" }, label);
  const strip = h("div", { class: "rg-strip" }, stops.flatMap((s, i) => [
    s.mark ? h("i", { class: "rg-tick" + (s.mark === "major" ? " is-major" : ""), style: { left: xs[i] + "px" } }) : null,
    s.label !== undefined && s.label !== null ? h("span", { class: "rg-lab", style: { left: xs[i] + "px" } }, s.label) : null,
  ]));
  const el = h("div", { class: "rg", role: "slider", "aria-label": label },
    h("div", { class: "rg-head" }, labelEl, extra, valEl), h("div", { class: "rg-scale" }, strip, h("i", { class: "rg-index" })));

  function place(p, animate) {
    strip.style.transition = animate ? "transform .2s cubic-bezier(.2,.8,.2,1)" : "none";
    strip.style.transform = `translateX(${-xAt(p)}px)`;
  }
  function render() {
    valEl.textContent = fmt ? fmt(stops[cur].v, cur) : String(stops[cur].v);
    el.setAttribute("aria-valuetext", valEl.textContent);
  }
  function choose(i) {
    if (i === cur) return;
    const lo = Math.min(cur, i), hi = Math.max(cur, i);
    let t = false;
    for (let k = lo; k <= hi; k++) if (k !== cur && tick(k)) t = true;
    cur = i;
    if (t) haptic("tick");
    render();
    if (onInput) onInput(stops[i].v, i);
  }
  el.addEventListener("pointerdown", (e) => {
    if (readonly || (extra && extra.contains(e.target))) return;
    const now = performance.now();
    if (now - lastTap < 320) {
      lastTap = 0;
      if (onReset) onReset();
      return;
    }
    lastTap = now;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startPos = cur;
    inSnap = snaps.includes(cur);
    el.setPointerCapture(e.pointerId);
    el.classList.add("is-active");
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 3) moved = true;
    if (!moved) return;
    let p = posAt(xAt(startPos) - dx);
    const s = snaps.find((k) => Math.abs(xAt(p) - xAt(k)) < 9);
    if (s !== undefined) {
      if (!inSnap) haptic("detent");
      inSnap = true;
      p = s;
    } else inSnap = false;
    place(p, false);
    choose(Math.round(p));
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("is-active");
    place(cur, true);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  place(cur, false);
  render();
  return {
    el,
    // 自動の値を指す（指で回しているときは動かさない）。p は小数でもよい
    set(p, animate = true) {
      if (dragging) return;
      cur = Math.max(0, Math.min(stops.length - 1, Math.round(p)));
      place(Math.max(0, Math.min(stops.length - 1, p)), animate);
      render();
    },
    get: () => cur,
    setText: (t) => (valEl.textContent = t),
    setLabel: (t) => (labelEl.textContent = t),
    setReadonly(on) {
      readonly = on;
      el.classList.toggle("is-readonly", on);
    },
    isDragging: () => dragging,
  };
}

// ---------- 知らせ ----------
let toastEl = null, toastTimer = 0, toastWater = null;
export function toast(text, actions = [], ms = 4000) {
  if (!toastEl) {
    toastEl = h("div", { class: "toast" });
    document.body.append(toastEl);
    toastWater = water(toastEl, { kind: "solid", radius: 24, press: false });
  }
  toastEl.replaceChildren(h("span", { class: "toast-text" }, text), ...actions.map(([t, fn]) => h("button", { class: "toast-btn", onClick: fn }, t)));
  if (toastWater.blob) toastEl.prepend(toastWater.blob.el); // 中身を入れ替えると水が外れるので、戻す
  toastEl.classList.add("is-on");
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), ms);
}

// ---------- 下から出る板 ----------
let openSheet = null;
export function sheet(title, body, { onClose } = {}) {
  closeSheet();
  const back = h("div", { class: "sheet-back", onClick: () => closeSheet() });
  const el = h("div", { class: "sheet", role: "dialog" }, h("div", { class: "sheet-in" }, h("div", { class: "sheet-grip" }), h("div", { class: "sheet-title" }, title), body));
  document.body.append(back, el);
  // 板は透けない濃い水（透かすと、後ろの字と重なって読めない）
  water(el, { kind: "solid", radius: 28, press: false });
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
  }, 340);
  if (onClose) onClose();
  return true;
}
