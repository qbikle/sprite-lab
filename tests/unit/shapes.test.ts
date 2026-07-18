import { describe, expect, it } from 'vitest';
import type { PixelPt, PointerInfo, Rgba, ToolCtx } from '../../src/core/contracts';
import { EllipseTool, plotEllipseRect } from '../../src/tools/ellipse';
import { LineTool } from '../../src/tools/line';
import { RectTool } from '../../src/tools/rect';
import type { Tool } from '../../src/tools/tool';

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
    },
    readCel: () => new Uint32Array(w * h),
    commitPixels: () => {},
  };
  return { ctx, staged, calls };
}

const ptr = (over: Partial<PointerInfo> = {}): PointerInfo => ({
  buttons: 1, shift: false, alt: false, ctrl: false, meta: false,
  pressure: 0.5, pointerType: 'mouse', ...over,
});

function drag(tool: Tool, h: Harness, from: PixelPt, to: PixelPt, over: Partial<PointerInfo> = {}): void {
  tool.onDown(h.ctx, from, ptr(over));
  tool.onMove(h.ctx, to, ptr(over));
  tool.onUp(h.ctx, to, ptr(over));
}

const stagedSet = (h: Harness): Set<string> => new Set(h.staged.keys());

describe('LineTool', () => {
  it('stamps an exact diagonal at brush 1', () => {
    const h = makeCtx(8, 8);
    drag(new LineTool(), h, { x: 0, y: 0 }, { x: 4, y: 4 });
    expect(stagedSet(h)).toEqual(new Set(['0,0', '1,1', '2,2', '3,3', '4,4']));
    expect([...h.staged.values()].every((c) => c === C)).toBe(true);
    expect(h.calls.commits).toEqual(['line']);
  });

  it('shift snaps a near-horizontal drag to horizontal', () => {
    const h = makeCtx(8, 8);
    drag(new LineTool(), h, { x: 0, y: 0 }, { x: 5, y: 1 }, { shift: true });
    expect(stagedSet(h)).toEqual(new Set(['0,0', '1,0', '2,0', '3,0', '4,0', '5,0']));
  });

  it('shift snaps a near-diagonal drag to 45°', () => {
    const h = makeCtx(8, 8);
    drag(new LineTool(), h, { x: 0, y: 0 }, { x: 4, y: 5 }, { shift: true });
    expect(stagedSet(h)).toEqual(new Set(['0,0', '1,1', '2,2', '3,3', '4,4', '5,5']));
  });

  it('shift snaps a near-vertical drag to vertical', () => {
    const h = makeCtx(8, 8);
    drag(new LineTool(), h, { x: 3, y: 0 }, { x: 4, y: 6 }, { shift: true });
    expect(stagedSet(h)).toEqual(new Set(['3,0', '3,1', '3,2', '3,3', '3,4', '3,5', '3,6']));
  });
});

describe('RectTool', () => {
  it('outline stages exactly the perimeter at brush 1', () => {
    const h = makeCtx(8, 8);
    drag(new RectTool(), h, { x: 1, y: 1 }, { x: 4, y: 3 });
    const expected = new Set<string>();
    for (let x = 1; x <= 4; x++) { expected.add(`${x},1`); expected.add(`${x},3`); }
    for (let y = 1; y <= 3; y++) { expected.add(`1,${y}`); expected.add(`4,${y}`); }
    expect(stagedSet(h)).toEqual(expected);
    expect(h.staged.has('2,2')).toBe(false);
    expect(h.staged.has('3,2')).toBe(false);
    expect(h.calls.commits).toEqual(['rect']);
  });

  it('alt fills the whole box', () => {
    const h = makeCtx(8, 8);
    drag(new RectTool(), h, { x: 1, y: 1 }, { x: 4, y: 3 }, { alt: true });
    expect(h.staged.size).toBe(4 * 3);
    for (let y = 1; y <= 3; y++) {
      for (let x = 1; x <= 4; x++) expect(h.staged.get(`${x},${y}`)).toBe(C);
    }
  });

  it('shift constrains to a square', () => {
    const h = makeCtx(8, 8);
    drag(new RectTool(), h, { x: 1, y: 1 }, { x: 5, y: 3 }, { shift: true, alt: true });
    expect(h.staged.size).toBe(25);
    for (let y = 1; y <= 5; y++) {
      for (let x = 1; x <= 5; x++) expect(h.staged.has(`${x},${y}`)).toBe(true);
    }
  });

  it('normalizes a reversed drag', () => {
    const h = makeCtx(8, 8);
    drag(new RectTool(), h, { x: 4, y: 3 }, { x: 1, y: 1 }, { alt: true });
    expect(h.staged.size).toBe(4 * 3);
    expect(h.staged.has('1,1')).toBe(true);
    expect(h.staged.has('4,3')).toBe(true);
  });
});

