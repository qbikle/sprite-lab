import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FloatBuffer, StageBuffer } from '../../src/core/contracts';
import { SpriteDoc } from '../../src/core/doc';
import { overRgba, packRgba } from '../../src/core/pixels';
import { Compositor } from '../../src/render/compositor';

/* Minimal canvas/ImageData stubs — vitest runs in node, and the compositor
 * only needs createElement('canvas'), getContext('2d') and putImageData. The
 * ImageData handed to putImageData shares the compositor's pixel buffer, so
 * tests read composites straight out of the recorded uploads. */

class FakeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

interface Put {
  img: FakeImageData;
  dirty: [number, number, number, number] | null;
}

class FakeContext2D {
  readonly puts: Put[] = [];
  putImageData(
    img: FakeImageData, dx: number, dy: number,
    x?: number, y?: number, w?: number, h?: number,
  ): void {
    void dx; void dy;
    this.puts.push({ img, dirty: x === undefined ? null : [x, y ?? 0, w ?? 0, h ?? 0] });
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  readonly ctx2d = new FakeContext2D();
  getContext(): FakeContext2D {
    return this.ctx2d;
  }
}

beforeAll(() => {
  vi.stubGlobal('document', { createElement: (): FakeCanvas => new FakeCanvas() });
  vi.stubGlobal('ImageData', FakeImageData);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const A = packRgba(255, 0, 0, 255);
const B = packRgba(0, 255, 0, 255);

function makeStage(n: number, writes: ReadonlyArray<[number, number]>): StageBuffer {
  const color = new Uint32Array(n);
  const mask = new Uint8Array(n);
  for (const [i, c] of writes) {
    mask[i] = 1;
    color[i] = c;
  }
  return { color, mask };
}

/** Render and read the composite through the last recorded upload. */
function px(
  comp: Compositor, frame: number, stage: StageBuffer | null, layer: number,
  float?: FloatBuffer | null,
): Uint32Array {
  const cnv = comp.frameCanvas(frame, stage, layer, float) as unknown as FakeCanvas;
  const last = cnv.ctx2d.puts[cnv.ctx2d.puts.length - 1];
  if (!last) throw new Error('no upload recorded');
  return new Uint32Array(last.img.data.buffer);
}

function lastDirty(comp: Compositor, frame: number, stage: StageBuffer | null, layer: number):
  [number, number, number, number] | null {
  const cnv = comp.frameCanvas(frame, stage, layer) as unknown as FakeCanvas;
  const last = cnv.ctx2d.puts[cnv.ctx2d.puts.length - 1];
  return last ? last.dirty : null;
}

describe('Compositor frameCanvas', () => {
  it('stage pixels replace the active layer cel — staged erases preview', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const cel = doc.ensureCel(doc.celKeyAt(0, 0));
    cel[5] = A;
    const comp = new Compositor(doc);
    const stage = makeStage(16, [[0, B], [5, 0]]);
    const withStage = px(comp, 0, stage, 0);
    expect(withStage[0]).toBe(B);
    expect(withStage[5]).toBe(0); // erase previews through, not painted over
    const plain = px(comp, 0, null, 0);
    expect(plain[0]).toBe(0);
    expect(plain[5]).toBe(A);
  });

  it('recomposites only after invalidation, and only the dirty rect', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const comp = new Compositor(doc);
    expect(px(comp, 0, null, 0)[10]).toBe(0);
    const cel = doc.ensureCel(doc.celKeyAt(0, 0));
    cel[10] = B; // mutate without announcing — cache must hold
    expect(px(comp, 0, null, 0)[10]).toBe(0);
    comp.invalidate({
      kind: 'cels',
      cels: [{ key: doc.celKeyAt(0, 0), rect: { x: 2, y: 2, w: 1, h: 1 } }],
    });
    expect(px(comp, 0, null, 0)[10]).toBe(B);
    comp.invalidate({
      kind: 'cels',
      cels: [{ key: doc.celKeyAt(0, 0), rect: { x: 2, y: 2, w: 1, h: 1 } }],
    });
    expect(lastDirty(comp, 0, null, 0)).toEqual([2, 2, 1, 1]); // partial upload
  });

  it('undo during a stroke never shows stale pixels', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const cel = doc.ensureCel(doc.celKeyAt(0, 0));
    cel[10] = A; // previously committed pixel
    const comp = new Compositor(doc);
    const stage = makeStage(16, [[0, B]]);
    const before = px(comp, 0, stage, 0);
    expect(before[0]).toBe(B);
    expect(before[10]).toBe(A);
    cel[10] = 0; // undo reverts the cel mid-stroke…
    comp.invalidate({
      kind: 'cels',
      cels: [{ key: doc.celKeyAt(0, 0), rect: { x: 2, y: 2, w: 1, h: 1 } }],
    });
    const after = px(comp, 0, stage, 0);
    expect(after[10]).toBe(0); // …and the composite follows
    expect(after[0]).toBe(B);  // while the live stage stays on top
  });

  it('hides staged pixels when their layer is toggled off mid-stroke', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const cel = doc.ensureCel(doc.celKeyAt(0, 0));
    cel[1] = A;
    const comp = new Compositor(doc);
    const stage = makeStage(16, [[0, B]]);
    const before = px(comp, 0, stage, 0);
    expect(before[0]).toBe(B);
    expect(before[1]).toBe(A);
    const layer = doc.layers[0];
    expect(layer).toBeDefined();
    if (!layer) return;
    layer.visible = false;
    comp.invalidate({ kind: 'layers' });
    const after = px(comp, 0, stage, 0);
    expect(after[0]).toBe(0);
    expect(after[1]).toBe(0);
  });

