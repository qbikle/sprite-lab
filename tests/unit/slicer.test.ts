/** io/slicer — grid cut math, alpha-scan cell detection, frame-size guessing. */
import { describe, expect, it } from 'vitest';
import { guessFrameSize, sliceGrid } from '../../src/io/slicer';
import { packRgba } from '../../src/core/pixels';

const OPAQUE = packRgba(255, 255, 255, 255);

function sheet(w: number, h: number, dots: Array<[x: number, y: number, c?: number]>): Uint32Array {
  const px = new Uint32Array(w * h);
  for (const [x, y, c] of dots) px[y * w + x] = c ?? OPAQUE;
  return px;
}

describe('sliceGrid', () => {
  it('returns full-size cells in row-major reading order with correct rects', () => {
    const px = sheet(24, 16, [
      [1, 1],    // row 0, col 0
      [17, 3],   // row 0, col 2
      [10, 9],   // row 1, col 1
    ]);
    const slices = sliceGrid(px, 24, 16, 8, 8);
    expect(slices).toEqual([
      { rect: { x: 0, y: 0, w: 8, h: 8 }, row: 0, col: 0 },
      { rect: { x: 16, y: 0, w: 8, h: 8 }, row: 0, col: 2 },
      { rect: { x: 8, y: 8, w: 8, h: 8 }, row: 1, col: 1 },
    ]);
  });

  it('floors cell counts — partial edge strips are never sliced', () => {
    const px = sheet(20, 10, [
      [2, 2],    // inside cell (0,0)
      [17, 1],   // right margin (x >= 16)
      [3, 9],    // bottom margin (y >= 8)
    ]);
    const slices = sliceGrid(px, 20, 10, 8, 8);
    expect(slices).toEqual([{ rect: { x: 0, y: 0, w: 8, h: 8 }, row: 0, col: 0 }]);
  });

  it('drops cells with no content', () => {
    const px = sheet(16, 8, [[12, 4]]);
    const slices = sliceGrid(px, 16, 8, 8, 8);
    expect(slices).toHaveLength(1);
    expect(slices[0]?.col).toBe(1);
  });

  it('uses the v1 alpha threshold: alpha 8 is empty, alpha 9 is content', () => {
    const dim = sheet(8, 8, [[4, 4, packRgba(10, 10, 10, 8)]]);
    expect(sliceGrid(dim, 8, 8, 8, 8)).toEqual([]);
    const lit = sheet(8, 8, [[4, 4, packRgba(10, 10, 10, 9)]]);
    expect(sliceGrid(lit, 8, 8, 8, 8)).toHaveLength(1);
  });

  it('returns nothing for degenerate frame or sheet sizes', () => {
    const px = sheet(8, 8, [[0, 0]]);
    expect(sliceGrid(px, 8, 8, 0, 8)).toEqual([]);
    expect(sliceGrid(px, 8, 8, 8, -1)).toEqual([]);
    expect(sliceGrid(px, 0, 0, 8, 8)).toEqual([]);
  });
});

describe('guessFrameSize', () => {
  it('prefers 32 when it divides both dims', () => {
    expect(guessFrameSize(64, 32)).toBe(32);
    expect(guessFrameSize(96, 96)).toBe(32);
  });

  it('walks the divisor preference order 32,16,24,48,64,8', () => {
    expect(guessFrameSize(48, 16)).toBe(16);
    expect(guessFrameSize(72, 24)).toBe(24);
    expect(guessFrameSize(40, 8)).toBe(8);
  });

  it('falls back to the gcd of the dims', () => {
    expect(guessFrameSize(40, 20)).toBe(20);
  });

  it('falls back to 32 when the clamped gcd no longer divides both dims', () => {
    expect(guessFrameSize(143, 286)).toBe(32); // gcd 143 → clamp 128, 128 ∤ 143
    expect(guessFrameSize(6, 10)).toBe(32);    // gcd 2 → clamp 8, 8 ∤ 6
    expect(guessFrameSize(34, 22)).toBe(32);   // gcd 2 → clamp 8 would crop the sheet
  });

  it('keeps a clamped gcd that still divides both dims', () => {
    expect(guessFrameSize(20, 100)).toBe(20);  // gcd 20, in range, divides
  });

  it('returns 32 when the dims are coprime', () => {
    expect(guessFrameSize(35, 64)).toBe(32);
    expect(guessFrameSize(7, 13)).toBe(32);
  });

  it('always returns a divisor of both dims, or the 32 fallback', () => {
    let seed = 0x9e3779b9;
    const rand = (max: number): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed % max) + 1;
    };
    for (let i = 0; i < 500; i++) {
      const w = rand(512);
      const h = rand(512);
      const s = guessFrameSize(w, h);
      const divides = w % s === 0 && h % s === 0;
      expect(divides || s === 32, `guessFrameSize(${w}, ${h}) → ${s}`).toBe(true);
    }
  });
});
