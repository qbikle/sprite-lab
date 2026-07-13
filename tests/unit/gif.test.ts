/** io/exporters/gif — GIF89a structure + LZW round-trip via a hand-rolled decoder. */
import { describe, expect, it } from 'vitest';
import { packRgba } from '../../src/core/pixels';
import { encodeGif, type GifFrame } from '../../src/io/exporters/gif';

/* ── tiny GIF-LZW decoder (test oracle) ─────────────────── */

function lzwDecode(minCodeSize: number, data: Uint8Array): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict: number[][] = [];
  const reset = (): void => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    codeSize = minCodeSize + 1;
    next = eoi + 1;
  };
  reset();
  let bitPos = 0;
  const readCode = (): number => {
    let v = 0;
    for (let i = 0; i < codeSize; i++, bitPos++) {
      v |= (((data[bitPos >> 3] ?? 0) >> (bitPos & 7)) & 1) << i;
    }
    return v;
  };
  const out: number[] = [];
  let prev: number[] | null = null;
  for (;;) {
    const code = readCode();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    const known = dict[code];
    if (code < next && known) entry = known;
    else if (code === next && prev) entry = [...prev, prev[0] ?? 0];
    else throw new Error(`lzwDecode: bad code ${code}`);
    out.push(...entry);
    if (prev && next < 4096) {
      dict[next++] = [...prev, entry[0] ?? 0];
      if (next >= 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return out;
}

/* ── structural GIF parser ──────────────────────────────── */

interface ParsedFrame {
  gcePacked: number;
  delay: number;
  transparentIndex: number;
  left: number;
  top: number;
  w: number;
  h: number;
  indices: number[];
}

interface ParsedGif {
  width: number;
  height: number;
  lsdPacked: number;
  gct: Array<[number, number, number]>;
  netscape: number[] | null; // app-extension sub-block data
  frames: ParsedFrame[];
  trailer: number;
}

function parseGif(bytes: Uint8Array): ParsedGif {
  const str = (off: number, len: number): string =>
    String.fromCharCode(...bytes.subarray(off, off + len));
  const u16 = (off: number): number => (bytes[off] ?? 0) | ((bytes[off + 1] ?? 0) << 8);
  expect(str(0, 6)).toBe('GIF89a');
  const width = u16(6);
  const height = u16(8);
  const lsdPacked = bytes[10] ?? 0;
  expect(lsdPacked & 0x80).toBe(0x80);
  const gctLen = 2 << (lsdPacked & 0x07);
  const gct: Array<[number, number, number]> = [];
  let off = 13;
  for (let i = 0; i < gctLen; i++, off += 3) {
    gct.push([bytes[off] ?? 0, bytes[off + 1] ?? 0, bytes[off + 2] ?? 0]);
  }

  const subBlocks = (start: number): { data: number[]; end: number } => {
    const data: number[] = [];
    let o = start;
    for (;;) {
      const len = bytes[o] ?? 0;
      o++;
      if (len === 0) break;
      for (let i = 0; i < len; i++) data.push(bytes[o + i] ?? 0);
      o += len;
    }
    return { data, end: o };
  };

  let netscape: number[] | null = null;
  const frames: ParsedFrame[] = [];
  let gcePacked = 0;
  let delay = 0;
  let transparentIndex = 0;
  let trailer = 0;
  while (off < bytes.length) {
    const b = bytes[off] ?? 0;
    if (b === 0x3b) {
      trailer = b;
      break;
    }
    if (b === 0x21) {
      const label = bytes[off + 1] ?? 0;
      if (label === 0xf9) {
        expect(bytes[off + 2]).toBe(4);
        gcePacked = bytes[off + 3] ?? 0;
        delay = u16(off + 4);
        transparentIndex = bytes[off + 6] ?? 0;
        expect(bytes[off + 7]).toBe(0);
        off += 8;
      } else if (label === 0xff) {
        expect(bytes[off + 2]).toBe(11);
        const app = str(off + 3, 11);
        const { data, end } = subBlocks(off + 14);
        if (app === 'NETSCAPE2.0') netscape = data;
        off = end;
      } else {
        off = subBlocks(off + 2).end; // header + data are all length-prefixed
      }
    } else if (b === 0x2c) {
      const left = u16(off + 1);
      const top = u16(off + 3);
      const w = u16(off + 5);
      const h = u16(off + 7);
      expect(bytes[off + 9]).toBe(0); // no local color table, not interlaced
      const minCodeSize = bytes[off + 10] ?? 0;
      const { data, end } = subBlocks(off + 11);
      frames.push({
        gcePacked, delay, transparentIndex, left, top, w, h,
        indices: lzwDecode(minCodeSize, new Uint8Array(data)),
      });
      off = end;
    } else {
      throw new Error(`parseGif: unexpected block 0x${b.toString(16)} at ${off}`);
    }
  }
  return { width, height, lsdPacked, gct, netscape, frames, trailer };
}

/* ── fixtures ───────────────────────────────────────────── */

const RED = packRgba(255, 0, 0, 255);
const BLUE = packRgba(0, 0, 255, 255);
const CLEAR = 0;
const FAINT = packRgba(9, 9, 9, 100); // alpha < 128 → transparent

// frame 1: red/blue checkerboard; frame 2: red bar + transparent bottom half
const F1 = new Uint32Array([
  RED, BLUE, RED, BLUE,
  BLUE, RED, BLUE, RED,
  RED, BLUE, RED, BLUE,
  BLUE, RED, BLUE, RED,
]);
const F2 = new Uint32Array([
  RED, RED, RED, RED,
  BLUE, BLUE, BLUE, BLUE,
  CLEAR, CLEAR, CLEAR, CLEAR,
  FAINT, FAINT, FAINT, FAINT,
]);
const FRAMES: GifFrame[] = [
  { pixels: F1, durationMs: 100 },
  { pixels: F2, durationMs: 250 },
];

function slotOf(gct: Array<[number, number, number]>, rgb: [number, number, number]): number {
  return gct.findIndex((c) => c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2]);
}

function expectedIndices(pixels: Uint32Array, gct: Array<[number, number, number]>): number[] {
  return [...pixels].map((c) => {
    if (c >>> 24 < 128) return 0;
    return slotOf(gct, [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff]);
  });
}

/* ── tests ──────────────────────────────────────────────── */

describe('encodeGif — structure', () => {
  const gif = parseGif(encodeGif(FRAMES, 4, 4));

  it('frames GIF89a: dims, GCT flag/size, trailer', () => {
    expect(gif.width).toBe(4);
    expect(gif.height).toBe(4);
    expect(gif.lsdPacked & 0x07).toBe(1); // 2^(1+1) = 4-entry table
    expect(gif.gct).toHaveLength(4);
    expect(gif.trailer).toBe(0x3b);
  });

  it('palette holds both colors, index 0 reserved for transparency', () => {
    expect(slotOf(gif.gct, [255, 0, 0])).toBeGreaterThanOrEqual(1);
    expect(slotOf(gif.gct, [0, 0, 255])).toBeGreaterThanOrEqual(1);
  });

  it('loops forever via NETSCAPE2.0', () => {
    expect(gif.netscape).toEqual([1, 0, 0]); // sub-block id 1, loop count 0
  });

  it('per-frame GCE: delay from durationMs, dispose-to-bg, transparent index 0', () => {
    expect(gif.frames).toHaveLength(2);
    for (const f of gif.frames) {
      expect(f.gcePacked).toBe(0x09); // disposal=2 | transparent flag
      expect(f.transparentIndex).toBe(0);
      expect([f.left, f.top, f.w, f.h]).toEqual([0, 0, 4, 4]);
    }
    expect(gif.frames[0]?.delay).toBe(10);
    expect(gif.frames[1]?.delay).toBe(25);
  });

  it('clamps delay to a 2-centisecond minimum', () => {
    const fast = parseGif(encodeGif([{ pixels: F1, durationMs: 10 }], 4, 4));
    expect(fast.frames[0]?.delay).toBe(2);
  });
});

describe('encodeGif — LZW round-trip', () => {
  it('decodes both frames back to the exact index maps', () => {
    const gif = parseGif(encodeGif(FRAMES, 4, 4));
    expect(gif.frames[0]?.indices).toEqual(expectedIndices(F1, gif.gct));
    expect(gif.frames[1]?.indices).toEqual(expectedIndices(F2, gif.gct));
  });

  it('round-trips a single-color frame (run-length heavy stream)', () => {
    const flat = new Uint32Array(16).fill(BLUE);
    const gif = parseGif(encodeGif([{ pixels: flat, durationMs: 100 }], 4, 4));
    expect(gif.frames[0]?.indices).toEqual(expectedIndices(flat, gif.gct));
  });
});

describe('encodeGif — quantization', () => {
  it('median-cuts >255 unique colors to a 256-entry table, nearest-mapped', () => {
    const w = 20;
    const h = 20;
    const px = new Uint32Array(w * h);
    for (let i = 0; i < px.length; i++) {
      px[i] = packRgba(i % 256, Math.floor(i / 256) * 16, 0, 255); // 400 unique colors
    }
    const gif = parseGif(encodeGif([{ pixels: px, durationMs: 100 }], w, h));
    expect(gif.gct).toHaveLength(256);
    const frame = gif.frames[0];
    expect(frame).toBeDefined();
    for (let i = 0; i < px.length; i++) {
      const slot = frame?.indices[i] ?? -1;
      expect(slot).toBeGreaterThanOrEqual(1);
      const c = gif.gct[slot];
      const src = px[i] ?? 0;
      const dr = (src & 0xff) - (c?.[0] ?? 999);
      const dg = ((src >>> 8) & 0xff) - (c?.[1] ?? 999);
      const db = ((src >>> 16) & 0xff) - (c?.[2] ?? 999);
      expect(dr * dr + dg * dg + db * db).toBeLessThanOrEqual(3 * 32 * 32);
    }
  });
});

describe('encodeGif — behavior', () => {
  it('reports per-frame progress via onFrame', () => {
    const calls: Array<[number, number]> = [];
    encodeGif(FRAMES, 4, 4, (frame, total) => calls.push([frame, total]));
    expect(calls).toEqual([[0, 2], [1, 2]]);
  });

  it('throws on zero frames', () => {
    expect(() => encodeGif([], 4, 4)).toThrow(/no frames/);
  });
});
