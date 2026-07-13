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
    const buf = ctx.readCel();
    if (e.shift) {
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === target) buf[i] = ctx.color;
      }
    } else {
      floodFill(buf, ctx.docW, ctx.docH, p, target, ctx.color);
    }
    ctx.commitPixels(buf, e.shift ? 'global fill' : 'fill');
  }
}

/** Scanline flood: fill whole horizontal runs, seed rows above/below per run. */
function floodFill(
  buf: Uint32Array, w: number, h: number,
  start: PixelPt, target: Rgba, replacement: Rgba,
): void {
  const stack: number[] = [start.y * w + start.x];
  const seedRuns = (rowStart: number, x0: number, x1: number): void => {
    let inRun = false;
    for (let x = x0; x <= x1; x++) {
      if (buf[rowStart + x] === target) {
        if (!inRun) { stack.push(rowStart + x); inRun = true; }
      } else {
        inRun = false;
      }
    }
  };
  while (stack.length > 0) {
    const seed = stack.pop();
    if (seed === undefined || buf[seed] !== target) continue;
    const y = (seed / w) | 0;
    const rowStart = y * w;
    let x0 = seed - rowStart;
    let x1 = x0;
    while (x0 > 0 && buf[rowStart + x0 - 1] === target) x0--;
    while (x1 < w - 1 && buf[rowStart + x1 + 1] === target) x1++;
    for (let i = rowStart + x0; i <= rowStart + x1; i++) buf[i] = replacement;
    if (y > 0) seedRuns(rowStart - w, x0, x1);
    if (y < h - 1) seedRuns(rowStart + w, x0, x1);
  }
}
