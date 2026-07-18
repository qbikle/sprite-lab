/** Layer structure commands — pure doc mutations, fully undoable.
 *  Ids and captured state are allocated ONCE (first apply) and reused on redo. */
import type { CelKey, Command, DirtyScope, Layer, LayerId } from '../contracts';
import type { SpriteDoc } from '../doc';
import { moveItem } from '../doc';
import { overRgbaScaled } from '../pixels';

type CelEntry = [CelKey, Uint32Array];

/** Src-over in place, src alpha scaled by opacity — same math as
 *  SpriteDoc.flattenFrame (merge-down bakes the top layer's opacity in). */
function over(dst: Uint32Array, src: Uint32Array, opacity: number): void {
  for (let i = 0; i < dst.length; i++) {
    dst[i] = overRgbaScaled(dst[i] ?? 0, src[i] ?? 0, opacity);
  }
}

/** Insert a blank layer above `aboveIndex`. */
export class AddLayer implements Command {
  readonly label = 'add layer';
  readonly dirty: DirtyScope = { kind: 'layers' };

  private readonly aboveIndex: number;
  private readonly name: string | undefined;
  private layer: Layer | null = null;
  private cels: CelEntry[] = [];

  constructor(aboveIndex: number, name?: string) {
    this.aboveIndex = aboveIndex;
    this.name = name;
  }

  get sizeBytes(): number {
    let n = 128;
    for (const [, buf] of this.cels) n += buf.byteLength;
    return n;
  }

  apply(doc: SpriteDoc): void {
    if (!this.layer) {
      const id = doc.allocLayerId();
      this.layer = { id, name: this.name ?? `layer ${id.slice(1)}`, opacity: 1, visible: true };
    }
    const at = Math.max(0, Math.min(this.aboveIndex + 1, doc.layers.length));
    doc.layers.splice(at, 0, this.layer);
    for (const [key, buf] of this.cels) doc.setCel(key, buf);
  }

  revert(doc: SpriteDoc): void {
    if (!this.layer) return;
    const i = doc.layers.indexOf(this.layer);
    if (i >= 0) doc.layers.splice(i, 1);
    // Defensive: later-undone edits may have left (blank) cels on this layer.
    this.cels = doc.celEntriesForLayer(this.layer.id);
    for (const [key] of this.cels) doc.removeCel(key);
  }
}

/** Remove layer at index with all its cels (refuse on last layer in caller). */
export class RemoveLayer implements Command {
  readonly label = 'delete layer';
  readonly dirty: DirtyScope = { kind: 'layers' };

  private readonly index: number;
  private noop: boolean | null = null;
  private layer: Layer | null = null;
  private cels: CelEntry[] = [];
  private _sizeBytes = 256;

  constructor(index: number) {
    this.index = index;
  }

  get sizeBytes(): number {
    return this._sizeBytes;
  }

  apply(doc: SpriteDoc): void {
    this.noop ??= doc.layers.length <= 1;
    if (this.noop) return;
    if (!this.layer) {
      const layer = doc.layers[this.index];
      if (!layer) throw new RangeError(`RemoveLayer: bad index ${this.index}`);
      this.layer = layer;
      this.cels = doc.celEntriesForLayer(layer.id);
      for (const [, buf] of this.cels) this._sizeBytes += buf.byteLength;
    }
    doc.layers.splice(this.index, 1);
    for (const [key] of this.cels) doc.removeCel(key);
  }

  revert(doc: SpriteDoc): void {
    if (this.noop || !this.layer) return;
    doc.layers.splice(this.index, 0, this.layer);
    for (const [key, buf] of this.cels) doc.setCel(key, buf);
  }
}

export class ReorderLayer implements Command {
  readonly label = 'reorder layer';
  readonly sizeBytes = 128;
  readonly dirty: DirtyScope = { kind: 'layers' };

  private readonly from: number;
  private readonly to: number;

  constructor(from: number, to: number) {
    this.from = from;
    this.to = to;
  }

  apply(doc: SpriteDoc): void {
    moveItem(doc.layers, this.from, this.to, 'ReorderLayer');
  }

  revert(doc: SpriteDoc): void {
    moveItem(doc.layers, this.to, this.from, 'ReorderLayer');
  }
}

export class SetLayerOpacity implements Command {
  readonly label = 'layer opacity';
  readonly sizeBytes = 64;
  readonly dirty: DirtyScope = { kind: 'layers' };

  private readonly index: number;
  private readonly opacity: number;
  private layer: Layer | null = null;
  private prev = 1;

  constructor(index: number, opacity: number) {
    this.index = index;
    this.opacity = Math.max(0, Math.min(1, opacity));
  }

