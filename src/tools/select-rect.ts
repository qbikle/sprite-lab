/** Rect marquee — drag a box, ⇧ square; on up → ctx.setSelection (click = deselect). */
import type { OverlayCtx, PixelPt, PointerInfo, Rect, ToolCtx, ToolId } from '../core/contracts';
import { maskFromRect } from '../core/selection';
import { Tool } from './tool';

export class SelectRectTool extends Tool {
  readonly id: ToolId = 'select-rect';
  readonly label = 'select';
  readonly hotkey = 'm';

  private down = false;
  private moved = false;
  private anchor: PixelPt = { x: 0, y: 0 };
  private cursor: PixelPt = { x: 0, y: 0 };

  override onDown(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void ctx; void e;
    this.down = true;
    this.moved = false;
    this.anchor = p;
    this.cursor = p;
  }

  override onMove(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void ctx;
    if (!this.down) return;
    this.track(p, e);
  }

  override onUp(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    if (!this.down) return;
    this.track(p, e);
    this.down = false;
    const r = box(this.anchor, this.cursor);
    if (!this.moved && r.w === 1 && r.h === 1) {
      ctx.setSelection(null, 'deselect');
      return;
    }
    const sel = maskFromRect(r, ctx.docW, ctx.docH);
    if (sel === null) ctx.setSelection(null, 'deselect');
    else ctx.setSelection(sel.mask, 'select rect');
  }

  override onCancel(ctx: ToolCtx): void {
    void ctx;
    this.down = false;
    this.moved = false;
  }

  override drawOverlay(o: OverlayCtx): void {
    if (!this.down) return;
    const r = box(this.anchor, this.cursor);
    const tl = o.camera.docToScreen({ x: r.x, y: r.y });
    const br = o.camera.docToScreen({ x: r.x + r.w, y: r.y + r.h });
    const g = o.g;
    g.save();
    g.strokeStyle = accentColor();
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.strokeRect(tl.x + 0.5, tl.y + 0.5, br.x - tl.x - 1, br.y - tl.y - 1);
    g.restore();
  }

  private track(p: PixelPt, e: PointerInfo): void {
    if (p.x !== this.anchor.x || p.y !== this.anchor.y) this.moved = true;
    this.cursor = e.shift ? constrainSquare(this.anchor, p) : p;
  }
}

function box(a: PixelPt, b: PixelPt): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x, b.x) - x + 1, h: Math.max(a.y, b.y) - y + 1 };
}

function constrainSquare(a: PixelPt, b: PixelPt): PixelPt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: a.x + Math.sign(dx) * d, y: a.y + Math.sign(dy) * d };
}

function accentColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ffb454';
}
