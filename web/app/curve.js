// トーンカーブの編集（2026-11-05）。点をたたいて足し、動かし、枠の外へ出すと消える。2 回たたくとまっすぐに戻る。
// 曲線の値は 0〜255 の点の並び（端の 0 と 255 は自動で入る。パソコンの道具の make_curve と同じ）
import { pchip } from "../engine/color.js";
import { haptic } from "./bridge.js";
import { L } from "./knobs.js";
import { h } from "./ui.js";

const CH = [["rgb", "RGB", "#fff"], ["r", L("Red", "レッド"), "#e58a80"], ["g", L("Green", "グリーン"), "#8fd08d"], ["b", L("Blue", "ブルー"), "#8fb0ea"]];

export function curveEditor(getCurve, onChange, onCommit) {
  let ch = "rgb", drag = -1, lastTap = 0;
  const cv = h("canvas", { class: "curve-cv" });
  const tabs = h("div", { class: "ed-words" });
  const el = h("div", { class: "curve" }, tabs, cv);

  function pts() {
    return (getCurve()[ch] || []).map((p) => [...p]);
  }
  function draw() {
    const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.width * dpr * 0.62);
    const c = cv.getContext("2d"), W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    c.strokeStyle = "rgba(255,255,255,.1)";
    c.lineWidth = dpr;
    for (let i = 1; i < 4; i++) {
      c.beginPath();
      c.moveTo((W * i) / 4, 0);
      c.lineTo((W * i) / 4, H);
      c.moveTo(0, (H * i) / 4);
      c.lineTo(W, (H * i) / 4);
      c.stroke();
    }
    c.strokeStyle = "rgba(255,255,255,.22)";
    c.beginPath();
    c.moveTo(0, H);
    c.lineTo(W, 0);
    c.stroke();
    const color = CH.find((x) => x[0] === ch)[2], curve = pchip(pts(), 256);
    c.strokeStyle = color;
    c.lineWidth = 1.5 * dpr;
    c.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * W, y = H - curve[i] * H;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.stroke();
    c.fillStyle = color;
    for (const [x, y] of pts()) {
      c.beginPath();
      c.arc((x / 255) * W, H - (y / 255) * H, 5 * dpr, 0, Math.PI * 2);
      c.fill();
    }
  }
  function renderTabs() {
    tabs.replaceChildren(...CH.map(([k, name, color]) => h("button", {
      class: "ed-word" + (k === ch ? " is-on" : "") + ((getCurve()[k] || []).length ? " is-changed" : ""),
      style: { "--chip": color }, onClick: () => ((ch = k), renderTabs(), draw()),
    }, name)));
  }
  function toXY(e) {
    const r = cv.getBoundingClientRect();
    return [Math.min(255, Math.max(0, ((e.clientX - r.left) / r.width) * 255)), Math.min(255, Math.max(0, (1 - (e.clientY - r.top) / r.height) * 255))];
  }
  function set(p) {
    const c = { ...getCurve(), [ch]: p.length ? p.sort((a, b) => a[0] - b[0]) : null };
    onChange(c);
    draw();
  }
  cv.addEventListener("pointerdown", (e) => {
    const now = performance.now(), [x, y] = toXY(e), p = pts();
    if (now - lastTap < 320) {
      lastTap = 0;
      set([]);
      haptic("detent");
      onCommit();
      renderTabs();
      return;
    }
    lastTap = now;
    cv.setPointerCapture(e.pointerId);
    drag = p.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 18);
    if (drag < 0) {
      p.push([x, y]);
      drag = p.length - 1;
      set(p);
      drag = pts().findIndex(([px, py]) => px === x && py === y);
    }
  });
  cv.addEventListener("pointermove", (e) => {
    if (drag < 0) return;
    const r = cv.getBoundingClientRect(), p = pts();
    const out = e.clientY < r.top - 30 || e.clientY > r.bottom + 30;
    const [x, y] = toXY(e);
    if (out) {
      p.splice(drag, 1);
      drag = -1;
      set(p);
      return;
    }
    p[drag] = [x, y];
    set(p);
    drag = pts().findIndex(([px, py]) => px === x && py === y);
  });
  const end = () => {
    if (drag === -2) return;
    drag = -1;
    onCommit();
    renderTabs();
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  renderTabs();
  requestAnimationFrame(draw);
  return { el, refresh: () => (renderTabs(), draw()) };
}
