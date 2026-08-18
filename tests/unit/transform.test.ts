/** core/commands/transform — frame-scoped flips + doc-wide rotate: byte-exact
 *  round-trips, sparse cels stay sparse, redo-after-undo identity (caching),
 *  non-square dims swap, honest sizeBytes. */
import { describe, expect, it } from 'vitest';
import { FlipFrameX, FlipFrameY, Rotate90CW } from '../../src/core/commands/transform';
import { AddFrame } from '../../src/core/commands/frames-ops';
import { AddLayer } from '../../src/core/commands/layers-ops';
import { Bus } from '../../src/core/bus';
import { SpriteDoc } from '../../src/core/doc';
import { History } from '../../src/core/history';
import { packRgba } from '../../src/core/pixels';

/** Canonical byte-compare snapshot (cel map iteration order is not semantic). */
function snap(doc: SpriteDoc): string {
  const j = doc.toJSON();
  const cels = Object.fromEntries(Object.entries(j.cels).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ ...j, cels });
}

/** 2 layers × 3 frames, every pixel distinct per cel; cel (l2, f2) left sparse. */
function seededDoc(w: number, h: number): SpriteDoc {
  const doc = SpriteDoc.blank(w, h, 'transform-me');
  new AddLayer(0).apply(doc);
  new AddFrame(0, 120).apply(doc);
  new AddFrame(1, 140).apply(doc);
  doc.layers.forEach((layer, li) => {
    doc.frames.forEach((frame, fi) => {
      if (li === 1 && fi === 1) return;
      const cel = doc.ensureCel(doc.celKey(layer.id, frame.id));
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          cel[y * w + x] = packRgba(x + 1, y + 1, li * 10 + fi + 1, 255);
        }
      }
    });
  });
  return doc;
}

function sparseKey(doc: SpriteDoc): `${string}:${string}` {
  const l2 = doc.layers[1];
  const f2 = doc.frames[1];
  if (!l2 || !f2) throw new Error('seed shape changed');
  return doc.celKey(l2.id, f2.id);
}

describe('FlipFrameX / FlipFrameY', () => {
  it.each([
    ['FlipFrameX', (i: number) => new FlipFrameX(i)] as const,
    ['FlipFrameY', (i: number) => new FlipFrameY(i)] as const,
  ])('%s scopes to ONE frame, all layers; other frames untouched', (_name, make) => {
    const doc = seededDoc(5, 4);
    const f0 = doc.frames[0];
    const f2 = doc.frames[2];
    if (!f0 || !f2) throw new Error('seed shape changed');
    const otherBefore = doc.celEntriesForFrame(f2.id).map(([k, b]) => [k, b.slice()] as const);
    const targetBefore = doc.celEntriesForFrame(f0.id).map(([k, b]) => [k, b.slice()] as const);
    expect(targetBefore.length).toBe(2); // both layers have a cel on frame 0

    make(0).apply(doc);
    for (const [key, before] of otherBefore) {
      expect(doc.getCel(key)).toEqual(before);
    }
    for (const [key, before] of targetBefore) {
      expect(doc.getCel(key)).not.toEqual(before);
    }
  });

  it('flip X mirrors columns (checked against an independent reference)', () => {
    const w = 5;
    const h = 4;
    const doc = seededDoc(w, h);
    const key = doc.celKeyAt(0, 0);
    const before = doc.ensureCel(key).slice();
    new FlipFrameX(0).apply(doc);
    const after = doc.getCel(key);
    expect(after).toBeDefined();
    if (!after) return;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        expect(after[y * w + x]).toBe(before[y * w + (w - 1 - x)]);
      }
    }
  });

  it('flip Y mirrors rows (checked against an independent reference)', () => {
    const w = 5;
    const h = 4;
    const doc = seededDoc(w, h);
    const key = doc.celKeyAt(0, 0);
    const before = doc.ensureCel(key).slice();
    new FlipFrameY(0).apply(doc);
    const after = doc.getCel(key);
    expect(after).toBeDefined();
    if (!after) return;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        expect(after[y * w + x]).toBe(before[(h - 1 - y) * w + x]);
      }
    }
  });

  it.each([
    ['FlipFrameX', (i: number) => new FlipFrameX(i)] as const,
    ['FlipFrameY', (i: number) => new FlipFrameY(i)] as const,
  ])('%s twice is identity; apply→revert is byte-identical', (_name, make) => {
    const doc = seededDoc(6, 3);
    const before = snap(doc);
    const cmd = make(1);
    cmd.apply(doc);
    const after = snap(doc);
    cmd.apply(doc); // involution — hits the cached-keys path, not first-apply
    expect(snap(doc)).toBe(before);
    cmd.apply(doc);
    expect(snap(doc)).toBe(after);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
  });

  it('sparse cels stay sparse; the sparse frame flips only existing cels', () => {
    const doc = seededDoc(4, 4);
    const key = sparseKey(doc);
    expect(doc.getCel(key)).toBeUndefined();
    const cmd = new FlipFrameX(1); // frame 1 = the frame with the sparse (l2) cel
    cmd.apply(doc);
    expect(doc.getCel(key)).toBeUndefined();
    cmd.revert(doc);
    expect(doc.getCel(key)).toBeUndefined();
    // dirty lists exactly the one existing cel, full-doc rect
    expect(cmd.dirty.kind).toBe('cels');
    if (cmd.dirty.kind === 'cels') {
      expect(cmd.dirty.cels.length).toBe(1);
      expect(cmd.dirty.cels[0]?.rect).toEqual({ x: 0, y: 0, w: 4, h: 4 });
    }
  });

  it('undo/redo cycles through History are byte-identical (cached keys)', () => {
    const doc = seededDoc(5, 5);
    const h = new History(doc, new Bus());
    const before = snap(doc);
    h.commit(new FlipFrameY(2));
    const after = snap(doc);
    for (let i = 0; i < 3; i++) {
      h.undo();
      expect(snap(doc)).toBe(before);
      h.redo();
      expect(snap(doc)).toBe(after);
    }
  });

  it('dirty is empty before first apply and populated after (History reads it post-apply)', () => {
    const cmd = new FlipFrameX(0);
    expect(cmd.dirty).toEqual({ kind: 'cels', cels: [] });
    const doc = seededDoc(3, 3);
    cmd.apply(doc);
    if (cmd.dirty.kind === 'cels') expect(cmd.dirty.cels.length).toBe(2);
  });

  it('retains no pixel buffers (sizeBytes stays trivial and stable)', () => {
    const doc = seededDoc(8, 8);
    const cmd = new FlipFrameX(0);
    cmd.apply(doc);
    const charged = cmd.sizeBytes;
    expect(charged).toBeLessThan(1024);
    cmd.revert(doc);
    expect(cmd.sizeBytes).toBe(charged);
  });

  it('throws on a bad frame index at first apply', () => {
    const doc = seededDoc(3, 3);
    expect(() => new FlipFrameX(99).apply(doc)).toThrow(RangeError);
    expect(() => new FlipFrameY(-1).apply(doc)).toThrow(RangeError);
  });
});

