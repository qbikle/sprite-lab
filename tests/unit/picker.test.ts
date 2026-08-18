import { describe, expect, it } from 'vitest';
import { hexToRgba, packRgba, rgbaToHex, unpackRgba } from '../../src/core/pixels';

/* picker.ts imports ui/modal.ts, whose DEV harness touches `window` at module
   scope — vitest runs in a node environment, so alias window before the
   (dynamic, non-hoisted) import. Only the pure exports are exercised here. */
(globalThis as { window?: unknown }).window = globalThis;
const { hsvToRgb, hsvaToRgba, rgbToHsv, rgbaToHsva } = await import('../../src/ui/picker');

describe('rgbToHsv edges', () => {
  it('black: v=0, s=0, hue reported 0 (undefined)', () => {
    expect(rgbToHsv(0, 0, 0)).toEqual([0, 0, 0]);
  });

  it('white: v=1, s=0, hue reported 0 (undefined)', () => {
    expect(rgbToHsv(255, 255, 255)).toEqual([0, 0, 1]);
  });

  it('greys: s=0, v scales, hue stays 0', () => {
    for (const g of [1, 64, 128, 200, 254]) {
      const [h, s, v] = rgbToHsv(g, g, g);
      expect(h).toBe(0);
      expect(s).toBe(0);
      expect(v).toBeCloseTo(g / 255, 12);
    }
  });

  it('full-sat corners land on exact hues', () => {
    expect(rgbToHsv(255, 0, 0)).toEqual([0, 1, 1]);
    expect(rgbToHsv(255, 255, 0)).toEqual([60, 1, 1]);
    expect(rgbToHsv(0, 255, 0)).toEqual([120, 1, 1]);
    expect(rgbToHsv(0, 255, 255)).toEqual([180, 1, 1]);
    expect(rgbToHsv(0, 0, 255)).toEqual([240, 1, 1]);
    expect(rgbToHsv(255, 0, 255)).toEqual([300, 1, 1]);
  });
});

describe('hsvToRgb', () => {
  it('primaries and edges', () => {
    expect(hsvToRgb(0, 1, 1)).toEqual([255, 0, 0]);
    expect(hsvToRgb(120, 1, 1)).toEqual([0, 255, 0]);
    expect(hsvToRgb(240, 1, 1)).toEqual([0, 0, 255]);
    expect(hsvToRgb(0, 0, 1)).toEqual([255, 255, 255]);
    expect(hsvToRgb(180, 1, 0)).toEqual([0, 0, 0]);
  });

  it('hue wraps mod 360 (h=360, 720, negative)', () => {
    expect(hsvToRgb(360, 1, 1)).toEqual([255, 0, 0]);
    expect(hsvToRgb(720 + 120, 1, 1)).toEqual([0, 255, 0]);
    expect(hsvToRgb(-120, 1, 1)).toEqual([0, 0, 255]);
  });
});

describe('rgb → hsv → rgb round-trips exactly', () => {
  it('over a channel grid including 0/255 edges', () => {
    const grid = [0, 1, 17, 51, 128, 200, 254, 255];
    for (const r of grid) {
      for (const g of grid) {
        for (const b of grid) {
          const [h, s, v] = rgbToHsv(r, g, b);
          expect(hsvToRgb(h, s, v)).toEqual([r, g, b]);
        }
      }
    }
  });
});

describe('packed hsva helpers', () => {
  it('preserves alpha through the round-trip', () => {
    for (const a of [1, 63, 128, 254, 255]) {
      const c = packRgba(180, 90, 30, a);
      const [h, s, v, ca] = rgbaToHsva(c);
      expect(ca).toBe(a);
      expect(hsvaToRgba(h, s, v, ca)).toBe(c);
    }
  });

  it('a=0 collapses to canonical transparent 0', () => {
    expect(hsvaToRgba(200, 0.5, 0.5, 0)).toBe(0);
  });

  it('opaque black round-trips (the initial:0 seed shape)', () => {
    const black = packRgba(0, 0, 0, 255);
    const [h, s, v, a] = rgbaToHsva(black);
    expect([h, s, v, a]).toEqual([0, 0, 0, 255]);
    expect(hsvaToRgba(h, s, v, a)).toBe(black);
  });
});

describe('hex parse/format (picker field contract)', () => {
  it('6-digit: parse → pack → format round-trips', () => {
    const c = hexToRgba('#3366aa');
    expect(c).not.toBeNull();
    if (c === null) return;
    expect(unpackRgba(c)).toEqual([0x33, 0x66, 0xaa, 255]);
    expect(rgbaToHex(c)).toBe('#3366aa');
  });

  it('8-digit: alpha survives parse and formats back to 8 digits', () => {
    const c = hexToRgba('#3366aa80');
    expect(c).not.toBeNull();
    if (c === null) return;
    expect(unpackRgba(c)).toEqual([0x33, 0x66, 0xaa, 0x80]);
    expect(rgbaToHex(c)).toBe('#3366aa80');
  });

  it('opaque formats as 6 digits, never 8', () => {
    expect(rgbaToHex(packRgba(255, 0, 0, 255))).toBe('#ff0000');
  });
});
