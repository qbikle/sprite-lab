/**
 * Main canvas: checker → composite blit (crisp, dpr-aware) → overlays.
 * rAF-on-dirty only. Owns pointer input: space/middle-drag pan, wheel
 * zoom-to-cursor, pinch zoom; forwards drawing pointers to the delegate.
 */
import type { OverlayCtx, PixelPt, PointerInfo, ViewportDelegate } from '../core/contracts';
import type { Bus } from '../core/bus';
import type { Camera } from './camera';
import type { Compositor } from './compositor';
import { Overlays } from './overlays';

export interface ViewportOpts {
  container: HTMLElement;
  bus: Bus;
  camera: Camera;
  compositor: Compositor;
  delegate: ViewportDelegate;
  docW: number;
  docH: number;
}

export class Viewport {
  private readonly container: HTMLElement;
  private readonly bus: Bus;
  private readonly camera: Camera;
  private readonly compositor: Compositor;
  private readonly delegate: ViewportDelegate;
  private docW: number;
  private docH: number;

  private canvas: HTMLCanvasElement | null = null;
  private g: CanvasRenderingContext2D | null = null;
  private readonly overlays = new Overlays();
  private readonly disposers: Array<() => void> = [];
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private dirty = false;
  private grid = false;
  private tiling = false;
  private antPhase = 0;
  private antTimer = 0;
  private hover: PixelPt | null = null;
  private spaceHeld = false;

  private panning = false;
  private panId = -1;
  private lastClientX = 0;
  private lastClientY = 0;

  private drawing = false;
  private drawId = -1;
  private lastDrawPt: PixelPt = { x: 0, y: 0 };

  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinching = false;
  private pinchLast: { dist: number; midX: number; midY: number } | null = null;

  private checker: CanvasPattern | null = null;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private fitted = false;

  constructor(opts: ViewportOpts) {
    this.container = opts.container;
    this.bus = opts.bus;
    this.camera = opts.camera;
    this.compositor = opts.compositor;
    this.delegate = opts.delegate;
    this.docW = opts.docW;
    this.docH = opts.docH;
  }

  /** Create canvas, listeners (all owned), ResizeObserver; camera.fit; first render. */
  mount(): void {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.touchAction = 'none';
    this.container.appendChild(canvas);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('viewport: 2d context unavailable');
    this.canvas = canvas;
    this.g = g;
    this.buildChecker();

    this.listen(canvas, 'pointerdown', (e) => this.onDown(e));
    this.listen(canvas, 'pointermove', (e) => this.onMove(e));
    this.listen(canvas, 'pointerup', (e) => this.onUp(e, false));
    this.listen(canvas, 'pointercancel', (e) => this.onUp(e, true));
    this.listen(canvas, 'lostpointercapture', (e) => this.onUp(e, true));
    this.listen(canvas, 'pointerleave', () => {
      if (this.hover === null) return;
      this.hover = null;
      this.bus.emit('cursor:moved', { p: null });
      this.requestRender();
    });
    this.listen(canvas, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.listen(canvas, 'contextmenu', (e) => e.preventDefault());
    this.listenWin('keydown', (e) => this.onKey(e, true));
    this.listenWin('keyup', (e) => this.onKey(e, false));

    this.disposers.push(this.bus.on('doc:changed', ({ scope }) => {
      this.compositor.invalidate(scope);
      this.requestRender();
    }));
    this.disposers.push(this.bus.on('camera:changed', () => this.requestRender()));
    this.disposers.push(this.bus.on('palette:changed', () => this.requestRender()));
    this.disposers.push(this.bus.on('selection:changed', () => this.requestRender()));
    this.disposers.push(this.bus.on('float:changed', () => this.requestRender()));
    this.disposers.push(this.bus.on('symmetry:changed', () => this.requestRender()));
    this.disposers.push(this.bus.on('onion:changed', () => this.requestRender()));
    this.disposers.push(this.bus.on('frame:active', () => this.requestRender()));
    this.disposers.push(this.bus.on('playback:changed', () => this.requestRender()));
    this.disposers.push(this.bus.on('theme:changed', () => {
      this.buildChecker();
      this.requestRender();
    }));

    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.container);
    this.onResize();
  }

