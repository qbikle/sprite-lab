/**
 * EditorState — session state (active tool/color/brush/frame/layer), the
 * concrete ToolCtx, the stage buffer, and pointer→tool dispatch. Implements
 * ViewportDelegate so render/ stays ignorant of app/.
 */
import type {
  DitherMode, FloatBuffer, OnionConfig, OverlayCtx, PixelPt, PointerInfo, Rect, Rgba,
  SelectionState, StageBuffer, SymmetryMode, ToolCtx, ToolId, ViewportDelegate,
} from '../core/contracts';
import type { Bus } from '../core/bus';
import type { History } from '../core/history';
import type { SpriteDoc } from '../core/doc';
import { PixelPatch } from '../core/commands/pixel-patch';
import type { SelectionHost } from '../core/commands/selection-ops';
import {
  AnchorFloat, DropFloat, LiftFloat, PasteFloat, SetSelection,
} from '../core/commands/selection-ops';
import { maskAll, tightBounds } from '../core/selection';
import { makeBuffer, packRgba, unpackRgba } from '../core/pixels';
import { BRUSH_MAX, BRUSH_MIN, bayerPass } from '../tools/brush';
import type { Tool } from '../tools/tool';

const RECENT_CAP = 10;

const SYMMETRY_ORDER: readonly SymmetryMode[] = ['off', 'x', 'y', 'quad'];
const DITHER_ORDER: readonly DitherMode[] = ['off', 'bayer2', 'bayer4'];
const DEFAULT_ONION: OnionConfig = { enabled: false, past: 1, future: 1, opacity: 0.35 };

interface ClipboardData { pixels: Uint32Array; w: number; h: number }

export class EditorState implements ViewportDelegate {
  private currentDoc: SpriteDoc;
  private readonly historyRef: History;
  private readonly busRef: Bus;
  private readonly allTools: readonly Tool[];
  private readonly ctx: ToolCtx;
  private readonly host: SelectionHost;

  private activeTool: Tool;
  private currentToolId: ToolId;
  private currentColor: Rgba;
  private prevColor: Rgba;
  private currentBrush = 1;
  private frameIndex = 0;
  private layerIndex = 0;

  private selectionState: SelectionState | null = null;
  private floatState: FloatBuffer | null = null;
  private symmetryMode: SymmetryMode = 'off';
  private ditherMode: DitherMode = 'off';
  private clipboard: ClipboardData | null = null;
  private onionConfig: OnionConfig = { ...DEFAULT_ONION };
  private playingFlag = false;
  private pauseHook: (() => void) | null = null;

  private stageBuf: StageBuffer | null = null;
  private stagedCount = 0;
  private pendingRect: Rect | null = null;
  private strokeTool: Tool | null = null;
  private flattenCache: Uint32Array | null = null;
  private readonly unsubDocChanged: () => void;

