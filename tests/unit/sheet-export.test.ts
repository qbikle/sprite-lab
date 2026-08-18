/** io/exporters/sheet — pure layout packing, fps median math, v1 JSON parity. */
import { describe, expect, it } from 'vitest';
import { buildSheetJson, packSheetLayout, renderSheetPixels, sheetFileName } from '../../src/io/exporters/sheet';
import { SpriteDoc } from '../../src/core/doc';
import { packRgba } from '../../src/core/pixels';

const RED = packRgba(255, 0, 0, 255);
const GREEN = packRgba(0, 255, 0, 255);
const BLUE = packRgba(0, 0, 255, 255);

interface V1Row { row: number; label: string; fps: number; frames: number[] }
interface V1Json { sheet: string; frameW: number; frameH: number; rows: V1Row[] }

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('unexpected null');
  return v;
}

function docWithFrames(durations: number[], name = 'cat'): SpriteDoc {
  const doc = SpriteDoc.blank(4, 4, name);
  must(doc.frames[0]).durationMs = durations[0] ?? 100;
  for (let i = 1; i < durations.length; i++) {
    doc.frames.push({ id: doc.allocFrameId(), durationMs: durations[i] ?? 100 });
  }
  return doc;
}

function jsonFor(doc: SpriteDoc): V1Json {
  return JSON.parse(buildSheetJson(doc, packSheetLayout(doc))) as V1Json;
}

describe('packSheetLayout', () => {
  it('falls back to a single "all" row when the doc has no tags', () => {
    const doc = docWithFrames([100, 100, 100]);
    const layout = packSheetLayout(doc);
    expect(layout.cols).toBe(3);
    expect(layout.rows).toHaveLength(1);
    const row = must(layout.rows[0]);
    expect(row.tag).toEqual({ name: 'all', from: 0, to: 2, mode: 'loop' });
    expect(row.frameIndices).toEqual([0, 1, 2]);
  });

  it('packs one row per tag, cols = widest row', () => {
    const doc = docWithFrames([100, 100, 100, 100]);
    doc.tags.push(
      { name: 'walk', from: 0, to: 2, mode: 'loop' },
      { name: 'idle', from: 3, to: 3, mode: 'hold' },
    );
    const layout = packSheetLayout(doc);
    expect(layout.cols).toBe(3);
    expect(layout.rows.map((r) => r.frameIndices)).toEqual([[0, 1, 2], [3]]);
    expect(layout.rows.map((r) => r.tag.name)).toEqual(['walk', 'idle']);
  });

  it('clamps tag ranges to existing frames and drops empty rows', () => {
    const doc = docWithFrames([100, 100]);
    doc.tags.push(
      { name: 'wide', from: -3, to: 99, mode: 'loop' },
      { name: 'gone', from: 5, to: 9, mode: 'loop' },
    );
    const layout = packSheetLayout(doc);
    expect(layout.rows).toHaveLength(1);
    expect(must(layout.rows[0]).frameIndices).toEqual([0, 1]);
    expect(layout.cols).toBe(2);
  });
});

