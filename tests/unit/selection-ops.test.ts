/** core/commands/selection-ops — selection/float commands + history integration. */
import { describe, expect, it } from 'vitest';
import type { SelectionHost } from '../../src/core/commands/selection-ops';
import { AnchorFloat, DropFloat, LiftFloat, PasteFloat, SetSelection } from '../../src/core/commands/selection-ops';
import { Bus } from '../../src/core/bus';
import { SpriteDoc } from '../../src/core/doc';
import { History } from '../../src/core/history';
import { packRgba } from '../../src/core/pixels';
import { maskFromRect } from '../../src/core/selection';

const RED = packRgba(255, 0, 0, 255);
const GREEN = packRgba(0, 255, 0, 255);
const BLUE = packRgba(0, 0, 255, 255);
const WHITE = packRgba(255, 255, 255, 255);

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('unexpected null');
  return v;
}

function makeHost(): SelectionHost {
  return { selection: null, float: null };
}

/** 8×8 blank doc with a RED/GREEN/BLUE/WHITE 2×2 block at (1,1). */
function seededDoc(): { doc: SpriteDoc; key: `${string}:${string}`; cel: Uint32Array } {
  const doc = SpriteDoc.blank(8, 8, 't');
  const key = doc.celKey('l1', 'f1');
  const cel = doc.ensureCel(key);
  cel[1 * 8 + 1] = RED;
  cel[1 * 8 + 2] = GREEN;
  cel[2 * 8 + 1] = BLUE;
  cel[2 * 8 + 2] = WHITE;
  return { doc, key, cel };
}

describe('SetSelection', () => {
  it('swaps in next on apply, restores prev on revert', () => {
    const doc = SpriteDoc.blank(8, 8, 't');
    const host = makeHost();
    const a = must(maskFromRect({ x: 0, y: 0, w: 1, h: 1 }, 8, 8));
    const b = must(maskFromRect({ x: 2, y: 2, w: 3, h: 3 }, 8, 8));
    host.selection = a;

    const cmd = new SetSelection(host, b, 'select rect');
    expect(cmd.label).toBe('select rect');
    expect(cmd.sizeBytes).toBe(a.mask.byteLength + b.mask.byteLength + 64);
    expect(cmd.dirty).toEqual({ kind: 'selection' });

    cmd.apply(doc);
    expect(host.selection).toBe(b);
    cmd.revert(doc);
    expect(host.selection).toBe(a);
    cmd.apply(doc);
    expect(host.selection).toBe(b);
  });

  it('handles null next (deselect)', () => {
    const doc = SpriteDoc.blank(8, 8, 't');
    const host = makeHost();
    const a = must(maskFromRect({ x: 1, y: 1, w: 2, h: 2 }, 8, 8));
    host.selection = a;

    const cmd = new SetSelection(host, null, 'deselect');
    expect(cmd.sizeBytes).toBe(a.mask.byteLength + 64);
    cmd.apply(doc);
    expect(host.selection).toBeNull();
    cmd.revert(doc);
    expect(host.selection).toBe(a);
  });

  it('counts only the next mask when there is no prior selection', () => {
    const host = makeHost();
    const b = must(maskFromRect({ x: 0, y: 0, w: 2, h: 2 }, 8, 8));
    expect(new SetSelection(host, b, 'select').sizeBytes).toBe(b.mask.byteLength + 64);
    expect(new SetSelection(host, null, 'deselect').sizeBytes).toBe(64);
  });
});

