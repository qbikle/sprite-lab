/** The bundled first-run demo sprite — schema-valid, animated, non-empty. */
import { describe, expect, it } from 'vitest';
import { SpriteDoc, type DocJson } from '../../src/core/doc';
import demoRaw from '../../src/assets/demo.sprite.json?raw';

function load(): SpriteDoc {
  return SpriteDoc.fromJSON(JSON.parse(demoRaw) as DocJson);
}

describe('demo sprite asset', () => {
  it('loads through SpriteDoc.fromJSON with the expected shape', () => {
    const doc = load();
    expect(doc.width).toBe(24);
    expect(doc.height).toBe(24);
    expect(doc.layers.map((l) => l.name)).toEqual(['body', 'face']);
    expect(doc.frames).toHaveLength(6);
    expect(doc.tags).toEqual([{ name: 'idle', from: 0, to: 5, mode: 'loop' }]);
    expect(doc.palette.colors).toHaveLength(8);
    expect(doc.meta.name).toBe('mochi');
  });

  it('has painted pixels on both layers of every frame', () => {
    const doc = load();
    doc.frames.forEach((frame, i) => {
      expect(frame.durationMs).toBeGreaterThan(0);
      for (const layer of doc.layers) {
        const cel = doc.getCel(doc.celKey(layer.id, frame.id));
        expect(cel, `cel ${layer.id}:${frame.id}`).toBeDefined();
        let nonZero = 0;
        if (cel) for (const v of cel) if (v !== 0) nonZero++;
        expect(nonZero, `layer ${layer.name} frame ${i}`).toBeGreaterThan(0);
      }
    });
  });

  it('actually animates — not every frame is identical', () => {
    const doc = load();
    const first = doc.flattenFrame(0);
    const moving = doc.frames.filter((_, i) => {
      const flat = doc.flattenFrame(i);
      for (let j = 0; j < flat.length; j++) if (flat[j] !== first[j]) return true;
      return false;
    });
    expect(moving.length).toBeGreaterThan(0);
  });

  it('round-trips toJSON → fromJSON byte-identically', () => {
    const doc = load();
    const doc2 = SpriteDoc.fromJSON(doc.toJSON());
    expect(doc2.width).toBe(doc.width);
    expect(doc2.height).toBe(doc.height);
    expect(doc2.layers).toEqual(doc.layers);
    expect(doc2.frames).toEqual(doc.frames);
    expect(doc2.tags).toEqual(doc.tags);
    expect(doc2.palette).toEqual(doc.palette);
    expect(doc2.meta).toEqual(doc.meta);
    for (const layer of doc.layers) {
      for (const frame of doc.frames) {
        const key = doc.celKey(layer.id, frame.id);
        expect(Array.from(doc2.getCel(key) ?? [])).toEqual(Array.from(doc.getCel(key) ?? []));
      }
    }
  });

  it('paints only with palette colors (plus transparent)', () => {
    const doc = load();
    const allowed = new Set([0, ...doc.palette.colors]);
    let offPalette = 0;
    for (const layer of doc.layers) {
      for (const frame of doc.frames) {
        const cel = doc.getCel(doc.celKey(layer.id, frame.id));
        for (const v of cel ?? []) if (!allowed.has(v)) offPalette++;
      }
    }
    expect(offPalette).toBe(0);
  });
});
