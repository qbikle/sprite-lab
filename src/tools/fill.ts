/** Fill — contiguous flood by default, global same-color replace with Shift. */
import type { PixelPt, PointerInfo, Rgba, ToolCtx, ToolId } from '../core/contracts';
import { Tool } from './tool';

export class FillTool extends Tool {
  readonly id: ToolId = 'fill';
  readonly label = 'fill';
  readonly hotkey = 'g';

  override onDown(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    if (!ctx.inBounds(p)) return;
    const target = ctx.getCelPixel(p);
    if (target === ctx.color) return;
    const mask = ctx.selection ? ctx.selection.mask : null;
    if (mask && mask[p.y * ctx.docW + p.x] !== 1) return;
    const buf = ctx.readCel();
    if (e.shift) {
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === target && (!mask || mask[i] === 1)) buf[i] = ctx.color;
      }
    } else {
      floodFill(buf, ctx.docW, ctx.docH, ctx.symmetrySeeds(p), target, ctx.color, mask);
    }
    ctx.commitPixels(buf, e.shift ? 'global fill' : 'fill');
  }
}

/** Scanline flood from each seed: fill whole horizontal runs, seed rows
 *  above/below per run. A selection `mask` gates expansion — unselected pixels
 *  are barriers, so the flood can't cross a corridor outside the selection. */
export function floodFill(
  buf: Uint32Array, w: number, h: number,
  seeds: readonly PixelPt[], target: Rgba, replacement: Rgba,
  mask: Uint8Array | null = null,
): void {
  const fillable = (i: number): boolean =>
    buf[i] === target && (mask === null || mask[i] === 1);
  const stack: number[] = [];
  for (const s of seeds) {
    if (s.x < 0 || s.y < 0 || s.x >= w || s.y >= h) continue;
    const i = s.y * w + s.x;
    if (fillable(i)) stack.push(i);
  }
  const seedRuns = (rowStart: number, x0: number, x1: number): void => {
    let inRun = false;
    for (let x = x0; x <= x1; x++) {
      if (fillable(rowStart + x)) {
        if (!inRun) { stack.push(rowStart + x); inRun = true; }
      } else {
        inRun = false;
      }
    }
  };
  while (stack.length > 0) {
    const seed = stack.pop();
    if (seed === undefined || !fillable(seed)) continue;
    const y = (seed / w) | 0;
    const rowStart = y * w;
    let x0 = seed - rowStart;
    let x1 = x0;
    while (x0 > 0 && fillable(rowStart + x0 - 1)) x0--;
    while (x1 < w - 1 && fillable(rowStart + x1 + 1)) x1++;
    for (let i = rowStart + x0; i <= rowStart + x1; i++) buf[i] = replacement;
    if (y > 0) seedRuns(rowStart - w, x0, x1);
    if (y < h - 1) seedRuns(rowStart + w, x0, x1);
  }
}