describe('EllipseTool', () => {
  it('degenerate 1-wide box falls back to a vertical line', () => {
    const h = makeCtx(8, 8);
    drag(new EllipseTool(), h, { x: 2, y: 1 }, { x: 2, y: 5 });
    expect(stagedSet(h)).toEqual(new Set(['2,1', '2,2', '2,3', '2,4', '2,5']));
  });

  it('degenerate 1-tall box falls back to a horizontal line', () => {
    const h = makeCtx(8, 8);
    drag(new EllipseTool(), h, { x: 1, y: 2 }, { x: 5, y: 2 });
    expect(stagedSet(h)).toEqual(new Set(['1,2', '2,2', '3,2', '4,2', '5,2']));
  });

  it('5×5 outline is 4-way symmetric with an empty interior', () => {
    const h = makeCtx(8, 8);
    drag(new EllipseTool(), h, { x: 0, y: 0 }, { x: 4, y: 4 });
    const s = stagedSet(h);
    expect(s.size).toBeGreaterThan(0);
    for (const k of s) {
      const [xs, ys] = k.split(',');
      const x = Number(xs);
      const y = Number(ys);
      expect(s.has(`${4 - x},${y}`)).toBe(true);
      expect(s.has(`${x},${4 - y}`)).toBe(true);
      expect(s.has(`${4 - x},${4 - y}`)).toBe(true);
      expect(x >= 0 && x <= 4 && y >= 0 && y <= 4).toBe(true);
    }
    for (let y = 1; y <= 3; y++) {
      for (let x = 1; x <= 3; x++) expect(s.has(`${x},${y}`)).toBe(false);
    }
    expect(s.has('2,0')).toBe(true);
    expect(s.has('2,4')).toBe(true);
    expect(s.has('0,2')).toBe(true);
    expect(s.has('4,2')).toBe(true);
    expect(h.calls.commits).toEqual(['ellipse']);
  });

  it('filled 5×5 is a superset of the outline and covers the center', () => {
    const outline = makeCtx(8, 8);
    drag(new EllipseTool(), outline, { x: 0, y: 0 }, { x: 4, y: 4 });
    const filled = makeCtx(8, 8);
    drag(new EllipseTool(), filled, { x: 0, y: 0 }, { x: 4, y: 4 }, { alt: true });
    const f = stagedSet(filled);
    for (const k of stagedSet(outline)) expect(f.has(k)).toBe(true);
    expect(f.has('2,2')).toBe(true);
  });

  it('filled rows have no gaps', () => {
    const h = makeCtx(16, 16);
    drag(new EllipseTool(), h, { x: 1, y: 2 }, { x: 10, y: 8 }, { alt: true });
    const rows = new Map<number, number[]>();
    for (const k of h.staged.keys()) {
      const [xs, ys] = k.split(',');
      const y = Number(ys);
      const row = rows.get(y) ?? [];
      row.push(Number(xs));
      rows.set(y, row);
    }
    for (const xs of rows.values()) {
      xs.sort((p, q) => p - q);
      const first = xs[0];
      const last = xs[xs.length - 1];
      expect(first).toBeDefined();
      expect(last).toBeDefined();
      if (first === undefined || last === undefined) continue;
      expect(xs.length).toBe(last - first + 1);
    }
  });
});

describe('plotEllipseRect golden — 2-wide-box tip completion', () => {
  // The finishing loop deliberately uses `<=` where Zingl has `<`: without it,
  // 2-wide boxes (a=1) lose their tip rows. These goldens pin that deviation.
  const points = (x0: number, y0: number, x1: number, y1: number): Set<string> => {
    const s = new Set<string>();
    plotEllipseRect(x0, y0, x1, y1, (x, y) => s.add(`${x},${y}`));
    return s;
  };

  it('2-wide boxes cover both columns on every row, tips included', () => {
    for (const y1 of [4, 6]) {
      const s = points(0, 0, 1, y1);
      for (let y = 0; y <= y1; y++) {
        expect(s.has(`0,${y}`)).toBe(true);
        expect(s.has(`1,${y}`)).toBe(true);
      }
      expect(s.size).toBe(2 * (y1 + 1));
    }
  });

  it('golden point set for the 2×3 box', () => {
    expect([...points(2, 1, 3, 3)].sort()).toEqual(
      ['2,1', '2,2', '2,3', '3,1', '3,2', '3,3'].sort(),
    );
  });

  it('golden point set for a 5×3 box stays exact', () => {
    expect([...points(0, 0, 4, 2)].sort()).toEqual(
      ['1,0', '2,0', '3,0', '0,1', '4,1', '1,2', '2,2', '3,2'].sort(),
    );
  });
});

describe('shape gesture lifecycle', () => {
  const cases: Array<[Tool, string]> = [
    [new LineTool(), 'line'],
    [new RectTool(), 'rect'],
    [new EllipseTool(), 'ellipse'],
  ];

  it('clears the stage on every move and commits exactly once on up', () => {
    for (const [tool, label] of cases) {
      const h = makeCtx(8, 8);
      tool.onDown(h.ctx, { x: 1, y: 1 }, ptr());
      tool.onMove(h.ctx, { x: 2, y: 2 }, ptr());
      tool.onMove(h.ctx, { x: 3, y: 2 }, ptr());
      tool.onMove(h.ctx, { x: 4, y: 3 }, ptr());
      tool.onUp(h.ctx, { x: 4, y: 3 }, ptr());
      expect(h.calls.clear).toBe(4);
      expect(h.calls.commits).toEqual([label]);
      tool.onMove(h.ctx, { x: 5, y: 5 }, ptr());
      expect(h.calls.clear).toBe(4);
    }
  });

  it('cancel clears the stage and never commits', () => {
    for (const [tool] of cases) {
      const h = makeCtx(8, 8);
      tool.onDown(h.ctx, { x: 1, y: 1 }, ptr());
      tool.onMove(h.ctx, { x: 4, y: 4 }, ptr());
      tool.onCancel(h.ctx);
      expect(h.staged.size).toBe(0);
      expect(h.calls.commits).toEqual([]);
      tool.onMove(h.ctx, { x: 5, y: 5 }, ptr());
      expect(h.staged.size).toBe(0);
    }
  });
});
