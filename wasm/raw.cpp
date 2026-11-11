// RAW（DNG など）を読む部品。LibRaw 0.22.2 を、ページで動く形（WebAssembly）にする（2026-11-05）。
// 読み方は、パソコンの道具（rawpy）と、前の C++ の画の処理（アプリ/app/src/main/cpp/engine.cpp の decode）と同じ:
//   ACES（AP0）の色・光の量のまま（ガンマ 1）・明るさの自動補正なし・16 ビット。
//   6000 画素幅を超える RAW（17 Ultra の 5000 万画素）は、半分の大きさで読む。
//   白の合わせ方は、撮ったときの値が使えれば使い、使えなければ昼の光の値。
// 縦の写真は、LibRaw が向きを直してから渡す（dcraw_make_mem_image が flip を当てる）。
#include <emscripten/emscripten.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "libraw/libraw.h"

namespace {
LibRaw* R = nullptr;
libraw_processed_image_t* img = nullptr;
libraw_processed_image_t* thumb = nullptr;
std::string meta;

void freeImages() {
  if (img) LibRaw::dcraw_clear_mem(img);
  if (thumb) LibRaw::dcraw_clear_mem(thumb);
  img = nullptr;
  thumb = nullptr;
}

std::string esc(const char* s) {
  std::string o;
  for (const char* p = s; p && *p; p++) {
    unsigned char c = (unsigned char)*p;
    if (c == '"' || c == '\\') {
      o += '\\';
      o += (char)c;
    } else if (c >= 0x20) {
      o += (char)c;
    }
  }
  return o;
}

// ---- レンズの明るさむらの補正（DNG の OpcodeList2 の GainMap）----
// LibRaw は GainMap を読むだけでかけないので、色を作る前の RAW の値に、ここでかける（2026-11-05）。
// 表の位置は画（ActiveArea）の中の 0〜1 の相対の位置。値は黒を引いた光の量に倍率をかける。
uint32_t be32(const uint8_t* p) { return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3]; }
double beD(const uint8_t* p) {
  uint64_t v = 0;
  for (int i = 0; i < 8; i++) v = (v << 8) | p[i];
  double d;
  std::memcpy(&d, &v, 8);
  return d;
}
float beF(const uint8_t* p) {
  uint32_t v = be32(p);
  float f;
  std::memcpy(&f, &v, 4);
  return f;
}

