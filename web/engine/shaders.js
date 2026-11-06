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
  vec3 v = max(uAp0ToAp1 * ap0 * uGainA, 0.0);
  vec3 t = clamp((vec3(cct(v.r), cct(v.g), cct(v.b)) - uLoA) / (uHiA - uLoA), 0.0, 1.0);
  return clamp(texture(uLutA, (t * (uNA - 1.0) + 0.5) / uNA).rgb, 0.0, 1.0);
}
vec3 lookB(vec3 ap0) {
  vec3 v = max(uAp0ToAp1 * ap0 * uGainB, 0.0);
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
  x = x + uHighlights / 100.0 * 0.15 * sin(PI * clamp((x - 0.5) / 0.5, 0.0, 1.0));
  x = x + uShadows / 100.0 * 0.15 * sin(PI * clamp(x / 0.5, 0.0, 1.0));
  float y = 1.0 - x;
  x = clamp(x + uWhites / 100.0 * 0.12 * x * x * x * x + uBlacks / 100.0 * 0.12 * y * y * y * y, 0.0, 1.0);
  float k = 0.3 + 0.7 * x;
  vec3 rgb = lab2rgb(vec3(x * 100.0, lab.y + uTint / 100.0 * 12.0 * k, lab.z + uTemp / 100.0 * 12.0 * k));
  float d = uDehaze / 100.0 * 0.4;
  if (d > 0.0) rgb = clamp((rgb - d * 0.8) / (1.0 - d * 0.8 + 1e-6), 0.0, 1.0);
  else if (d < 0.0) rgb = rgb * (1.0 + d) - d * 0.8;
  if (uParam.x != 0.0) rgb += uParam.x * sin(PI * clamp(rgb / 0.4, 0.0, 1.0));
  if (uParam.y != 0.0) rgb += uParam.y * sin(PI * clamp((rgb - 0.1) / 0.5, 0.0, 1.0));
  if (uParam.z != 0.0) rgb += uParam.z * sin(PI * clamp((rgb - 0.4) / 0.5, 0.0, 1.0));
  if (uParam.w != 0.0) rgb += uParam.w * sin(PI * clamp((rgb - 0.6) / 0.4, 0.0, 1.0));
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
  C = C * (1.0 + uSat / 100.0) * (1.0 + uVib / 100.0 * (1.0 - min(C / 50.0, 1.0)) * skin);
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
    L += uGrainAmp * texture(uNoise, vUv).r * clamp(1.15 - pow(l, 1.5), 0.2, 1.0);
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
void main() {
  vec3 c = texture(uRgb, vUv).rgb;
  if (uOn == 1) c += texture(uGlow, vUv).r * uAmt * vec3(1.0, 0.30, 0.10);
  o = vec4(c, 1.0);
}`);
export const FS_BLOOM_SRC = fs(`
uniform sampler2D uRgb;
void main() {
  float y = dot(texture(uRgb, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
  o = vec4(vec3(max(y - 0.55, 0.0)), 1.0);
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
void main() {
  vec2 uv = (uXf * vec3(vUv, 1.0)).xy;
  vec3 c = texture(uRgb, uv).rgb;
  if (uBloomOn == 1) c += texture(uGlow, uv).r * uBloom * vec3(1.0, 1.0 - 0.03 * uWarm, 1.0 - 0.10 * uWarm);
  c = clamp(c, 0.0, 1.0);
  if (uBw == 1) c = lab2rgb(vec3(rgb2lab(c).x, 0.0, 0.0));
  if (uClip == 1) {
    if (max(c.r, max(c.g, c.b)) >= 0.996) c = vec3(1.0, 0.25, 0.2);
    else if (max(c.r, max(c.g, c.b)) <= 0.004) c = vec3(0.2, 0.45, 1.0);
  }
  o = vec4(c, 1.0);
}`);
