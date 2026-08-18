/** Live preview panel — a small always-looping playback view at the top of the
 *  side column, INDEPENDENT of the main Player (emits nothing on the bus; the
 *  Player stays the sole 'playback:changed' emitter). Runs its own
 *  duration-driven rAF over all frames, or the active tag range when one is
 *  set (same range source the Player consumes). 'hold' tags loop here — a
 *  frozen preview tile reads as broken. Draws from a preview-OWNED compositor
 *  (never the viewport's — its composite cache is single-frame), repaints only
 *  on frame advance / doc changes, and parks the rAF while hidden, collapsed,
 *  or unmounted. */
import type { DirtyScope, TagMode } from '../../core/contracts';
import type { Bus } from '../../core/bus';
import type { SpriteDoc } from '../../core/doc';
import { icon } from '../icons';

/** Collapsed-state persistence. Absent/other value = open (the default). */
const STORE_KEY = 'sprite-lab:v2:preview';

/** Cap per-tick elapsed time so a suspended tab doesn't fast-forward. */
const MAX_TICK_MS = 250;

/** Canvas box height in CSS px (width follows the side rail). */
const BOX_H = 120;

export interface PreviewRange {
  from: number;
  to: number;
  mode: TagMode;
}

/** What the panel needs from its frame source — a dedicated render/Compositor
 *  satisfies this structurally. The panel OWNS the instance it is given:
 *  it invalidates and re-seats it as the doc changes. */
export interface PreviewCompositor {
  setDoc(doc: SpriteDoc): void;
  invalidate(scope: DirtyScope): void;
  frameCanvas(frameIndex: number, stage: null, activeLayer: number): HTMLCanvasElement;
}

export interface PreviewPanelOpts {
  host: HTMLElement;
  bus: Bus;
  /** Preview-owned frame source (construct a fresh Compositor for it). */
  compositor: PreviewCompositor;
  getDoc(): SpriteDoc;
  /** Active tag range (the Player's range source); null = whole timeline. */
  getRange(): Readonly<PreviewRange> | null;
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

export class PreviewPanel {
  private readonly opts: PreviewPanelOpts;
  private readonly unsubs: Array<() => void> = [];
  private rootEl: HTMLElement | null = null;
  private caretEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private canvasEl: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private collapsed = false;

  private lastDoc: SpriteDoc | null = null;
  private lastW = 0;
  private lastH = 0;

  private rafId: number | null = null;
  private lastTs = 0;
  private acc = 0;
  private frame = 0;
  private direction: 1 | -1 = 1;

  constructor(opts: PreviewPanelOpts) {
    this.opts = opts;
  }

  mount(): void {
    const o = this.opts;
    const root = div('sl-preview');

    const head = div('sl-panel-head sl-head-row sl-preview-head');
    head.title = 'live playback preview';
    const caret = document.createElement('span');
    caret.className = 'sl-preview-caret';
    const title = document.createElement('span');
    title.textContent = 'preview';
    head.append(caret, title, div('sl-head-line'));
    head.addEventListener('click', () => this.setCollapsed(!this.collapsed, true));

    const body = div('sl-preview-body');
    const canvas = document.createElement('canvas');
    canvas.className = 'sl-preview-canvas';
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('preview: 2d context unavailable');
    body.appendChild(canvas);

    root.append(head, body);
    // always the TOP of the side column, regardless of mount order
    o.host.prepend(root);

    this.rootEl = root;
    this.caretEl = caret;
    this.bodyEl = body;
    this.canvasEl = canvas;
    this.ctx = ctx;

    this.unsubs.push(
      o.bus.on('doc:changed', ({ scope }) => {
        o.compositor.invalidate(scope);
        this.paint();
      }),
      o.bus.on('doc:replaced', () => {
        this.frame = 0;
        this.direction = 1;
        this.acc = 0;
        this.paint();
      }),
    );
    const onVisibility = (): void => {
      if (document.hidden) this.stopLoop();
      else this.startLoop();
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.unsubs.push(() => document.removeEventListener('visibilitychange', onVisibility));
    const onResize = (): void => this.paint();
    window.addEventListener('resize', onResize);
    this.unsubs.push(() => window.removeEventListener('resize', onResize));

    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORE_KEY);
    } catch {
      /* storage unavailable */
    }
    this.setCollapsed(stored === 'closed', false);
  }

