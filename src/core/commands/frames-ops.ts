/** Frame structure commands — pure doc mutations, fully undoable.
 *  Ids and captured state are allocated ONCE (first apply) and reused on redo. */
import type { CelKey, Command, DirtyScope, Frame, Tag } from '../contracts';
import type { SpriteDoc } from '../doc';
import { moveItem } from '../doc';

type CelEntry = [CelKey, Uint32Array];

/** Shift/shrink tag ranges for a frame removal; a tag collapsing to nothing drops. */
function adjustTagsForRemoval(tags: readonly Tag[], index: number): Tag[] {
  const out: Tag[] = [];
  for (const t of tags) {
    if (t.from === index && t.to === index) continue;
    out.push({
      ...t,
      from: t.from > index ? t.from - 1 : t.from,
      to: t.to >= index ? t.to - 1 : t.to,
    });
  }
  return out;
}

/** Insert a blank frame after `afterIndex` (-1 = at start). */
export class AddFrame implements Command {
  readonly label = 'add frame';
  readonly dirty: DirtyScope = { kind: 'frames' };

  private readonly afterIndex: number;
  private readonly durationMs: number;
  private frame: Frame | null = null;
  private cels: CelEntry[] = [];

  constructor(afterIndex: number, durationMs = 100) {
    this.afterIndex = afterIndex;
    this.durationMs = durationMs;
  }

  get sizeBytes(): number {
    let n = 128;
    for (const [, buf] of this.cels) n += buf.byteLength;
    return n;
  }

  apply(doc: SpriteDoc): void {
    this.frame ??= { id: doc.allocFrameId(), durationMs: this.durationMs };
    const at = Math.max(0, Math.min(this.afterIndex + 1, doc.frames.length));
    doc.frames.splice(at, 0, this.frame);
    for (const [key, buf] of this.cels) doc.setCel(key, buf);
  }

  revert(doc: SpriteDoc): void {
    if (!this.frame) return;
    const i = doc.frames.indexOf(this.frame);
    if (i >= 0) doc.frames.splice(i, 1);
    // Defensive: later-undone edits may have left (blank) cels on this frame.
    this.cels = doc.celEntriesForFrame(this.frame.id);
    for (const [key] of this.cels) doc.removeCel(key);
  }
}

/** Duplicate frame at index (cels deep-copied), inserted right after it. */
export class DuplicateFrame implements Command {
  readonly label = 'duplicate frame';
  readonly dirty: DirtyScope = { kind: 'frames' };

  private readonly index: number;
  private frame: Frame | null = null;
  private cels: CelEntry[] = [];
  private _sizeBytes = 256;

  constructor(index: number) {
    this.index = index;
  }

  get sizeBytes(): number {
    return this._sizeBytes;
  }

  apply(doc: SpriteDoc): void {
    if (!this.frame) {
      const src = doc.frames[this.index];
      if (!src) throw new RangeError(`DuplicateFrame: bad index ${this.index}`);
      this.frame = { id: doc.allocFrameId(), durationMs: src.durationMs };
      for (const layer of doc.layers) {
        const buf = doc.getCel(doc.celKey(layer.id, src.id));
        if (!buf) continue;
        this.cels.push([doc.celKey(layer.id, this.frame.id), new Uint32Array(buf)]);
        this._sizeBytes += buf.byteLength;
      }
    }
    doc.frames.splice(this.index + 1, 0, this.frame);
    for (const [key, buf] of this.cels) doc.setCel(key, buf);
  }

  revert(doc: SpriteDoc): void {
    if (!this.frame) return;
    const i = doc.frames.indexOf(this.frame);
    if (i >= 0) doc.frames.splice(i, 1);
    this.cels = doc.celEntriesForFrame(this.frame.id);
    for (const [key] of this.cels) doc.removeCel(key);
  }
}

/** Remove frame at index (refuses on last frame — guard in caller too). */
export class RemoveFrame implements Command {
  readonly label = 'delete frame';
  readonly dirty: DirtyScope = { kind: 'frames' };