describe('LiftFloat', () => {
  it('throws when there is no selection', () => {
    const { key } = seededDoc();
    expect(() => new LiftFloat(makeHost(), key, 8, 8)).toThrow();
  });

  it('zeroes masked pixels into the float; revert is byte-identical', () => {
    const { doc, key, cel } = seededDoc();
    const original = new Uint32Array(cel);
    const host = makeHost();
    const sel = must(maskFromRect({ x: 1, y: 1, w: 2, h: 2 }, 8, 8));
    host.selection = sel;

    const cmd = new LiftFloat(host, key, 8, 8);
    expect(cmd.sizeBytes).toBe(3 * 2 * 2 * 4 + sel.mask.byteLength + 128);
    expect(cmd.dirty).toEqual({ kind: 'cels', cels: [{ key, rect: { x: 1, y: 1, w: 2, h: 2 } }] });

    cmd.apply(doc);
    expect(cel[1 * 8 + 1]).toBe(0);
    expect(cel[1 * 8 + 2]).toBe(0);
    expect(cel[2 * 8 + 1]).toBe(0);
    expect(cel[2 * 8 + 2]).toBe(0);
    const float = must(host.float);
    expect(float.rect).toEqual({ x: 1, y: 1, w: 2, h: 2 });
    expect([...float.pixels]).toEqual([RED, GREEN, BLUE, WHITE]);

    cmd.revert(doc);
    expect([...cel]).toEqual([...original]);
    expect(host.float).toBeNull();
    expect(host.selection).toBe(sel);
  });

  it('lifts only masked pixels; unmasked slots stay 0 in the float', () => {
    const { doc, key, cel } = seededDoc();
    const host = makeHost();
    const mask = new Uint8Array(64);
    mask[1 * 8 + 1] = 1;
    mask[2 * 8 + 2] = 1;
    host.selection = { mask, bounds: { x: 1, y: 1, w: 2, h: 2 } };

    new LiftFloat(host, key, 8, 8).apply(doc);
    expect(cel[1 * 8 + 1]).toBe(0);
    expect(cel[2 * 8 + 2]).toBe(0);
    expect(cel[1 * 8 + 2]).toBe(GREEN);
    expect(cel[2 * 8 + 1]).toBe(BLUE);
    expect([...must(host.float).pixels]).toEqual([RED, 0, 0, WHITE]);
  });

  it('redo restores a fresh rect so drags cannot corrupt the cache', () => {
    const { doc, key, cel } = seededDoc();
    const host = makeHost();
    host.selection = must(maskFromRect({ x: 1, y: 1, w: 2, h: 2 }, 8, 8));

    const cmd = new LiftFloat(host, key, 8, 8);
    cmd.apply(doc);
    const lifted = new Uint32Array(cel);
    must(host.float).rect.x = 5;
    must(host.float).rect.y = 6;
    cmd.revert(doc);
    cmd.apply(doc);
    expect([...cel]).toEqual([...lifted]);
    expect(must(host.float).rect).toEqual({ x: 1, y: 1, w: 2, h: 2 });
    expect([...must(host.float).pixels]).toEqual([RED, GREEN, BLUE, WHITE]);
  });
});

