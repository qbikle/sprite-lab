/** Move — drag inside the selection lifts it into a float (ctx.liftSelection)
 *  and drags it; drops (anchor) happen on tool switch / Esc / draw, not on up. */
import type { PixelPt, PointerInfo, ToolCtx, ToolId } from '../core/contracts';
import { Tool } from './tool';

export class MoveTool extends Tool {
  readonly id: ToolId = 'move';
  readonly label = 'move';
  readonly hotkey = 'v';

  private dragging = false;
  private last: PixelPt = { x: 0, y: 0 };

  override onDown(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void e;
    if (ctx.float !== null) {
      this.dragging = true;
      this.last = p;
      return;
    }
    const sel = ctx.selection;
    if (sel === null || !ctx.inBounds(p)) return;
    if ((sel.mask[p.y * ctx.docW + p.x] ?? 0) === 0) return;
    ctx.liftSelection();
    this.dragging = true;
    this.last = p;
  }

  override onMove(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void e;
    if (!this.dragging) return;
    ctx.dragFloat(p.x - this.last.x, p.y - this.last.y);
    this.last = p;
  }

  override onUp(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void ctx; void p; void e;
    this.dragging = false;
  }

  override onCancel(ctx: ToolCtx): void {
    void ctx;
    this.dragging = false;
  }
}
