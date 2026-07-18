/** Sheet slicing: fixed grid cut + v1's alpha-scan row detection. Pure. */
import type { Rect } from '../core/contracts';
import { clampRect } from '../core/pixels';

export interface SheetSlice {
  rect: Rect;          // source rect in the sheet
  row: number;         // grid row (labeler groups by row)
  col: number;
}

/** v1 threshold: a cell counts as content when any pixel alpha > 8. */
const ALPHA_MIN = 8;

/** Divisor guesses in v1-preference order (32 was the v1 default). */
const SIZE_TRIES: readonly number[] = [32, 16, 24, 48, 64, 8];

function cellHasContent(pixels: Uint32Array, sheetW: number, rect: Rect): boolean {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const row = y * sheetW;
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const c = pixels[row + x] ?? 0;
      if (((c >>> 24) & 0xff) > ALPHA_MIN) return true;
    }
  }
  return false;
}

/** Cut a sheet into row-major cells; drop cells with no opaque pixels. */
export function sliceGrid(
  pixels: Uint32Array, sheetW: number, sheetH: number,
  frameW: number, frameH: number,
): SheetSlice[] {
  const out: SheetSlice[] = [];
  if (frameW <= 0 || frameH <= 0 || sheetW <= 0 || sheetH <= 0) return out;
  const cols = Math.floor(sheetW / frameW);
  const rows = Math.floor(sheetH / frameH);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rect = clampRect(
        { x: c * frameW, y: r * frameH, w: frameW, h: frameH },
        sheetW, sheetH,
      );
      if (!rect) continue;
      if (cellHasContent(pixels, sheetW, rect)) out.push({ rect, row: r, col: c });
    }
  }
  return out;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Guess a square frame size from the sheet dims (v1 default was 32).
 *  The guess always divides both dims, or is the 32 fallback — a clamped gcd
 *  that stops dividing (gcd 2 → 8) would crop the sheet. */
export function guessFrameSize(sheetW: number, sheetH: number): number {
  for (const size of SIZE_TRIES) {
    if (sheetW % size === 0 && sheetH % size === 0) return size;
  }
  const g = gcd(sheetW, sheetH);
  if (g > 1) {
    const clamped = Math.min(128, Math.max(8, g));
    if (sheetW % clamped === 0 && sheetH % clamped === 0) return clamped;
  }
  return 32;
}
