/** core/commands/pixel-patch — the ensureCel path when the target cel is absent. */
import { describe, expect, it } from 'vitest';
import { PixelPatch } from '../../src/core/commands/pixel-patch';
import { AddFrame } from '../../src/core/commands/frames-ops';
import { SpriteDoc } from '../../src/core/doc';
import { packRgba } from '../../src/core/pixels';

const RED = packRgba(255, 0, 0, 255);

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('unexpected null');
  return v;
}

describe('PixelPatch on a missing cel', () => {
  it('apply creates the cel via ensureCel; revert keeps it, restored to before', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    new AddFrame(0).apply(doc); // the added frame starts with no cels
    const key = doc.celKeyAt(0, 1);
    expect(doc.getCel(key)).toBeUndefined();

    const blank = new Uint32Array(16);
    const painted = new Uint32Array(16);
    painted[5] = RED;
    const patch = must(PixelPatch.fromBuffers(key, 4, 4, blank, painted, 'paint'));

    patch.apply(doc);
    const cel = must(doc.getCel(key));
    expect(cel[5]).toBe(RED);

    patch.revert(doc);
    // the cel created by ensureCel stays registered, back to its before bytes
    const reverted = must(doc.getCel(key));
    expect([...reverted]).toEqual([...blank]);
    expect(doc.celEntriesForFrame(must(doc.frames[1]).id)).toHaveLength(1);

    patch.apply(doc);
    expect(must(doc.getCel(key))[5]).toBe(RED);
  });

  it('revert on a doc that never saw apply still materializes the cel', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    new AddFrame(0).apply(doc);
    const key = doc.celKeyAt(0, 1);

    const blank = new Uint32Array(16);
    const painted = new Uint32Array(16);
    painted[0] = RED;
    const patch = must(PixelPatch.fromBuffers(key, 4, 4, blank, painted, 'paint'));

    patch.revert(doc);
    expect([...must(doc.getCel(key))]).toEqual([...blank]);
  });
});