describe('AnchorFloat', () => {
  it('throws when there is no float', () => {
    const { key } = seededDoc();
    expect(() => new AnchorFloat(makeHost(), key, 8, 8)).toThrow();
  });

  it('composites at the moved rect; revert restores; redo re-lands identically', () => {
    const { doc, key, cel } = seededDoc();
    const host = makeHost();
    const sel = must(maskFromRect({ x: 1, y: 1, w: 2, h: 2 }, 8, 8));
    host.selection = sel;
    new LiftFloat(host, key, 8, 8).apply(doc);
    const lifted = new Uint32Array(cel);
    must(host.float).rect.x = 4;
    must(host.float).rect.y = 4;

    const cmd = new AnchorFloat(host, key, 8, 8);
    expect(cmd.sizeBytes).toBe(3 * 2 * 2 * 4 + 128);
    expect(cmd.dirty).toEqual({ kind: 'cels', cels: [{ key, rect: { x: 4, y: 4, w: 2, h: 2 } }] });

    cmd.apply(doc);
    const anchored = new Uint32Array(cel);
    expect(cel[4 * 8 + 4]).toBe(RED);
    expect(cel[4 * 8 + 5]).toBe(GREEN);
    expect(cel[5 * 8 + 4]).toBe(BLUE);
    expect(cel[5 * 8 + 5]).toBe(WHITE);
    expect(host.float).toBeNull();
    const after = must(host.selection);
    expect(after.bounds).toEqual({ x: 4, y: 4, w: 2, h: 2 });
    expect(after.mask[4 * 8 + 4]).toBe(1);
    expect(after.mask[5 * 8 + 5]).toBe(1);
    expect(after.mask[1 * 8 + 1]).toBe(0);

    cmd.revert(doc);
    expect([...cel]).toEqual([...lifted]);
    const restored = must(host.float);
    expect(restored.rect).toEqual({ x: 4, y: 4, w: 2, h: 2 });
    expect([...restored.pixels]).toEqual([RED, GREEN, BLUE, WHITE]);
    expect(host.selection).toBe(sel);

    restored.rect.x = 0;
    restored.pixels[0] = 0;
    cmd.apply(doc);
    expect([...cel]).toEqual([...anchored]);
  });

  it('src-over blends semi-transparent pixels and skips 0-alpha slots', () => {
    const doc = SpriteDoc.blank(8, 8, 't');
    const key = doc.celKey('l1', 'f1');
    const cel = doc.ensureCel(key);
    cel[0] = WHITE;
    cel[1] = BLUE;

    const host = makeHost();
    host.float = {
      pixels: new Uint32Array([packRgba(255, 0, 0, 128), 0]),
      rect: { x: 0, y: 0, w: 2, h: 1 },
    };
    const cmd = new AnchorFloat(host, key, 8, 8);
    cmd.apply(doc);
    expect(cel[0]).toBe(packRgba(255, 127, 127, 255));
    expect(cel[1]).toBe(BLUE);
    expect(must(host.selection).bounds).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('clamps a float overhanging the doc edge', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const key = doc.celKey('l1', 'f1');
    const cel = doc.ensureCel(key);

    const host = makeHost();
    host.float = { pixels: new Uint32Array([RED, GREEN]), rect: { x: -1, y: 0, w: 2, h: 1 } };
    const cmd = new AnchorFloat(host, key, 4, 4);
    expect(cmd.dirty).toEqual({ kind: 'cels', cels: [{ key, rect: { x: 0, y: 0, w: 1, h: 1 } }] });

    cmd.apply(doc);
    expect(cel[0]).toBe(GREEN);
    expect(must(host.selection).bounds).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    cmd.revert(doc);
    expect(cel[0]).toBe(0);
    expect(must(host.float).rect).toEqual({ x: -1, y: 0, w: 2, h: 1 });
  });
});

describe('PasteFloat', () => {
  it('sets a deep-copied float and leaves the selection alone', () => {
    const doc = SpriteDoc.blank(8, 8, 't');
    const host = makeHost();
    const sel = must(maskFromRect({ x: 0, y: 0, w: 2, h: 2 }, 8, 8));
    host.selection = sel;
    const src = new Uint32Array([RED, GREEN, BLUE, WHITE]);

    const cmd = new PasteFloat(host, src, 2, 2, { x: 3, y: 2 });
    expect(cmd.sizeBytes).toBe(src.byteLength + 64);
    expect(cmd.dirty).toEqual({ kind: 'selection' });
    src[0] = 0;

    cmd.apply(doc);
    const float = must(host.float);
    expect(float.rect).toEqual({ x: 3, y: 2, w: 2, h: 2 });
    expect([...float.pixels]).toEqual([RED, GREEN, BLUE, WHITE]);
    expect(host.selection).toBe(sel);

    float.rect.x = 6;
    float.pixels[0] = 0;
    cmd.revert(doc);
    expect(host.float).toBeNull();
    cmd.apply(doc);
    expect(must(host.float).rect).toEqual({ x: 3, y: 2, w: 2, h: 2 });
    expect([...must(host.float).pixels]).toEqual([RED, GREEN, BLUE, WHITE]);
  });
});

describe('DropFloat', () => {
  it('apply→revert→apply round-trips with a redo-stable capture', () => {
    const doc = SpriteDoc.blank(8, 8, 't');
    const host = makeHost();
    host.float = { pixels: new Uint32Array([RED, GREEN]), rect: { x: 2, y: 3, w: 2, h: 1 } };

    const cmd = new DropFloat(host);
    expect(cmd.label).toBe('cut float');
    expect(cmd.dirty).toEqual({ kind: 'selection' });
    expect(cmd.sizeBytes).toBe(64);

    cmd.apply(doc);
    expect(host.float).toBeNull();
    expect(cmd.sizeBytes).toBe(2 * 4 + 64);

    cmd.revert(doc);
    const restored = must(host.float);
    expect(restored.rect).toEqual({ x: 2, y: 3, w: 2, h: 1 });
    expect([...restored.pixels]).toEqual([RED, GREEN]);

    restored.rect.x = 7;
    restored.pixels[0] = 0;
    cmd.apply(doc);
    expect(host.float).toBeNull();
    cmd.revert(doc);
    expect(must(host.float).rect).toEqual({ x: 2, y: 3, w: 2, h: 1 });
    expect([...must(host.float).pixels]).toEqual([RED, GREEN]);
  });

  it('tolerates a null float (no-op pair)', () => {
    const doc = SpriteDoc.blank(8, 8, 't');
    const host = makeHost();
    const cmd = new DropFloat(host);
    cmd.apply(doc);
    expect(host.float).toBeNull();
    cmd.revert(doc);
    expect(host.float).toBeNull();
    expect(cmd.sizeBytes).toBe(64);
  });

  it('lift → drop round-trips through History undo/redo', () => {
    const { doc, key, cel } = seededDoc();
    const original = new Uint32Array(cel);
    const h = new History(doc, new Bus());
    const host = makeHost();
    host.selection = must(maskFromRect({ x: 1, y: 1, w: 2, h: 2 }, 8, 8));

    h.commit(new LiftFloat(host, key, 8, 8));
    h.commit(new DropFloat(host));
    const lifted = new Uint32Array(cel);
    expect(host.float).toBeNull();

    h.undo();
    expect([...must(host.float).pixels]).toEqual([RED, GREEN, BLUE, WHITE]);
    h.undo();
    expect([...cel]).toEqual([...original]);
    expect(host.float).toBeNull();

    h.redo();
    h.redo();
    expect([...cel]).toEqual([...lifted]);
    expect(host.float).toBeNull();
  });
});

describe('history integration', () => {
  it('select → lift → drag → anchor round-trips through undo/redo and jumpTo', () => {
    const { doc, key, cel } = seededDoc();
    const original = new Uint32Array(cel);
    const bus = new Bus();
    const h = new History(doc, bus);
    const host = makeHost();

    h.commit(new SetSelection(host, maskFromRect({ x: 1, y: 1, w: 2, h: 2 }, 8, 8), 'select'));
    h.commit(new LiftFloat(host, key, 8, 8));
    must(host.float).rect.x = 5;
    must(host.float).rect.y = 5;
    h.commit(new AnchorFloat(host, key, 8, 8));

    const moved = new Uint32Array(cel);
    expect(cel[5 * 8 + 5]).toBe(RED);
    expect(cel[1 * 8 + 1]).toBe(0);
    expect(host.float).toBeNull();

    h.undo();
    h.undo();
    expect([...cel]).toEqual([...original]);
    expect(host.float).toBeNull();
    expect(must(host.selection).bounds).toEqual({ x: 1, y: 1, w: 2, h: 2 });

    h.redo();
    h.redo();
    expect([...cel]).toEqual([...moved]);
    expect(host.float).toBeNull();
    expect(must(host.selection).bounds).toEqual({ x: 5, y: 5, w: 2, h: 2 });

    let docEvents = 0;
    const off = bus.on('doc:changed', () => {
      docEvents += 1;
    });
    h.jumpTo(0);
    expect(docEvents).toBe(3);
    off();
    expect([...cel]).toEqual([...original]);
    expect(host.selection).toBeNull();
    expect(host.float).toBeNull();
    expect(h.canUndo).toBe(false);

    h.jumpTo(99);
    expect([...cel]).toEqual([...moved]);
    expect(h.canRedo).toBe(false);

    h.jumpTo(-5);
    expect([...cel]).toEqual([...original]);
    h.jumpTo(3);
    expect([...cel]).toEqual([...moved]);
  });
});
