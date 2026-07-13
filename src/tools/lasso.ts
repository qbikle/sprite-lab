/** Lasso — freehand polygon, closed on up → ctx.setSelection. */
import type { OverlayCtx, PixelPt, PointerInfo, ToolCtx, ToolId } from '../core/contracts';
import { maskFromPolygon } from '../core/selection';
import { Tool } from './tool';

export class LassoTool extends Tool {
  readonly id: ToolId = 'lasso';
  readonly label = 'lasso';
  readonly hotkey = 'q';

  private down = false;
  private pts: PixelPt[] = [];

  override onDown(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void ctx; void e;
    this.down = true;
    this.pts = [p];
  }

  override onMove(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void ctx; void e;
    if (!this.down) return;
    this.push(p);
  }

  override onUp(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void {
    void e;
    if (!this.down) return;
    this.push(p);
    this.down = false;
    const pts = this.pts;
    this.pts = [];
    if (pts.length >= 3) {
      const sel = maskFromPolygon(pts, ctx.docW, ctx.docH);
      if (sel !== null) {
        ctx.setSelection(sel.mask, 'lasso select');
        return;
      }
    }
    ctx.setSelection(null, 'deselect');
  }

  override onCancel(ctx: ToolCtx): void {
    void ctx;
    this.down = false;
    this.pts = [];
  }

  override drawOverlay(o: OverlayCtx): void {
    const first = this.pts[0];
    const last = this.pts[this.pts.length - 1];
    if (!this.down || this.pts.length < 2 || first === undefined || last === undefined) return;
    const g = o.g;
    g.save();
    g.strokeStyle = accentColor();
    g.lineWidth = 1;
    g.beginPath();
    let started = false;
    for (const q of this.pts) {
      const s = o.camera.docToScreen({ x: q.x + 0.5, y: q.y + 0.5 });
      if (started) g.lineTo(s.x, s.y);
      else {
        g.moveTo(s.x, s.y);
        started = true;
      }
    }
    g.stroke();
    if (last.x !== first.x || last.y !== first.y) {
      const sl = o.camera.docToScreen({ x: last.x + 0.5, y: last.y + 0.5 });
      const sf = o.camera.docToScreen({ x: first.x + 0.5, y: first.y + 0.5 });
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(sl.x, sl.y);
      g.lineTo(sf.x, sf.y);
      g.stroke();
    }
    g.restore();
  }

  private push(p: PixelPt): void {
    const last = this.pts[this.pts.length - 1];
    if (last !== undefined && last.x === p.x && last.y === p.y) return;
    this.pts.push(p);
  }
}

function accentColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ffb454';
}
