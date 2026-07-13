/** Ellipse — midpoint ellipse in the drag box, ⌥ filled, ⇧ circle. */
import type { PixelPt, Rgba, ToolCtx, ToolId } from '../core/contracts';
import { stampLine, stampRect } from './brush';
import { ShapeTool } from './shape';

export class EllipseTool extends ShapeTool {
  readonly id: ToolId = 'ellipse';
  readonly label = 'ellipse';
  readonly hotkey = 'o';
  protected readonly commitLabel = 'ellipse';

  protected stampShape(ctx: ToolCtx, a: PixelPt, b: PixelPt, filled: boolean): void {
    const color = ctx.color;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    if (x0 === x1 || y0 === y1) {
      stampLine({ x: x0, y: y0 }, { x: x1, y: y1 }, ctx.brushSize, (q) => ctx.stage(q, color));
      return;
    }
    if (filled) {
      const spans = new Map<number, { min: number; max: number }>();
      plotEllipseRect(x0, y0, x1, y1, (x, y) => {
        const s = spans.get(y);
        if (s === undefined) spans.set(y, { min: x, max: x });
        else {
          if (x < s.min) s.min = x;
          if (x > s.max) s.max = x;
        }
      });
      for (const [y, s] of spans) {
        for (let x = s.min; x <= s.max; x++) ctx.stage({ x, y }, color);
      }
      return;
    }
    const size = ctx.brushSize;
    plotEllipseRect(x0, y0, x1, y1, (x, y) => stampFootprint(ctx, { x, y }, size, color));
  }
}

/** Brush footprint at p, mirroring brush.ts stampAt. */
function stampFootprint(ctx: ToolCtx, p: PixelPt, size: number, color: Rgba): void {
  const r = stampRect(p, size);
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) ctx.stage({ x, y }, color);
  }
}

/** Midpoint ellipse fitted to an inclusive box (rect variant, after Zingl) —
 *  exact for even and odd spans, emits 4-way symmetric outline points. */
function plotEllipseRect(
  x0: number, y0: number, x1: number, y1: number,
  plot: (x: number, y: number) => void,
): void {
  const a = x1 - x0;
  const b = y1 - y0;
  const b1 = b & 1;
  let dx = 4 * (1 - a) * b * b;
  let dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  let yTop = y0 + ((b + 1) >> 1);
  let yBot = yTop - b1;
  const a8 = 8 * a * a;
  const b8 = 8 * b * b;
  let xl = x0;
  let xr = x1;
  do {
    plot(xr, yTop);
    plot(xl, yTop);
    plot(xl, yBot);
    plot(xr, yBot);
    const e2 = 2 * err;
    if (e2 <= dy) {
      yTop++;
      yBot--;
      dy += a8;
      err += dy;
    }
    if (e2 >= dx || 2 * err > dy) {
      xl++;
      xr--;
      dx += b8;
      err += dx;
    }
  } while (xl <= xr);
  while (yTop - yBot <= b) {
    plot(xl - 1, yTop);
    plot(xr + 1, yTop);
    yTop++;
    plot(xl - 1, yBot);
    plot(xr + 1, yBot);
    yBot--;
  }
}
