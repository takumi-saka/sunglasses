// つまみの一覧と並び（2026-11-05）。0 が「核のまま」。
// 名前は Lightroom と同じ呼び方。粒・にじみ・白み・やわらかさは、0 がルックのまま、−100 で無し、
// 上げる側は 100 ごとに「ルックの量か目安の量の大きいほう」を足す（engine.js の knobAmount。2026-11-13。前は ％ の掛け算だけ）。
// 符号つきの数字（マイナスは、数字と幅のそろう「−」で書く）
export const signed = (v, text) => (v > 0 ? "+" : v < 0 ? "−" : "") + text.replace(/^-/, "");
export const num = (v) => signed(Math.round(v), String(Math.round(v)));

// 編集の画面の短い名前（タブ・つまみ・選ぶ言葉）の言語。"en" は英語、"ja" は日本語。ここ 1 か所で切り替える（2026-11-26）。
// 文になっている説明と知らせは、どちらでも日本語。
export const LANG = "ja"; // 言葉は日本語版の Lightroom に合わせる（2026-11-26 本人）
export const L = (en, ja) => (LANG === "ja" ? ja : en);

export const KNOBS = {
  exposure: { label: L("Exposure", "露光量"), min: -3, max: 3, step: 0.01, fmt: (v) => signed(v, v.toFixed(2)) },
  contrast: { label: L("Contrast", "コントラスト") },
  highlights: { label: L("Highlights", "ハイライト") },
  shadows: { label: L("Shadows", "シャドウ") },
  whites: { label: L("Whites", "白レベル") },
  blacks: { label: L("Blacks", "黒レベル") },
  temp: { label: L("Temp", "色温度"), track: "temp" },
  tint: { label: L("Tint", "色かぶり補正"), track: "tint" },
  vibrance: { label: L("Vibrance", "自然な彩度") },
  saturation: { label: L("Saturation", "彩度") },
  texture: { label: L("Texture", "テクスチャ") },
  clarity: { label: L("Clarity", "明瞭度") },
  dehaze: { label: L("Dehaze", "かすみの除去") },
  vignette: { label: L("Vignette", "周辺光量補正") },
  grain: { label: L("Grain", "粒子"), min: -100, max: 200 },
  grainSize: { label: L("Grain Size", "粒子のサイズ"), min: -50, max: 50 },
  halation: { label: L("Halation", "ハレーション"), min: -100, max: 200 },
  bloom: { label: L("Bloom", "白み"), min: -100, max: 200 },
  soften: { label: L("Soften", "やわらかさ"), min: -100, max: 200 },
  // 2026-11-21 ピクセルアート: ドットの大きさ（0 で無し。大きいほど粗い）と、ゲームの色味（100 が PS1 の画面の実測どおり）
  pixel: { label: L("Pixel Size", "ドットの大きさ"), min: 0, max: 100, fmt: (v) => String(Math.round(v)) },
  gameColor: { label: L("Game Color", "ゲームの色味"), min: 0, max: 200, fmt: (v) => String(Math.round(v)) },
  pixelLine: { label: L("Pixel Grid", "マスの線"), min: 0, max: 200, fmt: (v) => String(Math.round(v)) },
  sharpen: { label: L("Sharpen", "シャープ"), min: 0, max: 150 },
  noise: { label: L("Denoise", "ノイズ軽減"), min: 0, max: 100 },
  colorNoise: { label: L("Color Denoise", "カラーノイズの軽減"), min: 0, max: 100 },
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
  { id: "core", name: L("Look", "ルック") },
  { id: "basic", name: L("Favorites", "よく使う"), knobs: ["exposure", "bloom", "temp", "saturation", "grain", "pixel", "gameColor", "pixelLine"] },
  { id: "light", name: L("Light", "ライト"), knobs: ["exposure", "contrast", "highlights", "shadows", "whites", "blacks"], curve: true },
  { id: "color", name: L("Color", "カラー"), knobs: ["temp", "tint", "vibrance", "saturation"], bw: true },
  { id: "mix", name: L("Mix", "カラーミキサー") },
  { id: "grade", name: L("Grade", "カラーグレーディング") },
  { id: "effect", name: L("Effects", "効果"), knobs: ["texture", "clarity", "dehaze", "vignette", "grain", "grainSize", "halation", "bloom", "soften", "pixel", "gameColor", "pixelLine"] },
  { id: "detail", name: L("Detail", "ディテール"), knobs: ["sharpen", "noise", "colorNoise"] },
  { id: "crop", name: L("Crop", "切り抜き") },
];

export const HSL_NAMES = LANG === "ja" ? ["レッド", "オレンジ", "イエロー", "グリーン", "アクア", "ブルー", "パープル", "マゼンタ"] : ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"];
export const HSL_COLORS = ["#d8584e", "#e08a3c", "#e3c84a", "#5fae5a", "#4fb7b3", "#4f7fd6", "#8a62cf", "#cf5fa8"];
export const GRADE_ZONES = [["shadows", L("Shadows", "シャドウ")], ["midtones", L("Midtones", "中間調")], ["highlights", L("Highlights", "ハイライト")], ["global", L("Global", "全体")]];
export const ASPECTS = [[L("Original", "元画像"), 0], ["1:1", 1], ["4:5", 4 / 5], ["3:2", 3 / 2], ["16:9", 16 / 9], ["1.85:1", 1.85]];

// 値が初期値から動いているか（印を付ける）
export function changed(p, key) {
  const k = KNOBS[key];
  return k && Math.abs((p[key] ?? k.def) - k.def) > 1e-9;
}
