/** Selection mask helpers — DOM-free, shared by tools and commands. */
import type { PixelPt, Rect, SelectionState } from './contracts';
import { clampRect } from './pixels';

/** Mask with a filled rect (clamped); null when nothing remains. */
export function maskFromRect(r: Rect, w: number, h: number): SelectionState | null {
  const c = clampRect(r, w, h);
  if (!c) return null;
  const mask = new Uint8Array(w * h);
  for (let y = c.y; y < c.y + c.h; y++) {
    const row = y * w;
    mask.fill(1, row + c.x, row + c.x + c.w);
  }
  return { mask, bounds: c };
}

/** Mask from a closed polygon (lasso), even-odd scanline fill. null when empty. */
export function maskFromPolygon(pts: readonly PixelPt[], w: number, h: number): SelectionState | null {
  const n = pts.length;
  if (n < 3) return null;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  const mask = new Uint8Array(w * h);
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if (!a || !b) continue;
      if (a.y === b.y) continue;
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      if (yc < lo || yc >= hi) continue;
      xs.push(a.x + ((yc - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    const row = y * w;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = xs[i];
      const xb = xs[i + 1];
      if (xa === undefined || xb === undefined) break;
      const px0 = Math.max(0, Math.ceil(xa - 0.5));
      const px1 = Math.min(w - 1, Math.ceil(xb - 0.5) - 1);
      if (px1 >= px0) mask.fill(1, row + px0, row + px1 + 1);
    }
  }
  const bounds = tightBounds(mask, w, h);
  if (!bounds) return null;
  return { mask, bounds };
}

/** Full-doc mask. */
export function maskAll(w: number, h: number): SelectionState {
  const mask = new Uint8Array(w * h);
  mask.fill(1);
  return { mask, bounds: { x: 0, y: 0, w, h } };
}

/** Tight bounds of set bits; null when mask is empty. */
export function tightBounds(mask: Uint8Array, w: number, h: number): Rect | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!mask[i]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
