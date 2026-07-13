/** core/commands/palette-swap — doc-wide color remap + usedColors census. */
import { describe, expect, it } from 'vitest';
import { SwapColors, usedColors } from '../../src/core/commands/palette-swap';
import { AddFrame } from '../../src/core/commands/frames-ops';
import { AddLayer } from '../../src/core/commands/layers-ops';
import { Bus } from '../../src/core/bus';
import { SpriteDoc } from '../../src/core/doc';
import { History } from '../../src/core/history';
import { packRgba } from '../../src/core/pixels';

const RED = packRgba(255, 0, 0, 255);
const GREEN = packRgba(0, 255, 0, 255);
const BLUE = packRgba(0, 0, 255, 255);
const MAGENTA = packRgba(255, 0, 255, 255);
const YELLOW = packRgba(255, 255, 0, 255);
const WHITE = packRgba(255, 255, 255, 255);

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

/** 2 layers × 2 frames, 4×4. Three cels carry RED/GREEN; l1:f1 stays blank. */
function gridDoc(): SpriteDoc {
  const doc = SpriteDoc.blank(4, 4, 't');
  new AddLayer(0).apply(doc);
  new AddFrame(0).apply(doc);
  for (const layer of doc.layers) {
    for (const frame of doc.frames) doc.ensureCel(doc.celKey(layer.id, frame.id));
  }
  must(doc.getCel(doc.celKeyAt(0, 0)))[0] = RED;
  must(doc.getCel(doc.celKeyAt(0, 0)))[1] = GREEN;
  must(doc.getCel(doc.celKeyAt(0, 1)))[2] = RED;
  must(doc.getCel(doc.celKeyAt(1, 0)))[3] = GREEN;
  return doc;
}

describe('SwapColors', () => {
  it('remaps matching pixels across every layer and frame', () => {
    const doc = gridDoc();
    new SwapColors([{ from: RED, to: BLUE }, { from: GREEN, to: MAGENTA }], false).apply(doc);
    expect(must(doc.getCel(doc.celKeyAt(0, 0)))[0]).toBe(BLUE);
    expect(must(doc.getCel(doc.celKeyAt(0, 0)))[1]).toBe(MAGENTA);
    expect(must(doc.getCel(doc.celKeyAt(0, 1)))[2]).toBe(BLUE);
    expect(must(doc.getCel(doc.celKeyAt(1, 0)))[3]).toBe(MAGENTA);
  });

  it('uses map semantics: a→b,b→c remaps originals in one pass, not sequentially', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const cel = must(doc.getCel(doc.celKeyAt(0, 0)));
    cel[0] = RED;
    cel[1] = GREEN;
    new SwapColors([{ from: RED, to: GREEN }, { from: GREEN, to: BLUE }], false).apply(doc);
    expect(cel[0]).toBe(GREEN); // original RED → GREEN, NOT chained on to BLUE
    expect(cel[1]).toBe(BLUE);  // original GREEN → BLUE
  });

  it('later pair wins on a duplicate from', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    must(doc.getCel(doc.celKeyAt(0, 0)))[0] = RED;
    new SwapColors([{ from: RED, to: GREEN }, { from: RED, to: BLUE }], false).apply(doc);
    expect(must(doc.getCel(doc.celKeyAt(0, 0)))[0]).toBe(BLUE);
  });

  it('apply→revert→apply is byte-stable including palette colors and recent', () => {
    const doc = gridDoc();
    doc.palette.colors = [RED, GREEN, WHITE];
    doc.palette.recent = [GREEN, RED];
    const before = snap(doc);
    const cmd = new SwapColors([{ from: RED, to: BLUE }, { from: GREEN, to: MAGENTA }]);
    cmd.apply(doc);
    expect(doc.palette.colors).toEqual([BLUE, MAGENTA, WHITE]);
    expect(doc.palette.recent).toEqual([MAGENTA, BLUE]);
    const after = snap(doc);
    expect(after).not.toBe(before);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
    cmd.apply(doc);
    expect(snap(doc)).toBe(after);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
  });

  it('alsoPalette=false remaps pixels but leaves the palette untouched', () => {
    const doc = gridDoc();
    doc.palette.colors = [RED, WHITE];
    doc.palette.recent = [RED];
    const colorsRef = doc.palette.colors;
    const recentRef = doc.palette.recent;
    new SwapColors([{ from: RED, to: BLUE }], false).apply(doc);
    expect(doc.palette.colors).toBe(colorsRef);
    expect(doc.palette.recent).toBe(recentRef);
    expect(doc.palette.colors).toEqual([RED, WHITE]);
    expect(must(doc.getCel(doc.celKeyAt(0, 0)))[0]).toBe(BLUE);
  });

  it('captures only changed cels — untouched cels share no copies', () => {
    const doc = gridDoc();
    const celBytes = 4 * 4 * 4;
    const cmd = new SwapColors([{ from: RED, to: BLUE }, { from: GREEN, to: MAGENTA }], false);
    cmd.apply(doc);
    expect(cmd.sizeBytes).toBeGreaterThanOrEqual(2 * 3 * celBytes); // the 3 changed cels
    expect(cmd.sizeBytes).toBeLessThan(2 * 4 * celBytes + 256);     // never all 4
    // the blank l1:f1 cel was not captured: an external write there survives revert
    const untouched = must(doc.getCel(doc.celKeyAt(1, 1)));
    untouched[5] = YELLOW;
    cmd.revert(doc);
    expect(untouched[5]).toBe(YELLOW);
    expect(must(doc.getCel(doc.celKeyAt(0, 0)))[0]).toBe(RED);
  });

  it('sizeBytes > 0 after apply, even for a no-match swap', () => {
    const doc = gridDoc();
    const noop = new SwapColors([{ from: YELLOW, to: BLUE }], false);
    const before = snap(doc);
    noop.apply(doc);
    expect(noop.sizeBytes).toBeGreaterThan(0);
    expect(snap(doc)).toBe(before);
    noop.revert(doc);
    expect(snap(doc)).toBe(before);
  });

  it('round-trips through History undo/redo byte-identically', () => {
    const doc = gridDoc();
    doc.palette.colors = [RED, GREEN];
    const h = new History(doc, new Bus());
    const pristine = snap(doc);
    h.commit(new SwapColors([{ from: RED, to: BLUE }]));
    const swapped = snap(doc);
    h.undo();
    expect(snap(doc)).toBe(pristine);
    h.redo();
    expect(snap(doc)).toBe(swapped);
    h.undo();
    expect(snap(doc)).toBe(pristine);
  });
});

