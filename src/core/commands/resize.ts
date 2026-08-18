/** Canvas resize — every cel re-blitted onto a new w×h buffer, anchored.
 *  Old buffers + dims are captured ONCE (first apply) and reused on redo. */
import type { CelKey, Command, DirtyScope, Rect } from '../contracts';
import type { SpriteDoc } from '../doc';
import { clampRect, copyRect, makeBuffer, pasteRect } from '../pixels';

/** Which edge/corner of the old content stays pinned in the new canvas. */
export type ResizeAnchor = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br';

type CelEntry = [CelKey, Uint32Array];

/** Offset of the old content inside the new canvas along one axis.
 *  Centered axes use Math.trunc — on odd deltas the content leans toward the
 *  top-left both when growing (extra pixel lands right/bottom) and when
 *  shrinking (extra crop comes off the right/bottom). Pinned in tests. */
function axisOffset(edge: 'lo' | 'mid' | 'hi', oldSize: number, newSize: number): number {
  if (edge === 'lo') return 0;
  if (edge === 'hi') return newSize - oldSize;
  return Math.trunc((newSize - oldSize) / 2);
}

function anchorOffset(
  anchor: ResizeAnchor, ow: number, oh: number, nw: number, nh: number,
): { dx: number; dy: number } {
  const h = anchor === 'tl' || anchor === 'l' || anchor === 'bl' ? 'lo'
    : anchor === 'tr' || anchor === 'r' || anchor === 'br' ? 'hi' : 'mid';
  const v = anchor === 'tl' || anchor === 't' || anchor === 'tr' ? 'lo'
    : anchor === 'bl' || anchor === 'b' || anchor === 'br' ? 'hi' : 'mid';
  return { dx: axisOffset(h, ow, nw), dy: axisOffset(v, oh, nh) };
}

/** Old buffer blitted into a fresh nw×nh buffer at (dx, dy); clips on shrink. */
function blitResized(
  old: Uint32Array, ow: number, oh: number,
  nw: number, nh: number, dx: number, dy: number,
): Uint32Array {
  const out = makeBuffer(nw, nh);
  const src = clampRect({ x: -dx, y: -dy, w: nw, h: nh }, ow, oh);
  if (!src) return out;
  const patch = copyRect(old, ow, src);
  const dst: Rect = { x: src.x + dx, y: src.y + dy, w: src.w, h: src.h };
  pasteRect(out, nw, dst, patch);
  return out;
}

export class ResizeCanvas implements Command {
  readonly label = 'resize canvas';
  readonly dirty: DirtyScope = { kind: 'all' };

  private readonly width: number;
  private readonly height: number;
  private readonly anchor: ResizeAnchor;
  private prev: { width: number; height: number; cels: CelEntry[] } | null = null;
  private next: CelEntry[] = [];

  constructor(width: number, height: number, anchor: ResizeAnchor) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.anchor = anchor;
  }

  /** Retains BOTH generations: the captured originals and the resized copies. */
  get sizeBytes(): number {
    let n = 128;
    if (this.prev) for (const [, buf] of this.prev.cels) n += buf.byteLength;
    for (const [, buf] of this.next) n += buf.byteLength;
    return n;
  }

  apply(doc: SpriteDoc): void {
    if (!this.prev) {
      const ow = doc.width;
      const oh = doc.height;
      const { dx, dy } = anchorOffset(this.anchor, ow, oh, this.width, this.height);
      const cels: CelEntry[] = [];
      for (const layer of doc.layers) {
        for (const [key, buf] of doc.celEntriesForLayer(layer.id)) {
          cels.push([key, buf]);
          this.next.push([key, blitResized(buf, ow, oh, this.width, this.height, dx, dy)]);
        }
      }
      this.prev = { width: ow, height: oh, cels };
    }
    for (const [key, buf] of this.next) doc.setCel(key, buf);
    doc.setSize(this.width, this.height);
  }

  revert(doc: SpriteDoc): void {
    if (!this.prev) return;
    for (const [key, buf] of this.prev.cels) doc.setCel(key, buf);
    doc.setSize(this.prev.width, this.prev.height);
  }
}
