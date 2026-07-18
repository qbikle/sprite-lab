import { describe, expect, it } from 'vitest';
import type { PixelPt, PointerInfo, Rgba, ToolCtx } from '../../src/core/contracts';
import { PencilTool } from '../../src/tools/pencil';
import { pressureBrushSize } from '../../src/render/viewport';

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

const pen = (brushOverride?: number): PointerInfo => ({
  buttons: 1, shift: false, alt: false, ctrl: false, meta: false,
  pressure: 0.5, pointerType: 'pen',
  ...(brushOverride === undefined ? {} : { brushOverride }),
});

describe('pressureBrushSize mapping', () => {
  it('maps 0..1 onto 1..size via ceil', () => {
    expect(pressureBrushSize(0, 8)).toBe(1);
    expect(pressureBrushSize(0.001, 8)).toBe(1);
    expect(pressureBrushSize(0.125, 8)).toBe(1);
    expect(pressureBrushSize(0.25, 8)).toBe(2);
    expect(pressureBrushSize(0.5, 8)).toBe(4);
    expect(pressureBrushSize(0.51, 8)).toBe(5);
    expect(pressureBrushSize(1, 8)).toBe(8);
  });

  it('never leaves the 1..size range on junk input', () => {
    expect(pressureBrushSize(-1, 8)).toBe(1);
    expect(pressureBrushSize(2, 8)).toBe(8);
    expect(pressureBrushSize(Number.NaN, 8)).toBe(1);
    expect(pressureBrushSize(1, 1)).toBe(1);
    expect(pressureBrushSize(0.9, 1)).toBe(1);
  });
});

describe('StrokeTool honors PointerInfo.brushOverride', () => {
  it('stamps the override footprint instead of ctx.brushSize', () => {
    const h = makeCtx(16, 16, 8);
    const tool = new PencilTool();
    tool.onDown(h.ctx, { x: 4, y: 4 }, pen(2));
    // size 2 biases up-left: covers (4..5, 4..5)
    expect(new Set(h.staged.keys()))
      .toEqual(new Set(['4,4', '5,4', '4,5', '5,5']));
    tool.onUp(h.ctx, { x: 4, y: 4 }, pen(2));
    expect(h.calls.commits).toEqual(['pencil stroke']);
  });

  it('falls back to ctx.brushSize when the override is absent', () => {
    const h = makeCtx(16, 16, 8);
    const tool = new PencilTool();
    tool.onDown(h.ctx, { x: 7, y: 7 }, pen());
    expect(h.staged.size).toBe(64); // full 8×8 footprint
  });

  it('varies footprint within one stroke as pressure changes', () => {
    const h = makeCtx(32, 32, 8);
    const tool = new PencilTool();
    tool.onDown(h.ctx, { x: 4, y: 8 }, pen(1));
    expect(h.staged.size).toBe(1);
    tool.onMove(h.ctx, { x: 20, y: 8 }, pen(4));
    // the move leg stamps size 4 (offset 1 up-left) along the whole line
    expect(h.staged.has('20,7')).toBe(true);
    expect(h.staged.has('20,10')).toBe(true);
    expect(h.staged.has('12,7')).toBe(true);
    tool.onUp(h.ctx, { x: 20, y: 8 }, pen(4));
    expect(h.calls.commits).toEqual(['pencil stroke']);
  });
});
