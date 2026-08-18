/** app/stamps store (CRUD, caps, persistence, corrupt-entry resilience) +
 *  StampTool staging math (centering, transparent-skip, symmetry centers). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PixelPt, PointerInfo, Rgba, ToolCtx } from '../../src/core/contracts';
import { Bus } from '../../src/core/bus';
import { packRgba } from '../../src/core/pixels';

const KEY = 'sprite-lab:v2:stamps';

class MemoryStorage {
  private readonly map = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let storage: MemoryStorage;

type StampsModule = typeof import('../../src/app/stamps');

/** Fresh module instance per import — module-level store state resets. */
async function freshStamps(): Promise<StampsModule> {
  vi.resetModules();
  return import('../../src/app/stamps');
}

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const R = packRgba(255, 0, 0, 255);
const G = packRgba(0, 255, 0, 255);
const B = packRgba(0, 0, 255, 255);

function px(...values: number[]): Uint32Array {
  return Uint32Array.from(values);
}

describe('stamps store', () => {
  it('addStamp copies the buffer, activates the new stamp, and notifies', async () => {
    const s = await freshStamps();
    let fired = 0;
    const off = s.onStampsChanged(() => fired++);
    const source = px(R, 0, 0, G);
    const made = s.addStamp(2, 2, source);
    expect(made).not.toBeNull();
    expect(fired).toBe(1);
    expect(s.stamps()).toHaveLength(1);
    expect(s.activeStamp()).toBe(made);
    source[0] = B; // caller's buffer mutation must not reach the store
    expect(made?.pixels[0]).toBe(R);
    off();
    s.addStamp(1, 1, px(R));
    expect(fired).toBe(1); // unsubscribed
  });

  it('setActiveStamp switches, ignores unknown ids, and removeStamp clears active', async () => {
    const s = await freshStamps();
    const a = s.addStamp(1, 1, px(R));
    const b = s.addStamp(1, 1, px(G));
    if (!a || !b) throw new Error('setup failed');
    expect(s.activeStamp()?.id).toBe(b.id);
    s.setActiveStamp(a.id);
    expect(s.activeStamp()?.id).toBe(a.id);
    s.setActiveStamp('nope');
    expect(s.activeStamp()?.id).toBe(a.id);
    s.setActiveStamp(null);
    expect(s.activeStamp()).toBeNull();
    s.setActiveStamp(b.id);
    s.removeStamp(b.id);
    expect(s.activeStamp()).toBeNull();
    expect(s.stamps().map((t) => t.id)).toEqual([a.id]);
    s.removeStamp('nope'); // no-op, no throw
    expect(s.stamps()).toHaveLength(1);
  });

  it('refuses a 9th stamp, oversize sides, and mismatched buffers', async () => {
    const s = await freshStamps();
    for (let i = 0; i < 8; i++) expect(s.addStamp(1, 1, px(R))).not.toBeNull();
    expect(s.addStamp(1, 1, px(G))).toBeNull(); // full
    expect(s.stamps()).toHaveLength(8);

    storage.removeItem(KEY); // fresh shelf for the size checks
    const t = await freshStamps();
    expect(t.addStamp(49, 1, new Uint32Array(49))).toBeNull(); // oversize w
    expect(t.addStamp(1, 49, new Uint32Array(49))).toBeNull(); // oversize h
    expect(t.addStamp(0, 1, new Uint32Array(0))).toBeNull();
    expect(t.addStamp(2, 2, px(R))).toBeNull(); // wrong length
    expect(t.addStamp(48, 48, new Uint32Array(48 * 48))).not.toBeNull(); // cap ok
  });

  it('persists across a module reload byte-identically; active resets', async () => {
    const s = await freshStamps();
    const a = s.addStamp(2, 1, px(R, G));
    const b = s.addStamp(1, 2, px(B, 0));
    if (!a || !b) throw new Error('setup failed');

    const s2 = await freshStamps();
    const back = s2.stamps();
    expect(back.map((t) => ({ id: t.id, w: t.w, h: t.h }))).toEqual([
      { id: a.id, w: 2, h: 1 },
      { id: b.id, w: 1, h: 2 },
    ]);
    expect([...(back[0]?.pixels ?? [])]).toEqual([R, G]);
    expect([...(back[1]?.pixels ?? [])]).toEqual([B, 0]);
    expect(s2.activeStamp()).toBeNull();
    // id counter resumes past persisted ids — no collisions after reload
    const c = s2.addStamp(1, 1, px(G));
    expect(c?.id).not.toBe(a.id);
    expect(c?.id).not.toBe(b.id);
  });

  it('drops corrupt persisted entries and survives garbage stores', async () => {
    const good = { id: 'st7', w: 1, h: 1, px: btoa('\x01\x02\x03\xff') };
    storage.setItem(KEY, JSON.stringify({
      v: 1,
      stamps: [
        good,
        { id: 'st8', w: 1, h: 1, px: 'not base64!!' },
        { id: 'st9', w: 3, h: 3, px: btoa('\x01\x02\x03\xff') }, // dims ≠ buffer
        { id: '', w: 1, h: 1, px: btoa('\x01\x02\x03\xff') },
        { id: 'st10', w: 99, h: 1, px: btoa('') }, // oversize
        'garbage',
        null,
      ],
    }));
    const s = await freshStamps();
    expect(s.stamps().map((t) => t.id)).toEqual(['st7']);
    // and a wholly corrupt store loads as empty
    storage.setItem(KEY, '{nope');
    const t = await freshStamps();
    expect(t.stamps()).toEqual([]);
  });

  it('swallows storage write failures — the stamp still lands in memory', async () => {
    storage.failWrites = true;
    const s = await freshStamps();
    const made = s.addStamp(1, 1, px(R));
    expect(made).not.toBeNull();
    expect(s.stamps()).toHaveLength(1);
  });

  it('selectionPixels mirrors copyData: float first, else masked selection', async () => {
    const s = await freshStamps();
    type EditorArg = Parameters<typeof s.selectionPixels>[0];

    const float = {
      pixels: px(R, G),
      rect: { x: 3, y: 4, w: 2, h: 1 },
    };
    const floatEditor = { float, selection: null } as unknown as EditorArg;
    const fromFloat = s.selectionPixels(floatEditor);
    expect(fromFloat).toEqual({ w: 2, h: 1, pixels: px(R, G) });
    expect(fromFloat?.pixels).not.toBe(float.pixels); // copied

    // 4×4 doc, selection covers a 2×2 bounds but masks only the diagonal
    const mask = new Uint8Array(16);
    mask[1 * 4 + 1] = 1;
    mask[2 * 4 + 2] = 1;
    const cel = new Uint32Array(16);
    cel[1 * 4 + 1] = R;
    cel[1 * 4 + 2] = G; // in bounds, NOT masked — must stay transparent
    cel[2 * 4 + 2] = B;
    const selEditor = {
      float: null,
      selection: { mask, bounds: { x: 1, y: 1, w: 2, h: 2 } },
      activeLayer: 0,
      activeFrame: 0,
      doc: {
        width: 4,
        celKeyAt: () => 'l1:f1',
        getCel: () => cel,
      },
    } as unknown as EditorArg;
    expect(s.selectionPixels(selEditor)).toEqual({ w: 2, h: 2, pixels: px(R, 0, 0, B) });

    const emptyEditor = { float: null, selection: null } as unknown as EditorArg;
    expect(s.selectionPixels(emptyEditor)).toBeNull();
  });
});

