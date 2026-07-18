/** core/commands/frames-ops — structural frame commands: round-trips, tags, history. */
import { describe, expect, it } from 'vitest';
import {
  AddFrame, DuplicateFrame, RemoveFrame, ReorderFrame, ReverseFrames, SetFrameDuration,
} from '../../src/core/commands/frames-ops';
import { AddLayer } from '../../src/core/commands/layers-ops';
import { AddTag } from '../../src/core/commands/tags-ops';
import { PixelPatch } from '../../src/core/commands/pixel-patch';
import { Bus } from '../../src/core/bus';
import { SpriteDoc } from '../../src/core/doc';
import { History } from '../../src/core/history';
import { packRgba } from '../../src/core/pixels';

const RED = packRgba(255, 0, 0, 255);
const GREEN = packRgba(0, 255, 0, 255);
const BLUE = packRgba(0, 0, 255, 255);

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('unexpected null');
  return v;
}

/** Canonical byte-compare snapshot (cel map iteration order is not semantic). */
function snap(doc: SpriteDoc): string {
  const j = doc.toJSON();
  const cels = Object.fromEntries(Object.entries(j.cels).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ ...j, cels });
}

/** 2 layers × 3 frames, one distinct seeded pixel per (layer, frame). */
function gridDoc(): SpriteDoc {
  const doc = SpriteDoc.blank(4, 4, 't');
  new AddLayer(0).apply(doc);
  new AddFrame(0, 200).apply(doc);
  new AddFrame(1, 300).apply(doc);
  doc.layers.forEach((layer, li) => {
    doc.frames.forEach((frame, fi) => {
      const cel = doc.ensureCel(doc.celKey(layer.id, frame.id));
      cel[li * 4 + fi] = packRgba(li * 100 + 10, fi * 50 + 5, 0, 255);
    });
  });
  return doc;
}

describe('AddFrame', () => {
  it('inserts a blank frame after the index with the given duration', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    new AddFrame(0, 250).apply(doc);
    expect(doc.frames).toHaveLength(2);
    const added = must(doc.frames[1]);
    expect(added.durationMs).toBe(250);
    expect(added.id).not.toBe(must(doc.frames[0]).id);
    expect(doc.celEntriesForFrame(added.id)).toEqual([]);
  });

  it('afterIndex -1 inserts at the start with the default duration', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    new AddFrame(-1).apply(doc);
    expect(must(doc.frames[0]).id).toBe('f2');
    expect(must(doc.frames[0]).durationMs).toBe(100);
    expect(must(doc.frames[1]).id).toBe('f1');
  });

  it('apply→revert→apply is byte-stable with a stable id', () => {
    const doc = gridDoc();
    const before = snap(doc);
    const cmd = new AddFrame(1, 80);
    cmd.apply(doc);
    const id = must(doc.frames[2]).id;
    const after = snap(doc);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
    cmd.apply(doc);
    expect(snap(doc)).toBe(after);
    expect(must(doc.frames[2]).id).toBe(id);
  });

  it('never re-allocates: no id collision after undo + new command', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const h = new History(doc, new Bus());
    h.commit(new AddFrame(0));
    const first = must(doc.frames[1]).id;
    h.undo();
    h.commit(new AddFrame(0));
    const second = must(doc.frames[1]).id;
    expect(second).not.toBe(first);
    h.undo();
    h.redo();
    expect(must(doc.frames[1]).id).toBe(second);
  });

  it('sizeBytes grows to cover cels captured by a later revert', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const h = new History(doc, new Bus());
    const add = new AddFrame(0);
    h.commit(add);
    expect(add.sizeBytes).toBe(128);

    const key = doc.celKeyAt(0, 1);
    const blank = new Uint32Array(16);
    const red = new Uint32Array(16);
    red[0] = RED;
    h.commit(must(PixelPatch.fromBuffers(key, 4, 4, blank, red, 'paint')));

    h.undo(); // undo paint — leaves a blank cel on the added frame
    h.undo(); // undo add — captures that cel
    expect(add.sizeBytes).toBe(128 + 4 * 4 * 4);
    h.redo();
    expect(add.sizeBytes).toBe(128 + 4 * 4 * 4);
  });
});

describe('DuplicateFrame', () => {
  it('deep-copies every layer cel and the duration', () => {
    const doc = gridDoc();
    must(doc.frames[0]).durationMs = 170;
    new DuplicateFrame(0).apply(doc);
    expect(doc.frames).toHaveLength(4);
    const src = must(doc.frames[0]);
    const dup = must(doc.frames[1]);
    expect(dup.id).not.toBe(src.id);
    expect(dup.durationMs).toBe(170);
    for (const layer of doc.layers) {
      const a = must(doc.getCel(doc.celKey(layer.id, src.id)));
      const b = must(doc.getCel(doc.celKey(layer.id, dup.id)));
      expect([...b]).toEqual([...a]);
      b[15] = BLUE;
      expect(a[15]).not.toBe(BLUE);
      b[15] = 0;
    }
  });

  it('round-trips byte-stable through revert/apply', () => {
    const doc = gridDoc();
    const before = snap(doc);
    const cmd = new DuplicateFrame(1);
    cmd.apply(doc);
    const after = snap(doc);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
    cmd.apply(doc);
    expect(snap(doc)).toBe(after);
  });

  it('throws on a bad index', () => {
    expect(() => new DuplicateFrame(9).apply(SpriteDoc.blank(2, 2, 't'))).toThrow(RangeError);
  });
});

