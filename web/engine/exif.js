// 写真のファイル（DNG・JPEG）から、撮った時の ISO・シャッター（秒）・絞りを読む（2026-11-11）。
// 使う所: 夜の明るさの決まり（color.js の sceneEv）。場面そのものの明るさを出すのに要る。
// LibRaw は Android の DNG（ISO が最初の IFD に書かれている）の ISO を読めないので、ここで読む。
// 読めなかった値は 0 のまま返す。
export function shotInfo(buf) {
  const out = { iso: 0, shutter: 0, aperture: 0 };
  try {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), len = u8.length;
    let base = 0;
    if (u8[0] === 0xff && u8[1] === 0xd8) {
      // JPEG: 「Exif」の区画を探す。その中身が TIFF の形
      base = -1;
      for (let p = 2; p + 10 < len && u8[p] === 0xff && u8[p + 1] !== 0xda; p += 2 + dv.getUint16(p + 2)) {
        if (u8[p + 1] === 0xe1 && dv.getUint32(p + 4) === 0x45786966) {
          base = p + 10;
          break;
        }
      }
      if (base < 0) return out;
    }
    const mark = dv.getUint16(base);
    if (mark !== 0x4949 && mark !== 0x4d4d) return out;
    const le = mark === 0x4949;
    const u16 = (p) => dv.getUint16(p, le), u32 = (p) => dv.getUint32(p, le);
    const readIfd = (off, depth) => {
      const at = base + off;
      if (off <= 0 || at + 2 > len) return;
      const n = u16(at);
      for (let i = 0; i < n; i++) {
        const e = at + 2 + i * 12;
        if (e + 12 > len) return;
        const tag = u16(e), type = u16(e + 2);
        const num = () => (type === 3 ? u16(e + 8) : u32(e + 8));
        const ratio = () => {
          const p = base + u32(e + 8);
          if (p + 8 > len) return 0;
          const d = u32(p + 4);
          return d ? u32(p) / d : 0;
        };
        if (tag === 0x8827 && !out.iso) out.iso = num();
        else if (tag === 0x829a && !out.shutter) out.shutter = ratio();
        else if (tag === 0x829d && !out.aperture) out.aperture = ratio();
        else if (tag === 0x8769 && depth === 0) readIfd(u32(e + 8), 1);
      }
    };
    readIfd(u32(base + 4), 0);
  } catch (e) {
    // 形の崩れたファイルは、読めた所までを返す
  }
  return out;
}