/* ── StampTool ──────────────────────────────────────────── */

interface Harness {
  ctx: ToolCtx;
  staged: Map<string, Rgba>;
  stageCalls: number;
  calls: { clear: number; commits: string[] };
}

/** Mock ToolCtx; mirrorX simulates the editor's stage()-side x-symmetry
 *  expansion (each staged pixel also lands at its mirror). */
function makeCtx(w: number, h: number, opts: { mirrorX?: boolean } = {}): Harness {
  const staged = new Map<string, Rgba>();
  const calls = { clear: 0, commits: [] as string[] };
  const harness: Harness = {
    staged,
    stageCalls: 0,
    calls,
    ctx: {
      docW: w,
      docH: h,
      color: R,
      brushSize: 1,
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
        harness.stageCalls++;
        const put = (x: number, y: number): void => {
          if (x >= 0 && y >= 0 && x < w && y < h) staged.set(`${x},${y}`, color);
        };
        put(p.x, p.y);
        if (opts.mirrorX) put(w - 1 - p.x, p.y);
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
    },
  };
  return harness;
}

const ptr = (over: Partial<PointerInfo> = {}): PointerInfo => ({
  buttons: 1, shift: false, alt: false, ctrl: false, meta: false,
  pressure: 0.5, pointerType: 'mouse', ...over,
});