  it('switching frames recomposites without an explicit invalidate', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    doc.frames.push({ id: doc.allocFrameId(), durationMs: 100 });
    const celA = doc.ensureCel(doc.celKeyAt(0, 0));
    celA[0] = A;
    const celB = doc.ensureCel(doc.celKeyAt(0, 1));
    celB[3] = B;
    const comp = new Compositor(doc);
    const f0 = px(comp, 0, null, 0);
    expect(f0[0]).toBe(A);
    expect(f0[3]).toBe(0);
    const f1 = px(comp, 1, null, 0);
    expect(f1[0]).toBe(0);
    expect(f1[3]).toBe(B);
    expect(px(comp, 0, null, 0)[0]).toBe(A);
  });

  it('float composites src-over on top and lifts back off cleanly', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const cel = doc.ensureCel(doc.celKeyAt(0, 0));
    cel[5] = A;
    const comp = new Compositor(doc);
    const half = packRgba(0, 255, 0, 128);
    const float: FloatBuffer = { pixels: Uint32Array.of(half), rect: { x: 1, y: 1, w: 1, h: 1 } };
    expect(px(comp, 0, null, 0, float)[5]).toBe(overRgba(A, half));
    expect(px(comp, 0, null, 0)[5]).toBe(A); // float gone — underlying restored
  });

  it("'selection' scope leaves the composite cache untouched", () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const comp = new Compositor(doc);
    expect(px(comp, 0, null, 0)[10]).toBe(0);
    const cel = doc.ensureCel(doc.celKeyAt(0, 0));
    cel[10] = B;
    comp.invalidate({ kind: 'selection' }); // overlays only — no pixels changed
    expect(px(comp, 0, null, 0)[10]).toBe(0);
    comp.invalidate({ kind: 'all' });
    expect(px(comp, 0, null, 0)[10]).toBe(B);
  });
});

describe('Compositor ghostCanvas', () => {
  const PAST_HALF = ((128 << 24) | 0x005555ff) >>> 0;

  function setup(): { doc: SpriteDoc; comp: Compositor } {
    const doc = SpriteDoc.blank(4, 4, 't');
    doc.frames.push({ id: doc.allocFrameId(), durationMs: 100 });
    const cel = doc.ensureCel(doc.celKeyAt(0, 0));
    cel[0] = A;
    return { doc, comp: new Compositor(doc) };
  }

  it('caches per frame: identical requests never re-render', () => {
    const { comp } = setup();
    const g1 = comp.ghostCanvas(0, 'past', 0.5) as unknown as FakeCanvas;
    expect(g1.ctx2d.puts).toHaveLength(1);
    const data = new Uint32Array(g1.ctx2d.puts[0]!.img.data.buffer);
    expect(data[0]).toBe(PAST_HALF); // tinted silhouette, alpha scaled
    expect(data[1]).toBe(0);
    const g2 = comp.ghostCanvas(0, 'past', 0.5) as unknown as FakeCanvas;
    expect(g2).toBe(g1);
    expect(g1.ctx2d.puts).toHaveLength(1); // cache hit — no rebuild
  });

  it('rebuilds on tint/alpha change and on that frame cel invalidation', () => {
    const { doc, comp } = setup();
    const g = comp.ghostCanvas(0, 'past', 0.5) as unknown as FakeCanvas;
    expect(g.ctx2d.puts).toHaveLength(1);
    comp.ghostCanvas(0, 'past', 0.25);
    expect(g.ctx2d.puts).toHaveLength(2);
    comp.ghostCanvas(0, 'future', 0.25);
    expect(g.ctx2d.puts).toHaveLength(3);
    comp.invalidate({
      kind: 'cels',
      cels: [{ key: doc.celKeyAt(0, 0), rect: { x: 0, y: 0, w: 1, h: 1 } }],
    });
    comp.ghostCanvas(0, 'future', 0.25);
    expect(g.ctx2d.puts).toHaveLength(4);
  });

  it("another frame's invalidation leaves a cached ghost alone", () => {
    const { doc, comp } = setup();
    const g = comp.ghostCanvas(0, 'past', 0.5) as unknown as FakeCanvas;
    expect(g.ctx2d.puts).toHaveLength(1);
    comp.invalidate({
      kind: 'cels',
      cels: [{ key: doc.celKeyAt(0, 1), rect: { x: 0, y: 0, w: 1, h: 1 } }],
    });
    comp.ghostCanvas(0, 'past', 0.5);
    expect(g.ctx2d.puts).toHaveLength(1); // stroke on frame 1 ≠ ghost 0 rebuild
  });

  it('returns null out of range', () => {
    const { comp } = setup();
    expect(comp.ghostCanvas(-1, 'past', 0.5)).toBeNull();
    expect(comp.ghostCanvas(2, 'future', 0.5)).toBeNull();
  });
});