describe('buildSheetJson', () => {
  it('scales frameW/frameH with the PNG, sheet name unchanged', () => {
    const doc = docWithFrames([100, 100]);
    const layout = packSheetLayout(doc);
    const scaled = JSON.parse(buildSheetJson(doc, layout, 4)) as V1Json;
    expect(scaled.frameW).toBe(16);
    expect(scaled.frameH).toBe(16);
    expect(scaled.sheet).toBe(sheetFileName('cat'));
    const plain = JSON.parse(buildSheetJson(doc, layout)) as V1Json;
    expect(plain.frameW).toBe(4);
    expect(plain.rows).toEqual(scaled.rows);
  });

  it('matches the v1 key shape exactly', () => {
    const doc = docWithFrames([100, 125, 200, 50]);
    doc.tags.push(
      { name: 'walk', from: 0, to: 2, mode: 'loop' },
      { name: '', from: 3, to: 3, mode: 'hold' },
    );
    const json = buildSheetJson(doc, packSheetLayout(doc));
    const parsed = JSON.parse(json) as V1Json;
    expect(Object.keys(parsed)).toEqual(['sheet', 'frameW', 'frameH', 'rows']);
    for (const row of parsed.rows) {
      expect(Object.keys(row)).toEqual(['row', 'label', 'fps', 'frames']);
    }
    expect(parsed.sheet).toBe('cat-sheet.png');
    expect(parsed.frameW).toBe(4);
    expect(parsed.frameH).toBe(4);
    expect(parsed.rows).toEqual([
      { row: 0, label: 'walk', fps: 8, frames: [0, 1, 2] },
      { row: 1, label: 'row-1', fps: 20, frames: [0] },
    ]);
    expect(json).toContain('\n  ');
  });

  it('derives fps from the odd-count median duration', () => {
    const doc = docWithFrames([200, 100, 125]); // sorted median 125 → 8 fps
    expect(must(jsonFor(doc).rows[0]).fps).toBe(8);
  });

  it('averages the middle pair for even-count medians', () => {
    const doc = docWithFrames([1000, 50, 100, 50]); // (50+100)/2 = 75 → 13 fps
    expect(must(jsonFor(doc).rows[0]).fps).toBe(13);
  });

  it('rounds 1000/median to the nearest fps', () => {
    expect(must(jsonFor(docWithFrames([333])).rows[0]).fps).toBe(3);
    expect(must(jsonFor(docWithFrames([125, 125])).rows[0]).fps).toBe(8);
  });

  it('names the sheet exactly what sheetFileName() names the download', () => {
    expect(sheetFileName('cat')).toBe('cat-sheet.png');
    for (const name of ['cat', 'hero run', 'x.y']) {
      const doc = docWithFrames([100], name);
      expect(jsonFor(doc).sheet).toBe(sheetFileName(name));
    }
  });

  it('frames are column indices within the packed row', () => {
    const doc = docWithFrames([100, 100, 100]);
    doc.tags.push({ name: 'tail', from: 1, to: 2, mode: 'loop' });
    expect(must(jsonFor(doc).rows[0]).frames).toEqual([0, 1]);
  });
});

describe('renderSheetPixels', () => {
  it('composites each row-cell at its grid slot, transparent ragged padding', () => {
    const doc = SpriteDoc.blank(2, 2, 'x');
    const layer = must(doc.layers[0]);
    must(doc.getCel(doc.celKey(layer.id, must(doc.frames[0]).id))).fill(RED);
    const f1 = { id: doc.allocFrameId(), durationMs: 100 };
    const f2 = { id: doc.allocFrameId(), durationMs: 100 };
    doc.frames.push(f1, f2);
    doc.setCel(doc.celKey(layer.id, f1.id), new Uint32Array(4).fill(GREEN));
    doc.setCel(doc.celKey(layer.id, f2.id), new Uint32Array(4).fill(BLUE));
    doc.tags.push(
      { name: 'a', from: 0, to: 1, mode: 'loop' },
      { name: 'b', from: 2, to: 2, mode: 'loop' },
    );
    const layout = packSheetLayout(doc);
    const px = renderSheetPixels(doc, layout);
    expect(px).toHaveLength(4 * 4); // cols 2 × 2px, rows 2 × 2px
    expect(px[0]).toBe(RED);        // row 0, cell 0
    expect(px[4 + 1]).toBe(RED);
    expect(px[2]).toBe(GREEN);      // row 0, cell 1
    expect(px[4 + 3]).toBe(GREEN);
    expect(px[2 * 4]).toBe(BLUE);   // row 1, cell 0
    expect(px[3 * 4 + 1]).toBe(BLUE);
    expect(px[2 * 4 + 2]).toBe(0);  // row 1, cell 1 — no frame, stays transparent
    expect(px[3 * 4 + 3]).toBe(0);
  });
});
