/** core/commands/palette-edit — swatch replace/remove + whole-palette set. */
import { describe, expect, it } from 'vitest';
import {
  RemovePaletteColor, ReplacePaletteColor, SetPalette,
} from '../../src/core/commands/palette-edit';
import { AddPaletteColor } from '../../src/core/commands/palette-ops';
import { Bus } from '../../src/core/bus';
import { SpriteDoc } from '../../src/core/doc';
import { History } from '../../src/core/history';
import { packRgba } from '../../src/core/pixels';

const RED = packRgba(255, 0, 0, 255);
const GREEN = packRgba(0, 255, 0, 255);
const BLUE = packRgba(0, 0, 255, 255);

function threeColorDoc(): SpriteDoc {
  const doc = SpriteDoc.blank(2, 2, 't');
  doc.palette.colors = [RED, GREEN, BLUE];
  return doc;
}

describe('ReplacePaletteColor', () => {
  it('swaps the swatch at index; revert restores; redo-stable', () => {
    const doc = threeColorDoc();
    const white = packRgba(255, 255, 255, 255);
    const cmd = new ReplacePaletteColor(1, white);

    cmd.apply(doc);
    expect(doc.palette.colors).toEqual([RED, white, BLUE]);
    cmd.revert(doc);
    expect(doc.palette.colors).toEqual([RED, GREEN, BLUE]);
    cmd.apply(doc);
    expect(doc.palette.colors).toEqual([RED, white, BLUE]);
  });

  it('throws on a bad index', () => {
    expect(() => new ReplacePaletteColor(9, RED).apply(threeColorDoc())).toThrow(RangeError);
  });
});

describe('RemovePaletteColor', () => {
  it('removes at index; revert reinserts at the same position', () => {
    const doc = threeColorDoc();
    const cmd = new RemovePaletteColor(1);

    cmd.apply(doc);
    expect(doc.palette.colors).toEqual([RED, BLUE]);
    cmd.revert(doc);
    expect(doc.palette.colors).toEqual([RED, GREEN, BLUE]);
    cmd.apply(doc);
    expect(doc.palette.colors).toEqual([RED, BLUE]);
  });

  it('throws on a bad index', () => {
    expect(() => new RemovePaletteColor(3).apply(threeColorDoc())).toThrow(RangeError);
  });
});

describe('SetPalette', () => {
  it('replaces colors + name; revert restores both; redo-stable', () => {
    const doc = threeColorDoc();
    doc.palette.name = 'original';
    const cmd = new SetPalette([BLUE, RED], 'flat', 'import gpl');
    expect(cmd.label).toBe('import gpl');
    expect(cmd.sizeBytes).toBe(2 * 4 + 64);

    cmd.apply(doc);
    expect(doc.palette.colors).toEqual([BLUE, RED]);
    expect(doc.palette.name).toBe('flat');
    cmd.revert(doc);
    expect(doc.palette.colors).toEqual([RED, GREEN, BLUE]);
    expect(doc.palette.name).toBe('original');
    cmd.apply(doc);
    expect(doc.palette.colors).toEqual([BLUE, RED]);
    expect(doc.palette.name).toBe('flat');
  });

  it('null name leaves the palette name alone', () => {
    const doc = threeColorDoc();
    doc.palette.name = 'keep';
    const cmd = new SetPalette([RED], null);
    expect(cmd.label).toBe('set palette');
    cmd.apply(doc);
    expect(doc.palette.name).toBe('keep');
  });

  it('undo lands correctly after an in-place AddPaletteColor (array aliasing)', () => {
    const doc = SpriteDoc.blank(2, 2, 't');
    const h = new History(doc, new Bus());
    const original = [...doc.palette.colors];
    const fresh = packRgba(7, 7, 7, 255);

    h.commit(new AddPaletteColor(fresh)); // mutates the live colors array in place
    h.commit(new SetPalette([RED, GREEN], 'flat'));
    expect(doc.palette.colors).toEqual([RED, GREEN]);

    h.undo(); // SetPalette's prev capture aliases the live (mutated) array
    expect(doc.palette.colors).toEqual([...original, fresh]);
    h.undo();
    expect(doc.palette.colors).toEqual(original);

    h.redo();
    expect(doc.palette.colors).toEqual([...original, fresh]);
    h.redo();
    expect(doc.palette.colors).toEqual([RED, GREEN]);
    expect(doc.palette.name).toBe('flat');
  });
});
