import { describe, expect, it } from 'vitest';
import { bayerPass } from '../../src/tools/brush';

describe('bayerPass coverage', () => {
  it('bayer2 passes exactly half of a 4×4 region', () => {
    let on = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) if (bayerPass('bayer2', x, y)) on++;
    }
    expect(on).toBe(8);
  });

  it('bayer4 passes exactly half of an 8×8 region', () => {
    let on = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) if (bayerPass('bayer4', x, y)) on++;
    }
    expect(on).toBe(32);
  });

  it('bayer2 tile matches the [[0,2],[3,1]] matrix threshold', () => {
    expect(bayerPass('bayer2', 0, 0)).toBe(true);
    expect(bayerPass('bayer2', 1, 0)).toBe(false);
    expect(bayerPass('bayer2', 0, 1)).toBe(false);
    expect(bayerPass('bayer2', 1, 1)).toBe(true);
  });

  it('bayer4 tile matches the standard 4×4 matrix threshold', () => {
    const m = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(bayerPass('bayer4', x, y)).toBe(m[y]![x]! < 8);
      }
    }
  });
});

describe('bayerPass doc-space stability', () => {
  it('same coords always answer the same', () => {
    for (const mode of ['bayer2', 'bayer4'] as const) {
      for (let y = -3; y <= 3; y++) {
        for (let x = -3; x <= 3; x++) {
          expect(bayerPass(mode, x, y)).toBe(bayerPass(mode, x, y));
        }
      }
    }
  });

  it('pattern tiles with period n, including negative coords', () => {
    for (const [mode, n] of [['bayer2', 2], ['bayer4', 4]] as const) {
      for (let y = -8; y <= 8; y++) {
        for (let x = -8; x <= 8; x++) {
          const v = bayerPass(mode, x, y);
          expect(bayerPass(mode, x + n, y)).toBe(v);
          expect(bayerPass(mode, x, y + n)).toBe(v);
          expect(bayerPass(mode, ((x % n) + n) % n, ((y % n) + n) % n)).toBe(v);
        }
      }
    }
  });
});
