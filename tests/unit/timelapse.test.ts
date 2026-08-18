/** app/timelapse — the round-trip proof. Anything that walks history MUST
 *  leave the document and history byte-identical to how it found them; the
 *  suite pins that, plus sampling, frame-selection continuity, and the
 *  resize normalization policy (historical snapshots center-padded/cropped
 *  onto the FINAL dims — a GIF has one size). */
import { describe, expect, it } from 'vitest';
import { Bus } from '../../src/core/bus';
import { SpriteDoc } from '../../src/core/doc';
import { History } from '../../src/core/history';
import { packRgba } from '../../src/core/pixels';
import { PixelPatch } from '../../src/core/commands/pixel-patch';
import { AddFrame, SetFrameDuration } from '../../src/core/commands/frames-ops';
import { AddLayer } from '../../src/core/commands/layers-ops';
import { ResizeCanvas } from '../../src/core/commands/resize';
import { FlipFrameX, FlipFrameY } from '../../src/core/commands/transform';
import { captureTimelapse, type TimelapseResult } from '../../src/app/timelapse';

const C = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => packRgba(n * 20, n * 10, n * 5, 255));

/** Canonical byte-compare snapshot (cel map iteration order is not semantic). */
function snap(doc: SpriteDoc): string {
  const j = doc.toJSON();
  const cels = Object.fromEntries(Object.entries(j.cels).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ ...j, cels });
}

function histSnap(history: History): string {
  const { labels, cursor } = history.entries();
  return JSON.stringify({ labels, cursor, canUndo: history.canUndo, canRedo: history.canRedo });
}

/** Commit a single-pixel PixelPatch (full-cel diff, like a real stroke). */
function paint(
  history: History, doc: SpriteDoc,
  layerIdx: number, frameIdx: number, x: number, y: number, color: number,
): void {
  const key = doc.celKeyAt(layerIdx, frameIdx);
  const w = doc.width;
  const h = doc.height;
  const cur = doc.getCel(key);
  const before = cur ? new Uint32Array(cur) : new Uint32Array(w * h);
  const after = new Uint32Array(before);
  after[y * w + x] = color;
  const cmd = PixelPatch.fromBuffers(key, w, h, before, after, `px ${x},${y}`);
  if (!cmd) throw new Error('paint was a no-op');
  history.commit(cmd);
}

function px(result: TimelapseResult, frame: number): Uint32Array {
  const f = result.frames[frame];
  if (!f) throw new Error(`no frame ${frame}`);
  return new Uint32Array(f.pixels);
}

/** 12 mixed commands over a 6×6 doc that gets resized to 10×8 mid-history:
 *  pixels, AddFrame, flips, resize, AddLayer, duration — every scope kind. */
function mixedRig(): { doc: SpriteDoc; history: History } {
  const doc = SpriteDoc.blank(6, 6, 'lapse');
  const history = new History(doc, new Bus());
  paint(history, doc, 0, 0, 0, 0, C[0] ?? 0);              // 1  cels f0
  paint(history, doc, 0, 0, 1, 0, C[1] ?? 0);              // 2  cels f0
  history.commit(new AddFrame(0));                          // 3  frames
  paint(history, doc, 0, 1, 2, 1, C[2] ?? 0);              // 4  cels f1
  history.commit(new FlipFrameX(1));                        // 5  cels f1
  history.commit(new ResizeCanvas(10, 8, 'c'));             // 6  all (6×6 → 10×8)
  paint(history, doc, 0, 1, 3, 3, C[3] ?? 0);              // 7  cels f1
  history.commit(new AddLayer(0));                          // 8  layers
  paint(history, doc, 1, 0, 5, 5, C[4] ?? 0);              // 9  cels f0 (layer 2)
  history.commit(new SetFrameDuration(0, 250));             // 10 frames
  paint(history, doc, 0, 0, 4, 2, C[5] ?? 0);              // 11 cels f0
  history.commit(new FlipFrameY(0));                        // 12 cels f0
  return { doc, history };
}

const capture = (
  doc: SpriteDoc, history: History,
  extra?: Partial<Parameters<typeof captureTimelapse>[0]>,
): TimelapseResult | null =>
  captureTimelapse({ history, editor: { doc }, scale: 1, ...extra });

