/** Screen-space overlays: doc border, pixel grid, symmetry axes, marching
 *  ants (selection + float), brush cursor outline. */
import type {
  CameraView, FloatBuffer, OverlayCtx, PixelPt, SelectionState, SymmetryMode,
} from '../core/contracts';
import { stampRect } from '../tools/brush';
import { themeColors } from './theme';

export interface OverlayOpts {
  docW: number;
  docH: number;
  grid: boolean;          // pixel grid (only drawn at zoom >= 4)
  hover: PixelPt | null;
  brushSize: number;      // cursor outline covers the brush footprint
  selection: SelectionState | null;
  float: FloatBuffer | null;
  symmetry: SymmetryMode;
  antPhase: number;       // css px, advances ~8fps; dash period is 8
  playing: boolean;       // ants suppressed while animating (contract)
}

export class Overlays {
  draw(o: OverlayCtx, opts: OverlayOpts): void {
    const g = o.g;
    const cam = o.camera;
    const dpr = window.devicePixelRatio || 1;
    const snap = (v: number): number => Math.round(v * dpr) / dpr;
    const colors = themeColors();
    const accent = colors.accent;

    const org = cam.docToScreen({ x: 0, y: 0 });
    const x0 = snap(org.x);
    const y0 = snap(org.y);
    const x1 = snap(org.x + opts.docW * cam.zoom);
    const y1 = snap(org.y + opts.docH * cam.zoom);

    this.frameRect(g, x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2, 1, colors.border);

    if (opts.grid && cam.zoom >= 4) {
      // grid follows --text so it stays visible on both themes
      this.drawGrid(g, cam, opts, org, dpr, colors.text);
    }

    if (opts.symmetry !== 'off') {
      this.drawSymmetry(g, cam, opts, snap, dpr, accent, x0, y0, x1, y1);
    }
    // while a float is live, its ants are the selection — drawing both outlines confuses
    if (opts.selection && !opts.float && !opts.playing) {
      const path = this.selectionOutline(cam, opts.selection, opts.docW, opts.docH, snap, dpr);
      this.strokeAnts(g, path, dpr, opts.antPhase);
    }
    if (opts.float && !opts.playing) {
      this.drawFloatAnts(g, cam, opts.float, snap, dpr, accent, opts.antPhase);
    }

    if (opts.hover) {
      this.drawCursor(g, cam, opts.hover, opts.brushSize, opts.docW, opts.docH, snap, accent);
    }
  }

  /**
   * Mask outline as merged doc-edge segments in one Path2D. Two scans over
   * the selection bounds (row-major for horizontal edges, column-major for
   * vertical); O(bounds area) per draw — fine at doc sizes ≤512², revisit
   * with an edge cache if docs ever grow past that.
   */
  private selectionOutline(
    cam: CameraView, sel: SelectionState, docW: number, docH: number,
    snap: (v: number) => number, dpr: number,
  ): Path2D {
    const path = new Path2D();
    const m = sel.mask;
    const b = sel.bounds;
    const bx0 = Math.max(0, b.x);
    const by0 = Math.max(0, b.y);
    const bx1 = Math.min(docW, b.x + b.w);
    const by1 = Math.min(docH, b.y + b.h);
    const half = 0.5 / dpr; // stroke centers land on device-pixel centers, inset into the mask
    const set = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < docW && y < docH && (m[y * docW + x] ?? 0) !== 0;
    const sx = (v: number): number => snap(cam.docToScreen({ x: v, y: 0 }).x);
    const sy = (v: number): number => snap(cam.docToScreen({ x: 0, y: v }).y);

    for (let y = by0; y < by1; y++) {
      let top = -1;
      let bot = -1;
      for (let x = bx0; x <= bx1; x++) {
        const on = x < bx1 && set(x, y);
        const topEdge = on && !set(x, y - 1);
        const botEdge = on && !set(x, y + 1);
        if (topEdge && top < 0) top = x;
        if (!topEdge && top >= 0) {
          const ly = sy(y) + half;
          path.moveTo(sx(top), ly);
          path.lineTo(sx(x), ly);
          top = -1;
        }
        if (botEdge && bot < 0) bot = x;
        if (!botEdge && bot >= 0) {
          const ly = sy(y + 1) - half;
          path.moveTo(sx(bot), ly);
          path.lineTo(sx(x), ly);
          bot = -1;
        }
      }
    }
    for (let x = bx0; x < bx1; x++) {
      let left = -1;
      let right = -1;
      for (let y = by0; y <= by1; y++) {
        const on = y < by1 && set(x, y);
        const leftEdge = on && !set(x - 1, y);
        const rightEdge = on && !set(x + 1, y);
        if (leftEdge && left < 0) left = y;
        if (!leftEdge && left >= 0) {
          const lx = sx(x) + half;
          path.moveTo(lx, sy(left));
          path.lineTo(lx, sy(y));
          left = -1;
        }
        if (rightEdge && right < 0) right = y;
        if (!rightEdge && right >= 0) {
          const lx = sx(x + 1) - half;
          path.moveTo(lx, sy(right));
          path.lineTo(lx, sy(y));
          right = -1;
        }
      }
    }
    return path;
  }