  private readonly index: number;
  private noop: boolean | null = null;
  private frame: Frame | null = null;
  private cels: CelEntry[] = [];
  private prevTags: Tag[] | null = null;
  private nextTags: Tag[] = [];
  private _sizeBytes = 256;

  constructor(index: number) {
    this.index = index;
  }

  get sizeBytes(): number {
    return this._sizeBytes;
  }

  apply(doc: SpriteDoc): void {
    this.noop ??= doc.frames.length <= 1;
    if (this.noop) return;
    if (!this.frame) {
      const frame = doc.frames[this.index];
      if (!frame) throw new RangeError(`RemoveFrame: bad index ${this.index}`);
      this.frame = frame;
      this.cels = doc.celEntriesForFrame(frame.id);
      for (const [, buf] of this.cels) this._sizeBytes += buf.byteLength;
      this.prevTags = doc.tags;
      this.nextTags = adjustTagsForRemoval(doc.tags, this.index);
    }
    doc.frames.splice(this.index, 1);
    for (const [key] of this.cels) doc.removeCel(key);
    doc.tags = this.nextTags;
  }

  revert(doc: SpriteDoc): void {
    if (this.noop || !this.frame || !this.prevTags) return;
    doc.frames.splice(this.index, 0, this.frame);
    for (const [key, buf] of this.cels) doc.setCel(key, buf);
    doc.tags = this.prevTags;
  }
}

/** Move a frame; tag ranges are index-based and intentionally left untouched. */
export class ReorderFrame implements Command {
  readonly label = 'reorder frame';
  readonly sizeBytes = 128;
  readonly dirty: DirtyScope = { kind: 'frames' };

  private readonly from: number;
  private readonly to: number;

  constructor(from: number, to: number) {
    this.from = from;
    this.to = to;
  }

  apply(doc: SpriteDoc): void {
    moveItem(doc.frames, this.from, this.to, 'ReorderFrame');
  }

  revert(doc: SpriteDoc): void {
    moveItem(doc.frames, this.to, this.from, 'ReorderFrame');
  }
}

/** Reverse the whole frame order (tag ranges remapped to match). */
export class ReverseFrames implements Command {
  readonly label = 'reverse frames';
  readonly sizeBytes = 128;
  readonly dirty: DirtyScope = { kind: 'frames' };

  private prevTags: Tag[] | null = null;
  private nextTags: Tag[] = [];

  apply(doc: SpriteDoc): void {
    doc.frames.reverse();
    if (!this.prevTags) {
      const n = doc.frames.length;
      this.prevTags = doc.tags;
      this.nextTags = doc.tags.map((t) => ({ ...t, from: n - 1 - t.to, to: n - 1 - t.from }));
    }
    doc.tags = this.nextTags;
  }

  revert(doc: SpriteDoc): void {
    doc.frames.reverse();
    if (this.prevTags) doc.tags = this.prevTags;
  }
}

export class SetFrameDuration implements Command {
  readonly label = 'frame duration';
  readonly sizeBytes = 64;
  readonly dirty: DirtyScope = { kind: 'frames' };

  private readonly index: number;
  private readonly durationMs: number;
  private frame: Frame | null = null;
  private prev = 0;

  constructor(index: number, durationMs: number) {
    this.index = index;
    this.durationMs = Math.max(20, Math.min(5000, durationMs));
  }

  apply(doc: SpriteDoc): void {
    if (!this.frame) {
      const frame = doc.frames[this.index];
      if (!frame) throw new RangeError(`SetFrameDuration: bad index ${this.index}`);
      this.frame = frame;
      this.prev = frame.durationMs;
    }
    this.frame.durationMs = this.durationMs;
  }

  revert(doc: SpriteDoc): void {
    void doc; // unused
    if (this.frame) this.frame.durationMs = this.prev;
  }
}
