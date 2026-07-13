import { describe, expect, it } from 'vitest';
import { Camera } from '../../src/render/camera';

function cam(panX: number, panY: number, zoom: number): Camera {
  const c = new Camera();
  c.panX = panX;
  c.panY = panY;
  c.zoom = zoom;
  return c;
}

describe('docToScreen / screenToDocF', () => {
  it('maps doc points to screen with pan + zoom', () => {
    const c = cam(37.5, -12.25, 6);
    expect(c.docToScreen({ x: 0, y: 0 })).toEqual({ x: 37.5, y: -12.25 });
    expect(c.docToScreen({ x: 13, y: 9 })).toEqual({ x: 37.5 + 13 * 6, y: -12.25 + 9 * 6 });
  });

  it('round-trips doc → screen → doc', () => {
    const c = cam(101.3, -44.8, 3);
    const p = { x: 21.75, y: 8.5 };
    const s = c.docToScreen(p);
    const back = c.screenToDocF(s.x, s.y);
    expect(back.x).toBeCloseTo(p.x, 10);
    expect(back.y).toBeCloseTo(p.y, 10);
  });

  it('round-trips screen → doc → screen', () => {
    const c = cam(-15, 240, 12);
    const d = c.screenToDocF(333.25, 87.5);
    const s = c.docToScreen(d);
    expect(s.x).toBeCloseTo(333.25, 10);
    expect(s.y).toBeCloseTo(87.5, 10);
  });
});

describe('pixelAt', () => {
  it('floors to the pixel under the point', () => {
    const c = cam(10, 20, 8);
    expect(c.pixelAt(10, 20, 16, 16)).toEqual({ x: 0, y: 0 });
    expect(c.pixelAt(17.9, 27.9, 16, 16)).toEqual({ x: 0, y: 0 });
    expect(c.pixelAt(18, 28, 16, 16)).toEqual({ x: 1, y: 1 });
    expect(c.pixelAt(10 + 15 * 8 + 7.9, 20 + 15 * 8 + 7.9, 16, 16)).toEqual({ x: 15, y: 15 });
  });

  it('returns null outside the doc', () => {
    const c = cam(10, 20, 8);
    expect(c.pixelAt(9.99, 20, 16, 16)).toBeNull();
    expect(c.pixelAt(10, 19.99, 16, 16)).toBeNull();
    expect(c.pixelAt(10 + 16 * 8, 20, 16, 16)).toBeNull();
    expect(c.pixelAt(10, 20 + 16 * 8, 16, 16)).toBeNull();
  });
});

describe('zoomStep', () => {
  it('steps to the adjacent stop', () => {
    const c = cam(0, 0, 8);
    c.zoomStep(1, 0, 0);
    expect(c.zoom).toBe(12);
    c.zoomStep(-1, 0, 0);
    expect(c.zoom).toBe(8);
  });

  it('snaps from a non-stop zoom to the nearest stop ±1', () => {
    const up = cam(0, 0, 4.9);
    up.zoomStep(1, 0, 0);
    expect(up.zoom).toBe(6);
    const down = cam(0, 0, 5.2);
    down.zoomStep(-1, 0, 0);
    expect(down.zoom).toBe(4);
  });

  it('clamps at both ends of STOPS', () => {
    const hi = cam(0, 0, 64);
    hi.zoomStep(1, 100, 100);
    expect(hi.zoom).toBe(64);
    const lo = cam(0, 0, 0.25);
    lo.zoomStep(-1, 100, 100);
    expect(lo.zoom).toBe(0.25);
  });

  it('keeps the doc point under the pivot fixed', () => {
    const c = cam(53.5, -20.75, 8);
    const before = c.screenToDocF(123, 77);
    c.zoomStep(1, 123, 77);
    const after = c.screenToDocF(123, 77);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
    c.zoomStep(-1, 123, 77);
    const back = c.screenToDocF(123, 77);
    expect(back.x).toBeCloseTo(before.x, 10);
    expect(back.y).toBeCloseTo(before.y, 10);
  });
});

describe('setZoom', () => {
  it('clamps to the STOPS range but allows non-stop values', () => {
    const c = cam(0, 0, 8);
    c.setZoom(1000, 0, 0);
    expect(c.zoom).toBe(64);
    c.setZoom(0.01, 0, 0);
    expect(c.zoom).toBe(0.25);
    c.setZoom(5, 0, 0);
    expect(c.zoom).toBe(5);
  });

  it('keeps the doc point under the pivot fixed', () => {
    const c = cam(-31, 42, 8);
    const before = c.screenToDocF(400, 300);
    c.setZoom(5.5, 400, 300);
    const after = c.screenToDocF(400, 300);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });
});

describe('fit', () => {
  it('picks the largest stop fitting 85% of the view and centers', () => {
    const c = new Camera();
    c.fit(64, 64, 800, 600);
    expect(c.zoom).toBe(6); // 64*8=512 > 600*0.85=510, 64*6=384 fits
    expect(c.panX).toBe((800 - 64 * 6) / 2);
    expect(c.panY).toBe((600 - 64 * 6) / 2);
  });

  it('falls back to the smallest stop when nothing fits, still centered', () => {
    const c = new Camera();
    c.fit(1000, 1000, 100, 100);
    expect(c.zoom).toBe(0.25);
    expect(c.panX).toBe((100 - 1000 * 0.25) / 2);
    expect(c.panY).toBe((100 - 1000 * 0.25) / 2);
  });

  it('respects non-square docs (width-limited)', () => {
    const c = new Camera();
    c.fit(128, 32, 800, 600);
    expect(c.zoom).toBe(4); // 128*6=768 > 800*0.85=680, 128*4=512 fits
    expect(c.panX).toBe((800 - 128 * 4) / 2);
    expect(c.panY).toBe((600 - 32 * 4) / 2);
  });
});
