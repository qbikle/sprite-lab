/**
 * ★ FROZEN CONTRACTS — additive changes only, document every addition in
 * docs/ARCHITECTURE.md. Everything here is DOM-free except canvas types used
 * by render-facing interfaces.
 */

import type { SpriteDoc } from './doc';

/* ── pixels ─────────────────────────────────────────────── */

/** Packed 32-bit color, native little-endian ABGR — zero-copy compatible with
 *  `new Uint32Array(imageData.data.buffer)`. 0 = fully transparent. */
export type Rgba = number;

export interface PixelPt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/* ── document ───────────────────────────────────────────── */

export type LayerId = string; // 'l1', 'l2', … stable across reorder
export type FrameId = string; // 'f1', 'f2', … stable across reorder
export type CelKey = `${string}:${string}`; // `${LayerId}:${FrameId}`

export interface Layer {
  id: LayerId;
  name: string;
  opacity: number; // 0..1
  visible: boolean;
}

export interface Frame {
  id: FrameId;
  durationMs: number;
}

export type TagMode = 'loop' | 'pingpong' | 'hold';

export interface Tag {
  name: string;
  from: number; // frame index, inclusive
  to: number;   // frame index, inclusive
  mode: TagMode;
}

export interface Palette {
  name: string;
  colors: Rgba[];
  recent: Rgba[];
}

/** JSON-serializable document data (cels carried separately as buffers). */
export interface DocMeta { name: string }

export const DOC_VERSION = 1;

/* ── dirty tracking ─────────────────────────────────────── */

export type DirtyScope =
  | { kind: 'cels'; cels: ReadonlyArray<{ key: CelKey; rect: Rect }> }
  | { kind: 'frames' }
  | { kind: 'layers' }
  | { kind: 'palette' }
  | { kind: 'all' };

/* ── command pattern ────────────────────────────────────── */

export interface Command {
  /** Human label for the history panel, e.g. "pencil stroke". */
  readonly label: string;
  /** Approximate retained bytes — history evicts oldest past its byte budget. */
  readonly sizeBytes: number;
  readonly dirty: DirtyScope;
  apply(doc: SpriteDoc): void;
  revert(doc: SpriteDoc): void;
}

/* ── tools ──────────────────────────────────────────────── */

export type ToolId =
  | 'pencil'
  | 'eraser'
  | 'eyedropper'
  | 'fill';
// additive in later waves: 'line' | 'rect' | 'ellipse' | 'select-rect' | 'lasso' | 'move'

export interface PointerInfo {
  buttons: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  pressure: number;
  pointerType: 'mouse' | 'pen' | 'touch';
}

/**
 * A tool's entire world. Tools never touch the doc, canvas, or DOM directly.
 * Staged writes preview live (compositor overlays the stage buffer on the
 * active cel); commitStage diffs stage vs cel into one undoable command.
 */
export interface ToolCtx {
  readonly docW: number;
  readonly docH: number;
  readonly color: Rgba;
  readonly brushSize: number; // 1..8, square footprint
  inBounds(p: PixelPt): boolean;

  /** Read a pixel from the active cel (not the composite). */
  getCelPixel(p: PixelPt): Rgba;
  /** Read a pixel from the visible composite (eyedropper). */
  pickColor(p: PixelPt): Rgba;
  setColor(c: Rgba): void;

  /** Stage a replace-write at p (color 0 stages an erase). No-op out of bounds. */
  stage(p: PixelPt, color: Rgba): void;
  clearStage(): void;
  /** Diff stage vs active cel → PixelPatch command → history. Clears stage. */
  commitStage(label: string): void;

  /** Copy of the active cel's full buffer (fill & friends). */
  readCel(): Uint32Array;
  /** Commit a whole-cel replacement as one undoable command. */
  commitPixels(after: Uint32Array, label: string): void;
}

/** Camera surface exposed to overlay drawing (tools + render overlays). */
export interface CameraView {
  readonly zoom: number;
  docToScreen(p: PixelPt): { x: number; y: number };
}

export interface OverlayCtx {
  g: CanvasRenderingContext2D;
  camera: CameraView;
}

/** Live tool preview: mask=1 pixels replace the active cel in the composite
 *  (replace, not paint-over — so staged erases preview correctly). */
export interface StageBuffer {
  color: Uint32Array; // docW × docH
  mask: Uint8Array;   // docW × docH, 0|1
}

/** What the viewport needs from the editor — keeps render/ ignorant of app/. */
export interface ViewportDelegate {
  readonly activeFrame: number;
  readonly activeLayer: number;
  readonly stage: StageBuffer | null;
  readonly brushSize: number;
  onPointer(kind: 'down' | 'move' | 'up' | 'cancel', p: PixelPt, e: PointerInfo): void;
  drawToolOverlay(o: OverlayCtx): void;
}

/* ── events ─────────────────────────────────────────────── */

export type ThemeName = 'dark' | 'light';

export interface EventMap {
  'doc:changed': { scope: DirtyScope };
  'doc:replaced': undefined;
  'history:changed': { canUndo: boolean; canRedo: boolean };
  'tool:changed': { id: ToolId };
  'color:changed': { color: Rgba };
  'brush:changed': { size: number };
  'palette:changed': undefined;
  'frame:active': { index: number };
  'layer:active': { index: number };
  'selection:changed': undefined;
  'playback:changed': { playing: boolean };
  'camera:changed': undefined;
  'cursor:moved': { p: PixelPt | null };
  'theme:changed': { theme: ThemeName };
  'status:message': { text: string };
}

/* ── default keymap (frozen defaults; cheat sheet renders from registry) ── */
// B pencil · E eraser · I eyedropper · G fill · X swap color
// [ / ] brush size · + / - zoom · 0 fit · space-drag / middle-drag pan
// wheel zoom-to-cursor · , grid · T theme · ? cheat sheet · Esc dismiss
// ⌘/⌃Z undo · ⌘/⌃⇧Z or ⌘/⌃Y redo