int applyGainMaps() {
  const auto& op = R->imgdata.color.dng_levels.rawopcodes[1];  // OpcodeList2
  ushort* raw = R->imgdata.rawdata.raw_image;
  if (!op.data || op.len < 4 || !raw) return 0;
  const uint8_t* b = static_cast<const uint8_t*>(op.data);
  const auto& S = R->imgdata.sizes;
  const auto& C = R->imgdata.color;
  float black = C.black + (C.cblack[0] + C.cblack[1] + C.cblack[2] + C.cblack[3]) / 4.0f;
  if (C.cblack[4] && C.cblack[5]) {
    float s = 0;
    for (unsigned i = 0; i < C.cblack[4] * C.cblack[5]; i++) s += C.cblack[6 + i];
    black += s / (C.cblack[4] * C.cblack[5]);
  }
  const int H = S.height, W = S.width;
  uint32_t n = be32(b), applied = 0;
  size_t p = 4;
  for (uint32_t k = 0; k < n && p + 16 <= op.len; k++) {
    uint32_t id = be32(b + p), size = be32(b + p + 12);
    const uint8_t* q = b + p + 16;
    p += 16 + size;
    if (id != 9 || size < 76 || p > op.len) continue;
    uint32_t top = be32(q), left = be32(q + 4), bottom = be32(q + 8), right = be32(q + 12);
    uint32_t rowPitch = be32(q + 24), colPitch = be32(q + 28), nv = be32(q + 32), nh = be32(q + 36);
    double sv = beD(q + 40), sh = beD(q + 48), ov = beD(q + 56), oh = beD(q + 64);
    uint32_t planes = be32(q + 72);
    if (!nv || !nh || !planes || size < 76 + 4ull * nv * nh * planes || rowPitch == 0 || colPitch == 0) continue;
    std::vector<float> g(size_t(nv) * nh);
    for (uint32_t i = 0; i < nv * nh; i++) g[i] = beF(q + 76 + 4ull * i * planes);  // 1 面目だけ使う（CFA は 1 面）
    for (uint32_t r = top; r < bottom && r < (uint32_t)H; r += rowPitch) {
      double fy = ((r + 0.5) / H - ov) / (sv > 0 ? sv : 1);
      fy = std::min(std::max(fy, 0.0), double(nv - 1));
      uint32_t y0 = std::min(uint32_t(fy), nv > 1 ? nv - 2 : 0);
      float ty = nv > 1 ? float(fy - y0) : 0.f;
      ushort* row = raw + size_t(r + S.top_margin) * S.raw_pitch / 2 + S.left_margin;
      for (uint32_t c = left; c < right && c < (uint32_t)W; c += colPitch) {
        double fx = ((c + 0.5) / W - oh) / (sh > 0 ? sh : 1);
        fx = std::min(std::max(fx, 0.0), double(nh - 1));
        uint32_t x0 = std::min(uint32_t(fx), nh > 1 ? nh - 2 : 0);
        float tx = nh > 1 ? float(fx - x0) : 0.f;
        auto at = [&](uint32_t y, uint32_t x) { return g[size_t(std::min(y, nv - 1)) * nh + std::min(x, nh - 1)]; };
        float gain = (at(y0, x0) * (1 - tx) + at(y0, x0 + 1) * tx) * (1 - ty) + (at(y0 + 1, x0) * (1 - tx) + at(y0 + 1, x0 + 1) * tx) * ty;
        float v = (row[c] - black) * gain + black;
        row[c] = ushort(std::min(std::max(v, 0.0f), 65535.0f) + 0.5f);
      }
    }
    applied++;
  }
  return int(applied);
}
int gainMapsApplied = 0;
}  // namespace

