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
#include <string>

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
  auto& P = R->imgdata.params;
  if (half || R->imgdata.sizes.raw_width > 6000) P.half_size = 1;
  float* cm = R->imgdata.color.cam_mul;
  float mn = std::min(cm[0], std::min(cm[1], cm[2])), mx = std::max(cm[0], std::max(cm[1], cm[2]));
  bool camWb = mn > 0 && mx / mn > 1.3f;
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
  char b[1024];
  std::snprintf(b, sizeof b,
                "{\"make\":\"%s\",\"model\":\"%s\",\"lens\":\"%s\",\"iso\":%g,\"shutter\":%g,\"aperture\":%g,"
                "\"focal\":%g,\"timestamp\":%lld,\"flip\":%d,\"rawWidth\":%d,\"rawHeight\":%d,\"width\":%d,"
                "\"height\":%d,\"half\":%d,\"wb\":\"%s\"}",
                esc(I.make).c_str(), esc(I.model).c_str(), esc(R->imgdata.lens.Lens).c_str(), O.iso_speed, O.shutter,
                O.aperture, O.focal_len, (long long)O.timestamp, S.flip, S.raw_width, S.raw_height, img->width,
                img->height, P.half_size, camWb ? "camera" : "daylight");
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