async function toolWithStamp(
  w: number, h: number, pixels: Uint32Array,
): Promise<{ tool: import('../../src/tools/stamp').StampTool; stamps: StampsModule; bus: Bus }> {
  const stampsMod = await freshStamps();
  const made = stampsMod.addStamp(w, h, pixels);
  if (!made) throw new Error('stamp setup failed');
  const { StampTool } = await import('../../src/tools/stamp');
  const bus = new Bus();
  return { tool: new StampTool(bus), stamps: stampsMod, bus };
}

describe('StampTool', () => {
  it('centers an odd stamp on the cursor and skips transparent pixels', async () => {
    // 3×3 plus-shape: corners transparent
    const { tool } = await toolWithStamp(3, 3, px(0, R, 0, R, G, R, 0, R, 0));
    const h = makeCtx(16, 16);
    tool.onDown(h.ctx, { x: 8, y: 8 }, ptr());
    tool.onUp(h.ctx, { x: 8, y: 8 }, ptr());
    expect(new Set(h.staged.keys())).toEqual(
      new Set(['8,7', '7,8', '8,8', '9,8', '8,9']),
    );
    expect(h.staged.get('8,8')).toBe(G);
    expect(h.staged.get('8,7')).toBe(R);
    expect(h.calls.commits).toEqual(['stamp']);
  });

  it('biases even sizes up-left, brush-style (cursor = top-left of the extra row/col)', async () => {
    const { tool } = await toolWithStamp(2, 2, px(R, G, B, R));
    const h = makeCtx(16, 16);
    tool.onDown(h.ctx, { x: 5, y: 5 }, ptr());
    tool.onUp(h.ctx, { x: 5, y: 5 }, ptr());
    expect(new Set(h.staged.keys())).toEqual(new Set(['5,5', '6,5', '5,6', '6,6']));
    expect(h.staged.get('5,5')).toBe(R);
    expect(h.staged.get('6,6')).toBe(R);
    expect(h.staged.get('6,5')).toBe(G);
  });

  it('stamps every distinct pixel a drag visits, once each, one command per gesture', async () => {
    const { tool } = await toolWithStamp(1, 1, px(R));
    const h = makeCtx(16, 16);
    tool.onDown(h.ctx, { x: 2, y: 2 }, ptr());
    tool.onMove(h.ctx, { x: 2, y: 2 }, ptr()); // same pixel — no re-stage
    expect(h.stageCalls).toBe(1);
    tool.onMove(h.ctx, { x: 5, y: 2 }, ptr());
    tool.onUp(h.ctx, { x: 5, y: 2 }, ptr());
    expect(h.stageCalls).toBe(2);
    expect(new Set(h.staged.keys())).toEqual(new Set(['2,2', '5,2']));
    expect(h.calls.commits).toEqual(['stamp']);
    // a fresh down after up starts a new gesture
    tool.onDown(h.ctx, { x: 9, y: 9 }, ptr());
    tool.onUp(h.ctx, { x: 9, y: 9 }, ptr());
    expect(h.calls.commits).toEqual(['stamp', 'stamp']);
  });

  it('cancel clears the stage and commits nothing', async () => {
    const { tool } = await toolWithStamp(1, 1, px(R));
    const h = makeCtx(16, 16);
    tool.onDown(h.ctx, { x: 2, y: 2 }, ptr());
    tool.onCancel(h.ctx);
    expect(h.calls.clear).toBe(1);
    expect(h.calls.commits).toEqual([]);
    tool.onUp(h.ctx, { x: 2, y: 2 }, ptr()); // up after cancel is inert
    expect(h.calls.commits).toEqual([]);
  });

  it('stages the primary center only — stage()-side symmetry yields the mirrored stamp', async () => {
    // asymmetric 2×1 stamp: R then G
    const { tool } = await toolWithStamp(2, 1, px(R, G));
    const h = makeCtx(16, 16, { mirrorX: true });
    tool.onDown(h.ctx, { x: 4, y: 8 }, ptr());
    tool.onUp(h.ctx, { x: 4, y: 8 }, ptr());
    // tool issues exactly one stage() per opaque stamp pixel — no seed loop
    expect(h.stageCalls).toBe(2);
    // primary copy at the cursor + mirrored copy about x, colors flipped
    expect(h.staged.get('4,8')).toBe(R);
    expect(h.staged.get('5,8')).toBe(G);
    expect(h.staged.get('11,8')).toBe(R);
    expect(h.staged.get('10,8')).toBe(G);
    expect(h.staged.size).toBe(4);
  });

  it('with no active stamp: stages nothing, commits nothing, hints once per activation', async () => {
    const stampsMod = await freshStamps();
    const { StampTool, NO_STAMP_HINT } = await import('../../src/tools/stamp');
    const bus = new Bus();
    const messages: string[] = [];
    bus.on('status:message', ({ text }) => messages.push(text));
    const tool = new StampTool(bus);

    bus.emit('tool:changed', { id: 'stamp' }); // activation with empty shelf hints
    expect(messages).toEqual([NO_STAMP_HINT]);
    const h = makeCtx(16, 16);
    tool.onDown(h.ctx, { x: 2, y: 2 }, ptr());
    tool.onDown(h.ctx, { x: 3, y: 3 }, ptr());
    expect(h.stageCalls).toBe(0);
    tool.onUp(h.ctx, { x: 3, y: 3 }, ptr());
    expect(h.calls.commits).toEqual([]);
    expect(messages).toEqual([NO_STAMP_HINT]); // once per activation

    bus.emit('tool:changed', { id: 'stamp' }); // re-activation hints again
    expect(messages).toEqual([NO_STAMP_HINT, NO_STAMP_HINT]);

    stampsMod.addStamp(1, 1, px(R));
    tool.onDown(h.ctx, { x: 2, y: 2 }, ptr());
    tool.onUp(h.ctx, { x: 2, y: 2 }, ptr());
    expect(h.staged.get('2,2')).toBe(R); // shelf filled → paints again
  });

  it('paints the stamp the store holds at draw time (mid-gesture removal stops staging)', async () => {
    const { tool, stamps: stampsMod } = await toolWithStamp(1, 1, px(R));
    const h = makeCtx(16, 16);
    tool.onDown(h.ctx, { x: 2, y: 2 }, ptr());
    const active = stampsMod.activeStamp();
    if (active) stampsMod.removeStamp(active.id);
    tool.onMove(h.ctx, { x: 5, y: 5 }, ptr());
    expect(h.staged.has('5,5')).toBe(false);
    tool.onUp(h.ctx, { x: 5, y: 5 }, ptr());
    expect(h.calls.commits).toEqual(['stamp']); // gesture still closes cleanly
  });
});