extern "C" {

// ファイルの中身を渡して開く。buf は sg_close まで消さないこと（LibRaw は写さずに読む）
EMSCRIPTEN_KEEPALIVE int sg_open(const uint8_t* buf, int len) {
  if (!R) R = new LibRaw();
  freeImages();
  R->recycle();
  auto& P = R->imgdata.params;
  P.output_color = 6;  // ACES
  P.gamm[0] = 1.0;
  P.gamm[1] = 1.0;
  P.no_auto_bright = 1;
  P.output_bps = 16;
  P.half_size = 0;
  P.use_camera_wb = 0;
  for (int c = 0; c < 4; c++) P.user_mul[c] = 0;
  return R->open_buffer(buf, (size_t)len);
}

// RAW の中に入っている見本の画（JPEG）を取り出す。速く最初の画を出すのに使う
EMSCRIPTEN_KEEPALIVE int sg_thumb() {
  if (thumb) return 0;
  int r = R->unpack_thumb();
  if (r != LIBRAW_SUCCESS) return r;
  int e = 0;
  thumb = R->dcraw_make_mem_thumb(&e);
  if (!thumb || e != LIBRAW_SUCCESS) return e ? e : -1;
  if (thumb->type != LIBRAW_IMAGE_JPEG) return -3;
  return 0;
}
// 写真の向き（0 そのまま、3 は 180 度、5 は左へ 90 度、6 は右へ 90 度）。見本の画を正しい向きで出すのに使う
EMSCRIPTEN_KEEPALIVE int sg_flip() { return R ? R->imgdata.sizes.flip : 0; }
EMSCRIPTEN_KEEPALIVE const uint8_t* sg_thumb_data() { return thumb ? thumb->data : nullptr; }
EMSCRIPTEN_KEEPALIVE int sg_thumb_size() { return thumb ? (int)thumb->data_size : 0; }

// 現像する（光の量の画を作る）。half=1 なら半分の大きさで読む（一覧の小さな画を速く作るため）
EMSCRIPTEN_KEEPALIVE int sg_develop(int half) {
  int r = R->unpack();
  if (r != LIBRAW_SUCCESS) return r;
  gainMapsApplied = (R->imgdata.idata.filters && R->imgdata.rawdata.raw_image) ? applyGainMaps() : 0;
  auto& P = R->imgdata.params;
  if (half || R->imgdata.sizes.raw_width > 6000) P.half_size = 1;
  float* cm = R->imgdata.color.cam_mul;
  float mn = std::min(cm[0], std::min(cm[1], cm[2])), mx = std::max(cm[0], std::max(cm[1], cm[2]));
  bool camWb = mn > 0 && mx / mn > 1.3f;
  // 2026-11-11 光の色を残すルック（Cinema）のために、現像の前に「昼の光の白の基準 ÷ 端末が決めた白の基準」と、
  // カメラの色 → sRGB の行列を控える（dcraw_process のあとは、昼の基準が端末の基準で上書きされる）。
  // 比は緑を 1 にした値。白い物を昼の基準で現像したときの色（カメラの色）に当たる
  std::string light = "null";
  {
    const float* pm = R->imgdata.color.pre_mul;
    if (camWb && pm[0] > 0 && pm[1] > 0 && pm[2] > 0 && cm[0] > 0 && cm[1] > 0 && cm[2] > 0) {
      double g = double(pm[1]) / cm[1];
      char lb[512];
      const auto& rc = R->imgdata.color.rgb_cam;
      std::snprintf(lb, sizeof lb, "{\"ratio\":[%.6g,1,%.6g],\"cam\":[%.6g,%.6g,%.6g,%.6g,%.6g,%.6g,%.6g,%.6g,%.6g]}",
                    double(pm[0]) / cm[0] / g, double(pm[2]) / cm[2] / g, rc[0][0], rc[0][1], rc[0][2], rc[1][0], rc[1][1],
                    rc[1][2], rc[2][0], rc[2][1], rc[2][2]);
      light = lb;
    }
  }
  if (camWb) {
    P.use_camera_wb = 1;
  } else {
    for (int c = 0; c < 3; c++) P.user_mul[c] = R->imgdata.color.pre_mul[c];
    P.user_mul[3] = R->imgdata.color.pre_mul[1];
  }
  r = R->dcraw_process();
  if (r != LIBRAW_SUCCESS) return r;
  int e = 0;
  img = R->dcraw_make_mem_image(&e);
  if (!img || e != LIBRAW_SUCCESS) return e ? e : -1;
  if (img->colors != 3 || img->bits != 16) return -2;

  const auto& O = R->imgdata.other;
  const auto& I = R->imgdata.idata;
  const auto& S = R->imgdata.sizes;
  char b[2048];
  std::snprintf(b, sizeof b,
                "{\"make\":\"%s\",\"model\":\"%s\",\"lens\":\"%s\",\"iso\":%g,\"shutter\":%g,\"aperture\":%g,"
                "\"focal\":%g,\"timestamp\":%lld,\"flip\":%d,\"rawWidth\":%d,\"rawHeight\":%d,\"width\":%d,"
                "\"height\":%d,\"half\":%d,\"wb\":\"%s\",\"gainMaps\":%d,\"light\":%s}",
                esc(I.make).c_str(), esc(I.model).c_str(), esc(R->imgdata.lens.Lens).c_str(), O.iso_speed, O.shutter,
                O.aperture, O.focal_len, (long long)O.timestamp, S.flip, S.raw_width, S.raw_height, img->width,
                img->height, P.half_size, camWb ? "camera" : "daylight", gainMapsApplied, light.c_str());
  meta = b;
  // 画だけ残して、LibRaw の中の大きな作業用の領域を先に空ける
  R->recycle();
  return 0;
}

EMSCRIPTEN_KEEPALIVE int sg_width() { return img ? img->width : 0; }
EMSCRIPTEN_KEEPALIVE int sg_height() { return img ? img->height : 0; }
EMSCRIPTEN_KEEPALIVE const uint16_t* sg_pixels() { return img ? reinterpret_cast<const uint16_t*>(img->data) : nullptr; }
EMSCRIPTEN_KEEPALIVE const char* sg_meta() { return meta.c_str(); }
EMSCRIPTEN_KEEPALIVE const char* sg_error(int code) { return libraw_strerror(code); }

EMSCRIPTEN_KEEPALIVE void sg_close() {
  freeImages();
  if (R) R->recycle();
}

}  // extern "C"
