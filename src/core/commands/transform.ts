/** Canvas transforms — frame-scoped mirrors + doc-wide 90° rotation.
 *  Flips are involutions run IN PLACE via cel keys cached on first apply
 *  (structural-command rule: capture once, reuse on redo); Rotate90CW mirrors
 *  ResizeCanvas — both buffer generations captured once, honest sizeBytes,
 *  dims swapped via SpriteDoc.setSize under a {kind:'all'} dirty scope so the
 *  wave-9 resync + stale-buffer guards fire. */
import type { CelKey, Command, DirtyScope, Rect } from '../contracts';
import type { SpriteDoc } from '../doc';
import { makeBuffer } from '../pixels';

type CelEntry = [CelKey, Uint32Array];

function flipXInPlace(buf: Uint32Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0, r = w - 1; x < r; x++, r--) {
      const t = buf[row + x] ?? 0;
      buf[row + x] = buf[row + r] ?? 0;
      buf[row + r] = t;
    }
  }
}

function flipYInPlace(buf: Uint32Array, w: number, h: number): void {
  const tmp = new Uint32Array(w);
  for (let y = 0, b = h - 1; y < b; y++, b--) {
    const top = buf.subarray(y * w, y * w + w);
    const bot = buf.subarray(b * w, b * w + w);
    tmp.set(top);
    top.set(bot);
    bot.set(tmp);
  }
}

/** 90° clockwise: src (x, y) lands at (h-1-y, x); out is h×w. */
function rotateCW(src: Uint32Array, w: number, h: number): Uint32Array {
  const out = makeBuffer(h, w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const col = h - 1 - y;
    for (let x = 0; x < w; x++) out[x * h + col] = src[row + x] ?? 0;
  }
  return out;
}

/** Mirror every layer's cel of ONE frame. In-place involution: revert = apply
 *  again. Cel KEYS (+ the dirty rect) are resolved once, on first apply —
 *  sparse cels never materialize, and redo touches exactly the first-apply
 *  set. Retains no pixel buffers. */
abstract class FlipFrame implements Command {
  abstract readonly label: string;

  private readonly frameIndex: number;
  private cels: Array<{ key: CelKey; rect: Rect }> | null = null;

  constructor(frameIndex: number) {
    this.frameIndex = frameIndex;
  }

  /** Cel scopes for the touched frame (empty until first apply — History
   *  reads dirty only after apply). */
  get dirty(): DirtyScope {
    return { kind: 'cels', cels: this.cels ?? [] };
  }

  get sizeBytes(): number {
    return 96 + (this.cels?.length ?? 0) * 48;
  }

  apply(doc: SpriteDoc): void {
    if (!this.cels) {
      const frame = doc.frames[this.frameIndex];
      if (!frame) throw new RangeError(`${this.label}: bad frame index ${this.frameIndex}`);
      const rect: Rect = { x: 0, y: 0, w: doc.width, h: doc.height };
      this.cels = doc.celEntriesForFrame(frame.id).map(([key]) => ({ key, rect }));
    }
    this.mirror(doc);
  }

  revert(doc: SpriteDoc): void {
    this.mirror(doc);
  }

  protected abstract flip(buf: Uint32Array, w: number, h: number): void;

  private mirror(doc: SpriteDoc): void {
    if (!this.cels) return;
    for (const { key } of this.cels) {
      const buf = doc.getCel(key);
      if (buf) this.flip(buf, doc.width, doc.height);
    }
  }
}

export class FlipFrameX extends FlipFrame {
  readonly label = 'flip horizontal';

  protected flip(buf: Uint32Array, w: number, h: number): void {
    flipXInPlace(buf, w, h);
  }
}

export class FlipFrameY extends FlipFrame {
  readonly label = 'flip vertical';

  protected flip(buf: Uint32Array, w: number, h: number): void {
    flipYInPlace(buf, w, h);
  }
}

/** Rotate the WHOLE document 90° clockwise — every cel of every frame, dims
 *  swapped w↔h. Buffer generations captured ONCE (first apply) à la
 *  ResizeCanvas; sizeBytes retains both. Dirty 'all' so the app resyncs
 *  compositor/viewport and the editor drops stale doc-sized buffers. */
export class Rotate90CW implements Command {
  readonly label = 'rotate 90° cw';
  readonly dirty: DirtyScope = { kind: 'all' };

  private prev: { width: number; height: number; cels: CelEntry[] } | null = null;
  private next: CelEntry[] = [];

  /** Retains BOTH generations: captured originals and rotated copies. */
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
      const cels: CelEntry[] = [];
      for (const layer of doc.layers) {
        for (const [key, buf] of doc.celEntriesForLayer(layer.id)) {
          cels.push([key, buf]);
          this.next.push([key, rotateCW(buf, ow, oh)]);
        }
      }
      this.prev = { width: ow, height: oh, cels };
    }
    for (const [key, buf] of this.next) doc.setCel(key, buf);
    doc.setSize(this.prev.height, this.prev.width);
  }

  revert(doc: SpriteDoc): void {
    if (!this.prev) return;
    for (const [key, buf] of this.prev.cels) doc.setCel(key, buf);
    doc.setSize(this.prev.width, this.prev.height);
  }
}
