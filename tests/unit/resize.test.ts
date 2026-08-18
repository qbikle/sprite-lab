/** core/commands/resize — anchored canvas resize: per-anchor blits, byte-exact
 *  round-trips on sparse multi-layer docs, cached-buffer redo, sizeBytes. */
import { describe, expect, it } from 'vitest';
import { ResizeCanvas, type ResizeAnchor } from '../../src/core/commands/resize';
import { AddFrame } from '../../src/core/commands/frames-ops';
import { AddLayer } from '../../src/core/commands/layers-ops';
import { PixelPatch } from '../../src/core/commands/pixel-patch';
import { Bus } from '../../src/core/bus';
import { SpriteDoc } from '../../src/core/doc';
import { History } from '../../src/core/history';
import { packRgba } from '../../src/core/pixels';

const ANCHORS: readonly ResizeAnchor[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];

/** Canonical byte-compare snapshot (cel map iteration order is not semantic). */
function snap(doc: SpriteDoc): string {
  const j = doc.toJSON();
  const cels = Object.fromEntries(Object.entries(j.cels).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ ...j, cels });
}

/** 2 layers × 3 frames, every pixel distinct per cel; cel (l2, f2) left sparse. */
function seededDoc(w: number, h: number): SpriteDoc {
  const doc = SpriteDoc.blank(w, h, 'resize-me');
  new AddLayer(0).apply(doc);
  new AddFrame(0, 120).apply(doc);
  new AddFrame(1, 140).apply(doc);
  doc.layers.forEach((layer, li) => {
    doc.frames.forEach((frame, fi) => {
      if (li === 1 && fi === 1) return;
      const cel = doc.ensureCel(doc.celKey(layer.id, frame.id));
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          cel[y * w + x] = packRgba(x + 1, y + 1, li * 10 + fi + 1, 255);
        }
      }
    });
  });
  return doc;
}

/** Independent reference: new[x,y] must equal old[x-dx, y-dy] (0 outside). */
function expectBlit(
  oldBuf: Uint32Array, ow: number, oh: number,
  newBuf: Uint32Array, nw: number, nh: number,
  dx: number, dy: number,
): void {
  expect(newBuf.length).toBe(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const ox = x - dx;
      const oy = y - dy;
      const inOld = ox >= 0 && oy >= 0 && ox < ow && oy < oh;
      const want = inOld ? oldBuf[oy * ow + ox] ?? 0 : 0;
      expect(newBuf[y * nw + x] ?? 0).toBe(want);
    }
  }
}

interface Case {
  name: string;
  from: [number, number];
  to: [number, number];
  /** Hand-computed old-content offset per anchor — pins the anchor math. */
  offsets: Record<ResizeAnchor, [number, number]>;
}

/* Center ('mid') axes use trunc((new-old)/2): grow 4→7 gives dx 1 (extra pixel
 * right), shrink 6→3 gives dx -1 (extra crop right) — content leans top-left
 * on odd deltas in BOTH directions. */
const CASES: Case[] = [
  {
    name: 'grow 4×4 → 7×9 (odd deltas +3/+5)',
    from: [4, 4],
    to: [7, 9],
    offsets: {
      tl: [0, 0], t: [1, 0], tr: [3, 0],
      l: [0, 2], c: [1, 2], r: [3, 2],
      bl: [0, 5], b: [1, 5], br: [3, 5],
    },
  },
  {
    name: 'shrink 6×6 → 3×4 (deltas -3/-2)',
    from: [6, 6],
    to: [3, 4],
    offsets: {
      tl: [0, 0], t: [-1, 0], tr: [-3, 0],
      l: [0, -1], c: [-1, -1], r: [-3, -1],
      bl: [0, -2], b: [-1, -2], br: [-3, -2],
    },
  },
  {
    name: 'mixed 5×4 → 8×3 (deltas +3/-1)',
    from: [5, 4],
    to: [8, 3],
    offsets: {
      tl: [0, 0], t: [1, 0], tr: [3, 0],
      l: [0, 0], c: [1, 0], r: [3, 0],
      bl: [0, -1], b: [1, -1], br: [3, -1],
    },
  },
];

describe.each(CASES)('ResizeCanvas $name', ({ from, to, offsets }) => {
  const [ow, oh] = from;
  const [nw, nh] = to;

  it.each([...ANCHORS])('anchor %s blits per the offset table and round-trips', (anchor) => {
    const doc = seededDoc(ow, oh);
    const originals = new Map<string, Uint32Array>();
    for (const layer of doc.layers) {
      for (const [key, buf] of doc.celEntriesForLayer(layer.id)) {
        originals.set(key, buf.slice());
      }
    }
    expect(originals.size).toBe(5);
    const before = snap(doc);

    const cmd = new ResizeCanvas(nw, nh, anchor);
    cmd.apply(doc);
    expect(doc.width).toBe(nw);
    expect(doc.height).toBe(nh);
    const [dx, dy] = offsets[anchor];
    for (const [key, oldBuf] of originals) {
      const newBuf = doc.getCel(key as `${string}:${string}`);
      expect(newBuf).toBeDefined();
      if (newBuf) expectBlit(oldBuf, ow, oh, newBuf, nw, nh, dx, dy);
    }
    // the sparse cel stays sparse — resize never materializes cels
    const l2 = doc.layers[1];
    const f2 = doc.frames[1];
    expect(l2 && f2 && doc.getCel(doc.celKey(l2.id, f2.id))).toBeUndefined();
    const after = snap(doc);

    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
    cmd.apply(doc);
    expect(snap(doc)).toBe(after);
  });
});

