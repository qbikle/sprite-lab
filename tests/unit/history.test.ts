/** core/history + commands — round-trips, cursor semantics, budget, events. */
import { describe, expect, it } from 'vitest';
import type { Command, DirtyScope } from '../../src/core/contracts';
import { Bus } from '../../src/core/bus';
import { SpriteDoc } from '../../src/core/doc';
import { History } from '../../src/core/history';
import { PixelPatch } from '../../src/core/commands/pixel-patch';
import { AddPaletteColor } from '../../src/core/commands/palette-ops';
import { packRgba } from '../../src/core/pixels';

class FakeCmd implements Command {
  readonly label: string;
  readonly sizeBytes: number;
  readonly dirty: DirtyScope = { kind: 'all' };
  applies = 0;
  reverts = 0;
  lastDoc: SpriteDoc | null = null;

  constructor(label: string, sizeBytes = 100) {
    this.label = label;
    this.sizeBytes = sizeBytes;
  }

  apply(doc: SpriteDoc): void {
    this.applies += 1;
    this.lastDoc = doc;
  }

  revert(): void {
    this.reverts += 1;
  }
}

/** Getter-backed sizeBytes that grows on first revert — the AddFrame/AddLayer
 *  capture-on-revert shape. */
class GrowCmd implements Command {
  readonly label: string;
  readonly dirty: DirtyScope = { kind: 'all' };
  private grown = false;
  private readonly base: number;
  private readonly extra: number;

  constructor(label: string, base: number, extra: number) {
    this.label = label;
    this.base = base;
    this.extra = extra;
  }

  get sizeBytes(): number {
    return this.base + (this.grown ? this.extra : 0);
  }

  apply(): void {}

  revert(): void {
    this.grown = true;
  }
}

function totalBytes(h: History): number {
  return (h as unknown as { totalBytes: number }).totalBytes;
}

describe('PixelPatch', () => {
  it('apply → revert restores byte-identical pixels', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const key = doc.celKey('l1', 'f1');
    const cel = doc.ensureCel(key);
    const before = new Uint32Array(cel);
    const after = new Uint32Array(cel);
    after[5] = packRgba(255, 0, 0, 255);
    after[10] = packRgba(0, 0, 255, 255);

    const patch = PixelPatch.fromBuffers(key, 4, 4, before, after, 'stroke');
    expect(patch).not.toBeNull();
    if (!patch) throw new Error('unreachable');
    expect(patch.label).toBe('stroke');
    expect(patch.sizeBytes).toBe(2 * 2 * 2 * 4 + 64);
    expect(patch.dirty).toEqual({
      kind: 'cels',
      cels: [{ key, rect: { x: 1, y: 1, w: 2, h: 2 } }],
    });

    patch.apply(doc);
    expect(Array.from(doc.getCel(key) ?? [])).toEqual(Array.from(after));
    patch.revert(doc);
    expect(Array.from(doc.getCel(key) ?? [])).toEqual(Array.from(before));
  });

  it('returns null when buffers are identical', () => {
    const a = new Uint32Array(16).fill(9);
    expect(PixelPatch.fromBuffers('l1:f1', 4, 4, a, new Uint32Array(a), 'noop')).toBeNull();
  });
});

describe('AddPaletteColor', () => {
  it('round-trips, and is a no-op pair when the color already exists', () => {
    const doc = SpriteDoc.blank(2, 2, 't');
    const fresh = packRgba(9, 9, 9, 255);
    const cmd = new AddPaletteColor(fresh);
    const beforeColors = [...doc.palette.colors];
    cmd.apply(doc);
    expect(doc.palette.colors).toEqual([...beforeColors, fresh]);
    cmd.revert(doc);
    expect(doc.palette.colors).toEqual(beforeColors);

    const existing = beforeColors[0];
    if (existing === undefined) throw new Error('empty starter palette');
    const dup = new AddPaletteColor(existing);
    dup.apply(doc);
    expect(doc.palette.colors).toEqual(beforeColors);
    dup.revert(doc);
    expect(doc.palette.colors).toEqual(beforeColors);
  });
});