  apply(doc: SpriteDoc): void {
    if (!this.layer) {
      const layer = doc.layers[this.index];
      if (!layer) throw new RangeError(`SetLayerOpacity: bad index ${this.index}`);
      this.layer = layer;
      this.prev = layer.opacity;
    }
    this.layer.opacity = this.opacity;
  }

  revert(doc: SpriteDoc): void {
    void doc; // unused
    if (this.layer) this.layer.opacity = this.prev;
  }
}

export class SetLayerVisible implements Command {
  readonly label = 'layer visibility';
  readonly sizeBytes = 64;
  readonly dirty: DirtyScope = { kind: 'layers' };

  private readonly index: number;
  private readonly visible: boolean;
  private layer: Layer | null = null;
  private prev = true;

  constructor(index: number, visible: boolean) {
    this.index = index;
    this.visible = visible;
  }

  apply(doc: SpriteDoc): void {
    if (!this.layer) {
      const layer = doc.layers[this.index];
      if (!layer) throw new RangeError(`SetLayerVisible: bad index ${this.index}`);
      this.layer = layer;
      this.prev = layer.visible;
    }
    this.layer.visible = this.visible;
  }

  revert(doc: SpriteDoc): void {
    void doc; // unused
    if (this.layer) this.layer.visible = this.prev;
  }
}

export class RenameLayer implements Command {
  readonly label = 'rename layer';
  readonly sizeBytes = 64;
  readonly dirty: DirtyScope = { kind: 'layers' };

  private readonly index: number;
  private readonly name: string;
  private layer: Layer | null = null;
  private prev = '';

  constructor(index: number, name: string) {
    this.index = index;
    this.name = name;
  }

  apply(doc: SpriteDoc): void {
    if (!this.layer) {
      const layer = doc.layers[this.index];
      if (!layer) throw new RangeError(`RenameLayer: bad index ${this.index}`);
      this.layer = layer;
      this.prev = layer.name;
    }
    this.layer.name = this.name;
  }

  revert(doc: SpriteDoc): void {
    void doc; // unused
    if (this.layer) this.layer.name = this.prev;
  }
}

/** Merge layer at index into the one below (every frame), remove the top.
 *  Layers are bottom→top, so "below" = index-1; no-op when there is none.
 *  The result keeps the below layer's id/name; top opacity is baked in. */
export class MergeLayerDown implements Command {
  readonly label = 'merge down';
  readonly dirty: DirtyScope = { kind: 'layers' };

  private readonly index: number;
  private noop: boolean | null = null;
  private cap: { top: Layer; belowId: LayerId } | null = null;
  private topCels: CelEntry[] = [];
  private belowBefore: Array<{ key: CelKey; buf: Uint32Array | null }> = [];
  private _sizeBytes = 256;

  constructor(index: number) {
    this.index = index;
  }

  get sizeBytes(): number {
    return this._sizeBytes;
  }

  apply(doc: SpriteDoc): void {
    this.noop ??= this.index <= 0 || this.index >= doc.layers.length;
    if (this.noop) return;
    if (!this.cap) {
      const top = doc.layers[this.index];
      const below = doc.layers[this.index - 1];
      if (!top || !below) throw new RangeError(`MergeLayerDown: bad index ${this.index}`);
      this.cap = { top, belowId: below.id };
      this.topCels = doc.celEntriesForLayer(top.id);
      for (const [, buf] of this.topCels) this._sizeBytes += buf.byteLength;
      for (const frame of doc.frames) {
        if (!doc.getCel(doc.celKey(top.id, frame.id))) continue;
        const key = doc.celKey(below.id, frame.id);
        const existing = doc.getCel(key);
        this.belowBefore.push({ key, buf: existing ? new Uint32Array(existing) : null });
        if (existing) this._sizeBytes += existing.byteLength;
      }
    }
    const { top, belowId } = this.cap;
    for (const frame of doc.frames) {
      const topBuf = doc.getCel(doc.celKey(top.id, frame.id));
      if (!topBuf) continue;
      over(doc.ensureCel(doc.celKey(belowId, frame.id)), topBuf, top.opacity);
    }
    for (const [key] of this.topCels) doc.removeCel(key);
    doc.layers.splice(this.index, 1);
  }

  revert(doc: SpriteDoc): void {
    if (this.noop || !this.cap) return;
    doc.layers.splice(this.index, 0, this.cap.top);
    for (const [key, buf] of this.topCels) doc.setCel(key, buf);
    for (const { key, buf } of this.belowBefore) {
      if (buf) doc.ensureCel(key).set(buf);
      else doc.removeCel(key);
    }
  }
}
