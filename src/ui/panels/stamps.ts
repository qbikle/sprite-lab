/** Side rail: custom stamps — capture the selection as a stamp, pick one to
 *  paint with (click = use, alt-click = remove). Max 8 tiles, persisted. */
import type { Bus } from '../../core/bus';
import {
  STAMP_MAX_SIDE, STAMPS_MAX, activeStamp, addStamp, onStampsChanged,
  removeStamp, setActiveStamp, stamps, type Stamp, type StampSource,
} from '../../app/stamps';

export interface StampsPanelOpts {
  host: HTMLElement;
  bus: Bus;
  /** Same source the clipboard copy uses: live float, else masked selection. */
  getSelectionPixels(): StampSource | null;
  /** Called after a tile click sets the active stamp — app switches to the stamp tool. */
  onUseStamp(): void;
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

export class StampsPanel {
  private readonly opts: StampsPanelOpts;
  private readonly unsubs: Array<() => void> = [];
  private rootEl: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;
  private captureBtn: HTMLButtonElement | null = null;

  constructor(opts: StampsPanelOpts) {
    this.opts = opts;
  }

  mount(): void {
    const o = this.opts;
    const root = div('sl-stamps');
    const head = div('sl-panel-head');
    head.textContent = 'stamps';

    const capture = document.createElement('button');
    capture.type = 'button';
    capture.className = 'sl-stamps-capture';
    capture.textContent = 'from selection';
    capture.title = `save the selection as a stamp (max ${STAMP_MAX_SIDE}×${STAMP_MAX_SIDE})`;
    capture.addEventListener('click', () => this.capture());

    const grid = div('sl-stamps-grid');
    root.append(head, capture, grid);
    o.host.appendChild(root);
    this.rootEl = root;
    this.gridEl = grid;
    this.captureBtn = capture;

    this.unsubs.push(
      o.bus.on('selection:changed', () => this.syncCapture()),
      o.bus.on('float:changed', () => this.syncCapture()),
      o.bus.on('doc:replaced', () => this.syncCapture()),
      onStampsChanged(() => this.refresh()),
    );
    this.syncCapture();
    this.refresh();
  }

  unmount(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.rootEl?.remove();
    this.rootEl = null;
    this.gridEl = null;
    this.captureBtn = null;
  }

  private capture(): void {
    const src = this.opts.getSelectionPixels();
    if (!src) return;
    const status = (text: string): void => this.opts.bus.emit('status:message', { text });
    if (src.w > STAMP_MAX_SIDE || src.h > STAMP_MAX_SIDE) {
      status(`stamp too big — max ${STAMP_MAX_SIDE}×${STAMP_MAX_SIDE}`);
      return;
    }
    if (!src.pixels.some((v) => v !== 0)) {
      status('selection is empty — nothing to stamp');
      return;
    }
    if (stamps().length >= STAMPS_MAX) {
      status(`stamp shelf is full (${STAMPS_MAX}) — alt-click a tile to remove one`);
      return;
    }
    const made = addStamp(src.w, src.h, src.pixels);
    if (made) status(`stamp saved (${made.w}×${made.h}) — press A to paint`);
  }

  private syncCapture(): void {
    if (this.captureBtn) this.captureBtn.disabled = this.opts.getSelectionPixels() === null;
  }

  private refresh(): void {
    const grid = this.gridEl;
    if (!grid) return;
    grid.replaceChildren();
    const active = activeStamp();
    for (const stamp of stamps()) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'sl-stamp-tile';
      tile.title = `${stamp.w}×${stamp.h} — click to stamp, alt-click to remove`;
      const on = active !== null && active.id === stamp.id;
      tile.classList.toggle('active', on);
      tile.setAttribute('aria-pressed', String(on));
      tile.appendChild(this.thumb(stamp));
      tile.addEventListener('click', (e) => {
        if (e.altKey) {
          removeStamp(stamp.id);
          return;
        }
        setActiveStamp(stamp.id);
        this.opts.onUseStamp();
        this.refresh(); // active highlight even when the id didn't change
      });
      grid.appendChild(tile);
    }
  }

  private thumb(stamp: Stamp): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = stamp.w;
    canvas.height = stamp.h;
    canvas.className = 'sl-stamp-thumb';
    const g = canvas.getContext('2d');
    if (g) {
      const img = g.createImageData(stamp.w, stamp.h);
      img.data.set(new Uint8ClampedArray(
        stamp.pixels.buffer, stamp.pixels.byteOffset, stamp.pixels.length * 4,
      ));
      g.putImageData(img, 0, 0);
    }
    return canvas;
  }
}
