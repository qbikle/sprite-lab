/** Rectangle — outline with brush size, ⌥ filled, ⇧ square. */
import type { PixelPt, ToolCtx, ToolId } from '../core/contracts';
import { stampLine } from './brush';
import { ShapeTool } from './shape';

export class RectTool extends ShapeTool {
  readonly id: ToolId = 'rect';
  readonly label = 'rect';
  readonly hotkey = 'r';
  protected readonly commitLabel = 'rect';

  protected stampShape(ctx: ToolCtx, a: PixelPt, b: PixelPt, filled: boolean): void {
    const color = ctx.color;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    if (filled) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) ctx.stage({ x, y }, color);
      }
      return;
    }
    const put = (q: PixelPt): void => ctx.stage(q, color);
    const size = ctx.brushSize;
    stampLine({ x: x0, y: y0 }, { x: x1, y: y0 }, size, put);
    stampLine({ x: x1, y: y0 }, { x: x1, y: y1 }, size, put);
    stampLine({ x: x1, y: y1 }, { x: x0, y: y1 }, size, put);
    stampLine({ x: x0, y: y1 }, { x: x0, y: y0 }, size, put);
  }
}
