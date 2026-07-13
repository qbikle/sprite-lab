/** Abstract Tool — the polymorphic contract every tool implements.
 *  Tools receive a ToolCtx and never touch doc/canvas/DOM directly. */
import type { OverlayCtx, PixelPt, PointerInfo, Rgba, ToolCtx, ToolId } from '../core/contracts';
import { stampLine } from './brush';

export abstract class Tool {
  abstract readonly id: ToolId;
  abstract readonly label: string;
  abstract readonly hotkey: string;

  /* Default no-ops so simple tools override only what they need. */
  onDown(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void { void ctx; void p; void e; }
  onMove(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void { void ctx; void p; void e; }
  onUp(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void { void ctx; void p; void e; }
  onCancel(ctx: ToolCtx): void { void ctx; }
  drawOverlay(o: OverlayCtx): void { void o; }
}

/** Shared drag-to-stroke gesture: pencil paints ctx.color, eraser paints 0.
 *  One staged buffer per stroke, committed as a single command on up. */
export abstract class StrokeTool extends Tool {
  private down = false;
  private last: PixelPt | null = null;

  protected abstract readonly commitLabel: string;
  protected abstract strokeColor(ctx: ToolCtx): Rgba;

  override onDown(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void e;
    this.down = true;
    this.stampTo(ctx, p);
  }

  override onMove(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void e;
    if (!this.down) return;
    this.stampTo(ctx, p);
  }

  override onUp(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void e;
    if (!this.down) return;
    this.stampTo(ctx, p);
    ctx.commitStage(this.commitLabel);
    this.reset();
  }

  override onCancel(ctx: ToolCtx): void {
    if (!this.down) return;
    ctx.clearStage();
    this.reset();
  }

  private stampTo(ctx: ToolCtx, p: PixelPt): void {
    const color = this.strokeColor(ctx);
    stampLine(this.last, p, ctx.brushSize, (q) => ctx.stage(q, color));
    this.last = p;
  }

  private reset(): void {
    this.down = false;
    this.last = null;
  }
}
