/** core/doc — blank/fromImage, flatten, JSON round-trip. */
import { describe, expect, it } from 'vitest';
import { SpriteDoc, type DocJson } from '../../src/core/doc';
import { makeBuffer, packRgba } from '../../src/core/pixels';

const WHITE = packRgba(255, 255, 255, 255);
const BLACK = packRgba(0, 0, 0, 255);
const RED = packRgba(255, 0, 0, 255);
const GREEN = packRgba(0, 255, 0, 255);
const BLUE = packRgba(0, 0, 255, 255);

describe('SpriteDoc.blank', () => {
  it('has one layer, one frame, an empty cel, a 16-color starter palette', () => {
    const doc = SpriteDoc.blank(8, 6, 'fresh');
    expect(doc.width).toBe(8);
    expect(doc.height).toBe(6);
    expect(doc.meta).toEqual({ name: 'fresh' });
    expect(doc.layers).toEqual([{ id: 'l1', name: 'layer 1', opacity: 1, visible: true }]);
    expect(doc.frames).toEqual([{ id: 'f1', durationMs: 100 }]);
    const cel = doc.getCel(doc.celKey('l1', 'f1'));
    expect(cel).toBeDefined();
    expect(cel?.length).toBe(8 * 6);
    expect(cel?.every((p) => p === 0)).toBe(true);
    expect(doc.palette.colors).toHaveLength(16);
    expect(doc.palette.colors).not.toContain(0);
    expect(doc.palette.colors.every((c) => ((c >>> 24) & 0xff) === 255)).toBe(true);
    expect(doc.palette.recent).toEqual([]);
  });

  it('celKeyAt is bounds-checked', () => {
    const doc = SpriteDoc.blank(2, 2, 't');
    expect(doc.celKeyAt(0, 0)).toBe('l1:f1');
    expect(() => doc.celKeyAt(1, 0)).toThrow(RangeError);
    expect(() => doc.celKeyAt(0, 5)).toThrow(RangeError);
    expect(() => doc.celKeyAt(-1, 0)).toThrow(RangeError);
  });
});

describe('SpriteDoc.fromImage', () => {
  it('stores the whole buffer as the l1:f1 cel', () => {
    const px = new Uint32Array([RED, GREEN, BLUE, 0]);
    const doc = SpriteDoc.fromImage(px, 2, 2, 'img');
    expect(Array.from(doc.getCel(doc.celKey('l1', 'f1')) ?? [])).toEqual(Array.from(px));
  });

  it('extracts opaque colors by frequency, excluding transparent and translucent', () => {
    const semi = packRgba(10, 20, 30, 128);
    const px = new Uint32Array([RED, RED, RED, RED, GREEN, GREEN, BLUE, semi, 0]);
    const doc = SpriteDoc.fromImage(px, 3, 3, 'img');
    expect(doc.palette.colors).toEqual([RED, GREEN, BLUE]);
  });

  it('caps the palette at 64 colors', () => {
    const px = new Uint32Array(100);
    for (let i = 0; i < 100; i++) px[i] = packRgba(i, 255 - i, (i * 2) % 256, 255);
    const doc = SpriteDoc.fromImage(px, 10, 10, 'img');
    expect(doc.palette.colors).toHaveLength(64);
  });
});

describe('SpriteDoc.flattenFrame', () => {
  function overlayDoc(): SpriteDoc {
    const doc = SpriteDoc.blank(2, 2, 't');
    doc.setCel(doc.celKey('l1', 'f1'), new Uint32Array([WHITE, BLACK, BLACK, WHITE]));
    doc.layers.push({ id: 'l2', name: 'over', opacity: 0.5, visible: true });
    doc.setCel(doc.celKey('l2', 'f1'), new Uint32Array([RED, RED, RED, RED]));
    return doc;
  }

  it('composites a 50%-opacity layer over a checkered base exactly', () => {
    const flat = overlayDoc().flattenFrame(0);
    const overWhite = packRgba(255, 128, 128, 255);
    const overBlack = packRgba(128, 0, 0, 255);
    expect(Array.from(flat)).toEqual([overWhite, overBlack, overBlack, overWhite]);
  });

  it('skips invisible layers', () => {
    const doc = overlayDoc();
    const l2 = doc.layers[1];
    if (!l2) throw new Error('missing layer');
    l2.visible = false;
    expect(Array.from(doc.flattenFrame(0))).toEqual([WHITE, BLACK, BLACK, WHITE]);
  });

  it('accumulates alpha over a transparent base', () => {
    const doc = SpriteDoc.blank(1, 1, 't');
    const l1 = doc.layers[0];
    if (!l1) throw new Error('missing layer');
    l1.opacity = 0.5;
    doc.setCel(doc.celKey('l1', 'f1'), new Uint32Array([RED]));
    doc.layers.push({ id: 'l2', name: 'over', opacity: 0.5, visible: true });
    doc.setCel(doc.celKey('l2', 'f1'), new Uint32Array([GREEN]));
    expect(Array.from(doc.flattenFrame(0))).toEqual([packRgba(85, 170, 0, 192)]);
  });

  it('sub-rect variant matches the full flatten and leaves the rest untouched', () => {
    const doc = SpriteDoc.blank(4, 4, 't');
    const base = makeBuffer(4, 4);
    const over = makeBuffer(4, 4);
    for (let i = 0; i < 16; i++) {
      base[i] = packRgba((i * 3) % 256, (i * 5) % 256, (i * 7) % 256, 255);
      over[i] = packRgba((i * 11) % 256, (i * 13) % 256, (i * 17) % 256, i % 3 === 0 ? 0 : 200);
    }
    doc.setCel(doc.celKey('l1', 'f1'), base);
    doc.layers.push({ id: 'l2', name: 'over', opacity: 0.6, visible: true });
    doc.setCel(doc.celKey('l2', 'f1'), over);

    const full = doc.flattenFrame(0);
    const into = new Uint32Array(16).fill(0xffffffff);
    const returned = doc.flattenFrame(0, into, { x: 1, y: 1, w: 2, h: 2 });
    expect(returned).toBe(into);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const i = y * 4 + x;
        const inside = x >= 1 && x < 3 && y >= 1 && y < 3;
        expect(into[i]).toBe(inside ? full[i] : 0xffffffff);
      }
    }
  });

  it('throws RangeError on a bad frame index', () => {
    expect(() => SpriteDoc.blank(2, 2, 't').flattenFrame(1)).toThrow(RangeError);
  });
});