describe('usedColors', () => {
  it('orders by frequency, descending, across all layers and frames', () => {
    const doc = gridDoc();
    const c00 = must(doc.getCel(doc.celKeyAt(0, 0)));
    const c11 = must(doc.getCel(doc.celKeyAt(1, 1)));
    c00.fill(0);
    c00[0] = BLUE;
    c00[1] = BLUE;
    c00[2] = RED;
    must(doc.getCel(doc.celKeyAt(0, 1))).fill(0);
    must(doc.getCel(doc.celKeyAt(1, 0))).fill(0);
    c11[0] = BLUE;
    c11[1] = RED;
    c11[2] = GREEN;
    expect(usedColors(doc)).toEqual([BLUE, RED, GREEN]);
  });

  it('skips alpha=0 pixels but counts semi-transparent ones', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const cel = must(doc.getCel(doc.celKeyAt(0, 0)));
    const ghost = packRgba(9, 9, 9, 0);
    const semi = packRgba(1, 2, 3, 128);
    cel[0] = ghost;
    cel[1] = ghost;
    cel[2] = semi;
    expect(usedColors(doc)).toEqual([semi]);
  });

  it('caps the result (explicit cap and the default 32)', () => {
    const doc = SpriteDoc.blank(8, 8, 't');
    const cel = must(doc.getCel(doc.celKeyAt(0, 0)));
    for (let i = 0; i < 40; i++) cel[i] = packRgba(i + 1, 0, 0, 255);
    cel[40] = packRgba(1, 0, 0, 255); // color #1 twice → top of the list
    expect(usedColors(doc)).toHaveLength(32);
    expect(usedColors(doc, 2)).toEqual([packRgba(1, 0, 0, 255), packRgba(2, 0, 0, 255)]);
  });
});
