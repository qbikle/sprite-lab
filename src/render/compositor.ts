/** Per-frame composite cache with dirty-rect invalidation. Reads doc, never mutates. */
import type { DirtyScope, FloatBuffer, Rect, StageBuffer } from '../core/contracts';
import type { SpriteDoc } from '../core/doc';

/** Straight-alpha src-over with layer opacity — duplicates doc.flattenFrame's
 *  blend so stage pixels can REPLACE the active layer without mutating the doc. */
function over(d: number, s: number, opacity: number): number {
  const sa = (((s >>> 24) & 0xff) / 255) * opacity;
  if (sa <= 0) return d;
  const da = ((d >>> 24) & 0xff) / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return 0;
  const k = da * (1 - sa);
  const r = Math.round(((s & 0xff) * sa + (d & 0xff) * k) / oa);
  const g = Math.round((((s >>> 8) & 0xff) * sa + ((d >>> 8) & 0xff) * k) / oa);
  const b = Math.round((((s >>> 16) & 0xff) * sa + ((d >>> 16) & 0xff) * k) / oa);
  return ((Math.round(oa * 255) << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export class Compositor {
  private doc: SpriteDoc;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private buf!: Uint32Array;
  private img!: ImageData;
  private allDirty = true;
  private dirtyRect: Rect | null = null;
  private lastFrame = -1;
  private stageActive = false;
  private floatActive = false;

  constructor(doc: SpriteDoc) {
    this.doc = doc;
    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) throw new Error('compositor: 2d context unavailable');
    this.ctx = ctx;
    this.alloc();
  }

  setDoc(doc: SpriteDoc): void {
    this.doc = doc;
    this.alloc();
    this.lastFrame = -1;
    this.stageActive = false;
    this.floatActive = false;
  }

  invalidate(scope: DirtyScope): void {
    if (scope.kind === 'cels') {
      // Wave 1: rects dirty the cache regardless of which frame owns the cel.
      for (const c of scope.cels) this.union(c.rect);
    } else {
      this.allDirty = true;
    }
  }

  /**
   * Canvas holding the flattened frame (doc.flattenFrame under the hood,
   * recomposited only in dirty rects). When stage is given, mask=1 pixels
   * REPLACE the active layer's cel in the composite (live tool preview).
   * When float is given, its pixels composite src-over ON TOP of the whole
   * stack (hovers above the active layer — Wave 2 simplification).
   * Returned canvas is owned by the compositor — draw from it, don't keep it.
   */
  frameCanvas(
    frameIndex: number, stage: StageBuffer | null, activeLayer: number,
    float?: FloatBuffer | null,
  ): HTMLCanvasElement {
    const f = float ?? null;
    if (frameIndex !== this.lastFrame) {
      this.lastFrame = frameIndex;
      this.allDirty = true;
    }
    if (stage || f) {
      if (stage) this.compositeWithStage(frameIndex, stage, activeLayer);
      else this.doc.flattenFrame(frameIndex, this.buf);
      if (f) this.compositeFloat(f);
      this.stageActive = stage !== null;
      this.floatActive = f !== null;
      this.allDirty = false;
      this.dirtyRect = null;
      this.upload(null);
      return this.canvas;
    }
    if (this.stageActive || this.floatActive) {
      this.stageActive = false;
      this.floatActive = false;
      this.allDirty = true;
    }
    if (this.allDirty) {
      this.doc.flattenFrame(frameIndex, this.buf);
      this.allDirty = false;
      this.dirtyRect = null;
      this.upload(null);
    } else if (this.dirtyRect) {
      const r = this.dirtyRect;
      this.dirtyRect = null;
      this.doc.flattenFrame(frameIndex, this.buf, r);
      this.upload(r);
    }
    return this.canvas;
  }

  private alloc(): void {
    const w = this.doc.width;
    const h = this.doc.height;
    this.canvas.width = w;
    this.canvas.height = h;
    const bytes = new Uint8ClampedArray(w * h * 4);
    this.buf = new Uint32Array(bytes.buffer);
    this.img = new ImageData(bytes, w, h);
    this.allDirty = true;
    this.dirtyRect = null;
  }

  private union(r: Rect): void {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(this.doc.width, r.x + r.w);
    const y1 = Math.min(this.doc.height, r.y + r.h);
    if (x1 <= x0 || y1 <= y0) return;
    const d = this.dirtyRect;
    if (!d) {
      this.dirtyRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      return;
    }
    const nx0 = Math.min(d.x, x0);
    const ny0 = Math.min(d.y, y0);
    const nx1 = Math.max(d.x + d.w, x1);
    const ny1 = Math.max(d.y + d.h, y1);
    this.dirtyRect = { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 };
  }

  private compositeWithStage(frameIndex: number, stage: StageBuffer, activeLayer: number): void {
    const doc = this.doc;
    const n = doc.width * doc.height;
    this.buf.fill(0);
    for (let li = 0; li < doc.layers.length; li++) {
      const layer = doc.layers[li];
      if (!layer || !layer.visible || layer.opacity <= 0) continue;
      const cel = doc.getCel(doc.celKeyAt(li, frameIndex));
      const staged = li === activeLayer;
      if (!cel && !staged) continue;
      for (let i = 0; i < n; i++) {
        let s = cel ? (cel[i] ?? 0) : 0;
        if (staged && stage.mask[i]) s = stage.color[i] ?? 0;
        if (s === 0) continue;
        this.buf[i] = over(this.buf[i] ?? 0, s, layer.opacity);
      }
    }
  }

  private compositeFloat(f: FloatBuffer): void {
    const doc = this.doc;
    const r = f.rect;
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(doc.width, r.x + r.w);
    const y1 = Math.min(doc.height, r.y + r.h);
    for (let y = y0; y < y1; y++) {
      const srcRow = (y - r.y) * r.w - r.x;
      const dstRow = y * doc.width;
      for (let x = x0; x < x1; x++) {
        const s = f.pixels[srcRow + x] ?? 0;
        if (s === 0) continue;
        const i = dstRow + x;
        this.buf[i] = over(this.buf[i] ?? 0, s, 1);
      }
    }
  }

  private upload(r: Rect | null): void {
    if (r) this.ctx.putImageData(this.img, 0, 0, r.x, r.y, r.w, r.h);
    else this.ctx.putImageData(this.img, 0, 0);
  }
}