describe('Rotate90CW', () => {
  it('rotates pixels clockwise (checked against an independent reference)', () => {
    const w = 5;
    const h = 3;
    const doc = seededDoc(w, h);
    const key = doc.celKeyAt(0, 0);
    const before = doc.ensureCel(key).slice();
    new Rotate90CW().apply(doc);
    expect(doc.width).toBe(h);
    expect(doc.height).toBe(w);
    const after = doc.getCel(key);
    expect(after).toBeDefined();
    if (!after) return;
    expect(after.length).toBe(w * h);
    // src (x, y) lands at (h-1-y, x) in the h×w output
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        expect(after[x * h + (h - 1 - y)]).toBe(before[y * w + x]);
      }
    }
  });

  it('non-square doc swaps dims; every cel of every frame rotates', () => {
    const doc = seededDoc(6, 4);
    const before = new Map<string, Uint32Array>();
    for (const layer of doc.layers) {
      for (const [key, buf] of doc.celEntriesForLayer(layer.id)) before.set(key, buf.slice());
    }
    expect(before.size).toBe(5);
    new Rotate90CW().apply(doc);
    expect(doc.width).toBe(4);
    expect(doc.height).toBe(6);
    for (const [key, old] of before) {
      const rotated = doc.getCel(key as `${string}:${string}`);
      expect(rotated).toBeDefined();
      if (!rotated) continue;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 6; x++) {
          expect(rotated[x * 4 + (4 - 1 - y)]).toBe(old[y * 6 + x]);
        }
      }
    }
  });

  it('rotate ×4 through History is identity; sparse cel stays sparse', () => {
    const doc = seededDoc(5, 3);
    const h = new History(doc, new Bus());
    const key = sparseKey(doc);
    const s0 = snap(doc);
    for (let i = 0; i < 4; i++) h.commit(new Rotate90CW());
    expect(snap(doc)).toBe(s0);
    expect(doc.getCel(key)).toBeUndefined();
  });

  it('undo restores dims AND bytes; redo-after-undo identical (first-apply caching)', () => {
    const doc = seededDoc(7, 4);
    const h = new History(doc, new Bus());
    const before = snap(doc);
    h.commit(new Rotate90CW());
    const after = snap(doc);
    expect(doc.width).toBe(4);
    expect(doc.height).toBe(7);
    for (let i = 0; i < 3; i++) {
      h.undo();
      expect(snap(doc)).toBe(before);
      expect(doc.width).toBe(7);
      h.redo();
      expect(snap(doc)).toBe(after);
      expect(doc.width).toBe(4);
    }
  });

  it('sizeBytes counts both retained generations, exactly, stable across cycles', () => {
    const doc = seededDoc(4, 4); // 5 cels × 64 bytes
    const cmd = new Rotate90CW();
    expect(cmd.sizeBytes).toBe(128);
    cmd.apply(doc);
    const charged = 128 + 5 * 4 * 4 * 4 * 2; // originals + rotated copies
    expect(cmd.sizeBytes).toBe(charged);
    cmd.revert(doc);
    expect(cmd.sizeBytes).toBe(charged);
    cmd.apply(doc);
    expect(cmd.sizeBytes).toBe(charged);
  });

  it('label + dirty scope', () => {
    const cmd = new Rotate90CW();
    expect(cmd.label).toBe('rotate 90° cw');
    expect(cmd.dirty).toEqual({ kind: 'all' });
    expect(new FlipFrameX(0).label).toBe('flip horizontal');
    expect(new FlipFrameY(0).label).toBe('flip vertical');
  });
});
