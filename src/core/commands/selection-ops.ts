/**
 * Selection & float lifecycle as commands, so undo/redo covers EVERYTHING.
 * These close over a SelectionHost (the editor's session state) — the one
 * sanctioned impurity in the command layer, documented in ARCHITECTURE.
 */
import type { CelKey, Command, DirtyScope, FloatBuffer, Rect, Rgba, SelectionState } from '../contracts';
import type { SpriteDoc } from '../doc';
import { clampRect, copyRect, packRgba, pasteRect } from '../pixels';
import { tightBounds } from '../selection';

/** The slice of editor session state these commands mutate. */
export interface SelectionHost {
  selection: SelectionState | null;
  float: FloatBuffer | null;
}

/** Straight-alpha src-over (same math as SpriteDoc.flattenFrame). */
function over(s: Rgba, d: Rgba): Rgba {
  const sa = ((s >>> 24) & 0xff) / 255;
  const da = ((d >>> 24) & 0xff) / 255;
  const oa = sa + da * (1 - sa);
  const dw = da * (1 - sa);
  const r = Math.round(((s & 0xff) * sa + (d & 0xff) * dw) / oa);
  const g = Math.round((((s >>> 8) & 0xff) * sa + ((d >>> 8) & 0xff) * dw) / oa);
  const b = Math.round((((s >>> 16) & 0xff) * sa + ((d >>> 16) & 0xff) * dw) / oa);
  return packRgba(r, g, b, Math.round(oa * 255));
}

/** Selection covering the float's nonzero pixels, clamped to the doc. */
function floatSelection(pixels: Uint32Array, rect: Rect, docW: number, docH: number): SelectionState | null {
  const mask = new Uint8Array(docW * docH);
  for (let y = 0; y < rect.h; y++) {
    const dy = rect.y + y;
    if (dy < 0 || dy >= docH) continue;
    for (let x = 0; x < rect.w; x++) {
      const dx = rect.x + x;
      if (dx < 0 || dx >= docW) continue;
      const c = pixels[y * rect.w + x] ?? 0;
      if (((c >>> 24) & 0xff) === 0) continue;
      mask[dy * docW + dx] = 1;
    }
  }
  const bounds = tightBounds(mask, docW, docH);
  if (!bounds) return null;
  return { mask, bounds };
}

export class SetSelection implements Command {
  readonly label: string;
  readonly sizeBytes: number;
  readonly dirty: DirtyScope = { kind: 'selection' };

  private readonly host: SelectionHost;
  private readonly prev: SelectionState | null;
  private readonly next: SelectionState | null;

  constructor(host: SelectionHost, next: SelectionState | null, label: string) {
    this.host = host;
    this.prev = host.selection;
    this.next = next;
    this.label = label;
    this.sizeBytes = (next ? next.mask.byteLength : 0) + 64;
  }

  apply(doc: SpriteDoc): void {
    void doc; // unused
    this.host.selection = this.next;
  }

  revert(doc: SpriteDoc): void {
    void doc; // unused
    this.host.selection = this.prev;
  }
}

/** Cut the selection's pixels out of the cel into a float. */
export class LiftFloat implements Command {
  readonly label = 'lift selection';
  readonly sizeBytes: number;
  readonly dirty: DirtyScope;

  private readonly host: SelectionHost;
  private readonly key: CelKey;
  private readonly docW: number;
  private readonly selection: SelectionState;
  private before: Uint32Array | null = null;
  private after: Uint32Array | null = null;
  private floatPixels: Uint32Array | null = null;

  constructor(host: SelectionHost, key: CelKey, docW: number, docH: number) {
    void docH; // bounds are already in-doc
    if (!host.selection) throw new Error('LiftFloat: no selection');
    this.host = host;
    this.key = key;
    this.docW = docW;
    this.selection = host.selection;
    const b = this.selection.bounds;
    this.dirty = { kind: 'cels', cels: [{ key, rect: { ...b } }] };
    this.sizeBytes = 3 * b.w * b.h * 4 + 128;
  }

