/** core/commands/layers-ops — structural layer commands: round-trips, merge, history. */
import { describe, expect, it } from 'vitest';
import {
  AddLayer, MergeLayerDown, RemoveLayer, RenameLayer, ReorderLayer,
  SetLayerOpacity, SetLayerVisible,
} from '../../src/core/commands/layers-ops';
import { AddFrame } from '../../src/core/commands/frames-ops';
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

/** 2 layers × 2 frames, one distinct seeded pixel per (layer, frame). */
function gridDoc(): SpriteDoc {
  const doc = SpriteDoc.blank(4, 4, 't');
  new AddLayer(0).apply(doc);
  new AddFrame(0).apply(doc);
  doc.layers.forEach((layer, li) => {
    doc.frames.forEach((frame, fi) => {
      const cel = doc.ensureCel(doc.celKey(layer.id, frame.id));
      cel[li * 2 + fi] = packRgba(40 * li + 9, 30 * fi + 7, li + fi, 255);
    });
  });
  return doc;
}

describe('AddLayer', () => {
  it('inserts above the index with defaults and a derived name', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    new AddLayer(0).apply(doc);
    expect(doc.layers).toHaveLength(2);
    const added = must(doc.layers[1]);
    expect(added.id).toBe('l2');
    expect(added.name).toBe('layer 2');
    expect(added.opacity).toBe(1);
    expect(added.visible).toBe(true);
    expect(doc.celEntriesForLayer(added.id)).toEqual([]);
  });

  it('honors an explicit name and round-trips byte-stable with a stable id', () => {
    const doc = gridDoc();
    const before = snap(doc);
    const cmd = new AddLayer(0, 'shading');
    cmd.apply(doc);
    expect(must(doc.layers[1]).name).toBe('shading');
    const id = must(doc.layers[1]).id;
    const after = snap(doc);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
    cmd.apply(doc);
    expect(snap(doc)).toBe(after);
    expect(must(doc.layers[1]).id).toBe(id);
  });

  it('never re-allocates: no id collision after undo + new command', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const h = new History(doc, new Bus());
    h.commit(new AddLayer(0));
    const first = must(doc.layers[1]).id;
    h.undo();
    h.commit(new AddLayer(0));
    const second = must(doc.layers[1]).id;
    expect(second).not.toBe(first);
    h.undo();
    h.redo();
    expect(must(doc.layers[1]).id).toBe(second);
  });

  it('sizeBytes grows to cover cels captured by a later revert', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const h = new History(doc, new Bus());
    const add = new AddLayer(0);
    h.commit(add);
    expect(add.sizeBytes).toBe(128);

    const key = doc.celKeyAt(1, 0);
    const blank = new Uint32Array(16);
    const green = new Uint32Array(16);
    green[0] = GREEN;
    h.commit(must(PixelPatch.fromBuffers(key, 4, 4, blank, green, 'paint')));

    h.undo(); // undo paint — leaves a blank cel on the added layer
    h.undo(); // undo add — captures that cel
    expect(add.sizeBytes).toBe(128 + 4 * 4 * 4);
    h.redo();
    expect(add.sizeBytes).toBe(128 + 4 * 4 * 4);
  });
});

describe('RemoveLayer', () => {
  it('removes the layer with its cels across frames; revert restores byte-identical', () => {
    const doc = gridDoc();
    const before = snap(doc);
    const removedId = must(doc.layers[0]).id;
    const cmd = new RemoveLayer(0);
    cmd.apply(doc);
    expect(doc.layers).toHaveLength(1);
    expect(doc.celEntriesForLayer(removedId)).toEqual([]);
    const after = snap(doc);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
    cmd.apply(doc);
    expect(snap(doc)).toBe(after);
  });

  it('no-ops on the last layer, including revert', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const before = snap(doc);
    const cmd = new RemoveLayer(0);
    cmd.apply(doc);
    expect(snap(doc)).toBe(before);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
    expect(doc.layers).toHaveLength(1);
  });
});

describe('ReorderLayer', () => {
  it('moves the layer; revert moves it back; cels survive (id-keyed)', () => {
    const doc = gridDoc();
    const before = snap(doc);
    const ids = doc.layers.map((l) => l.id);
    const cmd = new ReorderLayer(0, 1);
    cmd.apply(doc);
    expect(doc.layers.map((l) => l.id)).toEqual([ids[1], ids[0]]);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
    cmd.apply(doc);
    expect(doc.layers.map((l) => l.id)).toEqual([ids[1], ids[0]]);
  });
});

describe('SetLayerOpacity', () => {
  it('clamps to 0..1 and restores the previous value', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    must(doc.layers[0]).opacity = 0.7;
    const hi = new SetLayerOpacity(0, 3);
    hi.apply(doc);
    expect(must(doc.layers[0]).opacity).toBe(1);
    hi.revert(doc);
    expect(must(doc.layers[0]).opacity).toBe(0.7);
    const lo = new SetLayerOpacity(0, -2);
    lo.apply(doc);
    expect(must(doc.layers[0]).opacity).toBe(0);
    lo.revert(doc);
    expect(must(doc.layers[0]).opacity).toBe(0.7);
  });
});

