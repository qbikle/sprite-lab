/** Uint32Array pixel-buffer ops. The ONLY place that packs/unpacks colors. */
import type { Rect, Rgba } from './contracts';

/** a=0 normalizes to 0 — one canonical transparent, no phantom rgb ghosts. */
export function packRgba(r: number, g: number, b: number, a: number): Rgba {
  if (a === 0) return 0;
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

/** Straight-alpha src-over with the src alpha pre-scaled by `opacity` (0..1). */
export function overRgbaScaled(dst: Rgba, src: Rgba, opacity: number): Rgba {
  const sa = (((src >>> 24) & 0xff) / 255) * opacity;
  if (sa <= 0) return dst;
  const da = ((dst >>> 24) & 0xff) / 255;
  const oa = sa + da * (1 - sa);
  const dw = da * (1 - sa);
  const r = Math.round(((src & 0xff) * sa + (dst & 0xff) * dw) / oa);
  const g = Math.round((((src >>> 8) & 0xff) * sa + ((dst >>> 8) & 0xff) * dw) / oa);
  const b = Math.round((((src >>> 16) & 0xff) * sa + ((dst >>> 16) & 0xff) * dw) / oa);
  return packRgba(r, g, b, Math.round(oa * 255));
}

/** Packed straight-alpha src-over blend of src onto dst. */
export function overRgba(dst: Rgba, src: Rgba): Rgba {
  return overRgbaScaled(dst, src, 1);
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

/** Nearest-neighbor upscale by an integer factor: every source pixel becomes a
 *  factor×factor block. Pure — src is never touched; factor 1 returns a copy.
 *  Allocation-exact: exactly one (w·factor)×(h·factor) buffer. */
export function upscaleNearest(src: Uint32Array, w: number, h: number, factor: number): Uint32Array {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new RangeError(`upscaleNearest: factor must be an integer >= 1, got ${factor}`);
  }
  if (src.length !== w * h) {
    throw new RangeError(`upscaleNearest: src length ${src.length} != ${w}x${h}`);
  }
  if (factor === 1) return new Uint32Array(src);
  const ow = w * factor;
  const out = new Uint32Array(ow * h * factor);
  for (let y = 0; y < h; y++) {
    const srcOff = y * w;
    const rowOff = y * factor * ow;
    for (let x = 0; x < w; x++) {
      const v = src[srcOff + x] ?? 0;
      const o = rowOff + x * factor;
      for (let i = 0; i < factor; i++) out[o + i] = v;
    }
    const row = out.subarray(rowOff, rowOff + ow);
    for (let i = 1; i < factor; i++) out.set(row, rowOff + i * ow);
  }
  return out;
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
