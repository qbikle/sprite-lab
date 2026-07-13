/** io/exporters/pxmap — exact snippet, transparency dot, alpha hex, 62-color cap. */
import { describe, expect, it } from 'vitest';
import { SpriteDoc } from '../../src/core/doc';
import { packRgba } from '../../src/core/pixels';
import { framePxMap } from '../../src/io/exporters/pxmap';

const RED = packRgba(255, 0, 0, 255);
const GREEN = packRgba(0, 255, 0, 255);
const BLUE = packRgba(0, 0, 255, 255);

describe('framePxMap', () => {
  it('emits the exact paste-ready snippet — frequency order, "." for transparent', () => {
    const doc = SpriteDoc.blank(4, 2, 'tiny');
    doc.setCel(doc.celKey('l1', 'f1'), new Uint32Array([
      RED, GREEN, BLUE, RED,
      0, RED, GREEN, BLUE,
    ]));
    expect(framePxMap(doc, 0)).toBe([
      '// tiny — frame 0',
      'const COLORS = {',
      "  a: '#ff0000',",
      "  b: '#00ff00',",
      "  c: '#0000ff',",
      '} as const;',
      '',
      'const ROWS = [',
      "  'abca',",
      "  '.abc',",
      '];',
      '',
      '// px(ROWS, COLORS)',
      '',
    ].join('\n'));
  });

  it('keeps a stable order on frequency ties (first-seen wins)', () => {
    const doc = SpriteDoc.blank(2, 2, 'tie');
    doc.setCel(doc.celKey('l1', 'f1'), new Uint32Array([BLUE, GREEN, BLUE, GREEN]));
    const out = framePxMap(doc, 0);
    expect(out).toContain("  a: '#0000ff',");
    expect(out).toContain("  b: '#00ff00',");
    expect(out).toContain("  'ab',");
  });

  it('emits #rrggbbaa for colors with alpha below 255', () => {
    const doc = SpriteDoc.blank(2, 1, 'ghost');
    doc.setCel(doc.celKey('l1', 'f1'), new Uint32Array([packRgba(255, 0, 0, 128), 0]));
    const out = framePxMap(doc, 0);
    expect(out).toContain("  a: '#ff000080',");
    expect(out).toContain("  'a.',");
  });

  it('throws past 62 unique colors', () => {
    const doc = SpriteDoc.blank(8, 8, 'many');
    const px = new Uint32Array(64);
    for (let i = 0; i < 63; i++) px[i] = packRgba(i, 0, 0, 255);
    doc.setCel(doc.celKey('l1', 'f1'), px);
    expect(() => framePxMap(doc, 0)).toThrow('too many colors for a px map (62 max)');
  });

  it('allows exactly 62 colors and spends the whole charset', () => {
    const doc = SpriteDoc.blank(8, 8, 'edge');
    const px = new Uint32Array(64);
    for (let i = 0; i < 62; i++) px[i] = packRgba(i, 0, 0, 255);
    doc.setCel(doc.celKey('l1', 'f1'), px);
    const out = framePxMap(doc, 0);
    expect(out).toContain('// edge — frame 0');
    expect(out).toContain("  a: '#000000',");
    expect(out).toContain("  9: '#3d0000',");
  });

  it('names the requested frame in the header', () => {
    const doc = SpriteDoc.blank(1, 1, 'multi');
    doc.frames.push({ id: 'f2', durationMs: 100 });
    expect(framePxMap(doc, 1)).toContain('// multi — frame 1');
  });
});
