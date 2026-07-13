import { describe, expect, it } from 'vitest';
import type { PixelPt, PointerInfo, Rgba, ToolCtx } from '../../src/core/contracts';
import { FillTool } from '../../src/tools/fill';

const A: Rgba = 0xff112233;
const C: Rgba = 0xff445566;

interface Commit { buf: Uint32Array; label: string }

function makeCtx(w: number, h: number, pixels: Uint32Array, color: Rgba): { ctx: ToolCtx; commits: Commit[] } {
  const commits: Commit[] = [];
  const ctx: ToolCtx = {
    docW: w,
    docH: h,
    color,
    brushSize: 1,
    inBounds: (p: PixelPt) => p.x >= 0 && p.y >= 0 && p.x < w && p.y < h,
    getCelPixel: (p: PixelPt) => pixels[p.y * w + p.x] ?? 0,
    pickColor: (p: PixelPt) => pixels[p.y * w + p.x] ?? 0,
    setColor: () => {},
    stage: () => {},
    clearStage: () => {},
    commitStage: () => {},
    readCel: () => pixels.slice(),
    commitPixels: (after, label) => { commits.push({ buf: after, label }); },
  };
  return { ctx, commits };
}

const ptr = (shift = false): PointerInfo => ({
  buttons: 1, shift, alt: false, ctrl: false, meta: false, pressure: 0.5, pointerType: 'mouse',
});

describe('FillTool contiguous flood', () => {
  it('stays inside an enclosed region', () => {
    const w = 6;
    const h = 6;
    const px = new Uint32Array(w * h);
    for (let x = 1; x <= 4; x++) { px[1 * w + x] = A; px[4 * w + x] = A; }
    for (let y = 1; y <= 4; y++) { px[y * w + 1] = A; px[y * w + 4] = A; }
    const { ctx, commits } = makeCtx(w, h, px, C);

    new FillTool().onDown(ctx, { x: 2, y: 2 }, ptr());

    expect(commits).toHaveLength(1);
    const buf = commits[0]!.buf;
    expect(commits[0]!.label).toBe('fill');
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inside = x >= 2 && x <= 3 && y >= 2 && y <= 3;
        const onRing = px[y * w + x] === A;
        expect(buf[y * w + x]).toBe(inside ? C : onRing ? A : 0);
      }
    }
    expect(px[2 * w + 2]).toBe(0);
  });

  it('fills the whole cel when nothing blocks', () => {
    const px = new Uint32Array(16);
    const { ctx, commits } = makeCtx(4, 4, px, C);

    new FillTool().onDown(ctx, { x: 2, y: 1 }, ptr());

    expect(commits[0]!.buf.every((v) => v === C)).toBe(true);
  });

  it('handles 1×N and N×1 edge strips with a barrier', () => {
    const col = new Uint32Array(8);
    col[4] = A;
    const vert = makeCtx(1, 8, col, C);
    new FillTool().onDown(vert.ctx, { x: 0, y: 1 }, ptr());
    const vbuf = vert.commits[0]!.buf;
    expect(Array.from(vbuf)).toEqual([C, C, C, C, A, 0, 0, 0]);

    const row = new Uint32Array(8);
    row[4] = A;
    const horiz = makeCtx(8, 1, row, C);
    new FillTool().onDown(horiz.ctx, { x: 6, y: 0 }, ptr());
    const hbuf = horiz.commits[0]!.buf;
    expect(Array.from(hbuf)).toEqual([0, 0, 0, 0, A, C, C, C]);
  });
});

describe('FillTool global replace (shift)', () => {
  it('replaces disconnected same-color pixels everywhere', () => {
    const w = 6;
    const h = 6;
    const px = new Uint32Array(w * h);
    px[0] = A;
    px[3 * w + 2] = A;
    px[5 * w + 5] = A;
    px[2 * w + 4] = C;
    const { ctx, commits } = makeCtx(w, h, px, C);

    new FillTool().onDown(ctx, { x: 0, y: 0 }, ptr(true));

    expect(commits).toHaveLength(1);
    expect(commits[0]!.label).toBe('global fill');
    const buf = commits[0]!.buf;
    expect(buf[0]).toBe(C);
    expect(buf[3 * w + 2]).toBe(C);
    expect(buf[5 * w + 5]).toBe(C);
    expect(buf[2 * w + 4]).toBe(C);
    expect(buf.filter((v) => v === C).length).toBe(4);
  });
});

describe('FillTool no-ops', () => {
  it('does not commit when target equals the active color', () => {
    const px = new Uint32Array(16);
    px[5] = C;
    const { ctx, commits } = makeCtx(4, 4, px, C);

    new FillTool().onDown(ctx, { x: 1, y: 1 }, ptr());
    new FillTool().onDown(ctx, { x: 1, y: 1 }, ptr(true));

    expect(commits).toHaveLength(0);
  });

  it('does not commit on out-of-bounds clicks', () => {
    const { ctx, commits } = makeCtx(4, 4, new Uint32Array(16), C);

    new FillTool().onDown(ctx, { x: -1, y: 2 }, ptr());
    new FillTool().onDown(ctx, { x: 2, y: 4 }, ptr());

    expect(commits).toHaveLength(0);
  });
});
