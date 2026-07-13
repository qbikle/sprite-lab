/** Shared drag-a-shape gesture: anchor on down, live preview via clearStage()
 *  + restamp on every move, one committed command on up.
 *  ⇧ constrains to square/circle · ⌥ fills. */
import type { PixelPt, PointerInfo, ToolCtx } from '../core/contracts';
import { Tool } from './tool';

export abstract class ShapeTool extends Tool {
  private down = false;
  private anchor: PixelPt = { x: 0, y: 0 };

  protected abstract readonly commitLabel: string;

  /** Stamp the shape from anchor→p (already constrained) into ctx.stage. */
  protected abstract stampShape(ctx: ToolCtx, a: PixelPt, b: PixelPt, filled: boolean): void;

  /** ⇧ constraint: snap b so |dx| == |dy| (square/circle). LineTool overrides. */
  protected constrain(a: PixelPt, b: PixelPt): PixelPt {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: a.x + Math.sign(dx) * d, y: a.y + Math.sign(dy) * d };
  }

  override onDown(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    this.down = true;
    this.anchor = p;
    this.stampShape(ctx, this.anchor, this.end(p, e), e.alt);
  }

  override onMove(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    if (!this.down) return;
    ctx.clearStage();
    this.stampShape(ctx, this.anchor, this.end(p, e), e.alt);
  }

  override onUp(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    if (!this.down) return;
    ctx.clearStage();
    this.stampShape(ctx, this.anchor, this.end(p, e), e.alt);
    ctx.commitStage(this.commitLabel);
    this.down = false;
  }

  override onCancel(ctx: ToolCtx): void {
    if (!this.down) return;
    ctx.clearStage();
    this.down = false;
  }

  private end(p: PixelPt, e: PointerInfo): PixelPt {
    return e.shift ? this.constrain(this.anchor, p) : p;
  }
}