describe('History', () => {
  it('commit/undo/redo move the cursor and call apply/revert', () => {
    const h = new History(SpriteDoc.blank(1, 1, 't'), new Bus());
    const a = new FakeCmd('a');
    const b = new FakeCmd('b');

    h.commit(a);
    h.commit(b);
    expect(h.entries()).toEqual({ labels: ['a', 'b'], cursor: 2 });
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);
    expect(a.applies).toBe(1);
    expect(b.applies).toBe(1);

    h.undo();
    expect(b.reverts).toBe(1);
    expect(h.entries().cursor).toBe(1);
    expect(h.canRedo).toBe(true);

    h.undo();
    expect(a.reverts).toBe(1);
    expect(h.canUndo).toBe(false);
    h.undo();
    expect(a.reverts).toBe(1);

    h.redo();
    expect(a.applies).toBe(2);
    h.redo();
    expect(b.applies).toBe(2);
    expect(h.canRedo).toBe(false);
    h.redo();
    expect(b.applies).toBe(2);
  });

  it('drops the redo tail on a new commit', () => {
    const h = new History(SpriteDoc.blank(1, 1, 't'), new Bus());
    h.commit(new FakeCmd('a'));
    h.commit(new FakeCmd('b'));
    h.undo();
    h.commit(new FakeCmd('c'));
    expect(h.entries()).toEqual({ labels: ['a', 'c'], cursor: 2 });
    expect(h.canRedo).toBe(false);
  });

  it('evicts the oldest entries past the byte budget', () => {
    const h = new History(SpriteDoc.blank(1, 1, 't'), new Bus(), 250);
    const a = new FakeCmd('a', 100);
    const b = new FakeCmd('b', 100);
    const c = new FakeCmd('c', 100);
    h.commit(a);
    h.commit(b);
    h.commit(c);
    expect(h.entries()).toEqual({ labels: ['b', 'c'], cursor: 2 });

    h.undo();
    h.undo();
    expect(h.canUndo).toBe(false);
    expect(c.reverts).toBe(1);
    expect(b.reverts).toBe(1);
    expect(a.reverts).toBe(0);
  });

  it('never evicts the just-pushed entry', () => {
    const h = new History(SpriteDoc.blank(1, 1, 't'), new Bus(), 50);
    h.commit(new FakeCmd('big', 1000));
    expect(h.entries()).toEqual({ labels: ['big'], cursor: 1 });
    expect(h.canUndo).toBe(true);
  });

  it('redo-tail drop subtracts a grown getter size exactly; never negative', () => {
    const h = new History(SpriteDoc.blank(1, 1, 't'), new Bus());
    const g = new GrowCmd('g', 100, 900);
    h.commit(g);
    expect(totalBytes(h)).toBe(100);
    h.commit(new FakeCmd('b', 50));
    expect(totalBytes(h)).toBe(150);

    h.undo(); // b
    expect(totalBytes(h)).toBe(150);
    h.undo(); // g grows 100 → 1000 on revert; ledger recharges
    expect(totalBytes(h)).toBe(1050);

    h.commit(new FakeCmd('c', 25)); // drops the [g, b] redo tail
    expect(h.entries()).toEqual({ labels: ['c'], cursor: 1 });
    expect(totalBytes(h)).toBe(25);
  });

  it('evicting a grown getter-size command keeps the ledger exact', () => {
    const h = new History(SpriteDoc.blank(1, 1, 't'), new Bus(), 250);
    const g = new GrowCmd('g', 100, 900);
    h.commit(g);
    h.commit(new FakeCmd('b', 100));
    h.undo();
    h.undo();
    h.redo();
    h.redo(); // g stays grown: 1000 charged
    expect(totalBytes(h)).toBe(1100);

    h.commit(new FakeCmd('c', 100)); // 1200 > 250 → evict g
    expect(h.entries()).toEqual({ labels: ['b', 'c'], cursor: 2 });
    expect(totalBytes(h)).toBe(200);
    expect(totalBytes(h)).toBeGreaterThanOrEqual(0);
  });

  it('emits doc:changed then history:changed with the command scope', () => {
    const bus = new Bus();
    const events: string[] = [];
    bus.on('doc:changed', ({ scope }) => events.push(`doc:${scope.kind}`));
    bus.on('history:changed', ({ canUndo, canRedo }) => events.push(`hist:${canUndo}:${canRedo}`));

    const h = new History(SpriteDoc.blank(1, 1, 't'), bus);
    h.commit(new FakeCmd('a'));
    expect(events).toEqual(['doc:all', 'hist:true:false']);

    events.length = 0;
    h.undo();
    expect(events).toEqual(['doc:all', 'hist:false:true']);

    events.length = 0;
    h.redo();
    expect(events).toEqual(['doc:all', 'hist:true:false']);
  });

  it('peekUndo returns the command undo would revert, null at pristine', () => {
    const h = new History(SpriteDoc.blank(1, 1, 't'), new Bus());
    expect(h.peekUndo()).toBeNull();
    const a = new FakeCmd('a');
    const b = new FakeCmd('b');
    h.commit(a);
    expect(h.peekUndo()).toBe(a);
    h.commit(b);
    expect(h.peekUndo()).toBe(b);
    h.undo();
    expect(h.peekUndo()).toBe(a);
    h.undo();
    expect(h.peekUndo()).toBeNull();
    h.redo();
    expect(h.peekUndo()).toBe(a);
  });

  it('jumpTo clamps out-of-range targets; forward + back lands identically', () => {
    const h = new History(SpriteDoc.blank(1, 1, 't'), new Bus());
    const a = new FakeCmd('a');
    const b = new FakeCmd('b');
    const c = new FakeCmd('c');
    h.commit(a);
    h.commit(b);
    h.commit(c);

    h.jumpTo(-5);
    expect(h.entries().cursor).toBe(0);
    expect(h.canUndo).toBe(false);
    h.jumpTo(99);
    expect(h.entries().cursor).toBe(3);
    expect(h.canRedo).toBe(false);

    h.jumpTo(1);
    expect(h.entries().cursor).toBe(1);
    h.jumpTo(3);
    h.jumpTo(1);
    expect(h.entries().cursor).toBe(1);
    // net effect of any jump path: applied iff below the cursor
    expect(a.applies - a.reverts).toBe(1);
    expect(b.applies - b.reverts).toBe(0);
    expect(c.applies - c.reverts).toBe(0);
  });

  it('replaceDoc clears the stack, rebinds, emits history:changed', () => {
    const bus = new Bus();
    const h = new History(SpriteDoc.blank(1, 1, 'a'), bus);
    h.commit(new FakeCmd('a'));

    let histEvents = 0;
    bus.on('history:changed', () => {
      histEvents += 1;
    });
    const docB = SpriteDoc.blank(2, 2, 'b');
    h.replaceDoc(docB);
    expect(h.entries()).toEqual({ labels: [], cursor: 0 });
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(histEvents).toBe(1);

    const cap = new FakeCmd('cap');
    h.commit(cap);
    expect(cap.lastDoc).toBe(docB);
  });
});
