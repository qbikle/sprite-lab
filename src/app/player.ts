/** Playback engine — advances the active frame by per-frame durations.
 *  Honors a tag range when set (loop/pingpong/hold). Sole emitter of
 *  'playback:changed'; App mirrors the flag into EditorState.syncPlaying. */
import type { TagMode } from '../core/contracts';
import type { Bus } from '../core/bus';
import type { SpriteDoc } from '../core/doc';

export interface PlayerOpts {
  bus: Bus;
  getDoc(): SpriteDoc;
  getFrame(): number;
  setFrame(index: number): void; // editor.setActiveFrame — emits frame:active
}

interface PlayRange { from: number; to: number; mode: TagMode }

/** Cap per-tick elapsed time so a suspended tab doesn't fast-forward. */
const MAX_TICK_MS = 250;

export class Player {
  private readonly opts: PlayerOpts;
  private isPlaying = false;
  private range: PlayRange | null = null;
  private rafId: number | null = null;
  private lastTs = 0;
  private acc = 0;
  private direction: 1 | -1 = 1;

  constructor(opts: PlayerOpts) {
    this.opts = opts;
  }

  get playing(): boolean { return this.isPlaying; }

  /** Loop range: null = whole timeline. */
  setRange(range: { from: number; to: number; mode: TagMode } | null): void {
    this.range = range ? { ...range } : null;
    this.direction = 1;
    if (this.isPlaying) {
      this.clampIntoRange();
      this.acc = 0;
    }
  }

  play(): void {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.direction = 1;
    this.clampIntoRange();
    this.acc = 0;
    this.lastTs = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
    this.opts.bus.emit('playback:changed', { playing: true });
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.opts.bus.emit('playback:changed', { playing: false });
  }

  toggle(): void {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  /** Stop rAF + listeners. */
  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.isPlaying = false;
  }

  /** Range clamped to current doc bounds; no range = whole-timeline loop. */
  private effectiveRange(): PlayRange {
    const last = Math.max(0, this.opts.getDoc().frames.length - 1);
    const r = this.range;
    if (!r) return { from: 0, to: last, mode: 'loop' };
    const from = Math.max(0, Math.min(r.from, last));
    const to = Math.max(from, Math.min(r.to, last));
    return { from, to, mode: r.mode };
  }

  private clampIntoRange(): void {
    const { from, to } = this.effectiveRange();
    const cur = this.opts.getFrame();
    if (cur < from || cur > to) this.opts.setFrame(from);
  }

  private readonly tick = (ts: number): void => {
    if (!this.isPlaying) return;
    this.rafId = requestAnimationFrame(this.tick);
    this.acc += Math.min(MAX_TICK_MS, ts - this.lastTs);
    this.lastTs = ts;
    const doc = this.opts.getDoc();
    const start = this.opts.getFrame();
    let cur = start;
    for (;;) {
      const dur = Math.max(1, doc.frames[cur]?.durationMs ?? 100);
      if (this.acc < dur) break;
      this.acc -= dur;
      const next = this.advance(cur);
      if (next === null) {
        this.pause();
        break;
      }
      cur = next;
    }
    if (cur !== start) this.opts.setFrame(cur);
  };

  /** Next frame honoring the range mode; null = hold reached its end. */
  private advance(cur: number): number | null {
    const { from, to, mode } = this.effectiveRange();
    if (cur < from || cur > to) return from;
    if (from === to) return mode === 'hold' ? null : from;
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
    if (cur === to) return mode === 'hold' ? null : from;
    return cur + 1;
  }
}