describe('captureTimelapse — round-trip safety (the whole game)', () => {
  it('leaves doc AND history byte-identical after a full mixed-scope walk', () => {
    const { doc, history } = mixedRig();
    const docBefore = snap(doc);
    const histBefore = histSnap(history);
    const result = capture(doc, history);
    expect(result).not.toBeNull();
    expect(snap(doc)).toBe(docBefore);
    expect(histSnap(history)).toBe(histBefore);
  });

  it('undo STILL works correctly after capture (one undo, verify, redo)', () => {
    const { doc, history } = mixedRig();
    // reference states, independent of the capture machinery
    const atFull = snap(doc);
    history.undo();
    const atMinus1 = snap(doc);
    history.redo();
    expect(snap(doc)).toBe(atFull);

    capture(doc, history);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
    history.undo();
    expect(snap(doc)).toBe(atMinus1);
    history.redo();
    expect(snap(doc)).toBe(atFull);
  });

  it('respects a mid-undo cursor: samples only ≤ cursor, redo tail intact', () => {
    const { doc, history } = mixedRig();
    const atFull = snap(doc);
    history.undo();
    history.undo();
    const docBefore = snap(doc);
    const histBefore = histSnap(history);

    const result = capture(doc, history);
    expect(result?.frames).toHaveLength(10); // 12 committed, cursor at 10
    expect(snap(doc)).toBe(docBefore);
    expect(histSnap(history)).toBe(histBefore);
    expect(history.canRedo).toBe(true);
    history.redo();
    history.redo();
    expect(snap(doc)).toBe(atFull);
  });

  it('returns null with fewer than 2 replayable entries', () => {
    const doc = SpriteDoc.blank(4, 4, 'empty');
    const history = new History(doc, new Bus());
    expect(capture(doc, history)).toBeNull();
    paint(history, doc, 0, 0, 0, 0, C[0] ?? 0);
    expect(capture(doc, history)).toBeNull();
    paint(history, doc, 0, 0, 1, 1, C[1] ?? 0);
    expect(capture(doc, history)).not.toBeNull();
    // two entries but the user undid down to one → nothing to replay again
    history.undo();
    expect(capture(doc, history)).toBeNull();
    history.redo();
  });
});

describe('captureTimelapse — sampling & timing', () => {
  it('one frame per step when under maxFrames, at final dims', () => {
    const { doc, history } = mixedRig();
    const result = capture(doc, history);
    expect(result?.frames).toHaveLength(12);
    expect(result?.w).toBe(10);
    expect(result?.h).toBe(8);
    for (const f of result?.frames ?? []) {
      expect(new Uint32Array(f.pixels)).toHaveLength(10 * 8);
    }
  });

  it('samples evenly under maxFrames, always including first and last', () => {
    const { doc, history } = mixedRig();
    const result = capture(doc, history, { maxFrames: 5 });
    expect(result?.frames).toHaveLength(5);

    // first sample = the state command 1 produced: one pixel C[0] at (0,0)
    // of the 6×6 era, center-padded onto 10×8 → lands at (2,1)
    const first = px(result as TimelapseResult, 0);
    expect(first[1 * 10 + 2]).toBe(C[0]);
    expect(first.filter((v) => v !== 0)).toHaveLength(1);

    // last sample = the current state's composite of frame 0 (last command
    // is cel-scoped there) — byte-equal to a fresh flatten
    const last = px(result as TimelapseResult, 4);
    expect(last).toEqual(doc.flattenFrame(0));
  });

  it('snapshots differ across steps — the stroke actually shows', () => {
    const { doc, history } = mixedRig();
    const result = capture(doc, history);
    const distinct = new Set<string>();
    for (let i = 0; i < (result?.frames.length ?? 0); i++) {
      distinct.add(px(result as TimelapseResult, i).join(','));
    }
    expect(px(result as TimelapseResult, 0)).not.toEqual(px(result as TimelapseResult, 1));
    expect(distinct.size).toBeGreaterThanOrEqual(6);
  });

  it('holds the last frame 1000ms; others use frameMs', () => {
    const { doc, history } = mixedRig();
    const result = capture(doc, history, { frameMs: 40 });
    const frames = result?.frames ?? [];
    for (const f of frames.slice(0, -1)) expect(f.durationMs).toBe(40);
    expect(frames[frames.length - 1]?.durationMs).toBe(1000);
  });

  it('reports progress (done, total) per sample', () => {
    const { doc, history } = mixedRig();
    const calls: Array<[number, number]> = [];
    capture(doc, history, {
      maxFrames: 4,
      onProgress: (done, total) => calls.push([done, total]),
    });
    expect(calls).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
  });
});