  unmount(): void {
    this.stopLoop();
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.rootEl?.remove();
    this.rootEl = this.caretEl = this.bodyEl = null;
    this.canvasEl = null;
    this.ctx = null;
    this.lastDoc = null;
  }

  private setCollapsed(on: boolean, persist: boolean): void {
    this.collapsed = on;
    if (this.caretEl) this.caretEl.replaceChildren(icon(on ? 'caret-right' : 'caret-down'));
    if (this.bodyEl) this.bodyEl.hidden = on;
    if (persist) {
      try {
        localStorage.setItem(STORE_KEY, on ? 'closed' : 'open');
      } catch {
        /* storage unavailable */
      }
    }
    if (on) {
      this.stopLoop();
    } else {
      this.paint();
      this.startLoop();
    }
  }

  private startLoop(): void {
    if (this.rafId !== null || this.collapsed || !this.rootEl || document.hidden) return;
    this.lastTs = performance.now();
    this.acc = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /** Range clamped to current doc bounds; no range = whole-timeline loop. */
  private effectiveRange(doc: SpriteDoc): PreviewRange {
    const last = Math.max(0, doc.frames.length - 1);
    const r = this.opts.getRange();
    if (!r) return { from: 0, to: last, mode: 'loop' };
    const from = Math.max(0, Math.min(r.from, last));
    const to = Math.max(from, Math.min(r.to, last));
    return { from, to, mode: r.mode };
  }

  /** Next frame in the range. 'hold' loops here — the preview never freezes. */
  private advance(cur: number, doc: SpriteDoc): number {
    const { from, to, mode } = this.effectiveRange(doc);
    if (cur < from || cur > to) return from;
    if (from === to) return from;
    if (mode === 'pingpong') {
      let next = cur + this.direction;
      if (next > to) {
        this.direction = -1;
        next = cur - 1;
      } else if (next < from) {
        this.direction = 1;
        next = cur + 1;
      }
      return next;
    }
    return cur === to ? from : cur + 1;
  }

  private readonly tick = (ts: number): void => {
    if (this.rafId === null) return;
    this.rafId = requestAnimationFrame(this.tick);
    this.acc += Math.min(MAX_TICK_MS, ts - this.lastTs);
    this.lastTs = ts;
    const doc = this.opts.getDoc();
    const start = this.frame;
    let cur = start;
    for (;;) {
      const dur = Math.max(1, doc.frames[cur]?.durationMs ?? 100);
      if (this.acc < dur) break;
      this.acc -= dur;
      cur = this.advance(cur, doc);
    }
    if (cur !== start) {
      this.frame = cur;
      this.paint();
    }
  };

  /** Re-seat the compositor when the doc object or its dims changed (adopt,
   *  ResizeCanvas/Rotate90CW and their undo/redo all funnel through here). */
  private syncDoc(doc: SpriteDoc): void {
    if (doc === this.lastDoc && doc.width === this.lastW && doc.height === this.lastH) return;
    this.opts.compositor.setDoc(doc);
    this.lastDoc = doc;
    this.lastW = doc.width;
    this.lastH = doc.height;
  }

  /** Canvas backing store = doc × integer device-pixel scale (fractional only
   *  when the doc outgrows the box); CSS size = device / dpr, so the checker
   *  background sits exactly under the sprite. */
  private fitCanvas(doc: SpriteDoc): void {
    const canvas = this.canvasEl;
    const body = this.bodyEl;
    if (!canvas || !body) return;
    const dpr = window.devicePixelRatio || 1;
    const boxW = Math.max(1, body.clientWidth);
    const raw = Math.min((boxW * dpr) / doc.width, (BOX_H * dpr) / doc.height);
    const scale = raw >= 1 ? Math.floor(raw) : raw;
    const w = Math.max(1, Math.round(doc.width * scale));
    const h = Math.max(1, Math.round(doc.height * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = `${w / dpr}px`;
    canvas.style.height = `${h / dpr}px`;
  }

  private paint(): void {
    if (this.collapsed) return;
    const canvas = this.canvasEl;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;
    const doc = this.opts.getDoc();
    this.syncDoc(doc);
    const { from, to } = this.effectiveRange(doc);
    if (this.frame < from || this.frame > to) {
      this.frame = from;
      this.direction = 1;
    }
    this.fitCanvas(doc);
    const src = this.opts.compositor.frameCanvas(this.frame, null, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  }
}