describe('SetLayerVisible', () => {
  it('toggles and restores', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const cmd = new SetLayerVisible(0, false);
    cmd.apply(doc);
    expect(must(doc.layers[0]).visible).toBe(false);
    cmd.revert(doc);
    expect(must(doc.layers[0]).visible).toBe(true);
    cmd.apply(doc);
    expect(must(doc.layers[0]).visible).toBe(false);
  });
});

describe('RenameLayer', () => {
  it('renames and restores', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const cmd = new RenameLayer(0, 'outline');
    cmd.apply(doc);
    expect(must(doc.layers[0]).name).toBe('outline');
    cmd.revert(doc);
    expect(must(doc.layers[0]).name).toBe('layer 1');
  });
});

describe('MergeLayerDown', () => {
  it('bakes the top layer 50% opacity into the below cel (exact blend)', () => {
    const doc = SpriteDoc.blank(2, 1, 't');
    const below = must(doc.layers[0]);
    const fid = must(doc.frames[0]).id;
    must(doc.getCel(doc.celKey(below.id, fid)))[0] = RED;
    new AddLayer(0).apply(doc);
    const top = must(doc.layers[1]);
    top.opacity = 0.5;
    const topCel = doc.ensureCel(doc.celKey(top.id, fid));
    topCel[0] = BLUE;
    topCel[1] = GREEN;

    new MergeLayerDown(1).apply(doc);
    expect(doc.layers).toHaveLength(1);
    expect(must(doc.layers[0]).id).toBe(below.id);
    expect(must(doc.layers[0]).opacity).toBe(1);
    expect(doc.celEntriesForLayer(top.id)).toEqual([]);
    const merged = must(doc.getCel(doc.celKey(below.id, fid)));
    expect(merged[0]).toBe(packRgba(128, 0, 128, 255)); // BLUE@50% over opaque RED
    expect(merged[1]).toBe(packRgba(0, 255, 0, 128));   // GREEN@50% over transparent
  });

  it('creates a below cel where only the top drew; revert removes it again', () => {
    const doc = SpriteDoc.blank(2, 1, 't');
    new AddFrame(0).apply(doc);
    new AddLayer(0).apply(doc);
    const top = must(doc.layers[1]);
    const f2 = must(doc.frames[1]);
    doc.ensureCel(doc.celKey(top.id, f2.id))[0] = GREEN;
    const before = snap(doc);
    const belowKey = doc.celKey('l1', f2.id);
    expect(doc.getCel(belowKey)).toBeUndefined();

    const cmd = new MergeLayerDown(1);
    cmd.apply(doc);
    expect([...must(doc.getCel(belowKey))]).toEqual([GREEN, 0]);
    const after = snap(doc);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
    expect(doc.getCel(belowKey)).toBeUndefined();
    cmd.apply(doc);
    expect(snap(doc)).toBe(after);
  });

  it('multi-frame merge reverts everything byte-identically, twice', () => {
    const doc = gridDoc();
    must(doc.layers[1]).opacity = 0.25;
    const before = snap(doc);
    const cmd = new MergeLayerDown(1);
    cmd.apply(doc);
    expect(doc.layers).toHaveLength(1);
    const after = snap(doc);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
    cmd.apply(doc);
    expect(snap(doc)).toBe(after);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
  });

  it('no-ops when there is no layer below', () => {
    const doc = gridDoc();
    const before = snap(doc);
    const cmd = new MergeLayerDown(0);
    cmd.apply(doc);
    expect(snap(doc)).toBe(before);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
  });
});

describe('history integration', () => {
  it('layer sequence + pixel patches jump 0→end byte-identically', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const h = new History(doc, new Bus());
    const pristine = snap(doc);

    const blank = new Uint32Array(16);
    const red = new Uint32Array(16);
    red[3] = RED;
    h.commit(must(PixelPatch.fromBuffers(doc.celKeyAt(0, 0), 4, 4, blank, red, 'paint below')));

    h.commit(new AddLayer(0, 'ink'));
    const inkKey = doc.celKeyAt(1, 0);
    const green = new Uint32Array(16);
    green[3] = GREEN;
    green[9] = GREEN;
    h.commit(must(PixelPatch.fromBuffers(inkKey, 4, 4, blank, green, 'paint ink')));

    h.commit(new SetLayerOpacity(1, 0.5));
    h.commit(new RenameLayer(0, 'base'));
    h.commit(new MergeLayerDown(1));
    h.commit(new AddLayer(0, 'scratch'));
    h.commit(new ReorderLayer(0, 1));
    h.commit(new SetLayerVisible(0, false));
    h.commit(new RemoveLayer(0));
    const final = snap(doc);
    expect(final).not.toBe(pristine);
    expect(doc.layers).toHaveLength(1);

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
