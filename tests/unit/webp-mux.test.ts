/** io/exporters/webp — RIFF/VP8X/ANIM/ANMF mux structure + canEncodeWebp. */
import { describe, expect, it } from 'vitest';
import { canEncodeWebp, muxAnimatedWebp, type WebpFrame } from '../../src/io/exporters/webp';

/* ── RIFF helpers (test oracle) ─────────────────────────── */

function u32(b: Uint8Array, off: number): number {
  return ((b[off] ?? 0) | ((b[off + 1] ?? 0) << 8) | ((b[off + 2] ?? 0) << 16) | ((b[off + 3] ?? 0) << 24)) >>> 0;
}

function u24(b: Uint8Array, off: number): number {
  return (b[off] ?? 0) | ((b[off + 1] ?? 0) << 8) | ((b[off + 2] ?? 0) << 16);
}

function fourcc(b: Uint8Array, off: number): string {
  return String.fromCharCode(b[off] ?? 0, b[off + 1] ?? 0, b[off + 2] ?? 0, b[off + 3] ?? 0);
}

interface Chunk { fourcc: string; offset: number; size: number; data: Uint8Array }

function walkChunks(b: Uint8Array, start: number, end: number): Chunk[] {
  const chunks: Chunk[] = [];
  let off = start;
  while (off + 8 <= end) {
    const size = u32(b, off + 4);
    chunks.push({ fourcc: fourcc(b, off), offset: off, size, data: b.subarray(off + 8, off + 8 + size) });
    off += 8 + size + (size & 1);
  }
  expect(off).toBe(end); // chunks tile the range exactly
  return chunks;
}

/** Minimal single-frame .webp file: RIFF/WEBP wrapping the given chunks. */
function fakeWebp(parts: Array<[string, Uint8Array]>): Uint8Array {
  const body = parts.map(([fc, data]) => {
    const c = new Uint8Array(8 + data.length + (data.length & 1));
    for (let i = 0; i < 4; i++) c[i] = fc.charCodeAt(i);
    new DataView(c.buffer).setUint32(4, data.length, true);
    c.set(data, 8);
    return c;
  });
  const bodyLen = body.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(12 + bodyLen);
  for (let i = 0; i < 4; i++) out[i] = 'RIFF'.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, 4 + bodyLen, true);
  for (let i = 0; i < 4; i++) out[8 + i] = 'WEBP'.charCodeAt(i);
  let off = 12;
  for (const c of body) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const VP8_BODY = new Uint8Array([1, 2, 3]); // odd length — exercises padding
const VP8L_BODY = new Uint8Array([9, 8, 7, 6]);
const FRAMES: WebpFrame[] = [
  { payload: fakeWebp([['VP8 ', VP8_BODY]]), durationMs: 100 },
  { payload: fakeWebp([['VP8L', VP8L_BODY]]), durationMs: 250 },
];

/* ── tests ──────────────────────────────────────────────── */

