/** Pan/zoom transform + screen↔pixel math. Pure state — callers emit camera:changed. */
import type { CameraView, PixelPt } from '../core/contracts';

export class Camera implements CameraView {
  static readonly STOPS: readonly number[] =
    [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

  /** Screen position (canvas CSS px) of doc origin. */
  panX = 0;
  panY = 0;
  zoom = 8;

  docToScreen(p: PixelPt): { x: number; y: number } {
    return { x: this.panX + p.x * this.zoom, y: this.panY + p.y * this.zoom };
  }

  /** Float doc coords from a screen point. */
  screenToDocF(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.panX) / this.zoom, y: (y - this.panY) / this.zoom };
  }

  /** Integer pixel under a screen point; null when outside the doc. */
  pixelAt(x: number, y: number, docW: number, docH: number): PixelPt | null {
    const d = this.screenToDocF(x, y);
    const px = Math.floor(d.x);
    const py = Math.floor(d.y);
    if (px < 0 || py < 0 || px >= docW || py >= docH) return null;
    return { x: px, y: py };
  }

  /** Step through STOPS keeping the screen pivot fixed on the same doc point. */
  zoomStep(dir: 1 | -1, pivotX: number, pivotY: number): void {
    const stops = Camera.STOPS;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      if (s === undefined) continue;
      const dist = Math.abs(s - this.zoom);
      if (dist < best) {
        best = dist;
        nearest = i;
      }
    }
    const next = stops[Math.min(stops.length - 1, Math.max(0, nearest + dir))];
    if (next === undefined) return;
    this.applyZoom(next, pivotX, pivotY);
  }

  setZoom(z: number, pivotX: number, pivotY: number): void {
    const min = Camera.STOPS[0] ?? 0.25;
    const max = Camera.STOPS[Camera.STOPS.length - 1] ?? 64;
    this.applyZoom(Math.min(max, Math.max(min, z)), pivotX, pivotY);
  }

  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
  }

  /** Center the doc in the view at the largest whole-pixel stop that fits. */
  fit(docW: number, docH: number, viewW: number, viewH: number): void {
    let zoom = Camera.STOPS[0] ?? 0.25;
    for (const s of Camera.STOPS) {
      if (docW * s <= viewW * 0.85 && docH * s <= viewH * 0.85) zoom = s;
    }
    this.zoom = zoom;
    this.panX = (viewW - docW * zoom) / 2;
    this.panY = (viewH - docH * zoom) / 2;
  }

  private applyZoom(z: number, pivotX: number, pivotY: number): void {
    const d = this.screenToDocF(pivotX, pivotY);
    this.zoom = z;
    this.panX = pivotX - d.x * z;
    this.panY = pivotY - d.y * z;
  }
}