describe('SpriteDoc toJSON / fromJSON', () => {
  function buildDoc(): SpriteDoc {
    const doc = SpriteDoc.blank(3, 2, 'round');
    const cel = doc.ensureCel(doc.celKey('l1', 'f1'));
    cel.set([0xdeadbeef, 0x00000000, 0xffffffff, 0x12345678, 0x9abcdef0, 0x0badf00d]);
    doc.layers.push({ id: 'l7', name: 'over', opacity: 0.5, visible: false });
    doc.setCel(doc.celKey('l7', 'f1'), new Uint32Array([1, 2, 3, 4, 5, 6]));
    doc.tags.push({ name: 'walk', from: 0, to: 0, mode: 'loop' });
    return doc;
  }

  it('round-trips through JSON with byte-identical cels', () => {
    const doc = buildDoc();
    const json = JSON.parse(JSON.stringify(doc.toJSON())) as DocJson;
    const doc2 = SpriteDoc.fromJSON(json);

    expect(doc2.width).toBe(3);
    expect(doc2.height).toBe(2);
    expect(doc2.meta).toEqual({ name: 'round' });
    expect(doc2.layers).toEqual(doc.layers);
    expect(doc2.frames).toEqual(doc.frames);
    expect(doc2.tags).toEqual(doc.tags);
    expect(doc2.palette).toEqual(doc.palette);
    for (const key of [doc.celKey('l1', 'f1'), doc.celKey('l7', 'f1')]) {
      expect(Array.from(doc2.getCel(key) ?? [])).toEqual(Array.from(doc.getCel(key) ?? []));
    }
  });

  it('keeps the id counter collision-free after load', () => {
    const json = buildDoc().toJSON();
    const doc2 = SpriteDoc.fromJSON(json) as unknown as {
      newLayerId(): string;
      newFrameId(): string;
    };
    expect(doc2.newLayerId()).toBe('l8');
    expect(doc2.newFrameId()).toBe('f2');
  });

  it('throws on a version mismatch', () => {
    const json = buildDoc().toJSON();
    const bad = { ...json, version: 2 } as unknown as DocJson;
    expect(() => SpriteDoc.fromJSON(bad)).toThrow(/version/);
  });

  it('drops cels whose buffer is not exactly w*h*4 bytes', () => {
    const doc = buildDoc();
    const json = doc.toJSON();
    const truncated = json.cels['l7:f1'];
    if (truncated === undefined) throw new Error('missing cel');
    json.cels['l7:f1'] = truncated.slice(0, 8);
    const doc2 = SpriteDoc.fromJSON(json);
    expect(doc2.getCel(doc2.celKey('l7', 'f1'))).toBeUndefined();
    expect(Array.from(doc2.getCel(doc2.celKey('l1', 'f1')) ?? []))
      .toEqual(Array.from(doc.getCel(doc.celKey('l1', 'f1')) ?? []));
  });

  it('drops orphan cel keys whose layer or frame id does not exist', () => {
    const doc = buildDoc();
    const json = doc.toJSON();
    const valid = json.cels['l1:f1'];
    if (valid === undefined) throw new Error('missing cel');
    json.cels['l99:f1'] = valid; // orphan layer — would collide with allocLayerId
    json.cels['l1:f9'] = valid;  // orphan frame
    json.cels['garbage'] = valid; // not even a key
    const doc2 = SpriteDoc.fromJSON(json);
    expect(doc2.getCel(doc2.celKey('l99', 'f1'))).toBeUndefined();
    expect(doc2.getCel(doc2.celKey('l1', 'f9'))).toBeUndefined();
    expect(doc2.celEntriesForLayer('l1')).toHaveLength(1);
    expect(doc2.celEntriesForLayer('l7')).toHaveLength(1);
  });

  it('a fully valid doc loads every cel untouched', () => {
    const doc = buildDoc();
    const doc2 = SpriteDoc.fromJSON(doc.toJSON());
    for (const key of [doc.celKey('l1', 'f1'), doc.celKey('l7', 'f1')]) {
      expect(Array.from(doc2.getCel(key) ?? [])).toEqual(Array.from(doc.getCel(key) ?? []));
    }
  });
});
