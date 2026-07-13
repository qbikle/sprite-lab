/** core/ramps — shading ladder generation: clamps, lightness curve, hue drift. */
import { describe, expect, it } from 'vitest';
import { makeRamp } from '../../src/core/ramps';
import { packRgba, unpackRgba } from '../../src/core/pixels';

const BASE = packRgba(200, 80, 60, 255);  // warm red, L≈51
const TEAL = packRgba(40, 160, 150, 255);

function lightness(c: number): number {
  const [r, g, b] = unpackRgba(c);
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  return ((max + min) / 2) * 100;
}

function hue(c: number): number {
  const [r, g, b] = unpackRgba(c);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function angDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe('makeRamp', () => {
  it('clamps steps to 3..9 and returns exactly that many entries', () => {
    expect(makeRamp(BASE, 1)).toHaveLength(3);
    expect(makeRamp(BASE, 0)).toHaveLength(3);
    expect(makeRamp(BASE, 99)).toHaveLength(9);
    expect(makeRamp(BASE, 5)).toHaveLength(5);
    expect(makeRamp(BASE, 7)).toHaveLength(7);
  });

  it('lightness increases strictly dark→light', () => {
    for (const base of [BASE, TEAL]) {
      const ramp = makeRamp(base, 7);
      for (let i = 1; i < ramp.length; i++) {
        expect(lightness(ramp[i] ?? 0)).toBeGreaterThan(lightness(ramp[i - 1] ?? 0));
      }
    }
  });

  it('the middle entry sits nearest the base lightness', () => {
    const ramp = makeRamp(BASE, 5);
    const baseL = lightness(BASE);
    const dists = ramp.map((c) => Math.abs(lightness(c) - baseL));
    const nearest = dists.indexOf(Math.min(...dists));
    expect(nearest).toBe(2);
    expect(angDist(hue(ramp[2] ?? 0), hue(BASE))).toBeLessThan(3);
  });

  it('shadows drift cool (toward 240) and highlights warm (toward 60)', () => {
    for (const base of [BASE, TEAL]) {
      const ramp = makeRamp(base, 7);
      const h = hue(base);
      expect(angDist(hue(ramp[0] ?? 0), 240)).toBeLessThan(angDist(h, 240) - 2);
      expect(angDist(hue(ramp[6] ?? 0), 60)).toBeLessThan(angDist(h, 60) - 2);
    }
  });

  it('every entry is fully opaque', () => {
    for (const c of makeRamp(TEAL, 9)) {
      expect(unpackRgba(c)[3]).toBe(255);
    }
  });

  it('is deterministic', () => {
    expect(makeRamp(BASE, 6)).toEqual(makeRamp(BASE, 6));
    expect(makeRamp(TEAL, 9)).toEqual(makeRamp(TEAL, 9));
  });

  it('handles extreme bases without leaving 0..255 range', () => {
    for (const base of [packRgba(0, 0, 0, 255), packRgba(255, 255, 255, 255)]) {
      const ramp = makeRamp(base, 9);
      expect(ramp).toHaveLength(9);
      for (let i = 1; i < ramp.length; i++) {
        expect(lightness(ramp[i] ?? 0)).toBeGreaterThan(lightness(ramp[i - 1] ?? 0));
      }
    }
  });
});
