/** Timelapse capture — replay the command history into "watch me draw" frames.
 *
 *  The undo stack holds the drawing's whole story (newest→oldest; a
 *  budget-evicted tail is simply absent — the timelapse starts wherever
 *  memory starts). Capture walks `undo()` down to the bottom of the stack,
 *  then `redo()` back up to EXACTLY the starting cursor, sampling the doc
 *  state after each redo — forward chronological order, ending at the
 *  current state. Commands are proven apply→revert byte-identical by their
 *  suites and History's recharge keeps the byte ledger exact, so the walk
 *  leaves doc + history byte-identical to how it found them (pinned in
 *  tests/unit/timelapse.test.ts). A redo tail above the starting cursor
 *  (user mid-undo) is never touched and never sampled.
 *
 *  Frame-selection policy (which animation frame each snapshot composites):
 *  a cel-scoped command names its frame (first cel key's frame id); any
 *  other command reuses the frame of the nearest EARLIER cel-scoped command
 *  (drawing continuity — a resize mid-sketch keeps showing the frame being
 *  drawn), initial fallback frame 0. Tracked by frame ID, resolved to an
 *  index at capture time (indices shift under frame ops); a vanished id
 *  falls back to frame 0.
 *
 *  Resize normalization: a GIF has ONE size, so every snapshot is normalized
 *  to the CURRENT doc dims — center-padded with transparency when the
 *  historical doc was smaller, center-cropped when larger, with the same
 *  Math.trunc centering bias as ResizeCanvas's 'c' anchor.
 *
 *  Compositing goes through doc.flattenFrame — the single source of
 *  flattening truth — into a fresh buffer per sample. The viewport's
 *  Compositor (or any render cache) is never touched (wave-10 lesson).
 *
 *  Precondition (the CALLER's wiring): no live gesture — anchor/dismiss any
 *  float + selection (editor.cancelOrDismiss() twice) and pause playback
 *  before calling. The walk itself is synchronous, so rAF-driven rendering
 *  never observes an intermediate state; each undo/redo still emits its
 *  usual bus events (inherent to History's public API).
 */
import type { History } from '../core/history';
import type { SpriteDoc } from '../core/doc';
import { clampRect, copyRect, pasteRect, upscaleNearest } from '../core/pixels';

/** GIF output-side cap (matches the export modal's gif card). */
const MAX_SIDE = 1024;
const LAST_FRAME_HOLD_MS = 1000;

export interface TimelapseOpts {
  history: History;
  editor: { doc: SpriteDoc };
  /** Integer nearest-neighbor upscale; clamped so max(w, h) · scale ≤ 1024
   *  (never below 1× — a doc already over 1024px exports at 1×). */
  scale: number;
  /** Sample cap; steps beyond it are sampled evenly, always including the
   *  first and last. Default 300. */
  maxFrames?: number;
  /** Per-frame duration; the LAST frame always holds 1000ms. Default 66. */
  frameMs?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface TimelapseResult {
  frames: { pixels: ArrayBuffer; durationMs: number }[];
  w: number;
  h: number;
}

/** src (w×h) centered onto a W×H transparent buffer; crops when larger.
 *  Math.trunc bias matches ResizeCanvas's centered anchor. Returns src
 *  itself when dims already match (callers copy before handing bytes out). */
function centerOnto(
  src: Uint32Array, w: number, h: number, outW: number, outH: number,
): Uint32Array {
  if (w === outW && h === outH) return src;
  const out = new Uint32Array(outW * outH);
  const dx = Math.trunc((outW - w) / 2);
  const dy = Math.trunc((outH - h) / 2);
  const dst = clampRect({ x: dx, y: dy, w, h }, outW, outH);
  if (!dst) return out;
  const srcRect = { x: dst.x - dx, y: dst.y - dy, w: dst.w, h: dst.h };
  pasteRect(out, outW, dst, copyRect(src, w, srcRect));
  return out;
}

/** Sampled step numbers (1-based, ascending) — all of 1..total when they fit,
 *  else `cap` evenly spaced steps always including 1 and total. */
function sampleSteps(total: number, cap: number): number[] {
  const steps: number[] = [];
  if (total <= cap) {
    for (let k = 1; k <= total; k++) steps.push(k);
    return steps;
  }
  for (let i = 0; i < cap; i++) {
    steps.push(1 + Math.round((i * (total - 1)) / (cap - 1)));
  }
  return steps;
}

/**
 * Capture a forward timelapse of the current document from its history.
 * Returns null when fewer than 2 history entries are replayable ('nothing
 * to replay'). SYNCHRONOUS — undo/redo are sync and capture is fast; GIF
 * encoding afterwards is the caller's job (existing worker path).
 */
export function captureTimelapse(opts: TimelapseOpts): TimelapseResult | null {
  const history = opts.history;
  const start = history.entries().cursor;
  if (start < 2) return null;

  const outW = opts.editor.doc.width;
  const outH = opts.editor.doc.height;
  const maxFrames = Math.max(2, Math.floor(opts.maxFrames ?? 300));
  const frameMs = Math.max(1, Math.floor(opts.frameMs ?? 66));
  const scale = Math.max(
    1,
    Math.min(Math.floor(opts.scale), Math.floor(MAX_SIDE / Math.max(outW, outH))),
  );

  const steps = sampleSteps(start, maxFrames);
  const frames: { pixels: ArrayBuffer; durationMs: number }[] = [];
  let trackFrameId: string | null = null;

  try {
    for (let i = 0; i < start; i++) history.undo();
    let si = 0;
    for (let k = 1; k <= start; k++) {
      history.redo();
      // peekUndo() now hands us the command redo just applied — its dirty
      // scope drives the frame-selection policy (tracked on EVERY step so
      // continuity survives sampling gaps).
      const scope = history.peekUndo()?.dirty;
      if (scope && scope.kind === 'cels' && scope.cels.length > 0) {
        const key = scope.cels[0]?.key;
        if (key) trackFrameId = key.slice(key.indexOf(':') + 1);
      }
      if (steps[si] !== k) continue;
      si += 1;
      const doc = opts.editor.doc;
      let frameIndex = trackFrameId === null
        ? -1
        : doc.frames.findIndex((f) => f.id === trackFrameId);
      if (frameIndex < 0) frameIndex = 0;
      const flat = doc.flattenFrame(frameIndex);
      const norm = centerOnto(flat, doc.width, doc.height, outW, outH);
      const scaled = scale === 1 ? norm : upscaleNearest(norm, outW, outH, scale);
      const pixels = new ArrayBuffer(scaled.byteLength);
      new Uint32Array(pixels).set(scaled);
      frames.push({ pixels, durationMs: frameMs });
      opts.onProgress?.(si, steps.length);
    }
  } finally {
    // The up-walk lands on `start` by construction; this fires only if a
    // command misbehaved mid-walk — best-effort return to the exact cursor.
    if (history.entries().cursor !== start) history.jumpTo(start);
  }

  const last = frames[frames.length - 1];
  if (last) last.durationMs = LAST_FRAME_HOLD_MS;
  return { frames, w: outW * scale, h: outH * scale };
}