  constructor(doc: SpriteDoc, history: History, bus: Bus, tools: readonly Tool[]) {
    this.currentDoc = doc;
    this.historyRef = history;
    this.busRef = bus;
    this.allTools = tools;

    const initial = tools.find((t) => t.id === 'pencil') ?? tools[0];
    if (!initial) throw new Error('EditorState requires at least one tool');
    this.activeTool = initial;
    this.currentToolId = initial.id;

    this.currentColor = EditorState.initialColor(doc);
    this.prevColor = this.currentColor;

    // Structural undo/redo can strand active indices past the end — clamp,
    // emitting the active events only when the value actually moved.
    this.unsubDocChanged = bus.on('doc:changed', ({ scope }) => {
      this.flattenCache = null;
      if (scope.kind === 'frames' || scope.kind === 'all') {
        const max = Math.max(0, this.currentDoc.frames.length - 1);
        if (this.frameIndex > max) {
          this.frameIndex = max;
          this.busRef.emit('frame:active', { index: max });
        }
      }
      if (scope.kind === 'layers' || scope.kind === 'all') {
        const max = Math.max(0, this.currentDoc.layers.length - 1);
        if (this.layerIndex > max) {
          this.layerIndex = max;
          this.busRef.emit('layer:active', { index: max });
        }
      }
      if (scope.kind === 'all') {
        // Canvas dims can change under us (ResizeCanvas, incl. its undo/redo).
        // Doc-sized session buffers keyed to the old dims would index with new-
        // width math and commit scrambled pixels — drop them. Length checks
        // make this fire only on genuine dims changes. A float's lifted pixels
        // stay recoverable through the lift command in history.
        const size = this.currentDoc.width * this.currentDoc.height;
        if (this.stageBuf !== null && this.stageBuf.color.length !== size) {
          this.stageBuf = null;
          this.stagedCount = 0;
          this.pendingRect = null;
        }
        const sel = this.selectionState;
        if (sel !== null && sel.mask.length !== size) {
          if (this.floatState !== null) this.host.float = null;
          this.host.selection = null;
        } else if (this.floatState !== null) {
          const r = this.floatState.rect;
          if (r.x + r.w > this.currentDoc.width || r.y + r.h > this.currentDoc.height) {
            this.host.float = null;
          }
        }
      }
    });

    const self = this;
    // Command-facing session state: every mutation emits its bus event.
    this.host = {
      get selection() { return self.selectionState; },
      set selection(v: SelectionState | null) {
        self.selectionState = v;
        self.busRef.emit('selection:changed');
      },
      get float() { return self.floatState; },
      set float(v: FloatBuffer | null) {
        self.floatState = v;
        self.busRef.emit('float:changed');
      },
    };
    this.ctx = {
      get docW() { return self.currentDoc.width; },
      get docH() { return self.currentDoc.height; },
      get color() { return self.currentColor; },
      get brushSize() { return self.currentBrush; },
      inBounds: (p: PixelPt) => self.inBounds(p),
      symmetrySeeds: (p: PixelPt) => self.expandSymmetry(p),
      getCelPixel: (p: PixelPt) => self.getCelPixel(p),
      pickColor: (p: PixelPt) => self.pickColor(p),
      setColor: (c: Rgba) => self.setColor(c),
      stage: (p: PixelPt, color: Rgba) => self.stagePixel(p, color),
      clearStage: () => self.clearStage(),
      commitStage: (label: string) => self.commitStage(label),
      readCel: () => self.readCel(),
      commitPixels: (after: Uint32Array, label: string) => self.commitPixels(after, label),
      get selection() { return self.selectionState; },
      setSelection: (mask, label) => self.applySelection(mask, label),
      get float() { return self.floatState; },
      liftSelection: () => self.liftSelection(),
      dragFloat: (dx, dy) => self.dragFloat(dx, dy),
      anchorFloat: () => self.anchorFloat(),
    };
  }

  private static initialColor(doc: SpriteDoc): Rgba {
    for (const c of doc.palette.colors) {
      if (unpackRgba(c)[3] !== 0) return c;
    }
    return packRgba(0, 0, 0, 255);
  }

  get doc(): SpriteDoc { return this.currentDoc; }
  get tools(): readonly Tool[] { return this.allTools; }
  get activeToolId(): ToolId { return this.currentToolId; }
  get color(): Rgba { return this.currentColor; }
  get brushSize(): number { return this.currentBrush; }
  get dither(): DitherMode { return this.ditherMode; }

  /* ViewportDelegate */
  get activeFrame(): number { return this.frameIndex; }
  get activeLayer(): number { return this.layerIndex; }
  get stage(): StageBuffer | null {
    return this.stagedCount > 0 ? this.stageBuf : null;
  }
  get float(): FloatBuffer | null { return this.floatState; }
  get selection(): SelectionState | null { return this.selectionState; }
  get hasClipboard(): boolean { return this.clipboard !== null; }
  get symmetry(): SymmetryMode { return this.symmetryMode; }
  get onion(): OnionConfig { return this.onionConfig; }
  setOnion(config: OnionConfig): void {
    this.onionConfig = config;
    this.busRef.emit('onion:changed', { config });
  }
  get playing(): boolean { return this.playingFlag; }
  /** Mirror playback state from the Player — the sole 'playback:changed' emitter. */
  syncPlaying(on: boolean): void {
    this.playingFlag = on;
  }
  /** App injects player.pause; drawing while playing pauses first. */
  setPauseHook(cb: () => void): void {
    this.pauseHook = cb;
  }