  unmount(): void {
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.antTimer !== 0) {
      clearTimeout(this.antTimer);
      this.antTimer = 0;
    }
    this.ro?.disconnect();
    this.ro = null;
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.canvas?.remove();
    this.canvas = null;
    this.g = null;
  }

  /** Mark dirty; coalesced into one rAF redraw. Subscribed to doc:changed + camera:changed. */
  requestRender(): void {
    this.dirty = true;
    if (this.raf !== 0) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.dirty) return;
      this.dirty = false;
      this.render();
    });
  }

  /** Doc replaced (import): update dims, refit, redraw. */
  setDocSize(w: number, h: number): void {
    this.docW = w;
    this.docH = h;
    if (this.cssW > 0 && this.cssH > 0) this.camera.fit(w, h, this.cssW, this.cssH);
    this.bus.emit('camera:changed');
    this.requestRender();
  }

  toggleGrid(): void {
    this.grid = !this.grid;
    this.requestRender();
  }

  toggleTiling(): void {
    this.tiling = !this.tiling;
    this.bus.emit('tiling:changed', { on: this.tiling });
    this.requestRender();
  }

  /* ── render ─────────────────────────────────────────────── */

  private render(): void {
    const g = this.g;
    if (!g) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, this.cssW, this.cssH);

    const snap = (v: number): number => Math.round(v * this.dpr) / this.dpr;
    const org = this.camera.docToScreen({ x: 0, y: 0 });
    const x0 = snap(org.x);
    const y0 = snap(org.y);
    const w = snap(org.x + this.docW * this.camera.zoom) - x0;
    const h = snap(org.y + this.docH * this.camera.zoom) - y0;

    if (this.checker) {
      g.fillStyle = this.checker;
      g.fillRect(x0, y0, w, h);
    }
    const frame = this.compositor.frameCanvas(
      this.delegate.activeFrame, this.delegate.stage, this.delegate.activeLayer,
      this.delegate.float);
    if (this.tiling) {
      // 3×3 wrap preview: 8 dimmed neighbors (no checker), real doc on top.
      g.globalAlpha = 0.45;
      for (let ty = -1; ty <= 1; ty++) {
        for (let tx = -1; tx <= 1; tx++) {
          if (tx === 0 && ty === 0) continue;
          const nx = snap(org.x + tx * this.docW * this.camera.zoom);
          const ny = snap(org.y + ty * this.docH * this.camera.zoom);
          const nw = snap(org.x + (tx + 1) * this.docW * this.camera.zoom) - nx;
          const nh = snap(org.y + (ty + 1) * this.docH * this.camera.zoom) - ny;
          g.drawImage(frame, nx, ny, nw, nh);
        }
      }
      g.globalAlpha = 1;
    }
    this.drawGhosts(g, x0, y0, w, h);
    g.drawImage(frame, x0, y0, w, h);

    const o: OverlayCtx = { g, camera: this.camera };
    this.overlays.draw(o, {
      docW: this.docW,
      docH: this.docH,
      grid: this.grid,
      hover: this.hover,
      brushSize: this.delegate.brushSize,
      selection: this.delegate.selection,
      float: this.delegate.float,
      symmetry: this.delegate.symmetry,
      antPhase: this.antPhase,
    });
    this.delegate.drawToolOverlay(o);
    this.tickAnts();
  }

  /** Onion ghosts under the composite (center tile only): past red then
   *  future teal, farthest→nearest so near ghosts sit on top. Skipped while
   *  playing. Each ghost canvas is reused — drawn before the next request. */
  private drawGhosts(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    const onion = this.delegate.onion;
    if (!onion.enabled || this.delegate.playing) return;
    const idx = this.delegate.activeFrame;
    for (let d = onion.past; d >= 1; d--) {
      const ghost = this.compositor.ghostCanvas(
        idx - d, 'past', onion.opacity * (1 - (d - 1) / (onion.past + 1)));
      if (ghost) g.drawImage(ghost, x, y, w, h);
    }
    for (let d = onion.future; d >= 1; d--) {
      const ghost = this.compositor.ghostCanvas(
        idx + d, 'future', onion.opacity * (1 - (d - 1) / (onion.future + 1)));
      if (ghost) g.drawImage(ghost, x, y, w, h);
    }
  }

  /** Slow marching-ants ticker: while a selection/float exists, advance the
   *  dash phase (~8fps) and re-render; single timer, cleared on unmount. */
  private tickAnts(): void {
    if (!this.delegate.selection && !this.delegate.float) return;
    if (this.antTimer !== 0) return;
    this.antTimer = window.setTimeout(() => {
      this.antTimer = 0;
      this.antPhase = (this.antPhase + 1) % 8;
      this.requestRender();
    }, 120);
  }

  private buildChecker(): void {
    if (!this.g) return;
    const tile = document.createElement('canvas');
    tile.width = 16;
    tile.height = 16;
    const tg = tile.getContext('2d');
    if (!tg) return;
    const styles = getComputedStyle(document.documentElement);
    const a = styles.getPropertyValue('--checker-a').trim() || '#20213a';
    const b = styles.getPropertyValue('--checker-b').trim() || '#2a2c48';
    tg.fillStyle = a;
    tg.fillRect(0, 0, 16, 16);
    tg.fillStyle = b;
    tg.fillRect(8, 0, 8, 8);
    tg.fillRect(0, 8, 8, 8);
    this.checker = this.g.createPattern(tile, 'repeat');
  }

  private onResize(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.cssW = w;
    this.cssH = h;
    this.dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * this.dpr);
    canvas.height = Math.round(h * this.dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    if (!this.fitted) {
      this.fitted = true;
      this.camera.fit(this.docW, this.docH, w, h);
    }
    this.requestRender();
  }

  /* ── pointer input ──────────────────────────────────────── */

  private onDown(e: PointerEvent): void {
    const canvas = this.canvas;
    if (!canvas) return;
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.touches.size === 2) {
        this.cancelDraw();
        this.pinching = true;
        this.pinchLast = null;
        canvas.setPointerCapture(e.pointerId);
        this.stepPinch();
        return;
      }
      if (this.touches.size > 2 || this.pinching) return;
    }
    if (this.panning || this.drawing) return;
    if (e.button === 1 || this.spaceHeld) {
      e.preventDefault();
      this.panning = true;
      this.panId = e.pointerId;
      this.lastClientX = e.clientX;
      this.lastClientY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    const p = this.camera.pixelAt(e.offsetX, e.offsetY, this.docW, this.docH);
    if (!p) return;
    this.drawing = true;
    this.drawId = e.pointerId;
    this.lastDrawPt = p;
    canvas.setPointerCapture(e.pointerId);
    this.delegate.onPointer('down', p, this.info(e));
    this.requestRender();
  }

  private onMove(e: PointerEvent): void {
    const prev = this.hover;
    this.hover = this.camera.pixelAt(e.offsetX, e.offsetY, this.docW, this.docH);
    this.bus.emit('cursor:moved', { p: this.hover });
    if ((prev === null) !== (this.hover === null) ||
        (prev && this.hover && (prev.x !== this.hover.x || prev.y !== this.hover.y))) {
      this.requestRender();
    }

    if (this.pinching && e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      this.stepPinch();
      return;
    }
    if (this.panning && e.pointerId === this.panId) {
      this.camera.panBy(e.clientX - this.lastClientX, e.clientY - this.lastClientY);
      this.lastClientX = e.clientX;
      this.lastClientY = e.clientY;
      this.bus.emit('camera:changed');
      return;
    }
    if (this.drawing && e.pointerId === this.drawId) {
      const p = this.clampedPixel(e.offsetX, e.offsetY);
      this.lastDrawPt = p;
      this.delegate.onPointer('move', p, this.info(e));
      this.requestRender();
    }
  }

  private onUp(e: PointerEvent, cancel: boolean): void {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.pinching && this.touches.size < 2) {
        this.pinching = false;
        this.pinchLast = null;
      }
    }
    if (this.panning && e.pointerId === this.panId) {
      this.panning = false;
      this.panId = -1;
      if (this.canvas) this.canvas.style.cursor = this.spaceHeld ? 'grab' : '';
      this.release(e.pointerId);
      return;
    }
    if (this.drawing && e.pointerId === this.drawId) {
      this.drawing = false;
      this.drawId = -1;
      const p = cancel ? this.lastDrawPt : this.clampedPixel(e.offsetX, e.offsetY);
      this.delegate.onPointer(cancel ? 'cancel' : 'up', p, this.info(e));
      this.release(e.pointerId);
      this.requestRender();
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey) {
      this.camera.setZoom(this.camera.zoom * Math.exp(-e.deltaY * 0.01), e.offsetX, e.offsetY);
    } else if (e.deltaY !== 0) {
      this.camera.zoomStep(e.deltaY < 0 ? 1 : -1, e.offsetX, e.offsetY);
    } else {
      return;
    }
    this.bus.emit('camera:changed');
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.code !== 'Space') return;
    const t = e.target;
    if (t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
         t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (down) e.preventDefault();
    this.spaceHeld = down;
    if (this.canvas && !this.panning) this.canvas.style.cursor = down ? 'grab' : '';
  }

  private stepPinch(): void {
    const pts = [...this.touches.values()];
    const a = pts[0];
    const b = pts[1];
    if (!a || !b) return;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const last = this.pinchLast;
    if (last) {
      this.camera.setZoom(this.camera.zoom * (dist / last.dist), midX, midY);
      this.camera.panBy(midX - last.midX, midY - last.midY);
      this.bus.emit('camera:changed');
    }
    this.pinchLast = { dist, midX, midY };
  }

  private cancelDraw(): void {
    if (!this.drawing) return;
    const id = this.drawId;
    this.drawing = false;
    this.drawId = -1;
    this.delegate.onPointer('cancel', this.lastDrawPt, {
      buttons: 0, shift: false, alt: false, ctrl: false, meta: false,
      pressure: 0, pointerType: 'touch',
    });
    this.release(id);
    this.requestRender();
  }

  /* ── helpers ────────────────────────────────────────────── */

  private clampedPixel(x: number, y: number): PixelPt {
    const d = this.camera.screenToDocF(x, y);
    return {
      x: Math.min(this.docW - 1, Math.max(0, Math.floor(d.x))),
      y: Math.min(this.docH - 1, Math.max(0, Math.floor(d.y))),
    };
  }

  private info(e: PointerEvent): PointerInfo {
    return {
      buttons: e.buttons,
      shift: e.shiftKey,
      alt: e.altKey,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      pressure: e.pressure,
      pointerType: e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse',
    };
  }

  private release(id: number): void {
    if (this.canvas?.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
  }

  private listen<K extends keyof HTMLElementEventMap>(
    el: HTMLElement, key: K, fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    el.addEventListener(key, fn, opts);
    this.disposers.push(() => el.removeEventListener(key, fn, opts));
  }

  private listenWin<K extends keyof WindowEventMap>(
    key: K, fn: (e: WindowEventMap[K]) => void,
  ): void {
    window.addEventListener(key, fn);
    this.disposers.push(() => window.removeEventListener(key, fn));
  }
}
