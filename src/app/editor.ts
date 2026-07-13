/**
 * EditorState — session state (active tool/color/brush/frame/layer), the
 * concrete ToolCtx, the stage buffer, and pointer→tool dispatch. Implements
 * ViewportDelegate so render/ stays ignorant of app/.
 */
import type {
  OverlayCtx, PixelPt, PointerInfo, Rect, Rgba, StageBuffer, ToolCtx, ToolId, ViewportDelegate,
} from '../core/contracts';
import type { Bus } from '../core/bus';
import type { History } from '../core/history';
import type { SpriteDoc } from '../core/doc';
import { PixelPatch } from '../core/commands/pixel-patch';
import { makeBuffer, packRgba, unpackRgba } from '../core/pixels';
import { BRUSH_MAX, BRUSH_MIN } from '../tools/brush';
import type { Tool } from '../tools/tool';

const RECENT_CAP = 10;

export class EditorState implements ViewportDelegate {
  private currentDoc: SpriteDoc;
  private readonly historyRef: History;
  private readonly busRef: Bus;
  private readonly allTools: readonly Tool[];
  private readonly ctx: ToolCtx;

  private activeTool: Tool;
  private currentToolId: ToolId;
  private currentColor: Rgba;
  private prevColor: Rgba;
  private currentBrush = 1;
  private frameIndex = 0;
  private layerIndex = 0;

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

    this.unsubDocChanged = bus.on('doc:changed', () => {
      this.flattenCache = null;
    });

    const self = this;
    this.ctx = {
      get docW() { return self.currentDoc.width; },
      get docH() { return self.currentDoc.height; },
      get color() { return self.currentColor; },
      get brushSize() { return self.currentBrush; },
      inBounds: (p: PixelPt) => self.inBounds(p),
      getCelPixel: (p: PixelPt) => self.getCelPixel(p),
      pickColor: (p: PixelPt) => self.pickColor(p),
      setColor: (c: Rgba) => self.setColor(c),
      stage: (p: PixelPt, color: Rgba) => self.stagePixel(p, color),
      clearStage: () => self.clearStage(),
      commitStage: (label: string) => self.commitStage(label),
      readCel: () => self.readCel(),
      commitPixels: (after: Uint32Array, label: string) => self.commitPixels(after, label),
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

  /* ViewportDelegate */
  get activeFrame(): number { return this.frameIndex; }
  get activeLayer(): number { return this.layerIndex; }
  get stage(): StageBuffer | null {
    return this.stagedCount > 0 ? this.stageBuf : null;
  }

  /** Route to active tool with the concrete ToolCtx. 'cancel' → tool.onCancel + clear stage. */
  onPointer(kind: 'down' | 'move' | 'up' | 'cancel', p: PixelPt, e: PointerInfo): void {
    const tool = this.strokeTool ?? this.activeTool;
    switch (kind) {
      case 'down':
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

  setTool(id: ToolId): void {
    if (id === this.currentToolId) return;
    const next = this.allTools.find((t) => t.id === id);
    if (!next) return;
    if (this.strokeTool) {
      this.strokeTool.onCancel(this.ctx);
      this.strokeTool = null;
      this.clearStage();
      this.flushPending();
    }
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

  /** Import/restore: swap doc, reset history + stage, emit doc:replaced. */
  replaceDoc(doc: SpriteDoc): void {
    if (this.strokeTool) {
      this.strokeTool.onCancel(this.ctx);
      this.strokeTool = null;
    }
    this.stageBuf = null;
    this.stagedCount = 0;
    this.pendingRect = null;
    this.flattenCache = null;
    this.currentDoc = doc;
    this.historyRef.replaceDoc(doc);
    this.frameIndex = 0;
    this.layerIndex = 0;
    this.currentColor = EditorState.initialColor(doc);
    this.prevColor = this.currentColor;
    this.busRef.emit('doc:replaced');
    this.busRef.emit('color:changed', { color: this.currentColor });
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

  private stagePixel(p: PixelPt, color: Rgba): void {
    if (!this.inBounds(p)) return;
    const buf = this.ensureStageBuf();
    const i = p.y * this.currentDoc.width + p.x;
    if (buf.mask[i] !== 1) {
      buf.mask[i] = 1;
      this.stagedCount++;
    }
    buf.color[i] = color;
    this.growPending(p.x, p.y);
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

  private commitPixels(after: Uint32Array, label: string): void {
    const key = this.activeCelKey();
    const before = this.currentDoc.ensureCel(key).slice();
    const patch = PixelPatch.fromBuffers(
      key, this.currentDoc.width, this.currentDoc.height, before, after, label,
    );
    if (patch) this.historyRef.commit(patch);
  }
}
