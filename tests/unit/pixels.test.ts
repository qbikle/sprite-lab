/** core/pixels — packing, hex, rect ops, diffBounds. */
import { describe, expect, it } from 'vitest';
import {
  clampRect, copyRect, diffBounds, hexToRgba, inRect, makeBuffer,
  packRgba, pasteRect, rgbaToHex, unpackRgba,
} from '../../src/core/pixels';

describe('packRgba / unpackRgba', () => {
  it('packs little-endian ABGR', () => {
    expect(packRgba(0x11, 0x22, 0x33, 0x44)).toBe(0x44332211);
    expect(packRgba(255, 255, 255, 255)).toBe(0xffffffff);
    expect(packRgba(0, 0, 0, 0)).toBe(0);
  });

  it('stays an unsigned u32', () => {
    expect(packRgba(0, 0, 0, 255)).toBeGreaterThan(0);
    expect(packRgba(255, 255, 255, 255)).toBeGreaterThan(0);
  });

  it('round-trips including alpha edges 0 and 255', () => {
    const cases: Array<[number, number, number, number]> = [
      [0, 0, 0, 0],
      [255, 255, 255, 255],
      [12, 34, 56, 0],
      [1, 2, 3, 255],
      [200, 100, 50, 128],
    ];
    for (const [r, g, b, a] of cases) {
      expect(unpackRgba(packRgba(r, g, b, a))).toEqual([r, g, b, a]);
    }
  });
});

describe('rgbaToHex / hexToRgba', () => {
  it('formats #rrggbb when opaque, #rrggbbaa otherwise', () => {
    expect(rgbaToHex(packRgba(255, 0, 77, 255))).toBe('#ff004d');
    expect(rgbaToHex(packRgba(255, 0, 77, 128))).toBe('#ff004d80');
    expect(rgbaToHex(packRgba(0, 0, 0, 0))).toBe('#00000000');
  });

  it('parses #rgb, #rrggbb, #rrggbbaa, # optional, case-insensitive', () => {
    expect(hexToRgba('#ff004d')).toBe(packRgba(255, 0, 77, 255));
    expect(hexToRgba('ff004d')).toBe(packRgba(255, 0, 77, 255));
    expect(hexToRgba('#FF004D')).toBe(packRgba(255, 0, 77, 255));
    expect(hexToRgba('#f0a')).toBe(packRgba(0xff, 0x00, 0xaa, 255));
    expect(hexToRgba('F0A')).toBe(packRgba(0xff, 0x00, 0xaa, 255));
    expect(hexToRgba('#ff004d80')).toBe(packRgba(255, 0, 77, 128));
  });

  it('round-trips hex → rgba → hex', () => {
    for (const hex of ['#ff004d', '#00e436', '#ff004d80', '#00000000']) {
      const c = hexToRgba(hex);
      expect(c).not.toBeNull();
      expect(rgbaToHex(c ?? 0)).toBe(hex);
    }
  });

  it('returns null on invalid input', () => {
    for (const bad of ['', '#', '#ff00', '#ggg', '#12345', '#ff004d8', 'nothex!', '#ff004d801']) {
      expect(hexToRgba(bad)).toBeNull();
    }
  });
});

describe('rect helpers', () => {
  it('inRect includes edges at x/y, excludes at x+w/y+h', () => {
    const r = { x: 1, y: 1, w: 2, h: 2 };
    expect(inRect({ x: 1, y: 1 }, r)).toBe(true);
    expect(inRect({ x: 2, y: 2 }, r)).toBe(true);
    expect(inRect({ x: 3, y: 2 }, r)).toBe(false);
    expect(inRect({ x: 0, y: 1 }, r)).toBe(false);
  });

  it('clampRect clips to bounds, null when empty', () => {
    expect(clampRect({ x: -2, y: -2, w: 4, h: 4 }, 8, 8)).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(clampRect({ x: 6, y: 6, w: 4, h: 4 }, 8, 8)).toEqual({ x: 6, y: 6, w: 2, h: 2 });
    expect(clampRect({ x: 10, y: 0, w: 4, h: 4 }, 8, 8)).toBeNull();
    expect(clampRect({ x: 0, y: 0, w: 0, h: 4 }, 8, 8)).toBeNull();
  });
});

describe('copyRect / pasteRect', () => {
  it('round-trips a sub-rect', () => {
    const src = makeBuffer(5, 4);
    for (let i = 0; i < src.length; i++) src[i] = i + 1;
    const rect = { x: 1, y: 1, w: 3, h: 2 };
    const patch = copyRect(src, 5, rect);
    expect(Array.from(patch)).toEqual([7, 8, 9, 12, 13, 14]);

    const dst = makeBuffer(5, 4);
    pasteRect(dst, 5, rect, patch);
    expect(Array.from(dst)).toEqual([
      0, 0, 0, 0, 0,
      0, 7, 8, 9, 0,
      0, 12, 13, 14, 0,
      0, 0, 0, 0, 0,
    ]);

    const scratch = new Uint32Array(src);
    scratch[7] = 999;
    scratch[12] = 999;
    pasteRect(scratch, 5, rect, patch);
    expect(Array.from(scratch)).toEqual(Array.from(src));
  });
});

describe('diffBounds', () => {
  it('returns the exact bounding rect of differing pixels', () => {
    const a = makeBuffer(8, 8);
    const b = makeBuffer(8, 8);
    b[3 * 8 + 2] = 1;
    b[6 * 8 + 5] = 2;
    expect(diffBounds(a, b, 8, 8)).toEqual({ x: 2, y: 3, w: 4, h: 4 });
  });

  it('returns a 1x1 rect for a single differing pixel', () => {
    const a = makeBuffer(4, 4);
    const b = makeBuffer(4, 4);
    b[0] = 7;
    expect(diffBounds(a, b, 4, 4)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('returns null when identical', () => {
    const a = makeBuffer(4, 4).fill(5);
    const b = makeBuffer(4, 4).fill(5);
    expect(diffBounds(a, b, 4, 4)).toBeNull();
  });
});