  /** Switch active frame: anchor a live float, cancel a live stroke, then move. */
  setActiveFrame(index: number): void {
    const max = this.currentDoc.frames.length - 1;
    const next = Math.max(0, Math.min(max, index));
    if (next === this.frameIndex) return;
    if (this.floatState) this.anchorFloat();
    this.cancelStroke();
    this.frameIndex = next;
    this.flattenCache = null;
    this.busRef.emit('frame:active', { index: next });
  }

  setActiveLayer(index: number): void {
    const max = this.currentDoc.layers.length - 1;
    const next = Math.max(0, Math.min(max, index));
    if (next === this.layerIndex) return;
    if (this.floatState) this.anchorFloat();
    this.cancelStroke();
    this.layerIndex = next;
    this.busRef.emit('layer:active', { index: next });
  }

  /** Route to active tool with the concrete ToolCtx. 'cancel' → tool.onCancel + clear stage. */
  onPointer(kind: 'down' | 'move' | 'up' | 'cancel', p: PixelPt, e: PointerInfo): void {
    const tool = this.strokeTool ?? this.activeTool;
    switch (kind) {
      case 'down':
        if (this.playingFlag) this.pauseHook?.();
        if (this.floatState && this.activeTool.id !== 'move') this.anchorFloat();
        this.strokeTool = this.activeTool;
        this.activeTool.onDown(this.ctx, p, e);
        break;
      case 'move':
        tool.onMove(this.ctx, p, e);
        break;
      case 'up':
        tool.onUp(this.ctx, p, e);
        this.strokeTool = null;
        break;
      case 'cancel':
        tool.onCancel(this.ctx);
        this.strokeTool = null;
        this.clearStage();
        break;
    }
    this.flushPending();
  }

  drawToolOverlay(o: OverlayCtx): void {
    (this.strokeTool ?? this.activeTool).drawOverlay(o);
  }

  private cancelStroke(): void {
    if (!this.strokeTool) return;
    this.strokeTool.onCancel(this.ctx);
    this.strokeTool = null;
    this.clearStage();
    this.flushPending();
  }

  setTool(id: ToolId): void {
    if (id === this.currentToolId) return;
    const next = this.allTools.find((t) => t.id === id);
    if (!next) return;
    this.cancelStroke();
    if (this.currentToolId === 'move' && this.floatState) this.anchorFloat();
    this.activeTool = next;
    this.currentToolId = id;
    this.busRef.emit('tool:changed', { id });
  }

  /** Remembers previous color for X-swap; pushes into palette.recent. */
  setColor(c: Rgba): void {
    if (c === this.currentColor) return;
    this.prevColor = this.currentColor;
    this.currentColor = c;
    // recent is ephemeral UX state, NOT undoable by design — direct mutation is fine
    const recent = this.currentDoc.palette.recent;
    const at = recent.indexOf(c);
    if (at !== -1) recent.splice(at, 1);
    recent.unshift(c);
    if (recent.length > RECENT_CAP) recent.length = RECENT_CAP;
    this.busRef.emit('color:changed', { color: c });
    this.busRef.emit('palette:changed');
  }

  swapColors(): void {
    const held = this.currentColor;
    this.currentColor = this.prevColor;
    this.prevColor = held;
    this.busRef.emit('color:changed', { color: this.currentColor });
  }

