#!/bin/bash
# RAW を読む部品（LibRaw 0.22.2）を、ページで動く形（WebAssembly）にする（2026-11-05）。
# 出力: web/engine/raw.js と web/engine/raw.wasm（組み立てた物も置き場に入れる。ページはそのまま読む）
# 使い方: bash wasm/build.sh    Emscripten（emcc）が要る。同時に組み立てる数は 2。
set -euo pipefail
cd "$(dirname "$0")"
V=0.22.2
SRC="third_party/LibRaw-$V"
if [ ! -d "$SRC" ]; then
  mkdir -p third_party
  curl -sL "https://www.libraw.org/data/LibRaw-$V.tar.gz" | tar xz -C third_party
fi
mkdir -p build/obj
FLAGS="-O3 -fwasm-exceptions -DLIBRAW_NOTHREADS -I$SRC -w"
export FLAGS SRC
# LibRaw の部品（libraw_sources.txt の 79 個）を 2 つずつ組み立てる。前に組み立てた物は使い回す
xargs -P 2 -I{} sh -c 'o="build/obj/$(echo "{}" | tr / _).o"; if [ ! -f "$o" ]; then emcc $FLAGS -c "$SRC/{}" -o "$o"; fi' < libraw_sources.txt
em++ $FLAGS raw.cpp build/obj/*.o -o ../web/engine/raw.js \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createRaw -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_MEMORY=64MB -sSTACK_SIZE=4MB \
  -sEXPORTED_FUNCTIONS=_sg_open,_sg_thumb,_sg_thumb_data,_sg_thumb_size,_sg_flip,_sg_develop,_sg_width,_sg_height,_sg_pixels,_sg_meta,_sg_error,_sg_close,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU16,UTF8ToString
ls -la ../web/engine/raw.js ../web/engine/raw.wasm
