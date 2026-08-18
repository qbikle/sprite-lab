/**
 * Stamp — paints the active custom stamp (captured from a selection) centered
 * on the cursor. One staged pass per visited pixel, one 'stamp' command per
 * gesture. Hover shows a ghost preview of the stamp.
 *
 * The optional Bus is UI plumbing only (never doc access): it feeds the hover
 * position for the ghost (the viewport forwards pointer moves to tools only
 * while drawing) and carries the "no stamp yet" status hint.
 *
 * Symmetry: the stamp is staged at the primary center only — ctx.stage()
 * expands every staged pixel through the active symmetry, so each mirrored
 * center receives the mirrored stamp for free (Aseprite-style). Stamping at
 * symmetrySeeds() centers as well would double-expose flipped + unflipped
 * copies at every center, so the seeds path is deliberately not used here.
 */
import type { Bus } from '../core/bus';
import type { OverlayCtx, PixelPt, PointerInfo, ToolCtx, ToolId } from '../core/contracts';
import { activeStamp, type Stamp } from '../app/stamps';
import { Tool } from './tool';

export const NO_STAMP_HINT = 'no stamp yet — select pixels and press the stamp button';

export class StampTool extends Tool {
  readonly id: ToolId = 'stamp';
  readonly label = 'stamp';
  readonly hotkey = 'a';

  private readonly bus: Bus | null;
  private down = false;
  private last: PixelPt | null = null;
  private hover: PixelPt | null = null;
  private warned = false;
  private ghost: HTMLCanvasElement | null = null;
  private ghostFor: Stamp | null = null;

  /** Subscriptions live for the app's lifetime, like the tool itself. */
  constructor(bus?: Bus) {
    super();
    this.bus = bus ?? null;
    bus?.on('cursor:moved', ({ p }) => {
      this.hover = p;
    });
    bus?.on('tool:changed', ({ id }) => {
      if (id !== 'stamp') return;
      this.warned = false; // hint again once per activation
      if (activeStamp() === null) this.warn();
    });
  }

  override onDown(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void e;
    this.hover = p;
    const stamp = activeStamp();
    if (!stamp) {
      this.warn();
      return;
    }
    this.down = true;
    this.last = p;
    this.stampAt(ctx, stamp, p);
  }

  override onMove(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void e;
    this.hover = p;
    if (!this.down) return;
    const stamp = activeStamp();
    if (!stamp) return;
    if (this.last && this.last.x === p.x && this.last.y === p.y) return;
    this.last = p;
    this.stampAt(ctx, stamp, p);
  }

  override onUp(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void p;
    void e;
    if (!this.down) return;
    this.down = false;
    this.last = null;
    ctx.commitStage('stamp');
  }

  override onCancel(ctx: ToolCtx): void {
    if (!this.down) return;
    this.down = false;
    this.last = null;
    ctx.clearStage();
  }

  /** Ghost preview at the hover point (hidden mid-gesture — the staged pixels
   *  already preview the real thing there). */
  override drawOverlay(o: OverlayCtx): void {
    if (this.down) return;
    const stamp = activeStamp();
    const c = this.hover;
    if (!stamp || !c) return;
    const canvas = this.ghostCanvas(stamp);
    if (!canvas) return;
    const x0 = c.x - ((stamp.w - 1) >> 1);
    const y0 = c.y - ((stamp.h - 1) >> 1);
    const tl = o.camera.docToScreen({ x: x0, y: y0 });
    const br = o.camera.docToScreen({ x: x0 + stamp.w, y: y0 + stamp.h });
    const g = o.g;
    g.save();
    g.imageSmoothingEnabled = false;
    g.globalAlpha = 0.5;
    g.drawImage(canvas, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    g.restore();
  }

  /** Stage the stamp centered on c (even sizes bias up-left, brush-style),
   *  skipping transparent stamp pixels. */
  private stampAt(ctx: ToolCtx, stamp: Stamp, c: PixelPt): void {
    const x0 = c.x - ((stamp.w - 1) >> 1);
    const y0 = c.y - ((stamp.h - 1) >> 1);
    for (let y = 0; y < stamp.h; y++) {
      for (let x = 0; x < stamp.w; x++) {
        const v = stamp.pixels[y * stamp.w + x] ?? 0;
        if (v >>> 24 === 0) continue;
        ctx.stage({ x: x0 + x, y: y0 + y }, v);
      }
    }
  }

  private warn(): void {
    if (this.warned) return;
    this.warned = true;
    this.bus?.emit('status:message', { text: NO_STAMP_HINT });
  }

  /** Stamps are immutable, so the ghost caches per stamp identity. */
  private ghostCanvas(stamp: Stamp): HTMLCanvasElement | null {
    if (this.ghost && this.ghostFor === stamp) return this.ghost;
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = stamp.w;
    canvas.height = stamp.h;
    const g = canvas.getContext('2d');
    if (!g) return null;
    const img = g.createImageData(stamp.w, stamp.h);
    img.data.set(new Uint8ClampedArray(
      stamp.pixels.buffer, stamp.pixels.byteOffset, stamp.pixels.length * 4,
    ));
    g.putImageData(img, 0, 0);
    this.ghost = canvas;
    this.ghostFor = stamp;
    return canvas;
  }
}