  setBrush(size: number): void {
    const clamped = Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, Math.round(size)));
    if (clamped === this.currentBrush) return;
    this.currentBrush = clamped;
    this.busRef.emit('brush:changed', { size: clamped });
  }

  setSymmetry(mode: SymmetryMode): void {
    if (mode === this.symmetryMode) return;
    this.symmetryMode = mode;
    this.busRef.emit('symmetry:changed', { mode });
  }

  cycleSymmetry(): void {
    const at = SYMMETRY_ORDER.indexOf(this.symmetryMode);
    this.setSymmetry(SYMMETRY_ORDER[(at + 1) % SYMMETRY_ORDER.length] ?? 'off');
  }

  setDither(mode: DitherMode): void {
    if (mode === this.ditherMode) return;
    this.ditherMode = mode;
    this.busRef.emit('dither:changed', { mode });
  }

  cycleDither(): void {
    const at = DITHER_ORDER.indexOf(this.ditherMode);
    this.setDither(DITHER_ORDER[(at + 1) % DITHER_ORDER.length] ?? 'off');
  }

  selectAll(): void {
    const all = maskAll(this.currentDoc.width, this.currentDoc.height);
    this.historyRef.commit(new SetSelection(this.host, all, 'select all'));
  }

  deselect(): void {
    if (!this.selectionState) return;
    this.historyRef.commit(new SetSelection(this.host, null, 'deselect'));
  }

  /** Esc chain: anchor a live float, else drop the selection. False = unhandled. */
  cancelOrDismiss(): boolean {
    if (this.floatState) {
      this.anchorFloat();
      return true;
    }
    if (this.selectionState) {
      this.deselect();
      return true;
    }
    return false;
  }

  copySelection(): void {
    const data = this.copyData();
    if (!data) return;
    this.clipboard = data;
    this.writeClipboardPng(data);
  }

  /** Copy, then drop the float (already lifted off the cel) or zero the masked pixels. */
  cutSelection(): void {
    const data = this.copyData();
    if (!data) return;
    this.clipboard = data;
    this.writeClipboardPng(data);
    if (this.floatState) {
      this.historyRef.commit(new DropFloat(this.host));
      return;
    }
    const sel = this.selectionState;
    if (!sel) return;
    const key = this.activeCelKey();
    const before = this.currentDoc.ensureCel(key).slice();
    const after = before.slice();
    for (let i = 0; i < after.length; i++) {
      if (sel.mask[i] === 1) after[i] = 0;
    }
    const patch = PixelPatch.fromBuffers(
      key, this.currentDoc.width, this.currentDoc.height, before, after, 'cut',
    );
    if (patch) this.historyRef.commit(patch);
  }

  /** Clipboard → centered float (anchoring any live float first) + move tool. */
  paste(): void {
    const clip = this.clipboard;
    if (!clip) return;
    if (this.floatState) this.anchorFloat();
    const docW = this.currentDoc.width;
    const docH = this.currentDoc.height;
    const x = Math.min(docW - 1, Math.max(1 - clip.w, Math.round((docW - clip.w) / 2)));
    const y = Math.min(docH - 1, Math.max(1 - clip.h, Math.round((docH - clip.h) / 2)));
    this.historyRef.commit(
      new PasteFloat(this.host, clip.pixels.slice(), clip.w, clip.h, { x, y }),
    );
    this.setTool('move');
  }

  /** Import/restore: swap doc, reset history + stage + wave-2 state, emit doc:replaced. */
  replaceDoc(doc: SpriteDoc): void {
    if (this.strokeTool) {
      this.strokeTool.onCancel(this.ctx);
      this.strokeTool = null;
    }
    this.stageBuf = null;
    this.stagedCount = 0;
    this.pendingRect = null;
    this.flattenCache = null;
    this.selectionState = null;
    this.floatState = null;
    this.symmetryMode = 'off';
    this.ditherMode = 'off';
    this.onionConfig = { ...DEFAULT_ONION };
    // App pauses the Player before adopting a doc — it owns the
    // 'playback:changed' emission; here we only mirror the reset.
    this.playingFlag = false;
    this.currentDoc = doc;
    this.historyRef.replaceDoc(doc);
    this.frameIndex = 0;
    this.layerIndex = 0;
    this.currentColor = EditorState.initialColor(doc);
    this.prevColor = this.currentColor;
    this.busRef.emit('doc:replaced');
    this.busRef.emit('color:changed', { color: this.currentColor });
    this.busRef.emit('selection:changed');
    this.busRef.emit('float:changed');
    this.busRef.emit('symmetry:changed', { mode: 'off' });
    this.busRef.emit('dither:changed', { mode: 'off' });
    this.busRef.emit('frame:active', { index: 0 });
    this.busRef.emit('layer:active', { index: 0 });
    this.busRef.emit('onion:changed', { config: this.onionConfig });
  }

  dispose(): void {
    this.unsubDocChanged();
  }

  /* ── ToolCtx internals ─────────────────────────────────── */

  private inBounds(p: PixelPt): boolean {
    return p.x >= 0 && p.y >= 0 && p.x < this.currentDoc.width && p.y < this.currentDoc.height;
  }

  private activeCelKey() {
    return this.currentDoc.celKeyAt(this.layerIndex, this.frameIndex);
  }

  private getCelPixel(p: PixelPt): Rgba {
    if (!this.inBounds(p)) return 0;
    const cel = this.currentDoc.getCel(this.activeCelKey());
    if (!cel) return 0;
    return cel[p.y * this.currentDoc.width + p.x] ?? 0;
  }

  private pickColor(p: PixelPt): Rgba {
    if (!this.inBounds(p)) return 0;
    if (!this.flattenCache) this.flattenCache = this.currentDoc.flattenFrame(this.frameIndex);
    return this.flattenCache[p.y * this.currentDoc.width + p.x] ?? 0;
  }

  private ensureStageBuf(): StageBuffer {
    if (!this.stageBuf) {
      this.stageBuf = {
        color: makeBuffer(this.currentDoc.width, this.currentDoc.height),
        mask: new Uint8Array(this.currentDoc.width * this.currentDoc.height),
      };
    }
    return this.stageBuf;
  }

  /** p → 1/2/4 mirrored points about the doc center, deduped when on-axis. */
  private expandSymmetry(p: PixelPt): PixelPt[] {
    const mode = this.symmetryMode;
    if (mode === 'off') return [p];
    const mx = this.currentDoc.width - 1 - p.x;
    const my = this.currentDoc.height - 1 - p.y;
    const pts: PixelPt[] = [p];
    const push = (x: number, y: number): void => {
      if (!pts.some((q) => q.x === x && q.y === y)) pts.push({ x, y });
    };
    if (mode === 'x' || mode === 'quad') push(mx, p.y);
    if (mode === 'y' || mode === 'quad') push(p.x, my);
    if (mode === 'quad') push(mx, my);
    return pts;
  }

  /** Symmetry-expand, then per point: bounds → selection clip → dither gate → write.
   *  Erases (color 0) skip the dither gate — the eraser stays solid, deliberately. */
  private stagePixel(p: PixelPt, color: Rgba): void {
    const w = this.currentDoc.width;
    const sel = this.selectionState;
    const dm = this.ditherMode;
    for (const q of this.expandSymmetry(p)) {
      if (!this.inBounds(q)) continue;
      const i = q.y * w + q.x;
      if (sel && sel.mask[i] !== 1) continue;
      if (dm !== 'off' && color !== 0 && !bayerPass(dm, q.x, q.y)) continue;
      const buf = this.ensureStageBuf();
      if (buf.mask[i] !== 1) {
        buf.mask[i] = 1;
        this.stagedCount++;
      }
      buf.color[i] = color;
      this.growPending(q.x, q.y);
    }
  }

  private growPending(x: number, y: number): void {
    const r = this.pendingRect;
    if (!r) {
      this.pendingRect = { x, y, w: 1, h: 1 };
      return;
    }
    const x0 = Math.min(r.x, x);
    const y0 = Math.min(r.y, y);
    const x1 = Math.max(r.x + r.w, x + 1);
    const y1 = Math.max(r.y + r.h, y + 1);
    this.pendingRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** One coalesced invalidation per onPointer call — never per staged pixel. */
  private flushPending(): void {
    const rect = this.pendingRect;
    if (!rect) return;
    this.pendingRect = null;
    this.busRef.emit('doc:changed', {
      scope: { kind: 'cels', cels: [{ key: this.activeCelKey(), rect }] },
    });
  }

  private clearStage(): void {
    const buf = this.stageBuf;
    if (!buf || this.stagedCount === 0) return;
    buf.mask.fill(0);
    this.stagedCount = 0;
    this.pendingRect = null;
    this.busRef.emit('doc:changed', {
      scope: {
        kind: 'cels',
        cels: [{
          key: this.activeCelKey(),
          rect: { x: 0, y: 0, w: this.currentDoc.width, h: this.currentDoc.height },
        }],
      },
    });
  }

  private commitStage(label: string): void {
    const buf = this.stageBuf;
    if (!buf || this.stagedCount === 0) return;
    const key = this.activeCelKey();
    const before = this.currentDoc.ensureCel(key).slice();
    const after = before.slice();
    for (let i = 0; i < after.length; i++) {
      if (buf.mask[i] === 1) after[i] = buf.color[i] ?? 0;
    }
    const patch = PixelPatch.fromBuffers(
      key, this.currentDoc.width, this.currentDoc.height, before, after, label,
    );
    if (patch) this.historyRef.commit(patch);
    buf.mask.fill(0);
    this.stagedCount = 0;
    this.pendingRect = null;
  }

  private readCel(): Uint32Array {
    return this.currentDoc.ensureCel(this.activeCelKey()).slice();
  }

  /** Whole-cel replacement; with a selection, unmasked pixels revert to before. */
  private commitPixels(after: Uint32Array, label: string): void {
    const key = this.activeCelKey();
    const before = this.currentDoc.ensureCel(key).slice();
    let merged = after;
    const sel = this.selectionState;
    if (sel) {
      merged = after.slice();
      for (let i = 0; i < merged.length; i++) {
        if (sel.mask[i] !== 1) merged[i] = before[i] ?? 0;
      }
    }
    const patch = PixelPatch.fromBuffers(
      key, this.currentDoc.width, this.currentDoc.height, before, merged, label,
    );
    if (patch) this.historyRef.commit(patch);
  }

  /* ── selection & float internals ───────────────────────── */

  private applySelection(mask: Uint8Array | null, label: string): void {
    let next: SelectionState | null = null;
    if (mask) {
      const bounds = tightBounds(mask, this.currentDoc.width, this.currentDoc.height);
      if (bounds) next = { mask, bounds };
    }
    if (!next && !this.selectionState) return;
    this.historyRef.commit(new SetSelection(this.host, next, label));
  }

  private liftSelection(): void {
    if (!this.selectionState || this.floatState) return;
    this.historyRef.commit(new LiftFloat(
      this.host, this.activeCelKey(), this.currentDoc.width, this.currentDoc.height,
    ));
  }

  /** Move the float; clamped so at least one pixel stays over the doc. No command. */
  private dragFloat(dx: number, dy: number): void {
    const f = this.floatState;
    if (!f) return;
    const nx = Math.min(this.currentDoc.width - 1, Math.max(1 - f.rect.w, f.rect.x + dx));
    const ny = Math.min(this.currentDoc.height - 1, Math.max(1 - f.rect.h, f.rect.y + dy));
    if (nx === f.rect.x && ny === f.rect.y) return;
    f.rect.x = nx;
    f.rect.y = ny;
    this.busRef.emit('float:changed');
  }

  private anchorFloat(): void {
    if (!this.floatState) return;
    this.historyRef.commit(new AnchorFloat(
      this.host, this.activeCelKey(), this.currentDoc.width, this.currentDoc.height,
    ));
  }

  private copyData(): ClipboardData | null {
    const f = this.floatState;
    if (f) return { pixels: f.pixels.slice(), w: f.rect.w, h: f.rect.h };
    const sel = this.selectionState;
    if (!sel) return null;
    const { x, y, w, h } = sel.bounds;
    const docW = this.currentDoc.width;
    const cel = this.currentDoc.getCel(this.activeCelKey());
    const out = new Uint32Array(w * h);
    if (cel) {
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const di = (y + yy) * docW + (x + xx);
          if (sel.mask[di] === 1) out[yy * w + xx] = cel[di] ?? 0;
        }
      }
    }
    return { pixels: out, w, h };
  }

  /** Best-effort OS clipboard mirror — failures are silently ignored. */
  private writeClipboardPng(data: ClipboardData): void {
    try {
      const bytes = new Uint8ClampedArray(data.pixels.slice().buffer);
      const image = new ImageData(bytes, data.w, data.h);
      const canvas = document.createElement('canvas');
      canvas.width = data.w;
      canvas.height = data.h;
      const g = canvas.getContext('2d');
      if (!g) return;
      g.putImageData(image, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) return;
        try {
          void navigator.clipboard
            .write([new ClipboardItem({ 'image/png': blob })])
            .catch(() => undefined);
        } catch {
          /* clipboard unavailable */
        }
      });
    } catch {
      /* clipboard unavailable */
    }
  }
}