describe('muxAnimatedWebp — container', () => {
  const out = muxAnimatedWebp(FRAMES, 4, 4);
  const top = walkChunks(out, 12, out.length);

  it('frames RIFF/WEBP with a correct declared size', () => {
    expect(fourcc(out, 0)).toBe('RIFF');
    expect(u32(out, 4)).toBe(out.length - 8);
    expect(fourcc(out, 8)).toBe('WEBP');
    expect(out.length % 2).toBe(0);
  });

  it('leads with VP8X: animation+alpha flags, 24-bit LE canvas dims minus one', () => {
    const vp8x = top[0];
    expect(vp8x?.fourcc).toBe('VP8X');
    expect(vp8x?.size).toBe(10);
    expect(vp8x?.data[0]).toBe(0x12);
    expect(u24(vp8x?.data ?? new Uint8Array(), 4)).toBe(3); // w-1
    expect(u24(vp8x?.data ?? new Uint8Array(), 7)).toBe(3); // h-1
  });

  it('ANIM declares bg color 0 and loop count 0 (infinite)', () => {
    const anim = top[1];
    expect(anim?.fourcc).toBe('ANIM');
    expect(anim?.size).toBe(6);
    expect(u32(anim?.data ?? new Uint8Array(), 0)).toBe(0);
    expect((anim?.data[4] ?? 1) | ((anim?.data[5] ?? 1) << 8)).toBe(0);
  });

  it('emits one ANMF per frame: offsets 0, dims-1, duration, no-blend + dispose-to-bg', () => {
    const anmfs = top.filter((c) => c.fourcc === 'ANMF');
    expect(anmfs).toHaveLength(2);
    const durations = [100, 250];
    anmfs.forEach((anmf, i) => {
      expect(u24(anmf.data, 0)).toBe(0); // x/2
      expect(u24(anmf.data, 3)).toBe(0); // y/2
      expect(u24(anmf.data, 6)).toBe(3); // w-1
      expect(u24(anmf.data, 9)).toBe(3); // h-1
      expect(u24(anmf.data, 12)).toBe(durations[i]);
      expect(anmf.data[15]).toBe(0x03);
    });
  });

  it('embeds the source image chunks byte-for-byte, stripped of the RIFF header', () => {
    const anmfs = top.filter((c) => c.fourcc === 'ANMF');
    const inner0 = walkChunks(anmfs[0]?.data ?? new Uint8Array(), 16, anmfs[0]?.data.length ?? 0);
    expect(inner0.map((c) => c.fourcc)).toEqual(['VP8 ']);
    expect([...(inner0[0]?.data ?? [])]).toEqual([...VP8_BODY]);
    const inner1 = walkChunks(anmfs[1]?.data ?? new Uint8Array(), 16, anmfs[1]?.data.length ?? 0);
    expect(inner1.map((c) => c.fourcc)).toEqual(['VP8L']);
    expect([...(inner1[0]?.data ?? [])]).toEqual([...VP8L_BODY]);
  });

  it('pads odd chunk payloads so every chunk starts on an even offset', () => {
    const anmf0 = top.find((c) => c.fourcc === 'ANMF');
    const inner = walkChunks(anmf0?.data ?? new Uint8Array(), 16, anmf0?.data.length ?? 0);
    expect(inner[0]?.size).toBe(3); // declared size stays unpadded
    expect(anmf0?.size).toBe(16 + 8 + 4); // padded to 4 inside the ANMF payload
    for (const c of top) expect(c.offset % 2).toBe(0);
  });
});

describe('muxAnimatedWebp — source hygiene', () => {
  it('strips source VP8X/ANIM chunks, keeps ALPH + image data', () => {
    const src = fakeWebp([
      ['VP8X', new Uint8Array(10)],
      ['ANIM', new Uint8Array(6)],
      ['ALPH', new Uint8Array([5, 5])],
      ['VP8 ', VP8_BODY],
    ]);
    const out = muxAnimatedWebp([{ payload: src, durationMs: 40 }], 4, 4);
    const anmf = walkChunks(out, 12, out.length).find((c) => c.fourcc === 'ANMF');
    const inner = walkChunks(anmf?.data ?? new Uint8Array(), 16, anmf?.data.length ?? 0);
    expect(inner.map((c) => c.fourcc)).toEqual(['ALPH', 'VP8 ']);
  });

  it('rejects payloads that are not webp files, and empty frame lists', () => {
    expect(() => muxAnimatedWebp([{ payload: new Uint8Array(20), durationMs: 1 }], 4, 4))
      .toThrow(/not a webp/);
    expect(() => muxAnimatedWebp([], 4, 4)).toThrow(/no frames/);
  });
});

describe('canEncodeWebp', () => {
  it('is false without OffscreenCanvas (node)', () => {
    expect(typeof OffscreenCanvas).toBe('undefined');
    expect(canEncodeWebp()).toBe(false);
  });
});
