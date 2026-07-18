/** io/palettes — .gpl + JSON serializers/parsers (pure parts, node-safe). */
import { describe, expect, it } from 'vitest';
import { gplToColors, paletteToGpl, paletteToJson } from '../../src/io/palettes';
import { hexToRgba, packRgba } from '../../src/core/pixels';

const RED = packRgba(255, 0, 0, 255);
const GREEN = packRgba(0, 128, 0, 255);
const MUD = packRgba(12, 34, 56, 255);

describe('paletteToGpl / gplToColors', () => {
  it('round-trips colors and name', () => {
    const colors = [RED, GREEN, MUD, packRgba(255, 255, 255, 255)];
    const parsed = gplToColors(paletteToGpl('warm ramp', colors));
    expect(parsed.name).toBe('warm ramp');
    expect(parsed.colors).toEqual(colors);
  });

  it('writes the standard GIMP header and hex swatch names', () => {
    const text = paletteToGpl('p', [RED]);
    expect(text.startsWith('GIMP Palette\nName: p\n#\n')).toBe(true);
    expect(text).toContain('255   0   0\t#ff0000');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('tolerates CRLF, comments, Columns, junk lines, and trailing words', () => {
    const text = [
      'GIMP Palette',
      'Columns: 4',
      '# a comment 1 2 3',
      '  255   0   0\tred',
      '0 128 0 mossy green 2',
      'not a color line',
      '300 0 0',
      ' 12 34 56 78 90',
      '',
    ].join('\r\n');
    const parsed = gplToColors(text);
    expect(parsed.name).toBe('imported');
    expect(parsed.colors).toEqual([RED, GREEN, MUD]);
  });

  it('honors the 4th int as alpha in an Aseprite Channels: RGBA palette', () => {
    const text = [
      'GIMP Palette',
      'Name: aseprite-rgba',
      'Columns: 0',
      'Channels: RGBA',
      '#',
      '255   0   0 255\tRed',
      '  0 255   0 128\tHalf green',
      ' 26  26  26  10\tSmoke',
      '  1   2   3 999\talpha out of range',
    ].join('\n');
    const parsed = gplToColors(text);
    expect(parsed.name).toBe('aseprite-rgba');
    expect(parsed.colors).toEqual([
      packRgba(255, 0, 0, 255),
      packRgba(0, 255, 0, 128),
      packRgba(26, 26, 26, 10),
      packRgba(1, 2, 3, 255), // >255 is not an alpha value
    ]);
  });

  it('keeps dropping trailing ints without a Channels: RGBA header', () => {
    const parsed = gplToColors('GIMP Palette\n12 34 56 78 90\n');
    expect(parsed.colors).toEqual([MUD]);
  });

  it('takes the palette name from the Name: line, digits and all', () => {
    const parsed = gplToColors('GIMP Palette\nName: Sunset 8\n#\n1 2 3\n');
    expect(parsed.name).toBe('Sunset 8');
    expect(parsed.colors).toEqual([packRgba(1, 2, 3, 255)]);
  });

  it('throws a friendly error when no colors are found', () => {
    expect(() => gplToColors('hello\nworld')).toThrow('not a GIMP palette (.gpl)');
    expect(() => gplToColors('')).toThrow('not a GIMP palette (.gpl)');
    expect(() => gplToColors('GIMP Palette\nName: empty\n#\n')).toThrow(Error);
  });
});

describe('paletteToJson', () => {
  it('round-trips name and colors through hex', () => {
    const colors = [RED, GREEN, MUD, packRgba(1, 2, 3, 128)];
    const json = paletteToJson({ name: 'dusk', colors, recent: [RED] });
    const parsed = JSON.parse(json) as { name: string; colors: string[] };
    expect(parsed.name).toBe('dusk');
    expect(parsed.colors.map((h) => hexToRgba(h))).toEqual(colors);
  });

  it('is pretty-printed and omits recent', () => {
    const json = paletteToJson({ name: 'p', colors: [RED], recent: [GREEN] });
    expect(json).toContain('\n  ');
    expect(json).not.toContain('recent');
  });
});
