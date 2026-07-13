/** io/project — .sprite blob round-trip, name convention, friendly errors. */
import { describe, expect, it } from 'vitest';
import { SpriteDoc } from '../../src/core/doc';
import { docToSpriteFile, spriteFileName, spriteFileToDoc } from '../../src/io/project';

function buildDoc(): SpriteDoc {
  const doc = SpriteDoc.blank(3, 2, 'round');
  const cel = doc.ensureCel(doc.celKey('l1', 'f1'));
  cel.set([0xdeadbeef, 0x00000000, 0xffffffff, 0x12345678, 0x9abcdef0, 0x0badf00d]);
  doc.layers.push({ id: 'l7', name: 'over', opacity: 0.5, visible: false });
  doc.setCel(doc.celKey('l7', 'f1'), new Uint32Array([1, 2, 3, 4, 5, 6]));
  doc.tags.push({ name: 'walk', from: 0, to: 0, mode: 'loop' });
  return doc;
}

describe('docToSpriteFile / spriteFileToDoc', () => {
  it('round-trips doc → blob → doc with byte-identical cels', async () => {
    const doc = buildDoc();
    const blob = docToSpriteFile(doc);
    expect(blob.type).toBe('application/json');

    const doc2 = await spriteFileToDoc(blob);
    expect(doc2.width).toBe(doc.width);
    expect(doc2.height).toBe(doc.height);
    expect(doc2.meta).toEqual(doc.meta);
    expect(doc2.layers).toEqual(doc.layers);
    expect(doc2.frames).toEqual(doc.frames);
    expect(doc2.tags).toEqual(doc.tags);
    expect(doc2.palette).toEqual(doc.palette);
    for (const key of [doc.celKey('l1', 'f1'), doc.celKey('l7', 'f1')]) {
      const before = doc.getCel(key);
      const after = doc2.getCel(key);
      expect(after).toBeDefined();
      expect(Array.from(after ?? [])).toEqual(Array.from(before ?? []));
    }
  });

  it('the blob is plain DocJson (nothing held hostage)', async () => {
    const blob = docToSpriteFile(buildDoc());
    const parsed = JSON.parse(await blob.text()) as { version: number; meta: { name: string } };
    expect(parsed.version).toBe(1);
    expect(parsed.meta).toEqual({ name: 'round' });
  });

  it('names files <doc name>.sprite', () => {
    expect(spriteFileName(buildDoc())).toBe('round.sprite');
  });

  it('rejects non-JSON with a friendly error', async () => {
    await expect(spriteFileToDoc(new Blob(['not json at all']))).rejects.toThrow(/\.sprite/);
  });

  it('rejects JSON that is not a sprite doc', async () => {
    const blob = new Blob([JSON.stringify({ hello: 1 })]);
    await expect(spriteFileToDoc(blob)).rejects.toThrow(/\.sprite/);
  });
});