describe('ResizeCanvas center rounding (pinned)', () => {
  it('grow by an odd delta keeps content toward the top-left (new pixels right/bottom)', () => {
    const doc = seededDoc(4, 4);
    const key = doc.celKeyAt(0, 0);
    const old = doc.ensureCel(key).slice();
    new ResizeCanvas(5, 5, 'c').apply(doc);
    // trunc(1/2) = 0 → old (0,0) stays at (0,0); appended column 4 / row 4 empty
    const buf = doc.getCel(key);
    expect(buf).toBeDefined();
    if (buf) {
      expectBlit(old, 4, 4, buf, 5, 5, 0, 0);
      expect(buf[0 * 5 + 0]).toBe(old[0]);
      expect(buf[0 * 5 + 4]).toBe(0);
      expect(buf[4 * 5 + 0]).toBe(0);
    }
  });

  it('shrink by an odd delta keeps content toward the top-left (crop right/bottom)', () => {
    const doc = seededDoc(5, 5);
    const key = doc.celKeyAt(0, 0);
    const old = doc.ensureCel(key).slice();
    new ResizeCanvas(4, 4, 'c').apply(doc);
    // trunc(-1/2) = 0 → left/top kept, column 4 / row 4 cropped
    const buf = doc.getCel(key);
    expect(buf).toBeDefined();
    if (buf) {
      expectBlit(old, 5, 5, buf, 4, 4, 0, 0);
      expect(buf[0]).toBe(old[0]);
    }
  });
});

describe('ResizeCanvas redo caching', () => {
  it('undo/redo cycles are byte-identical (buffers allocated once, first apply)', () => {
    const doc = seededDoc(4, 4);
    const h = new History(doc, new Bus());
    const before = snap(doc);
    h.commit(new ResizeCanvas(7, 5, 'br'));
    const after = snap(doc);
    for (let i = 0; i < 3; i++) {
      h.undo();
      expect(snap(doc)).toBe(before);
      h.redo();
      expect(snap(doc)).toBe(after);
    }
  });

  it('interleaved with a later pixel edit: full undo/redo chain is byte-identical', () => {
    const doc = seededDoc(4, 4);
    const h = new History(doc, new Bus());
    const s0 = snap(doc);
    h.commit(new ResizeCanvas(6, 6, 'c'));
    const s1 = snap(doc);
    const key = doc.celKeyAt(0, 0);
    const beforePx = doc.ensureCel(key).slice();
    const afterPx = beforePx.slice();
    afterPx[5 * 6 + 5] = packRgba(9, 9, 9, 255);
    const patch = PixelPatch.fromBuffers(key, 6, 6, beforePx, afterPx, 'dot');
    expect(patch).not.toBeNull();
    if (patch) h.commit(patch);
    const s2 = snap(doc);

    h.undo();
    expect(snap(doc)).toBe(s1);
    h.undo();
    expect(snap(doc)).toBe(s0);
    h.redo();
    expect(snap(doc)).toBe(s1);
    h.redo();
    expect(snap(doc)).toBe(s2);
  });

  it('shrink-then-undo restores clipped pixels exactly', () => {
    const doc = seededDoc(6, 6);
    const h = new History(doc, new Bus());
    const before = snap(doc);
    h.commit(new ResizeCanvas(2, 2, 'tl'));
    expect(doc.width).toBe(2);
    h.undo();
    expect(snap(doc)).toBe(before);
    expect(doc.width).toBe(6);
    expect(doc.height).toBe(6);
  });
});

describe('ResizeCanvas sizeBytes', () => {
  it('counts both retained generations, exactly, and stays stable across cycles', () => {
    const doc = seededDoc(4, 4); // 5 cels × 64 bytes
    const cmd = new ResizeCanvas(6, 6, 'tl'); // 5 cels × 144 bytes
    expect(cmd.sizeBytes).toBe(128);
    cmd.apply(doc);
    const charged = 128 + 5 * 4 * 4 * 4 + 5 * 6 * 6 * 4;
    expect(cmd.sizeBytes).toBe(charged);
    cmd.revert(doc);
    expect(cmd.sizeBytes).toBe(charged);
    cmd.apply(doc);
    expect(cmd.sizeBytes).toBe(charged);
  });
});

describe('ResizeCanvas basics', () => {
  it('label + dirty scope', () => {
    const cmd = new ResizeCanvas(8, 8, 'tl');
    expect(cmd.label).toBe('resize canvas');
    expect(cmd.dirty).toEqual({ kind: 'all' });
  });

  it('clamps degenerate dimensions to 1×1', () => {
    const doc = seededDoc(4, 4);
    const cmd = new ResizeCanvas(0, -3, 'c');
    const before = snap(doc);
    cmd.apply(doc);
    expect(doc.width).toBe(1);
    expect(doc.height).toBe(1);
    cmd.revert(doc);
    expect(snap(doc)).toBe(before);
  });
});
