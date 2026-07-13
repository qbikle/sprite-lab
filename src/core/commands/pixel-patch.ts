/** One undoable pixel edit on one cel — before/after sub-rect buffers.
 *  Memory ∝ dirty area, not frame size. */
import type { CelKey, Command, DirtyScope, Rect } from '../contracts';
import type { SpriteDoc } from '../doc';
import { copyRect, diffBounds, pasteRect } from '../pixels';

export class PixelPatch implements Command {
  readonly label: string;
  readonly sizeBytes: number;
  readonly dirty: DirtyScope;

  private readonly key: CelKey;
  private readonly rect: Rect;
  private readonly before: Uint32Array;
  private readonly after: Uint32Array;

  private constructor(
    label: string, sizeBytes: number, dirty: DirtyScope,
    key: CelKey, rect: Rect, before: Uint32Array, after: Uint32Array,
  ) {
    this.label = label;
    this.sizeBytes = sizeBytes;
    this.dirty = dirty;
    this.key = key;
    this.rect = rect;
    this.before = before;
    this.after = after;
  }

  /** Diff two full-cel buffers → patch of the changed sub-rect. null when identical. */
  static fromBuffers(
    key: CelKey, w: number, h: number,
    before: Uint32Array, after: Uint32Array, label: string,
  ): PixelPatch | null {
    const rect = diffBounds(before, after, w, h);
    if (!rect) return null;
    const beforePatch = copyRect(before, w, rect);
    const afterPatch = copyRect(after, w, rect);
    const sizeBytes = 2 * rect.w * rect.h * 4 + 64;
    const dirty: DirtyScope = { kind: 'cels', cels: [{ key, rect }] };
    return new PixelPatch(label, sizeBytes, dirty, key, rect, beforePatch, afterPatch);
  }

  apply(doc: SpriteDoc): void {
    const cel = doc.ensureCel(this.key);
    pasteRect(cel, doc.width, this.rect, this.after);
  }

  revert(doc: SpriteDoc): void {
    const cel = doc.ensureCel(this.key);
    pasteRect(cel, doc.width, this.rect, this.before);
  }
}