  /** Classic ants: solid dark underlay, then white dashes marching via antPhase. */
  private strokeAnts(
    g: CanvasRenderingContext2D, path: Path2D, dpr: number, antPhase: number,
  ): void {
    g.lineWidth = 1 / dpr;
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.setLineDash([]);
    g.stroke(path);
    g.strokeStyle = '#fff';
    g.setLineDash([4, 4]);
    g.lineDashOffset = -antPhase;
    g.stroke(path);
    g.setLineDash([]);
    g.lineDashOffset = 0;
  }

  private drawFloatAnts(
    g: CanvasRenderingContext2D, cam: CameraView, float: FloatBuffer,
    snap: (v: number) => number, dpr: number, accent: string, antPhase: number,
  ): void {
    const r = float.rect;
    const a = cam.docToScreen({ x: r.x, y: r.y });
    const b = cam.docToScreen({ x: r.x + r.w, y: r.y + r.h });
    const x = snap(a.x);
    const y = snap(a.y);
    const w = snap(b.x) - x;
    const h = snap(b.y) - y;
    if (w <= 0 || h <= 0) return;
    g.globalAlpha = 0.35;
    this.frameRect(g, x + 1, y + 1, w - 2, h - 2, 1, accent);
    g.globalAlpha = 1;
    const half = 0.5 / dpr;
    const path = new Path2D();
    path.rect(x + half, y + half, w - 2 * half, h - 2 * half);
    this.strokeAnts(g, path, dpr, antPhase);
  }

  private drawSymmetry(
    g: CanvasRenderingContext2D, cam: CameraView, opts: OverlayOpts,
    snap: (v: number) => number, dpr: number, accent: string,
    x0: number, y0: number, x1: number, y1: number,
  ): void {
    const half = 0.5 / dpr;
    const path = new Path2D();
    if (opts.symmetry === 'x' || opts.symmetry === 'quad') {
      const mx = snap(cam.docToScreen({ x: opts.docW / 2, y: 0 }).x) + half;
      path.moveTo(mx, y0);
      path.lineTo(mx, y1);
    }
    if (opts.symmetry === 'y' || opts.symmetry === 'quad') {
      const my = snap(cam.docToScreen({ x: 0, y: opts.docH / 2 }).y) + half;
      path.moveTo(x0, my);
      path.lineTo(x1, my);
    }
    g.lineWidth = 1 / dpr;
    g.strokeStyle = accent;
    g.globalAlpha = 0.5;
    g.setLineDash([6, 4]);
    g.stroke(path);
    g.setLineDash([]);
    g.globalAlpha = 1;
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
    docW: number, docH: number, snap: (v: number) => number, accent: string,
  ): void {
    const r = stampRect(hover, brushSize);
    // footprint clipped to doc bounds — the stamp never lands outside either
    const cx0 = Math.max(0, r.x);
    const cy0 = Math.max(0, r.y);
    const cx1 = Math.min(docW, r.x + r.w);
    const cy1 = Math.min(docH, r.y + r.h);
    if (cx1 <= cx0 || cy1 <= cy0) return;
    const a = cam.docToScreen({ x: cx0, y: cy0 });
    const b = cam.docToScreen({ x: cx1, y: cy1 });
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
