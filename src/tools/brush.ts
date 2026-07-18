/** Brush footprint + stroke walking, shared by pencil/eraser (dither joins in Wave 2). */
import type { PixelPt, Rect } from '../core/contracts';

export const BRUSH_MIN = 1;
export const BRUSH_MAX = 8;

const BAYER2 = Uint8Array.from([0, 2, 3, 1]);
const BAYER4 = Uint8Array.from([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);

/** Bayer gate for dither brushes: true = paint this doc pixel (50% coverage).
 *  Doc-space coords so pattern stays stable across strokes. */
export function bayerPass(mode: 'bayer2' | 'bayer4', x: number, y: number): boolean {
  const n = mode === 'bayer2' ? 2 : 4;
  const m = mode === 'bayer2' ? BAYER2 : BAYER4;
  const col = ((x % n) + n) % n;
  const row = ((y % n) + n) % n;
  return (m[row * n + col] ?? 0) < (n * n) / 2;
}

/** Square footprint centered on p (even sizes bias up-left, Aseprite-style). */
export function stampRect(p: PixelPt, size: number): Rect {
  const off = (size - 1) >> 1;
  return { x: p.x - off, y: p.y - off, w: size, h: size };
}

/** Scratch point handed to stamp callbacks — mutated in place per pixel so the
 *  stroke hot path allocates nothing. Callbacks must not retain it. */
const SCRATCH: PixelPt = { x: 0, y: 0 };

/** Stamp the brush footprint centered on (px, py); fn sees each covered pixel. */
export function stampAt(px: number, py: number, size: number, fn: (p: PixelPt) => void): void {
  const off = (size - 1) >> 1;
  const x0 = px - off;
  const y0 = py - off;
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      SCRATCH.x = x;
      SCRATCH.y = y;
      fn(SCRATCH);
    }
  }
}

/** Walk a Bresenham line from→to (from=null → just to), stamping the brush
 *  footprint at every step; fn receives each covered pixel (may repeat). */
export function stampLine(
  from: PixelPt | null, to: PixelPt, size: number,
  fn: (p: PixelPt) => void,
): void {
  if (from === null) {
    stampAt(to.x, to.y, size, fn);
    return;
  }
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - x);
  const dy = -Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1;
  const sy = y < to.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    stampAt(x, y, size, fn);
    if (x === to.x && y === to.y) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}
