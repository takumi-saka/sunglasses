// つまみの一覧と並び（2026-11-05）。0 が「核のまま」。
// 名前は Lightroom と同じ呼び方。粒・にじみ・白み・やわらかさは「核の量の何％増やすか」。
const pct = (v) => (v > 0 ? "+" : "") + Math.round(v) + "%";
const num = (v) => (v > 0 ? "+" : "") + Math.round(v);

export const KNOBS = {
  exposure: { label: "露光量", min: -3, max: 3, step: 0.01, fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(2) },
  contrast: { label: "コントラスト" },
  highlights: { label: "ハイライト" },
  shadows: { label: "シャドウ" },
  whites: { label: "白レベル" },
  blacks: { label: "黒レベル" },
  temp: { label: "色温度", track: "temp" },
  tint: { label: "色かぶり補正", track: "tint" },
  vibrance: { label: "自然な彩度" },
  saturation: { label: "彩度" },
  texture: { label: "テクスチャ" },
  clarity: { label: "明瞭度" },
  dehaze: { label: "かすみの除去" },
  vignette: { label: "周辺光量補正" },
  grain: { label: "粒子", min: -100, max: 200, fmt: pct },
  grainSize: { label: "粒子のサイズ", min: -50, max: 50 },
  halation: { label: "ハレーション", min: -100, max: 200, fmt: pct },
  bloom: { label: "白み", min: -100, max: 200, fmt: pct },
  soften: { label: "やわらかさ", min: -100, max: 200, fmt: pct },
  sharpen: { label: "シャープ", min: 0, max: 150 },
  noise: { label: "ノイズ軽減", min: 0, max: 100 },
  colorNoise: { label: "カラーノイズ軽減", min: 0, max: 100 },
  sunLevel: { label: "Sun Level", min: 0, max: 100, def: 100, fmt: (v) => String(Math.round(v)) },
};
for (const k of Object.values(KNOBS)) {
  k.min ??= -100;
  k.max ??= 100;
  k.step ??= 1;
  k.def ??= 0;
  k.fmt ??= num;
}

// 下の板の並び。「よく使う」は 本人がよく動かすもの（露光量・白み・色温度・彩度・粒）
export const GROUPS = [
  { id: "core", name: "ルック" },
  { id: "basic", name: "よく使う", knobs: ["exposure", "bloom", "temp", "saturation", "grain"] },
  { id: "light", name: "ライト", knobs: ["exposure", "contrast", "highlights", "shadows", "whites", "blacks"], curve: true },
  { id: "color", name: "カラー", knobs: ["temp", "tint", "vibrance", "saturation"], bw: true },
  { id: "mix", name: "カラーミックス" },
  { id: "grade", name: "グレーディング" },
  { id: "effect", name: "効果", knobs: ["texture", "clarity", "dehaze", "vignette", "grain", "grainSize", "halation", "bloom", "soften"] },
  { id: "detail", name: "ディテール", knobs: ["sharpen", "noise", "colorNoise"] },
  { id: "crop", name: "切り抜き" },
];

export const HSL_NAMES = ["レッド", "オレンジ", "イエロー", "グリーン", "アクア", "ブルー", "パープル", "マゼンタ"];
export const HSL_COLORS = ["#d8584e", "#e08a3c", "#e3c84a", "#5fae5a", "#4fb7b3", "#4f7fd6", "#8a62cf", "#cf5fa8"];
export const GRADE_ZONES = [["shadows", "シャドウ"], ["midtones", "中間"], ["highlights", "ハイライト"], ["global", "全体"]];
export const ASPECTS = [["元の比", 0], ["1:1", 1], ["4:5", 4 / 5], ["3:2", 3 / 2], ["16:9", 16 / 9], ["1.85:1", 1.85]];

// 値が初期値から動いているか（印を付ける）
export function changed(p, key) {
  const k = KNOBS[key];
  return k && Math.abs((p[key] ?? k.def) - k.def) > 1e-9;
}
