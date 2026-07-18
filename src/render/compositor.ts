/** Per-frame composite cache with dirty-rect invalidation. Reads doc, never mutates. */
import type { CelKey, DirtyScope, FloatBuffer, Rect, StageBuffer } from '../core/contracts';
import { overRgba, overRgbaScaled } from '../core/pixels';
import type { SpriteDoc } from '../core/doc';

/** Silhouette tint bases (LE ABGR, alpha 0): past #ff5555, future #2ec8c0. */
const GHOST_TINT = { past: 0x005555ff, future: 0x00c0c82e } as const;

/** Cached ghosts beyond this are evicted oldest-first (onion depth is ≤ a few). */
const GHOST_CACHE_CAP = 8;

interface GhostEntry {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  buf: Uint32Array;
  img: ImageData;
  tint: 'past' | 'future';
  alpha: number;
  dirty: boolean;
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
  private stageLayer = -1;
  private floatActive = false;
  private readonly ghosts = new Map<number, GhostEntry>();

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
    this.ghosts.clear();
  }

  invalidate(scope: DirtyScope): void {
    if (scope.kind === 'cels') {
      // Wave 1: rects dirty the cache regardless of which frame owns the cel.
      for (const c of scope.cels) {
        this.union(c.rect);
        this.dirtyGhostForCel(c.key);
      }
    } else if (scope.kind === 'selection') {
      // overlays only — no pixels changed, composite and ghosts stay valid
    } else {
      this.allDirty = true;
      for (const entry of this.ghosts.values()) entry.dirty = true;
    }
  }

  /**
   * Canvas holding the flattened frame (doc.flattenFrame under the hood,
   * recomposited only in dirty rects — including while a stage is active, so
   * a stroke costs the dirty union, not w×h×layers per rAF). When stage is
   * given, mask=1 pixels REPLACE the active layer's cel in the composite
   * (live tool preview). When float is given, its pixels composite src-over
   * ON TOP of the whole stack (hovers above the active layer — Wave 2
   * simplification; the float path stays a full recomposite because float
   * drags emit no dirty rects). Returned canvas is owned by the compositor —
   * draw from it, don't keep it.
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
    if (stage && this.stageActive && activeLayer !== this.stageLayer) {
      this.allDirty = true;
    }
    if (f) {
      if (stage) this.compositeWithStage(frameIndex, stage, activeLayer, null);
      else this.doc.flattenFrame(frameIndex, this.buf);
      this.compositeFloat(f);
      this.stageActive = stage !== null;
      this.stageLayer = activeLayer;
      this.floatActive = true;
      this.allDirty = false;
      this.dirtyRect = null;
      this.upload(null);
      return this.canvas;
    }
    if (this.floatActive) {
      // float just vanished — its pixels are baked into the buffer
      this.floatActive = false;
      this.allDirty = true;
    }
    if (stage) {
      if (this.allDirty) {
        this.compositeWithStage(frameIndex, stage, activeLayer, null);
        this.allDirty = false;
        this.dirtyRect = null;
        this.upload(null);
      } else if (this.dirtyRect) {
        const r = this.dirtyRect;
        this.dirtyRect = null;
        this.compositeWithStage(frameIndex, stage, activeLayer, r);
        this.upload(r);
      }
      this.stageActive = true;
      this.stageLayer = activeLayer;
      return this.canvas;
    }
    if (this.stageActive) {
      // stage just ended — preview pixels are baked in, rebuild clean
      this.stageActive = false;
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

  /**
   * docW×docH silhouette-tinted flat composite of a frame, for onion skin.
   * Per pixel: out = tint color with alpha = srcAlpha * alpha (classic onion
   * silhouette). Ghost canvases are CACHED per frame, keyed on (tint, alpha)
   * and invalidated with that frame's cels — repeat requests while idle or
   * mid-stroke cost nothing. Returned canvas is owned by the compositor
   * (reuse contract unchanged: draw it before requesting another ghost).
   * Null when frameIndex is out of bounds. Never touches the main cache.
   */
  ghostCanvas(frameIndex: number, tint: 'past' | 'future', alpha: number): HTMLCanvasElement | null {
    if (frameIndex < 0 || frameIndex >= this.doc.frames.length) return null;
    const w = this.doc.width;
    const h = this.doc.height;
    let entry = this.ghosts.get(frameIndex);
    if (entry && !entry.dirty && entry.tint === tint && entry.alpha === alpha) {
      return entry.canvas;
    }
    if (!entry) {
      if (this.ghosts.size >= GHOST_CACHE_CAP) {
        const oldest = this.ghosts.keys().next();
        if (!oldest.done) this.ghosts.delete(oldest.value);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      if (!ctx) throw new Error('compositor: 2d context unavailable');
      const bytes = new Uint8ClampedArray(w * h * 4);
      entry = {
        canvas,
        ctx,
        buf: new Uint32Array(bytes.buffer),
        img: new ImageData(bytes, w, h),
        tint,
        alpha,
        dirty: true,
      };
      this.ghosts.set(frameIndex, entry);
    }
    this.doc.flattenFrame(frameIndex, entry.buf);
    const base = GHOST_TINT[tint];
    const a = Math.min(1, Math.max(0, alpha));
    const buf = entry.buf;
    for (let i = 0; i < buf.length; i++) {
      const sa = (buf[i] ?? 0) >>> 24;
      buf[i] = sa === 0 ? 0 : ((Math.round(sa * a) << 24) | base) >>> 0;
    }
    entry.ctx.putImageData(entry.img, 0, 0);
    entry.tint = tint;
    entry.alpha = alpha;
    entry.dirty = false;
    return entry.canvas;
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

  /** Ghosts are keyed by frame index — map the cel's frame id to mark just
   *  that frame stale (a stroke's own frame is never drawn as a ghost). */
  private dirtyGhostForCel(key: CelKey): void {
    const fid = key.slice(key.indexOf(':') + 1);
    const frames = this.doc.frames;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i]?.id !== fid) continue;
      const entry = this.ghosts.get(i);
      if (entry) entry.dirty = true;
      return;
    }
  }

  private compositeWithStage(
    frameIndex: number, stage: StageBuffer, activeLayer: number, rect: Rect | null,
  ): void {
    const doc = this.doc;
    const w = doc.width;
    const r = rect ?? { x: 0, y: 0, w, h: doc.height };
    for (let y = r.y; y < r.y + r.h; y++) {
      const row = y * w;
      for (let x = r.x; x < r.x + r.w; x++) this.buf[row + x] = 0;
    }
    for (let li = 0; li < doc.layers.length; li++) {
      const layer = doc.layers[li];
      if (!layer || !layer.visible || layer.opacity <= 0) continue;
      const cel = doc.getCel(doc.celKeyAt(li, frameIndex));
      const staged = li === activeLayer;
      if (!cel && !staged) continue;
      for (let y = r.y; y < r.y + r.h; y++) {
        const row = y * w;
        for (let x = r.x; x < r.x + r.w; x++) {
          const i = row + x;
          let s = cel ? (cel[i] ?? 0) : 0;
          if (staged && stage.mask[i]) s = stage.color[i] ?? 0;
          if (s === 0) continue;
          this.buf[i] = overRgbaScaled(this.buf[i] ?? 0, s, layer.opacity);
        }
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
        this.buf[i] = overRgba(this.buf[i] ?? 0, s);
      }
    }
  }

  private upload(r: Rect | null): void {
    if (r) this.ctx.putImageData(this.img, 0, 0, r.x, r.y, r.w, r.h);
    else this.ctx.putImageData(this.img, 0, 0);
  }
}
