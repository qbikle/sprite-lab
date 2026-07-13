/** core/selection — mask builders + tight bounds. */
import { describe, expect, it } from 'vitest';
import { maskAll, maskFromPolygon, maskFromRect, tightBounds } from '../../src/core/selection';

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('unexpected null');
  return v;
}

function rows(mask: Uint8Array, w: number, h: number): string[] {
  const out: string[] = [];
  for (let y = 0; y < h; y++) out.push([...mask.subarray(y * w, (y + 1) * w)].join(''));
  return out;
}

describe('maskFromRect', () => {
  it('fills an in-bounds rect with matching bounds', () => {
    const s = must(maskFromRect({ x: 1, y: 1, w: 2, h: 2 }, 4, 4));
    expect(s.bounds).toEqual({ x: 1, y: 1, w: 2, h: 2 });
    expect(rows(s.mask, 4, 4)).toEqual(['0000', '0110', '0110', '0000']);
  });

  it('clamps rects overhanging the doc edges', () => {
    const tl = must(maskFromRect({ x: -2, y: -2, w: 4, h: 4 }, 4, 4));
    expect(tl.bounds).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(rows(tl.mask, 4, 4)).toEqual(['1100', '1100', '0000', '0000']);

    const br = must(maskFromRect({ x: 2, y: 3, w: 10, h: 10 }, 4, 4));
    expect(br.bounds).toEqual({ x: 2, y: 3, w: 2, h: 1 });
    expect(rows(br.mask, 4, 4)).toEqual(['0000', '0000', '0000', '0011']);
  });

  it('returns null when the rect is clamped away', () => {
    expect(maskFromRect({ x: 5, y: 5, w: 2, h: 2 }, 4, 4)).toBeNull();
    expect(maskFromRect({ x: -9, y: 0, w: 3, h: 3 }, 4, 4)).toBeNull();
    expect(maskFromRect({ x: 1, y: 1, w: 0, h: 3 }, 4, 4)).toBeNull();
  });
});

describe('maskFromPolygon', () => {
  it('fills a right triangle sampled at pixel centers', () => {
    const s = must(maskFromPolygon([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }], 5, 5));
    expect(rows(s.mask, 5, 5)).toEqual(['11100', '11000', '10000', '00000', '00000']);
    expect(s.bounds).toEqual({ x: 0, y: 0, w: 3, h: 3 });
  });

  it('fills a concave L-shape with even-odd rule', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 },
      { x: 2, y: 2 }, { x: 2, y: 4 }, { x: 0, y: 4 },
    ];
    const s = must(maskFromPolygon(pts, 5, 5));
    expect(rows(s.mask, 5, 5)).toEqual(['11110', '11110', '11000', '11000', '00000']);
    expect(s.bounds).toEqual({ x: 0, y: 0, w: 4, h: 4 });
  });

  it('clamps a polygon overhanging the doc', () => {
    const pts = [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }];
    const s = must(maskFromPolygon(pts, 4, 4));
    expect(rows(s.mask, 4, 4)).toEqual(['1100', '1100', '0000', '0000']);
    expect(s.bounds).toEqual({ x: 0, y: 0, w: 2, h: 2 });
  });

  it('returns null for degenerate input', () => {
    expect(maskFromPolygon([], 4, 4)).toBeNull();
    expect(maskFromPolygon([{ x: 0, y: 0 }, { x: 3, y: 3 }], 4, 4)).toBeNull();
    expect(maskFromPolygon([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 0 }], 4, 4)).toBeNull();
    expect(maskFromPolygon([{ x: 10, y: 10 }, { x: 14, y: 10 }, { x: 10, y: 14 }], 4, 4)).toBeNull();
  });
});

describe('maskAll', () => {
  it('sets every bit with full-doc bounds', () => {
    const s = maskAll(3, 2);
    expect(rows(s.mask, 3, 2)).toEqual(['111', '111']);
    expect(s.bounds).toEqual({ x: 0, y: 0, w: 3, h: 2 });
  });
});

describe('tightBounds', () => {
  it('finds the min box around set bits', () => {
    const mask = new Uint8Array(16);
    mask[1 * 4 + 2] = 1;
    mask[3 * 4 + 1] = 1;
    expect(tightBounds(mask, 4, 4)).toEqual({ x: 1, y: 1, w: 2, h: 3 });
  });

  it('covers the full buffer when every bit is set', () => {
    expect(tightBounds(new Uint8Array(6).fill(1), 3, 2)).toEqual({ x: 0, y: 0, w: 3, h: 2 });
  });

  it('returns null for an empty mask', () => {
    expect(tightBounds(new Uint8Array(16), 4, 4)).toBeNull();
  });
});