describe('RemoveFrame', () => {
  it('removes the frame + cels on every layer; revert restores byte-identical', () => {
    const doc = gridDoc();
    const before = snap(doc);
    const removedId = must(doc.frames[1]).id;
    const cmd = new RemoveFrame(1);
    cmd.apply(doc);
    expect(doc.frames).toHaveLength(2);
    expect(doc.frames.some((f) => f.id === removedId)).toBe(false);
    expect(doc.celEntriesForFrame(removedId)).toEqual([]);
    const after = snap(doc);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
    cmd.apply(doc);
    expect(snap(doc)).toBe(after);
  });

  it('shifts/shrinks/drops tags; revert restores the prior tags wholesale', () => {
    const doc = gridDoc();
    new AddFrame(2).apply(doc);
    doc.tags = [
      { name: 'a', from: 0, to: 0, mode: 'loop' },
      { name: 'b', from: 1, to: 3, mode: 'hold' },
      { name: 'c', from: 2, to: 2, mode: 'loop' },
      { name: 'd', from: 3, to: 3, mode: 'pingpong' },
      { name: 'e', from: 0, to: 3, mode: 'loop' },
    ];
    const prevTags = doc.tags;
    const cmd = new RemoveFrame(2);
    cmd.apply(doc);
    expect(doc.tags).toEqual([
      { name: 'a', from: 0, to: 0, mode: 'loop' },
      { name: 'b', from: 1, to: 2, mode: 'hold' },
      { name: 'd', from: 2, to: 2, mode: 'pingpong' },
      { name: 'e', from: 0, to: 2, mode: 'loop' },
    ]);
    cmd.revert(doc);
    expect(doc.tags).toBe(prevTags);
    expect(doc.tags).toHaveLength(5);
  });

  it('no-ops on the last frame, including revert', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const before = snap(doc);
    const cmd = new RemoveFrame(0);
    cmd.apply(doc);
    expect(snap(doc)).toBe(before);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
    expect(doc.frames).toHaveLength(1);
  });
});

describe('ReorderFrame', () => {
  it('moves the frame to the target index; revert moves it back', () => {
    const doc = gridDoc();
    const ids = doc.frames.map((f) => f.id);
    const cmd = new ReorderFrame(0, 2);
    cmd.apply(doc);
    expect(doc.frames.map((f) => f.id)).toEqual([ids[1], ids[2], ids[0]]);
    cmd.revert(doc);
    expect(doc.frames.map((f) => f.id)).toEqual(ids);
    cmd.apply(doc);
    expect(doc.frames.map((f) => f.id)).toEqual([ids[1], ids[2], ids[0]]);
  });
});

describe('ReverseFrames', () => {
  it('reverses order and remaps tags; revert restores exactly', () => {
    const doc = gridDoc();
    doc.tags = [
      { name: 'head', from: 0, to: 1, mode: 'loop' },
      { name: 'tail', from: 2, to: 2, mode: 'hold' },
    ];
    const before = snap(doc);
    const ids = doc.frames.map((f) => f.id);
    const cmd = new ReverseFrames();
    cmd.apply(doc);
    expect(doc.frames.map((f) => f.id)).toEqual([...ids].reverse());
    expect(doc.tags).toEqual([
      { name: 'head', from: 1, to: 2, mode: 'loop' },
      { name: 'tail', from: 0, to: 0, mode: 'hold' },
    ]);
    const after = snap(doc);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
    cmd.apply(doc);
    expect(snap(doc)).toBe(after);
  });
});

describe('SetFrameDuration', () => {
  it('clamps to 20..5000 and restores the previous value', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const lo = new SetFrameDuration(0, 5);
    lo.apply(doc);
    expect(must(doc.frames[0]).durationMs).toBe(20);
    lo.revert(doc);
    expect(must(doc.frames[0]).durationMs).toBe(100);
    const hi = new SetFrameDuration(0, 90000);
    hi.apply(doc);
    expect(must(doc.frames[0]).durationMs).toBe(5000);
    hi.revert(doc);
    expect(must(doc.frames[0]).durationMs).toBe(100);
  });

  it('throws on a bad index', () => {
    expect(() => new SetFrameDuration(3, 100).apply(SpriteDoc.blank(2, 2, 't'))).toThrow(RangeError);
  });
});

describe('history integration', () => {
  it('structural + pixel commands jump 0→end byte-identically', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const h = new History(doc, new Bus());
    const pristine = snap(doc);

    const key1 = doc.celKeyAt(0, 0);
    const blank = new Uint32Array(16);
    const red = new Uint32Array(16);
    red[0] = RED;
    h.commit(must(PixelPatch.fromBuffers(key1, 4, 4, blank, red, 'paint')));

    h.commit(new AddFrame(0, 60));
    h.commit(new DuplicateFrame(0));

    // paint onto the added frame's nonexistent cel — exercises AddFrame's
    // defensive cel capture on undo/redo
    const key2 = doc.celKeyAt(0, 2);
    const painted = new Uint32Array(16);
    painted[7] = GREEN;
    h.commit(must(PixelPatch.fromBuffers(key2, 4, 4, blank, painted, 'paint 2')));

    h.commit(new AddTag({ name: 'walk', from: 0, to: 2, mode: 'loop' }));
    h.commit(new SetFrameDuration(1, 45));
    h.commit(new RemoveFrame(1));
    h.commit(new ReorderFrame(0, 1));
    h.commit(new ReverseFrames());
    const final = snap(doc);
    expect(final).not.toBe(pristine);

    h.jumpTo(0);
    expect(snap(doc)).toBe(pristine);
    h.jumpTo(99);
    expect(snap(doc)).toBe(final);
    h.jumpTo(0);
    expect(snap(doc)).toBe(pristine);
    h.jumpTo(99);
    expect(snap(doc)).toBe(final);
  });
});
