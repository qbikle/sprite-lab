/** Uint32Array pixel-buffer ops. The ONLY place that packs/unpacks colors. */
import type { PixelPt, Rect, Rgba } from './contracts';

export function packRgba(r: number, g: number, b: number, a: number): Rgba {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export function unpackRgba(c: Rgba): [r: number, g: number, b: number, a: number] {
  return [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff];
}

/** '#rrggbb' when opaque, '#rrggbbaa' otherwise. */
export function rgbaToHex(c: Rgba): string {
  const [r, g, b, a] = unpackRgba(c);
  const hx = (v: number): string => v.toString(16).padStart(2, '0');
  const rgb = `#${hx(r)}${hx(g)}${hx(b)}`;
  return a === 255 ? rgb : rgb + hx(a);
}

/** Accepts #rgb, #rrggbb, #rrggbbaa (leading # optional). null when invalid. */
export function hexToRgba(hex: string): Rgba | null {
  const s = (hex.startsWith('#') ? hex.slice(1) : hex).toLowerCase();
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s)) return null;
  if (s.length === 3) {
    const r = parseInt(s.charAt(0) + s.charAt(0), 16);
    const g = parseInt(s.charAt(1) + s.charAt(1), 16);
    const b = parseInt(s.charAt(2) + s.charAt(2), 16);
    return packRgba(r, g, b, 255);
  }
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) : 255;
  return packRgba(r, g, b, a);
}

export function makeBuffer(w: number, h: number): Uint32Array {
  return new Uint32Array(w * h);
}

export function inRect(p: PixelPt, r: Rect): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
}

/** Clamp rect to a w×h buffer; null when nothing remains. */
export function clampRect(r: Rect, w: number, h: number): Rect | null {
  const x0 = Math.max(r.x, 0);
  const y0 = Math.max(r.y, 0);
  const x1 = Math.min(r.x + r.w, w);
  const y1 = Math.min(r.y + r.h, h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Copy of the sub-rect (rect assumed in-bounds). */
export function copyRect(src: Uint32Array, srcW: number, rect: Rect): Uint32Array {
  const out = new Uint32Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++) {
    const off = (rect.y + y) * srcW + rect.x;
    out.set(src.subarray(off, off + rect.w), y * rect.w);
  }
  return out;
}

/** Paste patch (rect.w×rect.h) into dst at rect (rect assumed in-bounds). */
export function pasteRect(dst: Uint32Array, dstW: number, rect: Rect, patch: Uint32Array): void {
  for (let y = 0; y < rect.h; y++) {
    const row = y * rect.w;
    dst.set(patch.subarray(row, row + rect.w), (rect.y + y) * dstW + rect.x);
  }
}

/** Bounding box of differing pixels between equal-size buffers; null if identical. */
export function diffBounds(a: Uint32Array, b: Uint32Array, w: number, h: number): Rect | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (a[i] === b[i]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
