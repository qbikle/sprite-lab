/** Animated WebP muxer — wraps per-frame WebP payloads in RIFF/VP8X/ANIM/ANMF.
 *  Frame encoding itself needs OffscreenCanvas (Chrome-family); mux is pure. */

export interface WebpFrame {
  payload: Uint8Array; // bytes of a single-frame .webp file (VP8/VP8L inside)
  durationMs: number;
}

let webpProbe: boolean | null = null;

/** True when this browser can encode webp frames off-thread.
 *  Compromise: convertToBlob({type:'image/webp'}) support is only detectable
 *  async, but callers need a sync answer — so heuristic: OffscreenCanvas
 *  exists and the UA is not Safari-proper (Safari silently falls back to png). */
export function canEncodeWebp(): boolean {
  if (webpProbe === null) {
    const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
    const safari = /safari/i.test(ua) && !/chrome|chromium|crios|edg/i.test(ua);
    webpProbe = typeof OffscreenCanvas !== 'undefined' && !safari;
  }
  return webpProbe;
}

const STRIP = new Set(['VP8X', 'ANIM', 'ANMF']);

function fourccAt(b: Uint8Array, off: number): string {
  return String.fromCharCode(b[off] ?? 0, b[off + 1] ?? 0, b[off + 2] ?? 0, b[off + 3] ?? 0);
}

function putFourcc(b: Uint8Array, off: number, s: string): void {
  for (let i = 0; i < 4; i++) b[off + i] = s.charCodeAt(i);
}

function putU32(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff;
  b[off + 1] = (v >>> 8) & 0xff;
  b[off + 2] = (v >>> 16) & 0xff;
  b[off + 3] = (v >>> 24) & 0xff;
}

function putU24(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff;
  b[off + 1] = (v >>> 8) & 0xff;
  b[off + 2] = (v >>> 16) & 0xff;
}

function readU32(b: Uint8Array, off: number): number {
  return ((b[off] ?? 0) | ((b[off + 1] ?? 0) << 8) | ((b[off + 2] ?? 0) << 16) | ((b[off + 3] ?? 0) << 24)) >>> 0;
}

/** fourcc + u32le size + data + pad byte when size is odd (RIFF alignment). */
function chunkBytes(fourcc: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  putFourcc(out, 0, fourcc);
  putU32(out, 4, data.length);
  out.set(data, 8);
  return out;
}

interface Chunk { fourcc: string; data: Uint8Array }

function parseWebpChunks(payload: Uint8Array): Chunk[] {
  if (payload.length < 12 || fourccAt(payload, 0) !== 'RIFF' || fourccAt(payload, 8) !== 'WEBP') {
    throw new Error('muxAnimatedWebp: frame payload is not a webp file');
  }
  const chunks: Chunk[] = [];
  let off = 12;
  while (off + 8 <= payload.length) {
    const fourcc = fourccAt(payload, off);
    const size = readU32(payload, off + 4);
    if (off + 8 + size > payload.length) throw new Error('muxAnimatedWebp: truncated chunk');
    chunks.push({ fourcc, data: payload.subarray(off + 8, off + 8 + size) });
    off += 8 + size + (size & 1);
  }
  return chunks;
}

/** Mux single-frame webp files into one animated webp (loop forever). */
export function muxAnimatedWebp(
  frames: readonly WebpFrame[],
  w: number,
  h: number,
): Uint8Array<ArrayBuffer> {
  if (frames.length === 0) throw new Error('muxAnimatedWebp: no frames');

  const chunks: Uint8Array[] = [];

  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x12; // alpha + animation flags
  putU24(vp8x, 4, w - 1);
  putU24(vp8x, 7, h - 1);
  chunks.push(chunkBytes('VP8X', vp8x));

  const anim = new Uint8Array(6); // bg color 0, loop count 0 = infinite
  chunks.push(chunkBytes('ANIM', anim));

  for (const f of frames) {
    const inner = parseWebpChunks(f.payload).filter((c) => !STRIP.has(c.fourcc));
    if (inner.length === 0) throw new Error('muxAnimatedWebp: frame has no image chunk');
    const innerBytes = inner.map((c) => chunkBytes(c.fourcc, c.data));
    const innerLen = innerBytes.reduce((s, b) => s + b.length, 0);
    const data = new Uint8Array(16 + innerLen);
    putU24(data, 6, w - 1); // x,y offsets stay 0
    putU24(data, 9, h - 1);
    putU24(data, 12, Math.max(0, Math.min(0xffffff, Math.round(f.durationMs))));
    data[15] = 0x03; // no-blend (overwrite) + dispose-to-background
    let off = 16;
    for (const b of innerBytes) {
      data.set(b, off);
      off += b.length;
    }
    chunks.push(chunkBytes('ANMF', data));
  }

  const bodyLen = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(12 + bodyLen);
  putFourcc(out, 0, 'RIFF');
  putU32(out, 4, 4 + bodyLen);
  putFourcc(out, 8, 'WEBP');
  let off = 12;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
