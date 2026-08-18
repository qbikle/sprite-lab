/** app/daily — the deterministic daily dare (pure, DOM-free). */
import { describe, expect, it } from 'vitest';
import { DAILY_ADJECTIVES, DAILY_NOUNS, dailySeed } from '../../src/app/daily';
import { unpackRgba } from '../../src/core/pixels';

/** Test-local HSL (mirrors the generator's private math) for range checks. */
function hslOf(c: number): [h: number, s: number, l: number] {
  const [r, g, b] = unpackRgba(c);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s * 100, l * 100];
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

describe('dailySeed', () => {
  it('is deterministic: the same local date twice → identical output', () => {
    const a = dailySeed(new Date(2026, 7, 18, 9, 30));
    const b = dailySeed(new Date(2026, 7, 18, 23, 59)); // same day, other time
    expect(a).toEqual(b);
    expect(a.date).toBe('2026-08-18');
  });

  it('differs across dates', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const s = dailySeed(new Date(2026, 0, 1 + i));
      seen.add(`${s.prompt}|${s.colors.join(',')}`);
    }
    // prompts may occasionally repeat; the full seed should not collapse
    expect(seen.size).toBeGreaterThan(25);
  });

  it('curated lists: ≥24 bare lowercase words each, no baked-in articles', () => {
    expect(DAILY_ADJECTIVES.length).toBeGreaterThanOrEqual(24);
    expect(DAILY_NOUNS.length).toBeGreaterThanOrEqual(24);
    for (const w of [...DAILY_ADJECTIVES, ...DAILY_NOUNS]) {
      expect(w).toMatch(/^[a-z]+$/);
    }
    expect(new Set(DAILY_ADJECTIVES).size).toBe(DAILY_ADJECTIVES.length);
    expect(new Set(DAILY_NOUNS).size).toBe(DAILY_NOUNS.length);
  });

  it('60 consecutive dates: 4 distinct opaque colors in sane HSL ranges, article correct', () => {
    for (let i = 0; i < 60; i++) {
      const s = dailySeed(new Date(2026, 2, 1 + i));

      // prompt: '<a|an> <adjective> <noun>' from the curated lists
      const parts = s.prompt.split(' ');
      expect(parts).toHaveLength(3);
      const [article, adj, noun] = parts as [string, string, string];
      expect(DAILY_ADJECTIVES).toContain(adj);
      expect(DAILY_NOUNS).toContain(noun);
      expect(article).toBe(/^[aeiou]/.test(adj) ? 'an' : 'a');

      // colors: 4, all opaque, none transparent, all distinct
      expect(s.colors).toHaveLength(4);
      expect(new Set(s.colors).size).toBe(4);
      for (const c of s.colors) {
        expect(c).not.toBe(0);
        expect(unpackRgba(c)[3]).toBe(255);
      }

      // lightness ladder: dark shade < mid tone < light tone; accent between
      const [dark, mid, light, accent] = s.colors as [number, number, number, number];
      const [, , dl] = hslOf(dark);
      const [mh, , ml] = hslOf(mid);
      const [, , ll] = hslOf(light);
      const [ah, , al] = hslOf(accent);
      expect(dl).toBeGreaterThan(10);
      expect(dl).toBeLessThan(35);
      expect(ml).toBeGreaterThan(35);
      expect(ml).toBeLessThan(60);
      expect(ll).toBeGreaterThan(65);
      expect(ll).toBeLessThan(90);
      expect(al).toBeGreaterThan(40);
      expect(al).toBeLessThan(70);
      // the accent sits across the wheel — never a near-black/base collision
      expect(hueDist(ah, mh)).toBeGreaterThan(90);
      expect(accent).not.toBe(dark);
    }
  });
});
