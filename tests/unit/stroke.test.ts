import { describe, expect, it } from 'vitest';
import type { PixelPt, PointerInfo, Rgba, ToolCtx } from '../../src/core/contracts';
import { stampLine } from '../../src/tools/brush';
import { EraserTool } from '../../src/tools/eraser';
import { PencilTool } from '../../src/tools/pencil';

const C: Rgba = 0xff336699;

interface Harness {
  ctx: ToolCtx;
  staged: Map<string, Rgba>;
  calls: { clear: number; commits: string[] };
}

function makeCtx(w: number, h: number, brushSize = 1): Harness {
  const staged = new Map<string, Rgba>();
  const calls = { clear: 0, commits: [] as string[] };
  const ctx: ToolCtx = {
    docW: w,
    docH: h,
    color: C,
    brushSize,
    inBounds: (p: PixelPt) => p.x >= 0 && p.y >= 0 && p.x < w && p.y < h,
    symmetrySeeds: (p: PixelPt) => [p],
    selection: null,
    setSelection: () => {},
    float: null,
    liftSelection: () => {},
    dragFloat: () => {},
    anchorFloat: () => {},
    getCelPixel: () => 0,
    pickColor: () => 0,
    setColor: () => {},
    stage: (p, color) => {
      if (p.x >= 0 && p.y >= 0 && p.x < w && p.y < h) staged.set(`${p.x},${p.y}`, color);
    },
    clearStage: () => {
      calls.clear++;
      staged.clear();
    },
    commitStage: (label) => {
      calls.commits.push(label);
      staged.clear();
    },
    readCel: () => new Uint32Array(w * h),
    commitPixels: () => {},
  };
  return { ctx, staged, calls };
}

const ptr = (): PointerInfo => ({
  buttons: 1, shift: false, alt: false, ctrl: false, meta: false,
  pressure: 0.5, pointerType: 'mouse',
});

/** Expected coverage of one stampLine segment chain at brush 1. */
function lineSet(pts: readonly PixelPt[]): Set<string> {
  const out = new Set<string>();
  let last: PixelPt | null = null;
  for (const p of pts) {
    stampLine(last, p, 1, (q) => out.add(`${q.x},${q.y}`));
    last = p;
  }
  return out;
}

describe('StrokeTool lifecycle', () => {
  it('commits exactly one command per stroke', () => {
    const h = makeCtx(16, 16);
    const tool = new PencilTool();
    tool.onDown(h.ctx, { x: 1, y: 1 }, ptr());
    tool.onMove(h.ctx, { x: 3, y: 2 }, ptr());
    tool.onMove(h.ctx, { x: 6, y: 4 }, ptr());
    tool.onUp(h.ctx, { x: 6, y: 4 }, ptr());
    expect(h.calls.commits).toEqual(['pencil stroke']);
    tool.onMove(h.ctx, { x: 9, y: 9 }, ptr());
    expect(h.staged.size).toBe(0); // stroke over — moves stage nothing
    expect(h.calls.commits).toEqual(['pencil stroke']);
  });

  it('interpolates sparse moves into a connected line', () => {
    const h = makeCtx(16, 16);
    const tool = new PencilTool();
    tool.onDown(h.ctx, { x: 0, y: 0 }, ptr());
    tool.onMove(h.ctx, { x: 5, y: 3 }, ptr()); // one jumpy move — no gaps allowed
    tool.onMove(h.ctx, { x: 10, y: 4 }, ptr());
    const expected = lineSet([{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 10, y: 4 }]);
    expect(new Set(h.staged.keys())).toEqual(expected);
    expect([...h.staged.values()].every((c) => c === C)).toBe(true);
  });

  it('eraser stages transparent through the same lifecycle', () => {
    const h = makeCtx(8, 8);
    const tool = new EraserTool();
    tool.onDown(h.ctx, { x: 2, y: 2 }, ptr());
    tool.onMove(h.ctx, { x: 4, y: 2 }, ptr());
    expect([...h.staged.values()].every((c) => c === 0)).toBe(true);
    tool.onUp(h.ctx, { x: 4, y: 2 }, ptr());
    expect(h.calls.commits).toEqual(['erase']);
  });

  it('cancel discards the stage and never commits', () => {
    const h = makeCtx(8, 8);
    const tool = new PencilTool();
    tool.onDown(h.ctx, { x: 1, y: 1 }, ptr());
    tool.onMove(h.ctx, { x: 4, y: 4 }, ptr());
    tool.onCancel(h.ctx);
    expect(h.calls.clear).toBe(1);
    expect(h.staged.size).toBe(0);
    expect(h.calls.commits).toEqual([]);
    tool.onMove(h.ctx, { x: 5, y: 5 }, ptr());
    expect(h.staged.size).toBe(0);
  });

  it('move/up before down are no-ops', () => {
    const h = makeCtx(8, 8);
    const tool = new PencilTool();
    tool.onMove(h.ctx, { x: 2, y: 2 }, ptr());
    tool.onUp(h.ctx, { x: 2, y: 2 }, ptr());
    expect(h.staged.size).toBe(0);
    expect(h.calls.commits).toEqual([]);
  });
});