describe('captureTimelapse — resize normalization (one GIF size)', () => {
  it('pads pre-resize snapshots with transparency, centered like anchor c', () => {
    const { doc, history } = mixedRig();
    const result = capture(doc, history);
    // steps 1–5 predate the 6×6 → 10×8 resize; each must still be 10×8 with
    // old content shifted by (trunc(4/2), trunc(2/2)) = (2, 1)
    const s2 = px(result as TimelapseResult, 1); // after cmd 2: (0,0)+(1,0)
    expect(s2[1 * 10 + 2]).toBe(C[0]);
    expect(s2[1 * 10 + 3]).toBe(C[1]);
    expect(s2.filter((v) => v !== 0)).toHaveLength(2);
    // post-resize step 7 draws at (3,3) directly in 10×8 space
    const s7 = px(result as TimelapseResult, 6);
    expect(s7[3 * 10 + 3]).toBe(C[3]);
  });

  it('center-crops snapshots when the doc shrank mid-history', () => {
    const doc = SpriteDoc.blank(8, 8, 'shrink');
    const history = new History(doc, new Bus());
    paint(history, doc, 0, 0, 3, 3, C[0] ?? 0); // survives the crop → (1,1)
    paint(history, doc, 0, 0, 0, 0, C[1] ?? 0); // cropped away
    history.commit(new ResizeCanvas(4, 4, 'c'));
    const result = capture(doc, history);
    expect(result?.w).toBe(4);
    expect(result?.h).toBe(4);
    const s1 = px(result as TimelapseResult, 0);
    expect(s1[1 * 4 + 1]).toBe(C[0]);
    expect(s1.filter((v) => v !== 0)).toHaveLength(1);
    const s2 = px(result as TimelapseResult, 1);
    expect(s2[1 * 4 + 1]).toBe(C[0]); // (0,0) fell outside the crop window
    expect(s2.filter((v) => v !== 0)).toHaveLength(1);
  });
});

describe('captureTimelapse — frame-selection policy', () => {
  it('cel steps composite their frame; non-cel steps follow the previous cel frame', () => {
    const doc = SpriteDoc.blank(4, 4, 'frames');
    const history = new History(doc, new Bus());
    paint(history, doc, 0, 0, 0, 0, C[0] ?? 0); // 1: cels f0
    history.commit(new AddFrame(0));            // 2: frames → continuity = f0
    paint(history, doc, 0, 1, 2, 2, C[1] ?? 0); // 3: cels f1
    const result = capture(doc, history);
    const s1 = px(result as TimelapseResult, 0);
    const s2 = px(result as TimelapseResult, 1);
    const s3 = px(result as TimelapseResult, 2);
    expect(s1[0]).toBe(C[0]);
    expect(s2).toEqual(s1); // AddFrame kept showing frame 0, unchanged
    expect(s3[2 * 4 + 2]).toBe(C[1]); // the f1 stroke composites frame 1
    expect(s3[0]).toBe(0);
  });

  it('falls back to frame 0 before any cel-scoped command exists', () => {
    const doc = SpriteDoc.blank(4, 4, 'fallback');
    const history = new History(doc, new Bus());
    history.commit(new AddFrame(0));            // 1: frames — no cel yet
    paint(history, doc, 0, 1, 1, 1, C[0] ?? 0); // 2: cels f1
    const result = capture(doc, history);
    const s1 = px(result as TimelapseResult, 0);
    expect(s1.every((v) => v === 0)).toBe(true); // blank frame 0
  });
});

describe('captureTimelapse — scale', () => {
  it('applies integer nearest-neighbor scale to every snapshot', () => {
    const doc = SpriteDoc.blank(4, 4, 'scaled');
    const history = new History(doc, new Bus());
    paint(history, doc, 0, 0, 1, 1, C[0] ?? 0);
    paint(history, doc, 0, 0, 2, 1, C[1] ?? 0);
    const result = capture(doc, history, { scale: 3 });
    expect(result?.w).toBe(12);
    expect(result?.h).toBe(12);
    const s1 = px(result as TimelapseResult, 0);
    expect(s1).toHaveLength(144);
    for (let by = 0; by < 3; by++) {
      for (let bx = 0; bx < 3; bx++) {
        expect(s1[(3 + by) * 12 + 3 + bx]).toBe(C[0]);
      }
    }
    expect(s1.filter((v) => v !== 0)).toHaveLength(9);
  });

  it('clamps scale so the output side stays ≤ 1024 (never below 1×)', () => {
    const { doc, history } = mixedRig(); // final dims 10×8
    const result = capture(doc, history, { maxFrames: 2, scale: 500 });
    expect(result?.w).toBe(1020); // floor(1024 / 10) = 102×
    expect(result?.h).toBe(816);
  });
});
