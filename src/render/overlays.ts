/** Screen-space overlays: doc border, pixel grid, brush cursor outline. */
import type { CameraView, OverlayCtx, PixelPt } from '../core/contracts';
import { stampRect } from '../tools/brush';

export interface OverlayOpts {
  docW: number;
  docH: number;
  grid: boolean;          // pixel grid (only drawn at zoom >= 4)
  hover: PixelPt | null;
  brushSize: number;      // cursor outline covers the brush footprint
}

export class Overlays {
  draw(o: OverlayCtx, opts: OverlayOpts): void {
    const g = o.g;
    const cam = o.camera;
    const dpr = window.devicePixelRatio || 1;
    const snap = (v: number): number => Math.round(v * dpr) / dpr;
    const styles = getComputedStyle(document.documentElement);

    const org = cam.docToScreen({ x: 0, y: 0 });
    const x0 = snap(org.x);
    const y0 = snap(org.y);
    const x1 = snap(org.x + opts.docW * cam.zoom);
    const y1 = snap(org.y + opts.docH * cam.zoom);

    const border = styles.getPropertyValue('--border').trim() || '#000';
    this.frameRect(g, x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2, 1, border);

    if (opts.grid && cam.zoom >= 4) {
      // grid follows --text so it stays visible on both themes
      const text = styles.getPropertyValue('--text').trim() || '#888';
      this.drawGrid(g, cam, opts, org, dpr, text);
    }

    if (opts.hover) {
      const accent = styles.getPropertyValue('--accent').trim() || '#ffb454';
      this.drawCursor(g, cam, opts.hover, opts.brushSize, snap, accent);
    }
  }

  private drawGrid(
    g: CanvasRenderingContext2D, cam: CameraView, opts: OverlayOpts,
    org: { x: number; y: number }, dpr: number, text: string,
  ): void {
    const z = cam.zoom;
    const t = 1 / dpr;
    const cssW = g.canvas.width / dpr;
    const cssH = g.canvas.height / dpr;
    const snap = (v: number): number => Math.round(v * dpr) / dpr;

    const gx0 = Math.max(1, Math.ceil((0 - org.x) / z));
    const gx1 = Math.min(opts.docW - 1, Math.floor((cssW - org.x) / z));
    const gy0 = Math.max(1, Math.ceil((0 - org.y) / z));
    const gy1 = Math.min(opts.docH - 1, Math.floor((cssH - org.y) / z));

    const sx0 = Math.max(0, snap(org.x));
    const sx1 = Math.min(cssW, snap(org.x + opts.docW * z));
    const sy0 = Math.max(0, snap(org.y));
    const sy1 = Math.min(cssH, snap(org.y + opts.docH * z));

    for (const major of [false, true]) {
      g.globalAlpha = major ? 0.32 : 0.16;
      g.fillStyle = text;
      for (let x = gx0; x <= gx1; x++) {
        if ((x % 8 === 0) !== major) continue;
        g.fillRect(snap(org.x + x * z), sy0, t, sy1 - sy0);
      }
      for (let y = gy0; y <= gy1; y++) {
        if ((y % 8 === 0) !== major) continue;
        g.fillRect(sx0, snap(org.y + y * z), sx1 - sx0, t);
      }
    }
    g.globalAlpha = 1;
  }

  private drawCursor(
    g: CanvasRenderingContext2D, cam: CameraView, hover: PixelPt, brushSize: number,
    snap: (v: number) => number, accent: string,
  ): void {
    const r = stampRect(hover, brushSize);
    const a = cam.docToScreen({ x: r.x, y: r.y });
    const b = cam.docToScreen({ x: r.x + r.w, y: r.y + r.h });
    const x = snap(a.x);
    const y = snap(a.y);
    const w = snap(b.x) - x;
    const h = snap(b.y) - y;
    this.frameRect(g, x - 1, y - 1, w + 2, h + 2, 1, accent);
    this.frameRect(g, x, y, w, h, 1, 'rgba(0,0,0,0.65)');
  }

  private frameRect(
    g: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, t: number, color: string,
  ): void {
    if (w <= 0 || h <= 0) return;
    g.fillStyle = color;
    g.fillRect(x, y, w, t);
    g.fillRect(x, y + h - t, w, t);
    if (h > 2 * t) {
      g.fillRect(x, y + t, t, h - 2 * t);
      g.fillRect(x + w - t, y + t, t, h - 2 * t);
    }
  }
}
