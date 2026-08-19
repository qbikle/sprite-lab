import { describe, expect, it } from 'vitest';
import { BADGE_H, BADGE_W, badgeDoc, buildBadgePixels, type BadgeColors } from '../../src/ui/badge';
import { packRgba } from '../../src/core/pixels';

const COLORS: BadgeColors = {
  bg: packRgba(34, 36, 64, 255),
  border: packRgba(13, 14, 28, 255),
  text: packRgba(232, 230, 240, 255),
  accent: packRgba(255, 180, 84, 255),
  heart: packRgba(224, 85, 85, 255),
};

function count(pixels: Uint32Array, color: number): number {
  let n = 0;
  for (const v of pixels) if (v === color) n++;
  return n;
}

describe('buildBadgePixels', () => {
  it('is 88×31, fully opaque, and deterministic', () => {
    const a = buildBadgePixels(COLORS, true);
    const b = buildBadgePixels(COLORS, true);
    expect(a.length).toBe(BADGE_W * BADGE_H);
    expect(a.every((v) => v !== 0)).toBe(true);
    expect(a).toEqual(b);
  });

  it('draws border, text, name, and heart in their own colors', () => {
    const p = buildBadgePixels(COLORS, true);
    // border: full perimeter
    expect(count(p, COLORS.border)).toBe(2 * BADGE_W + 2 * (BADGE_H - 2));
    // "BUILT WITH" has a healthy pixel count
    expect(count(p, COLORS.text)).toBeGreaterThan(60);
    // "QBIKLE" at 2× dwarfs it (plus 4 corner studs)
    expect(count(p, COLORS.accent)).toBeGreaterThan(count(p, COLORS.text));
    // big heart = 46 filled cells of the 9×8 map
    expect(count(p, COLORS.heart)).toBe(46);
  });

  it('heart frames differ and only in heart-or-bg cells', () => {
    const big = buildBadgePixels(COLORS, true);
    const small = buildBadgePixels(COLORS, false);
    expect(count(small, COLORS.heart)).toBeLessThan(count(big, COLORS.heart));
    let diffs = 0;
    for (let i = 0; i < big.length; i++) {
      if (big[i] === small[i]) continue;
      diffs++;
      const pair = [big[i], small[i]];
      expect(pair).toContain(COLORS.heart);
      expect(pair.every((v) => v === COLORS.heart || v === COLORS.bg)).toBe(true);
    }
    expect(diffs).toBeGreaterThan(0);
  });
});

describe('badgeDoc', () => {
  it('round-trips into a real 2-frame doc with the beat tag', () => {
    const doc = badgeDoc(COLORS);
    expect(doc.width).toBe(BADGE_W);
    expect(doc.height).toBe(BADGE_H);
    expect(doc.frames.length).toBe(2);
    expect(doc.tags).toEqual([{ name: 'beat', from: 0, to: 1, mode: 'loop' }]);
    expect(doc.meta.name).toBe('badge');
    const f1 = doc.getCel(doc.celKeyAt(0, 0));
    const f2 = doc.getCel(doc.celKeyAt(0, 1));
    expect(f1).toBeDefined();
    expect(f2).toBeDefined();
    expect(Array.from(f1 ?? [])).toEqual(Array.from(buildBadgePixels(COLORS, true)));
    expect(Array.from(f2 ?? [])).toEqual(Array.from(buildBadgePixels(COLORS, false)));
  });
});
