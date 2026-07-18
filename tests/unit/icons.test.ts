import { describe, expect, it } from 'vitest';
import { GLYPH_ROWS, ICON_NAMES } from '../../src/ui/icons';

describe('icon registry', () => {
  it('covers every name with a well-formed 16×16 glyph', () => {
    expect(ICON_NAMES.length).toBe(44);
    for (const name of ICON_NAMES) {
      const rows = GLYPH_ROWS[name];
      expect(rows.length, `${name} row count`).toBe(16);
      for (const row of rows) {
        expect(row.length, `${name} row width`).toBe(16);
        expect(row, `${name} charset`).toMatch(/^[.#]{16}$/);
      }
      const filled = rows.join('').replace(/[^#]/g, '').length;
      expect(filled, `${name} visual weight`).toBeGreaterThanOrEqual(10);
    }
  });

  it('keeps glyphs inside the live area (row 0 and 15 empty)', () => {
    for (const name of ICON_NAMES) {
      const rows = GLYPH_ROWS[name];
      expect(rows[0], `${name} top padding`).not.toContain('#');
      expect(rows[15], `${name} bottom padding`).not.toContain('#');
    }
  });

  it('derives pairs exactly', () => {
    const mirror = (rows: readonly string[]): string[] =>
      rows.map((r) => [...r].reverse().join(''));
    expect(GLYPH_ROWS['redo']).toEqual(mirror(GLYPH_ROWS['undo']));
    expect(GLYPH_ROWS['frame-next']).toEqual(mirror(GLYPH_ROWS['frame-prev']));
    expect(GLYPH_ROWS['step-down']).toEqual([...GLYPH_ROWS['step-up']].reverse());
    expect(GLYPH_ROWS['layer-down']).toEqual([...GLYPH_ROWS['layer-up']].reverse());
  });
});
