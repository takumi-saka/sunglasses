// 画の処理の式（GPU で動く分、2026-11-05）。
// 順番と式は、パソコンの道具（カメラアプリ/_work/scripts/look_lr.py の render・lr_apply）と同じ。
// 画は、どの段でも「1 行目が画の上」の向きで持つ（vUv.y = 0 が上）。画面に出す最後の段だけ上下を返す。

export const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
precision highp usampler2D;
in vec2 vUv;
out vec4 o;
const float PI = 3.14159265358979;
`;

// sRGB ⇄ L*a*b*（D65。パソコンの道具の look_search.rgb2lab / lab2rgb と同じ）
const COLOR = `
const mat3 M_RGB2XYZ = mat3(0.4124564, 0.2126729, 0.0193339, 0.3575761, 0.7151522, 0.1191920, 0.1804375, 0.0721750, 0.9503041);
const mat3 M_XYZ2RGB = mat3(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252);
const vec3 WHITE = vec3(0.95047, 1.0, 1.08883);
float s2l(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float l2s(float c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055; }
vec3 s2l(vec3 c) { return vec3(s2l(c.r), s2l(c.g), s2l(c.b)); }
vec3 l2s(vec3 c) { return vec3(l2s(c.r), l2s(c.g), l2s(c.b)); }
float labF(float t) { return t > 0.008856 ? pow(t, 1.0 / 3.0) : 7.787 * t + 16.0 / 116.0; }
float labFi(float f) { return f > 0.2068966 ? f * f * f : (f - 16.0 / 116.0) / 7.787; }
vec3 rgb2lab(vec3 rgb) {
  vec3 xyz = (M_RGB2XYZ * s2l(rgb)) / WHITE;
  vec3 f = vec3(labF(xyz.x), labF(xyz.y), labF(xyz.z));
  return vec3(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
}
vec3 lab2rgb(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0;
  vec3 xyz = vec3(labFi(fy + lab.y / 500.0), labFi(fy), labFi(fy - lab.z / 200.0)) * WHITE;
  return clamp(l2s(max(M_XYZ2RGB * xyz, 0.0)), 0.0, 1.0);
}
// 0〜1 を等分した点の曲線（np.interp と同じ）。曲線は R32F の横長の画に、1 行に 1 本ずつ入っている
float curveAt(sampler2D t, int row, float x) {
  int n = textureSize(t, 0).x - 1;
  float p = clamp(x, 0.0, 1.0) * float(n);
  int i = min(int(floor(p)), n - 1);
  return mix(texelFetch(t, ivec2(i, row), 0).r, texelFetch(t, ivec2(i + 1, row), 0).r, p - float(i));
}
`;

const fs = (body) => HEAD + COLOR + body;

// RAW の 16 ビットの値 → 光の量（ACES AP0）の浮動小数点の画
export const FS_RAW2F = fs(`
uniform usampler2D uRaw;
void main() {
  uvec3 v = texelFetch(uRaw, ivec2(gl_FragCoord.xy), 0).rgb;
  o = vec4(vec3(v) / 65535.0, 1.0);
}`);

// JPEG の値（sRGB） → 素直な現像の逆で光の量に戻す → ACES AP0
export const FS_JPEG2F = fs(`
uniform sampler2D uJpeg;
uniform sampler2D uToLinear;
uniform mat3 uSrgbToAp0;
void main() {
  vec3 c = texelFetch(uJpeg, ivec2(gl_FragCoord.xy), 0).rgb;
  vec3 lin = vec3(curveAt(uToLinear, 0, c.r), curveAt(uToLinear, 0, c.g), curveAt(uToLinear, 0, c.b));
  o = vec4(max(uSrgbToAp0 * lin, 0.0), 1.0);
}`);

// 現像: 光の量 → 露光量 → 核の対応表（素直な現像と混ぜて強さを変える）→ つまみ（1 点ずつの分）→ L*a*b*
export const FS_DEVELOP = fs(`
uniform sampler2D uSrc;
uniform mat3 uXf;
uniform sampler3D uLutA;
uniform sampler3D uLutB;
uniform vec3 uLoA;
uniform vec3 uHiA;
uniform float uNA;
uniform vec3 uLoB;
uniform vec3 uHiB;
uniform float uNB;
uniform mat3 uAp0ToAp1;
uniform mat3 uAp0ToSrgb;
uniform mat3 uKeepA; // 2026-11-11 光の色を残す行列（核ごと。残さない核と写真は、何もしない行列）
uniform mat3 uKeepB;
uniform sampler2D uNeutralCurve;
uniform float uGainA;
uniform float uGainB;
uniform float uGainN;
uniform float uWA;
uniform float uWB;
uniform float uWN;
uniform int uKnobs;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uTemp;
uniform float uTint;
uniform float uDehaze;
uniform vec4 uParam;
uniform int uCurveOn;
uniform sampler2D uCurves;
uniform float uSat;
uniform float uVib;
uniform int uHslOn;
uniform float uHslH[8];
uniform float uHslS[8];
uniform float uHslL[8];
uniform int uGradeOn;
uniform float uBalance;
uniform vec2 uGradeAB[4];
uniform float uGradeLum[4];
const float CENTERS[9] = float[9](25.0, 55.0, 90.0, 135.0, 190.0, 250.0, 295.0, 340.0, 385.0);

float cct(float v) { return v <= 0.0078125 ? 10.5402377416545 * v + 0.0729055341958355 : (log2(v) + 9.72) / 17.52; }
vec3 lookA(vec3 ap0) {
  vec3 v = max(uAp0ToAp1 * (uKeepA * ap0) * uGainA, 0.0);
  vec3 t = clamp((vec3(cct(v.r), cct(v.g), cct(v.b)) - uLoA) / (uHiA - uLoA), 0.0, 1.0);
  return clamp(texture(uLutA, (t * (uNA - 1.0) + 0.5) / uNA).rgb, 0.0, 1.0);
}
vec3 lookB(vec3 ap0) {
  vec3 v = max(uAp0ToAp1 * (uKeepB * ap0) * uGainB, 0.0);
  vec3 t = clamp((vec3(cct(v.r), cct(v.g), cct(v.b)) - uLoB) / (uHiB - uLoB), 0.0, 1.0);
  return clamp(texture(uLutB, (t * (uNB - 1.0) + 0.5) / uNB).rgb, 0.0, 1.0);
}
float shoulder(float v) { return v <= 0.8 ? v : 0.8 + 0.2 * (1.0 - exp(-(v - 0.8) / 0.2)); }
vec3 neutral(vec3 ap0) {
  vec3 lin = max(uAp0ToSrgb * ap0 * uGainN, 0.0);
  vec3 s = clamp(l2s(vec3(shoulder(lin.r), shoulder(lin.g), shoulder(lin.b))), 0.0, 1.0);
  return vec3(curveAt(uNeutralCurve, 0, s.r), curveAt(uNeutralCurve, 0, s.g), curveAt(uNeutralCurve, 0, s.b));
}
vec3 knobs(vec3 lab) {
  float x = clamp(lab.x / 100.0, 0.0, 1.0);
  float c = clamp(uContrast / 100.0 * 0.5, -0.5, 0.5);
  x = x + c * 4.0 * x * (1.0 - x) * (x - 0.5);
  // 2026-11-15 つまみの効きの見直し: 端まで動かして物足りないことが無いよう、弱かった物を強めた（どれも明るさの順が入れ替わらない上限の内）
  x = x + uHighlights / 100.0 * 0.18 * sin(PI * clamp((x - 0.4) / 0.6, 0.0, 1.0));
  x = x + uShadows / 100.0 * 0.18 * sin(PI * clamp(x / 0.6, 0.0, 1.0));
  float y = 1.0 - x;
  x = clamp(x + (uWhites > 0.0 ? uWhites / 100.0 * 0.45 * x * x : uWhites / 100.0 * 0.35 * x * x) + uBlacks / 100.0 * 0.30 * y * y * y, 0.0, 1.0);
  float k = 0.3 + 0.7 * x;
  vec3 rgb = lab2rgb(vec3(x * 100.0, lab.y + uTint / 100.0 * 18.0 * k, lab.z + uTemp / 100.0 * 18.0 * k));
  float d = uDehaze / 100.0 * 0.18;
  if (d > 0.0) rgb = clamp((rgb - d * 0.8) / (1.0 - d * 0.8 + 1e-6), 0.0, 1.0);
  else if (d < 0.0) rgb = rgb * (1.0 + d) - d * 0.8;
  if (uParam.x != 0.0) rgb += uParam.x * sin(PI * clamp(rgb / 0.4, 0.0, 1.0));
  if (uParam.y != 0.0) rgb += uParam.y * sin(PI * clamp((rgb - 0.1) / 0.5, 0.0, 1.0));
  if (uParam.z != 0.0) rgb += uParam.z * sin(PI * clamp((rgb - 0.4) / 0.5, 0.0, 1.0));
  if (uParam.w != 0.0) rgb += uParam.w * sin(PI * clamp((rgb - 0.5) / 0.5, 0.0, 1.0));
  rgb = clamp(rgb, 0.0, 1.0);
  if (uCurveOn == 1) {
    rgb = vec3(curveAt(uCurves, 0, rgb.r), curveAt(uCurves, 0, rgb.g), curveAt(uCurves, 0, rgb.b));
    rgb = vec3(curveAt(uCurves, 1, rgb.r), curveAt(uCurves, 2, rgb.g), curveAt(uCurves, 3, rgb.b));
  }
  vec3 l2 = rgb2lab(rgb);
  float L = l2.x;
  float C = length(l2.yz);
  float h = degrees(atan(l2.z, l2.y));
  if (h < 0.0) h += 360.0;
  float skin = (h > 20.0 && h < 70.0) ? 0.5 : 1.0;
  C = C * (1.0 + uSat / 100.0) * max(1.0 + uVib / 100.0 * 1.5 * (1.0 - min(C / 50.0, 1.0)) * skin, 0.0);
  if (uHslOn == 1) {
    float hh = h < CENTERS[0] ? h + 360.0 : h;
    float dh = 0.0, ds = 0.0, dl = 0.0;
    for (int i = 0; i < 8; i++) {
      if (hh >= CENTERS[i] && hh < CENTERS[i + 1]) {
        float t = (hh - CENTERS[i]) / (CENTERS[i + 1] - CENTERS[i]);
        int j = (i + 1) % 8;
        dh = (1.0 - t) * uHslH[i] + t * uHslH[j];
        ds = (1.0 - t) * uHslS[i] + t * uHslS[j];
        dl = (1.0 - t) * uHslL[i] + t * uHslL[j];
      }
    }
    h += dh;
    L = clamp(L + dl * min(C / 30.0, 1.0), 0.0, 100.0);
    C = max(C * (1.0 + ds), 0.0);
  }
  float a = C * cos(radians(h)), b = C * sin(radians(h));
  if (uGradeOn == 1) {
    float xb = pow(clamp(L / 100.0, 0.0, 1.0), exp2(-uBalance / 100.0));
    float ms = (1.0 - xb) * (1.0 - xb), mh = xb * xb;
    float m[4] = float[4](ms, 1.0 - ms - mh, mh, 1.0);
    for (int i = 0; i < 4; i++) {
      a += m[i] * uGradeAB[i].x;
      b += m[i] * uGradeAB[i].y;
      L += m[i] * uGradeLum[i];
    }
  }
  return vec3(clamp(L, 0.0, 100.0), a, b);
}
void main() {
  vec3 ap0 = texture(uSrc, (uXf * vec3(vUv, 1.0)).xy).rgb;
  // 2 つの核と素の画を、Sun Level の重みで混ぜる
  vec3 rgb = vec3(0.0);
  if (uWA > 0.0) rgb += uWA * lookA(ap0);
  if (uWB > 0.0) rgb += uWB * lookB(ap0);
  if (uWN != 0.0) rgb += uWN * neutral(ap0); // 核より強くするときはマイナス（素の画から離れる向きに伸ばす）
  vec3 lab = rgb2lab(rgb);
  if (uKnobs == 1) lab = knobs(lab);
  o = vec4(lab, 1.0);
}`);

// ぼかし（ガウス。片側の重みを渡す。方向は横か縦の 1 画素ぶん）
export const FS_BLUR = fs(`
uniform sampler2D uTex;
uniform vec2 uDir;
uniform int uRadius;
uniform float uW[49];
void main() {
  vec4 s = texture(uTex, vUv) * uW[0];
  for (int i = 1; i < 49; i++) {
    if (i > uRadius) break;
    vec2 d = uDir * float(i);
    s += (texture(uTex, vUv + d) + texture(uTex, vUv - d)) * uW[i];
  }
  o = s;
}`);

// 縮めるときと広げるときの写し（直線で混ぜて読む）
export const FS_COPY = fs(`
uniform sampler2D uTex;
uniform mat3 uXf;
void main() { o = texture(uTex, (uXf * vec3(vUv, 1.0)).xy); }`);

// ノイズ軽減（明るさは近い明るさどうしで混ぜ、色は輪郭を越えずに広く混ぜる）
export const FS_NR = fs(`
uniform sampler2D uLab;
uniform vec2 uTexel;
uniform float uStep;
uniform float uLuma;
uniform float uChroma;
void main() {
  vec3 c = texture(uLab, vUv).xyz;
  float sr = max(uLuma, 1e-3);
  float wl = 0.0, sl = 0.0, wc = 0.0;
  vec2 sc = vec2(0.0);
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      vec2 off = vec2(float(x), float(y));
      vec3 n = texture(uLab, vUv + off * uTexel * uStep).xyz;
      float dl = n.x - c.x, r2 = dot(off, off);
      if (abs(x) <= 2 && abs(y) <= 2) {
        float w = exp(-r2 / 4.5 - dl * dl / (2.0 * sr * sr));
        wl += w;
        sl += w * n.x;
      }
      float w2 = exp(-r2 / 18.0 - dl * dl / 200.0);
      wc += w2;
      sc += w2 * n.yz;
    }
  }
  float L = uLuma > 0.0 ? sl / wl : c.x;
  vec2 ab = mix(c.yz, sc / wc, uChroma);
  o = vec4(L, ab, 1.0);
}`);

// テクスチャ（細かい凹凸）: L += t × (L − ぼかした L)
export const FS_TEXTURE = fs(`
uniform sampler2D uLab;
uniform sampler2D uBlur;
uniform float uAmt;
void main() {
  vec4 c = texture(uLab, vUv);
  c.x += uAmt * (c.x - texture(uBlur, vUv).x);
  o = c;
}`);

// 明瞭度（中くらいの凹凸）: L += c × (少しぼかした L − 大きくぼかした L)
export const FS_CLARITY = fs(`
uniform sampler2D uLab;
uniform sampler2D uSmall;
uniform sampler2D uLarge;
uniform float uAmt;
void main() {
  vec4 c = texture(uLab, vUv);
  c.x += uAmt * (texture(uSmall, vUv).x - texture(uLarge, vUv).x);
  o = c;
}`);

// シャープ: 輪郭の所だけ L を強める（平らな所の細かいざらつきは強めない）
export const FS_SHARPEN = fs(`
uniform sampler2D uLab;
uniform sampler2D uBlur;
uniform float uAmt;
uniform float uThreshold;
void main() {
  vec4 c = texture(uLab, vUv);
  float d = c.x - texture(uBlur, vUv).x;
  c.x += uAmt * d * smoothstep(uThreshold, uThreshold * 2.0 + 1e-3, abs(d));
  o = c;
}`);

// 粒のもと: 画の上の位置ごとに決まる、正規分布の白いノイズ（拡大しても同じ所は同じ粒）
export const FS_NOISE = fs(`
uniform vec2 uOrigin;
uniform vec2 uSize;
uniform uint uSeed;
uint hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
void main() {
  ivec2 p = ivec2(floor(uOrigin + vUv * uSize));
  uint h = hash(uint(p.x) * 1973u + hash(uint(p.y) * 9277u + uSeed * 26699u));
  float u1 = (float(h & 0xffffu) + 0.5) / 65536.0;
  float u2 = (float(hash(h) & 0xffffu) + 0.5) / 65536.0;
  o = vec4(sqrt(-2.0 * log(u1)) * cos(2.0 * PI * u2), 0.0, 0.0, 1.0);
}`);

// 周辺光量と粒をかけて、L*a*b* → sRGB に戻す
export const FS_FINISH = fs(`
uniform sampler2D uLab;
uniform sampler2D uNoise;
uniform int uGrainOn;
uniform float uGrainAmp;
uniform float uVignette;
uniform mat3 uToCrop;
// 2026-11-10 明るさごとの粒の量の表（明るさ 0〜1 を 32 等分した 33 点。looks.json の grainCurve から作る）。
// uGrainCurveOn が 0 のときは今までの式 clamp(1.15 − l^1.5, 0.2, 1) のまま
uniform int uGrainCurveOn;
uniform float uGrainCurve[33];
void main() {
  vec3 lab = texture(uLab, vUv).xyz;
  float L = lab.x;
  if (uVignette != 0.0) {
    vec2 c = ((uToCrop * vec3(vUv, 1.0)).xy - 0.5) / 0.5;
    float r2 = c.x * c.x * 0.5 + c.y * c.y * 0.5;
    L = L * (1.0 + uVignette / 100.0 * 0.5 * r2);
  }
  if (uGrainOn == 1) {
    float l = clamp(L, 0.0, 100.0) / 100.0;
    float m = clamp(1.15 - pow(l, 1.5), 0.2, 1.0);
    if (uGrainCurveOn == 1) {
      float x = l * 32.0;
      int i = int(min(floor(x), 31.0));
      m = mix(uGrainCurve[i], uGrainCurve[i + 1], x - float(i));
    }
    L += uGrainAmp * texture(uNoise, vUv).r * m;
  }
  o = vec4(lab2rgb(vec3(clamp(L, 0.0, 100.0), lab.yz)), 1.0);
}`);

// にじみ（赤）のもと: いちばん明るい色が 0.6 を超えた分
export const FS_HAL_SRC = fs(`
uniform sampler2D uRgb;
void main() {
  vec3 c = texture(uRgb, vUv).rgb;
  o = vec4(vec4(max(max(c.r, max(c.g, c.b)) - 0.6, 0.0)).rgb, 1.0);
}`);

// にじみを足し、白みのもと（明るさが 0.55 を超えた分）を作る
export const FS_HAL_ADD = fs(`
uniform sampler2D uRgb;
uniform sampler2D uGlow;
uniform float uAmt;
uniform int uOn;
// 2026-11-10 縁だけのにじみ（looks.json の halationEdge がある核だけ 1）。足す量を「ぼかした光源 − その場の光源」の正の分にする。
// 大きな明るい面の内側では、ぼかした光源がその場の光源とほぼ同じなので、ほとんど足さない（白い空や壁が桃色にならないため）。
// 明るい所の外側（その場の光源が 0）には、今までと同じだけ赤く広がる。0 のときは今までの式のまま
uniform int uEdge;
void main() {
  vec3 c = texture(uRgb, vUv).rgb;
  if (uOn == 1) {
    float g = texture(uGlow, vUv).r;
    if (uEdge == 1) g = max(g - max(max(c.r, max(c.g, c.b)) - 0.6, 0.0), 0.0);
    c += g * uAmt * vec3(1.0, 0.30, 0.10);
  }
  o = vec4(c, 1.0);
}`);
// 2026-11-13 白みのもとを 2 つに分けた: ルックが元から持つ分（uBase。明るさ 0.55 を超えた分）と、つまみで足した分
// （uAdd。明るさ uFrom を超えた分）。白を低く止めるルック（新しい Aftersun）では 0.55 を超える所がほとんど無く、
// つまみを上げても白みが増えなかったので、足した分はもっと低い明るさ（looks.json の knobRef.bloomFrom）からかかるようにした。
// 量はここで掛けておく（仕上げの uBloom は 1）。uFrom が 0.55 のルックは、前と同じ画
export const FS_BLOOM_SRC = fs(`
uniform sampler2D uRgb;
uniform float uBase;
uniform float uAdd;
uniform float uFrom;
void main() {
  float y = dot(texture(uRgb, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
  o = vec4(vec3(uBase * max(y - 0.55, 0.0) + uAdd * max(y - uFrom, 0.0)), 1.0);
}`);

// 仕上げ: 白みを足す → 0〜1 に収める → 白黒 → 白飛び・黒つぶれの印
export const FS_FINAL = fs(`
uniform sampler2D uRgb;
uniform sampler2D uGlow;
uniform int uBloomOn;
uniform float uBloom;
uniform float uWarm;
uniform mat3 uXf;
uniform int uBw;
uniform int uClip;
// 2026-11-21 ピクセルアート（ドットの大きさ）とゲームの色味。
// uCells = 画の全体に並ぶマスの数（横・縦。0 で無し）、uRegion = いま描いている部分が画の全体のどこか（左上 x,y・幅・高さ。0〜1）。
// マスの色は、マスの真ん中の 1/3 だけを拾う（縁をぼかさない、硬い出方）。
// uGame = ゲームの色味（0〜2。1.0 が PS1 の画面 672 枚の実測どおり）。明暗（黒を落とす）と色の濃さ（うすい色ほど大きく濃く）を Oklab で動かす。
// 表の数字のもとは、パソコンの道具 game_color.py の TONE・CHR・CHR_W
uniform vec2 uCells;
uniform vec4 uRegion;
uniform float uGame;
uniform float uLine; // マスの線の強さ（0〜2。1 = お手本と同じ）
const float GT_X[9] = float[9](0.0, 0.10, 0.17, 0.22, 0.41, 0.54, 0.65, 0.89, 1.0);
const float GT_Y[9] = float[9](0.0, 0.0, 0.03, 0.08, 0.29, 0.45, 0.62, 0.86, 1.0);
const float GC_X[9] = float[9](0.0, 0.01, 0.025, 0.05, 0.09, 0.11, 0.15, 0.25, 0.4);
const float GC_Y[9] = float[9](0.0, 0.017, 0.048, 0.09, 0.135, 0.165, 0.21, 0.29, 0.4);
float ip9(float x, float xs[9], float ys[9]) {
  if (x <= xs[0]) return ys[0];
  for (int i = 1; i < 9; i++) if (x <= xs[i]) return mix(ys[i - 1], ys[i], (x - xs[i - 1]) / (xs[i] - xs[i - 1]));
  return ys[8];
}
vec3 okLin(float L, float a, float b) {
  float l = L + 0.3963377774 * a + 0.2158037573 * b, m = L - 0.1055613458 * a - 0.0638541728 * b, s = L - 0.0894841775 * a - 1.2914855480 * b;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
bool okIn(vec3 r) { return all(greaterThanEqual(r, vec3(-1e-4))) && all(lessThanEqual(r, vec3(1.0001))); }
vec3 gameColor(vec3 c, float s) {
  vec3 q = s2l(c);
  float l = pow(0.4122214708 * q.r + 0.5363325363 * q.g + 0.0514459929 * q.b, 1.0 / 3.0);
  float m = pow(0.2119034982 * q.r + 0.6806995451 * q.g + 0.1073969566 * q.b, 1.0 / 3.0);
  float t = pow(0.0883024619 * q.r + 0.2817188376 * q.g + 0.6299787005 * q.b, 1.0 / 3.0);
  float L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * t;
  float a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * t;
  float b = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * t;
  L = clamp(L + s * (ip9(L, GT_X, GT_Y) - L), 0.0, 1.0);
  float ch = length(vec2(a, b));
  if (ch > 1e-6) {
    float w = L < 0.1 ? mix(0.2, 0.3, L / 0.1) : (L < 0.3 ? mix(0.3, 1.0, (L - 0.1) / 0.2) : 1.0);
    float k = max(ch + s * w * (ip9(ch, GC_X, GC_Y) - ch), 0.0) / ch;
    a *= k; b *= k;
  }
  vec3 r = okLin(L, a, b);
  if (!okIn(r)) {
    // 画面に出せない濃さは、明るさと色相を変えずに、出せる所まで濃さだけ下げる
    float lo = 0.0, hi = 1.0;
    for (int i = 0; i < 10; i++) { float h = 0.5 * (lo + hi); if (okIn(okLin(L, a * h, b * h))) lo = h; else hi = h; }
    r = okLin(L, a * lo, b * lo);
  }
  return clamp(l2s(clamp(r, 0.0, 1.0)), 0.0, 1.0);
}
// マスの線（2026-11-21）。GTA6 のお手本 9 枚の、色が平らなマスを測った形。マスの幅を 12 に分けた位置ごとの、暗くなる割合。
// PL_X = 左右の端の縦の線、PL_Y = 上下のなだらかな山（マスの真ん中の列だけ。PL_M がその効き方）。線は暗い所ほど濃く、山は暗い所では弱い
const float PL_X[12] = float[12](0.032, 0.019, 0.004, 0.0, 0.0, 0.0, 0.0, 0.0, 0.002, 0.009, 0.022, 0.032);
const float PL_M[12] = float[12](0.0, 0.2, 0.5, 0.8, 1.0, 1.0, 1.0, 1.0, 0.7, 0.45, 0.2, 0.0);
const float PL_Y[12] = float[12](0.0175, 0.0148, 0.0125, 0.0110, 0.0095, 0.0060, 0.0005, -0.0040, -0.0018, 0.0064, 0.0160, 0.0215);
float pl12(float t, float T[12]) {
  float x = fract(t) * 12.0 - 0.5, i0 = floor(x);
  int a = int(i0 + 12.0) % 12, b = (a + 1) % 12;
  return mix(T[a], T[b], x - i0);
}
// 画面の 1 画素がマスのどれだけに当たるか（w）の幅でならす（マスが小さい時に、線がちらつかないように）
float plAvg(float t, float w, float T[12]) {
  w = min(w, 1.0);
  float s = 0.0;
  for (int k = 0; k < 6; k++) s += pl12(t + w * ((float(k) + 0.5) / 6.0 - 0.5), T);
  return s / 6.0;
}
vec3 cellLine(vec3 c, vec2 p, vec2 w, float s) {
  float Y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float line = plAvg(p.x, w.x, PL_X) * (0.052 - 0.030 * Y) / 0.032;
  float hump = plAvg(p.y, w.y, PL_Y) * plAvg(p.x, w.x, PL_M) * smoothstep(0.08, 0.4, Y);
  return c * clamp(1.0 - s * (line + hump), 0.0, 1.5);
}
void main() {
  vec2 uv = (uXf * vec3(vUv, 1.0)).xy;
  vec3 c;
  vec2 gp = vec2(0.0), gw = vec2(1.0);
  if (uCells.x > 0.0) {
    vec2 g = uRegion.xy + uv * uRegion.zw;
    gp = g * uCells;
    gw = fwidth(gp);
    vec2 cell = (floor(g * uCells) + 0.5) / uCells;
    vec2 d = 1.0 / (9.0 * uCells * uRegion.zw);
    uv = clamp((cell - uRegion.xy) / uRegion.zw, 0.0, 1.0);
    c = vec3(0.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) c += texture(uRgb, clamp(uv + vec2(float(i), float(j)) * d, 0.0, 1.0)).rgb;
    c /= 9.0;
  } else c = texture(uRgb, uv).rgb;
  if (uBloomOn == 1) c += texture(uGlow, uv).r * uBloom * vec3(1.0, 1.0 - 0.03 * uWarm, 1.0 - 0.10 * uWarm);
  c = clamp(c, 0.0, 1.0);
  if (uGame > 0.0) c = gameColor(c, uGame);
  if (uCells.x > 0.0 && uLine > 0.0) c = cellLine(c, gp, gw, uLine);
  if (uBw == 1) c = lab2rgb(vec3(rgb2lab(c).x, 0.0, 0.0));
  if (uClip == 1) {
    if (max(c.r, max(c.g, c.b)) >= 0.996) c = vec3(1.0, 0.25, 0.2);
    else if (max(c.r, max(c.g, c.b)) <= 0.004) c = vec3(0.2, 0.45, 1.0);
  }
  o = vec4(c, 1.0);
}`);

// ---------- 写ルンです（2026-11-15。式は utsurun.js の冒頭と _work/写ルンです/scripts/utsurun.py）----------
// 元の画（AP0、端末が決めた白）→ フィルムに当たる光の量（昼の光の白の sRGB の原色。18% の灰色がちょうどよく写る量 = 1）
export const FS_UTS_EXPOSE = fs(`
uniform sampler2D uSrc;
uniform mat3 uXf;
uniform mat3 uToRgb;
uniform float uK;
void main() {
  vec3 ap0 = texture(uSrc, (uXf * vec3(vUv, 1.0)).xy).rgb;
  o = vec4(max(uToRgb * ap0, 0.0) * uK, 1.0);
}`);

// センサーのノイズを消す（光の量の平方根の上で。ノイズの大きさが明るさによらず、ほぼそろう）。
// 明るさ: 近くの似た明るさの所だけでならす（輪郭は残る）。色: もっと広くならす（色の点々を消す）。uAmt = 0〜1
export const FS_UTS_NR = fs(`
uniform sampler2D uH;
uniform vec2 uTexel;
uniform float uStep;
uniform float uAmt;
uniform float uLum;   // 明るさのざらつきを消す割合（uAmt に掛ける。ふつうは 0.5、色だけならすときは 0）
uniform float uSigma;
void main() {
  vec3 c = sqrt(max(texture(uH, vUv).rgb, 0.0));
  float cl = (c.r + c.g + c.b) / 3.0;
  float sr = uSigma * 0.6;
  float wl = 0.0, sl = 0.0, wc = 0.0;
  vec3 sc = vec3(0.0);
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      vec2 off = vec2(float(x), float(y));
      vec3 n = sqrt(max(texture(uH, vUv + off * uTexel * uStep).rgb, 0.0));
      float nl = (n.r + n.g + n.b) / 3.0, dl = nl - cl, r2 = dot(off, off);
      float w = exp(-r2 / 8.0 - dl * dl / (2.0 * sr * sr));
      wl += w;
      sl += w * nl;
      float w2 = exp(-r2 / 18.0 - dl * dl / (50.0 * sr * sr));
      wc += w2;
      sc += w2 * (n - nl);
    }
  }
  // 明るさのざらつきは半分だけ消す（細かい所を残す）。色の点々は全部消す
  vec3 v = max(mix(cl, sl / wl, uAmt * uLum) + mix(c - cl, sc / wc, uAmt), 0.0);
  o = vec4(v * v, 1.0);
}`);

// 粒のもと 4 つ（rgb = フィルムの層ごと、a = 3 つの層で共通）。位置ごとに決まる、正規分布の白いノイズ
export const FS_NOISE4 = fs(`
uniform vec2 uOrigin;
uniform vec2 uSize;
uniform uint uSeed;
uint hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float gauss(uint h) {
  float u1 = (float(h & 0xffffu) + 0.5) / 65536.0;
  float u2 = (float(hash(h) & 0xffffu) + 0.5) / 65536.0;
  return sqrt(-2.0 * log(u1)) * cos(2.0 * PI * u2);
}
void main() {
  ivec2 p = ivec2(floor(uOrigin + vUv * uSize));
  uint h = hash(uint(p.x) * 1973u + hash(uint(p.y) * 9277u + uSeed * 26699u));
  o = vec4(gauss(hash(h + 0x9e3779b9u)), gauss(hash(h + 0x3c6ef372u)), gauss(hash(h + 0xdaa66d2bu)), gauss(hash(h + 0x78dde6e4u)));
}`);

// レンズ（にじみ・四隅・かぶり）→ ネガの濃さ → 粒 → 写真屋の機械（明るさと色の合わせ → 印画紙の線）→ sRGB
export const FS_UTS_FILM = fs(`
uniform sampler2D uBlurA; // 光の量を、まん中のにじみの分だけぼかした物
uniform sampler2D uBlurB; // 角のにじみの分だけぼかした物
uniform sampler2D uNoise;
uniform mat3 uToCrop;
uniform vec2 uR2;         // 画面のまん中からの離れ方（角で 1）を出す係数
uniform float uVig;
uniform vec3 uFlare;
uniform mat3 uMix;
uniform vec3 uGamma;
uniform vec3 uToeD;
uniform vec4 uFilm;       // x0, toe, dmax, xgray
uniform int uGrainOn;
uniform vec3 uGrain;      // 粒の強さ（濃さの単位）, 層ごとの分の重み, 共通の分の重み
uniform float uGrainShape[49]; // ネガの濃さごとの粒の強さ（濃さ 0〜2.4 を 0.05 刻み）
uniform float uGain;
uniform vec3 uOffset;
uniform vec3 uRange;
uniform vec3 uPaper;      // s, e0, nu
uniform float uSat;
uniform float uSep;       // ネガの上での色の分かれ方の倍率（1 でそのまま）
uniform int uFinOn;
uniform float uFin[15];   // 色の仕上げの値（並びは utsurun.js の P.fin の説明）
const float LN10 = 2.302585092994046;
// Oklab（線形 sRGB との行き来）
const mat3 OK_M1 = mat3(0.4122214708, 0.2119034982, 0.0883024619, 0.5363325363, 0.6806995451, 0.2817188376, 0.0514459929, 0.1073969566, 0.6299787005);
const mat3 OK_M2 = mat3(0.2104542553, 1.9779984951, 0.0259040371, 0.7936177850, -2.4285922050, 0.7827717662, -0.0040720468, 0.4505937099, -0.8086757660);
const mat3 OK_M2I = mat3(1.0, 1.0, 1.0, 0.3963377774, -0.1055613458, -0.0894841775, 0.2158037573, -0.0638541728, -1.2914855480);
const mat3 OK_M1I = mat3(4.0767416621, -1.2684380046, -0.0041960863, -3.3077115913, 2.6097574011, -0.7034186147, 0.2309699292, -0.3413193965, 1.7076147010);
float sst(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float hwin(float h, float a, float b, float c, float d) { return sst(a, b, h) * (1.0 - sst(c, d, h)); }
// 色の仕上げ: 本物の写ルンですの写真の集まりに合わせた、印画紙のあとの色の癖（色の研究 2026-11-15）
// (1) 色のない物の色を明るさ 3 段でずらす (2) 明るい青・明るい橙・暗い橙・緑の色あいを回す (3) 明るさごとの鮮やかさと、青・緑の鮮やかさ
vec3 finishColor(vec3 lin) {
  vec3 lab = OK_M2 * pow(max(OK_M1 * lin, 0.0), vec3(1.0 / 3.0));
  float L = lab.x;
  float wd = clamp((0.55 - L) / 0.3, 0.0, 1.0), wb = clamp((L - 0.65) / 0.25, 0.0, 1.0), wm = 1.0 - wd - wb;
  float guard = sst(0.0, 0.12, L);
  float a = lab.y + (uFin[0] * wd + uFin[2] * wm + uFin[4] * wb) * 0.004 * guard;
  float b = lab.z + (uFin[1] * wd + uFin[3] * wm + uFin[5] * wb) * 0.004 * guard;
  float C = length(vec2(a, b));
  float h = C > 1e-7 ? degrees(atan(b, a)) : 0.0;
  if (h < 0.0) h += 360.0;
  float bright = sst(0.55, 0.8, L), dark = 1.0 - sst(0.3, 0.55, L);
  float wblue = hwin(h, 185.0, 215.0, 255.0, 285.0), wwarm = hwin(h, 25.0, 50.0, 90.0, 115.0), wgreen = hwin(h, 105.0, 125.0, 150.0, 175.0);
  float h2 = radians(h + uFin[9] * wblue * bright + uFin[11] * wwarm * bright + uFin[12] * wwarm * dark + uFin[13] * wgreen);
  float k = uFin[6] * wd + uFin[7] * wm + uFin[8] * wb;
  float C2 = C * k * (1.0 + (uFin[10] - 1.0) * wblue * sst(0.45, 0.75, L)) * (1.0 + (uFin[14] - 1.0) * wgreen);
  vec3 lms = OK_M2I * vec3(L, C2 * cos(h2), C2 * sin(h2));
  return clamp(OK_M1I * (lms * lms * lms), 0.0, 1.0);
}
void main() {
  vec2 c = (uToCrop * vec3(vUv, 1.0)).xy - 0.5;
  float r2 = dot(c * c, uR2);
  vec3 H = mix(texture(uBlurA, vUv).rgb, texture(uBlurB, vUv).rgb, clamp(r2, 0.0, 1.0));
  float v = 1.0 + uVig * r2;
  H = H / (v * v) + uFlare;
  // ネガの濃さ（素の濃さより上の分）
  vec3 x = log(max(uMix * H, 3.98e-6)) / LN10 + uFilm.w;
  vec3 t = (x - uFilm.x - uToeD) / uFilm.y;
  vec3 d = uGamma * uFilm.y * (max(t, 0.0) + log(1.0 + exp(-abs(t) * LN10)) / LN10);
  d = d / pow(1.0 + pow(d / uFilm.z, vec3(3.0)), vec3(1.0 / 3.0));
  if (uGrainOn == 1) {
    vec4 n = texture(uNoise, vUv);
    // 薄い所（暗い所）ほど強く、濃い所（明るい所）は弱い。層ごとに、その濃さの値を表から引く
    vec3 g = clamp(d, 0.0, 2.4) * 20.0;
    ivec3 gi = min(ivec3(g), ivec3(47));
    vec3 gf = g - vec3(gi);
    vec3 shape = mix(vec3(uGrainShape[gi.r], uGrainShape[gi.g], uGrainShape[gi.b]), vec3(uGrainShape[gi.r + 1], uGrainShape[gi.g + 1], uGrainShape[gi.b + 1]), gf);
    d += (n.rgb * uGrain.y + n.a * uGrain.z) * uGrain.x * shape;
  }
  // 写真屋の機械: 光の量の見積もり（灰色 = 0、log10）→ 薄いネガの引き伸ばし → 明るさと色の合わせ → 印画紙
  float floorE = uFilm.x - uFilm.w;
  vec3 e = d / uGamma + uFilm.x + uToeD - uFilm.w;
  e = floorE + (e - floorE) * uGain + uOffset;
  float em = (e.r + e.g + e.b) / 3.0;
  e = em + (e - em) * uSep;
  vec3 Dp = uRange * pow(1.0 + uPaper.z * exp(uPaper.x * (e - uPaper.y) * LN10), vec3(-1.0 / uPaper.z));
  vec3 R = exp(-Dp * LN10);
  float Y = dot(R, vec3(0.2126, 0.7152, 0.0722));
  R = clamp(Y + (R - Y) * uSat, 0.0, 1.0);
  if (uFinOn == 1) R = finishColor(R);
  o = vec4(l2s(R), 1.0);
}`);

// 写真屋の機械の輪郭強調（sRGB の値のまま）
export const FS_UTS_SHARP = fs(`
uniform sampler2D uRgb;
uniform sampler2D uBlur;
uniform float uAmt;
void main() {
  vec3 c = texture(uRgb, vUv).rgb;
  o = vec4(clamp(c + uAmt * (c - texture(uBlur, vUv).rgb), 0.0, 1.0), 1.0);
}`);
