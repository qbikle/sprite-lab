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
  | { kind: 'selection' } // no pixels changed — overlays only
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
  | 'fill'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'select-rect'
  | 'lasso'
  | 'move';

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

  /* Wave 2 — selection & float (tools stay ignorant of symmetry/dither:
     stage() expands mirrors and gates dither internally). */
  readonly selection: SelectionState | null;
  /** Replace the selection (null = deselect). Undoable command. */
  setSelection(mask: Uint8Array | null, label: string): void;
  readonly float: FloatBuffer | null;
  /** Lift current selection's pixels into the float (cut from cel). Undoable. */
  liftSelection(): void;
  /** Move the float (no command — anchoring records the whole gesture). */
  dragFloat(dx: number, dy: number): void;
  /** Merge the float into the cel at its current rect. Undoable. */
  anchorFloat(): void;

  /** Read a pixel from the active cel (not the composite). */
  getCelPixel(p: PixelPt): Rgba;
  /** Read a pixel from the visible composite (eyedropper). */
  pickColor(p: PixelPt): Rgba;
  setColor(c: Rgba): void;

  /** p expanded through the active symmetry (1/2/4 points, deduped) — for
   *  seed-based tools like fill; stroke tools get this inside stage(). */
  symmetrySeeds(p: PixelPt): readonly PixelPt[];

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

/* ── Wave 2 additions (documented in ARCHITECTURE contract addenda) ── */

/** Pixel-mask selection. Absent selection = everything editable. */
export interface SelectionState {
  mask: Uint8Array; // docW × docH, 0|1
  bounds: Rect;     // tight bounding box of set bits
}

/** Pixels lifted off the cel by the move tool / paste, following the pointer. */
export interface FloatBuffer {
  pixels: Uint32Array; // rect.w × rect.h
  rect: Rect;          // current position in doc space
}

export type SymmetryMode = 'off' | 'x' | 'y' | 'quad';
export type DitherMode = 'off' | 'bayer2' | 'bayer4';

/* ── Wave 3 additions ── */

/** Onion skin: ghost composites of neighbor frames under the active one. */
export interface OnionConfig {
  enabled: boolean;
  past: number;      // frames behind (tinted --danger-ish red)
  future: number;    // frames ahead (tinted teal)
  opacity: number;   // 0..1 ghost strength
}

/** What the viewport needs from the editor — keeps render/ ignorant of app/. */
export interface ViewportDelegate {
  readonly activeFrame: number;
  readonly activeLayer: number;
  readonly stage: StageBuffer | null;
  readonly brushSize: number;
  /** Wave 2: floating pixels (move/paste), drawn over the composite. */
  readonly float: FloatBuffer | null;
  /** Wave 2: active selection, for marching ants. */
  readonly selection: SelectionState | null;
  /** Wave 2: mirror axes overlay. */
  readonly symmetry: SymmetryMode;
  /** Wave 3: onion skin config (ghosts drawn when enabled && !playing). */
  readonly onion: OnionConfig;
  /** Wave 3: suppress onion + ants while animating. */
  readonly playing: boolean;
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
  'float:changed': undefined;
  'symmetry:changed': { mode: SymmetryMode };
  'dither:changed': { mode: DitherMode };
  'tiling:changed': { on: boolean };
  'playback:changed': { playing: boolean };
  'onion:changed': { config: OnionConfig };
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
// Wave 2: L line · R rect · O ellipse (⇧ = square/circle, ⌥ = filled)
// M select-rect · Q lasso · V move · ⌘A select all · ⌘D deselect
// ⌘C/⌘X/⌘V copy/cut/paste · S symmetry cycle · D dither cycle · . tiling preview
// Esc: anchor float → clear selection → close overlays
// Wave 3: ← / → prev/next frame · Enter play/pause · N new frame · ⇧N duplicate frame
// K onion toggle · PgUp/PgDn active layer up/down
