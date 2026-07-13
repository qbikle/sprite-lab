/** Line — brush-stamped Bresenham from anchor to cursor. ⇧ snaps to 45°. */
import type { PixelPt, ToolCtx, ToolId } from '../core/contracts';
import { stampLine } from './brush';
import { ShapeTool } from './shape';

const OCTANT = Math.PI / 4;

export class LineTool extends ShapeTool {
  readonly id: ToolId = 'line';
  readonly label = 'line';
  readonly hotkey = 'l';
  protected readonly commitLabel = 'line';

  /** ⇧ snaps to the nearest of the 8 cardinal/diagonal directions. */
  protected override constrain(a: PixelPt, b: PixelPt): PixelPt {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    const oct = Math.round(Math.atan2(dy, dx) / OCTANT);
    const ux = Math.round(Math.cos(oct * OCTANT));
    const uy = Math.round(Math.sin(oct * OCTANT));
    return { x: a.x + ux * d, y: a.y + uy * d };
  }

  protected stampShape(ctx: ToolCtx, a: PixelPt, b: PixelPt, filled: boolean): void {
    void filled;
    const color = ctx.color;
    stampLine(a, b, ctx.brushSize, (q) => ctx.stage(q, color));
  }
}
