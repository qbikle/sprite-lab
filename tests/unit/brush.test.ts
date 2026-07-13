import { describe, expect, it } from 'vitest';
import type { PixelPt } from '../../src/core/contracts';
import { stampLine, stampRect } from '../../src/tools/brush';

function collect(from: PixelPt | null, to: PixelPt, size: number): PixelPt[] {
  const pts: PixelPt[] = [];
  stampLine(from, to, size, (p) => pts.push({ x: p.x, y: p.y }));
  return pts;
}

const key = (p: PixelPt): string => `${p.x},${p.y}`;

describe('stampRect', () => {
  it('size 1 is the point itself', () => {
    expect(stampRect({ x: 5, y: 7 }, 1)).toEqual({ x: 5, y: 7, w: 1, h: 1 });
  });

  it('odd sizes are symmetric around the point', () => {
    expect(stampRect({ x: 5, y: 5 }, 3)).toEqual({ x: 4, y: 4, w: 3, h: 3 });
    expect(stampRect({ x: 5, y: 5 }, 5)).toEqual({ x: 3, y: 3, w: 5, h: 5 });
    expect(stampRect({ x: 0, y: 0 }, 7)).toEqual({ x: -3, y: -3, w: 7, h: 7 });
  });

  it('even sizes bias up-left: p plus extra pixels right/down', () => {
    expect(stampRect({ x: 5, y: 5 }, 2)).toEqual({ x: 5, y: 5, w: 2, h: 2 });
    expect(stampRect({ x: 5, y: 5 }, 4)).toEqual({ x: 4, y: 4, w: 4, h: 4 });
    expect(stampRect({ x: 5, y: 5 }, 8)).toEqual({ x: 2, y: 2, w: 8, h: 8 });
  });
});

describe('stampLine', () => {
  it('from=null stamps a single footprint at to', () => {
    const pts = collect(null, { x: 5, y: 5 }, 2);
    expect(new Set(pts.map(key))).toEqual(new Set(['5,5', '6,5', '5,6', '6,6']));
    expect(pts).toHaveLength(4);
  });

  it('from equal to to stamps the point exactly once', () => {
    const pts = collect({ x: 2, y: 2 }, { x: 2, y: 2 }, 1);
    expect(pts).toEqual([{ x: 2, y: 2 }]);
  });

  it('diagonal covers every step with no gaps', () => {
    const pts = collect({ x: 0, y: 0 }, { x: 5, y: 3 }, 1);
    expect(pts).toHaveLength(6);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 5, y: 3 });
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const cheb = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      expect(cheb).toBe(1);
    }
  });

  it('steep and reversed lines reach both endpoints without gaps', () => {
    for (const [from, to] of [
      [{ x: 0, y: 0 }, { x: 2, y: 7 }],
      [{ x: 5, y: 3 }, { x: 0, y: 0 }],
      [{ x: 4, y: 0 }, { x: 0, y: 4 }],
    ] as const) {
      const pts = collect(from, to, 1);
      expect(pts).toHaveLength(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) + 1);
      expect(pts[0]).toEqual(from);
      expect(pts[pts.length - 1]).toEqual(to);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        expect(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))).toBe(1);
      }
    }
  });

  it('size >1 sweeps the full footprint along the path', () => {
    const covered = new Set(collect({ x: 0, y: 0 }, { x: 4, y: 0 }, 3).map(key));
    for (let y = -1; y <= 1; y++) {
      for (let x = -1; x <= 5; x++) expect(covered.has(`${x},${y}`)).toBe(true);
    }
    expect(covered.size).toBe(7 * 3);
  });
});