  apply(doc: SpriteDoc): void {
    const cel = doc.ensureCel(this.key);
    const b = this.selection.bounds;
    if (this.after && this.floatPixels) {
      pasteRect(cel, this.docW, b, this.after);
      this.host.float = { pixels: this.floatPixels, rect: { ...b } };
      return;
    }
    this.before = copyRect(cel, this.docW, b);
    const lifted = new Uint32Array(b.w * b.h);
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const i = (b.y + y) * this.docW + (b.x + x);
        if (!this.selection.mask[i]) continue;
        lifted[y * b.w + x] = cel[i] ?? 0;
        cel[i] = 0;
      }
    }
    this.after = copyRect(cel, this.docW, b);
    this.floatPixels = lifted;
    this.host.float = { pixels: lifted, rect: { ...b } };
  }

  revert(doc: SpriteDoc): void {
    if (this.before) {
      pasteRect(doc.ensureCel(this.key), this.docW, this.selection.bounds, this.before);
    }
    this.host.float = null;
    this.host.selection = this.selection;
  }
}

/** Merge the float into the cel at its (captured) rect; selection follows. */
export class AnchorFloat implements Command {
  readonly label = 'anchor selection';
  readonly sizeBytes: number;
  readonly dirty: DirtyScope;

  private readonly host: SelectionHost;
  private readonly key: CelKey;
  private readonly docW: number;
  private readonly docH: number;
  private readonly pixels: Uint32Array;
  private readonly rect: Rect;
  private readonly clamped: Rect | null;
  private readonly prevSelection: SelectionState | null;
  private before: Uint32Array | null = null;
  private after: Uint32Array | null = null;

  constructor(host: SelectionHost, key: CelKey, docW: number, docH: number) {
    if (!host.float) throw new Error('AnchorFloat: no float');
    this.host = host;
    this.key = key;
    this.docW = docW;
    this.docH = docH;
    this.pixels = new Uint32Array(host.float.pixels);
    this.rect = { ...host.float.rect };
    this.clamped = clampRect(this.rect, docW, docH);
    this.prevSelection = host.selection;
    this.dirty = this.clamped
      ? { kind: 'cels', cels: [{ key, rect: this.clamped }] }
      : { kind: 'selection' };
    this.sizeBytes = (this.clamped ? 3 * this.clamped.w * this.clamped.h * 4 : 0) + 128;
  }

  apply(doc: SpriteDoc): void {
    const c = this.clamped;
    if (c) {
      const cel = doc.ensureCel(this.key);
      if (this.after) {
        pasteRect(cel, this.docW, c, this.after);
      } else {
        this.before = copyRect(cel, this.docW, c);
        for (let y = 0; y < this.rect.h; y++) {
          const dy = this.rect.y + y;
          if (dy < c.y || dy >= c.y + c.h) continue;
          for (let x = 0; x < this.rect.w; x++) {
            const dx = this.rect.x + x;
            if (dx < c.x || dx >= c.x + c.w) continue;
            const s = this.pixels[y * this.rect.w + x] ?? 0;
            if (((s >>> 24) & 0xff) === 0) continue;
            const i = dy * this.docW + dx;
            cel[i] = over(s, cel[i] ?? 0);
          }
        }
        this.after = copyRect(cel, this.docW, c);
      }
    }
    this.host.float = null;
    this.host.selection = floatSelection(this.pixels, this.rect, this.docW, this.docH);
  }

  revert(doc: SpriteDoc): void {
    if (this.clamped && this.before) {
      pasteRect(doc.ensureCel(this.key), this.docW, this.clamped, this.before);
    }
    this.host.float = { pixels: new Uint32Array(this.pixels), rect: { ...this.rect } };
    this.host.selection = this.prevSelection;
  }
}

/** Clipboard paste → new float (+ selection = float footprint). */
export class PasteFloat implements Command {
  readonly label = 'paste';
  readonly sizeBytes: number;
  readonly dirty: DirtyScope = { kind: 'selection' };

  private readonly host: SelectionHost;
  private readonly pixels: Uint32Array;
  private readonly rect: Rect;
  private readonly prevFloat: FloatBuffer | null;

  constructor(host: SelectionHost, pixels: Uint32Array, w: number, h: number, at: { x: number; y: number }) {
    this.host = host;
    this.pixels = new Uint32Array(pixels);
    this.rect = { x: at.x, y: at.y, w, h };
    this.prevFloat = host.float
      ? { pixels: new Uint32Array(host.float.pixels), rect: { ...host.float.rect } }
      : null;
    this.sizeBytes = this.pixels.byteLength + 64;
  }

  apply(doc: SpriteDoc): void {
    void doc; // unused
    this.host.float = { pixels: new Uint32Array(this.pixels), rect: { ...this.rect } };
  }

  revert(doc: SpriteDoc): void {
    void doc; // unused
    this.host.float = this.prevFloat;
  }
}
