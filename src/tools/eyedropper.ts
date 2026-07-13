/** Eyedropper — picks from the composite on down/drag. */
import type { PixelPt, PointerInfo, ToolCtx, ToolId } from '../core/contracts';
import { Tool } from './tool';

export class EyedropperTool extends Tool {
  readonly id: ToolId = 'eyedropper';
  readonly label = 'eyedropper';
  readonly hotkey = 'i';

  private down = false;

  override onDown(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void e;
    this.down = true;
    this.pick(ctx, p);
  }

  override onMove(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void e;
    if (this.down) this.pick(ctx, p);
  }

  override onUp(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void ctx; void p; void e;
    this.down = false;
  }

  override onCancel(ctx: ToolCtx): void {
    void ctx;
    this.down = false;
  }

  private pick(ctx: ToolCtx, p: PixelPt): void {
    if (ctx.inBounds(p)) ctx.setColor(ctx.pickColor(p));
  }
}
