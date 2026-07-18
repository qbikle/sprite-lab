/** Sheet import dialog — the labeler: grid slice preview, rows → named tags. */
import type { Bus } from '../../core/bus';
import type { Frame, Rgba } from '../../core/contracts';
import { SpriteDoc } from '../../core/doc';
import { makeBuffer } from '../../core/pixels';
import { guessFrameSize, sliceGrid, type SheetSlice } from '../../io/slicer';

export interface ImporterOpts {
  bus: Bus;
  /** Called with the built doc (frames from slices, tags from row names). */
  adopt(doc: SpriteDoc): void;
}

interface RowEntry {
  row: number;
  slices: SheetSlice[];
  name: string;
  fps: number;
  include: boolean;
}

const STRIP_CELLS = 6;
const DEFAULT_FPS = 8;
/** Floor for the frame w/h inputs — typing "16" passes through "1", and a
 *  1px grid over a big sheet means ~1M slice objects. */
const MIN_FRAME = 4;
const MAX_FRAME = 512;
const RESLICE_DEBOUNCE_MS = 200;

function extractPalette(pixels: Uint32Array): Rgba[] {
  const counts = new Map<Rgba, number>();
  for (let i = 0; i < pixels.length; i++) {
    const c = pixels[i] ?? 0;
    if (((c >>> 24) & 0xff) !== 255) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((p, q) => q[1] - p[1])
    .slice(0, 64)
    .map((e) => e[0]);
}

function tokenColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === '' ? fallback : v;
}

function numberInput(className: string, value: number, min: number, max: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = className;
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  return input;
}

export class SheetImporter {
  private readonly opts: ImporterOpts;

  private overlay: HTMLElement | null = null;
  private srcCanvas: HTMLCanvasElement | null = null;
  private previewCtx: CanvasRenderingContext2D | null = null;
  private summaryEl: HTMLElement | null = null;
  private rowsEl: HTMLElement | null = null;
  private importBtn: HTMLButtonElement | null = null;

  private pixels: Uint32Array = new Uint32Array(0);
  private sheetW = 0;
  private sheetH = 0;
  private docName = 'imported';
  private frameW = 32;
  private frameH = 32;
  private scale = 1;
  private entries: RowEntry[] = [];
  private resliceTimer: number | null = null;

  /** Modal capture guard: Esc closes; typing inside the dialog passes through;
   *  everything else stops here so app shortcuts (Enter/N/…) stay inert. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    const t = e.target;
    const typing = t instanceof HTMLInputElement
      && this.overlay !== null && this.overlay.contains(t);
    if (!typing) e.stopPropagation();
  };

  constructor(opts: ImporterOpts) {
    this.opts = opts;
  }

  /** Open the modal for a raw decoded image. */
  open(pixels: Uint32Array, w: number, h: number, name: string): void {
    this.close();
    this.pixels = pixels;
    this.sheetW = w;
    this.sheetH = h;
    this.docName = name;
    const size = guessFrameSize(w, h);
    this.frameW = size;
    this.frameH = size;

    const src = document.createElement('canvas');
    src.width = w;
    src.height = h;
    const sctx = src.getContext('2d');
    if (!sctx) return;
    const img = sctx.createImageData(w, h);
    img.data.set(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length * 4));
    sctx.putImageData(img, 0, 0);
    this.srcCanvas = src;

    let fit = Math.min((window.innerWidth * 0.6) / w, (window.innerHeight * 0.7) / h);
    if (fit > 1) fit = Math.floor(fit);
    if (!(fit > 0)) fit = 1;
    this.scale = fit;

    this.buildDom();
    this.reslice();
    document.addEventListener('keydown', this.onKeyDown, true);
  }

  dispose(): void {
    this.close();
  }

  private close(): void {
    if (!this.overlay) return;
    document.removeEventListener('keydown', this.onKeyDown, true);
    if (this.resliceTimer !== null) {
      window.clearTimeout(this.resliceTimer);
      this.resliceTimer = null;
    }
    this.overlay.remove();
    this.overlay = null;
    this.srcCanvas = null;
    this.previewCtx = null;
    this.summaryEl = null;
    this.rowsEl = null;
    this.importBtn = null;
    this.entries = [];
    this.pixels = new Uint32Array(0);
  }

  private buildDom(): void {
    const overlay = document.createElement('div');
    overlay.className = 'sl-importer';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'import sprite sheet');
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) this.close();
    });

    const panel = document.createElement('div');
    panel.className = 'sl-importer-panel';
    panel.tabIndex = -1;

    const head = document.createElement('div');
    head.className = 'sl-importer-head';
    const title = document.createElement('div');
    title.className = 'sl-importer-title';
    title.textContent = 'import sheet';
    const nameEl = document.createElement('div');
    nameEl.className = 'sl-importer-name';
    nameEl.textContent = `${this.docName} · ${this.sheetW}×${this.sheetH}`;
    const hint = document.createElement('div');
    hint.className = 'sl-importer-hint';
    hint.textContent = 'esc to cancel';
    head.append(title, nameEl, hint);

    const body = document.createElement('div');
    body.className = 'sl-importer-body';

    const stage = document.createElement('div');
    stage.className = 'sl-importer-stage';
    const preview = document.createElement('canvas');
    preview.className = 'sl-importer-preview';
    preview.width = Math.max(1, Math.round(this.sheetW * this.scale));
    preview.height = Math.max(1, Math.round(this.sheetH * this.scale));
    stage.appendChild(preview);
    this.previewCtx = preview.getContext('2d');

    const side = document.createElement('div');
    side.className = 'sl-importer-side';

    const dims = document.createElement('div');
    dims.className = 'sl-importer-dims';
    const wInput = numberInput('sl-importer-num', this.frameW, MIN_FRAME, MAX_FRAME);
    const hInput = numberInput('sl-importer-num', this.frameH, MIN_FRAME, MAX_FRAME);
    const wLabel = document.createElement('label');
    wLabel.className = 'sl-importer-dim';
    wLabel.append('frame w ', wInput);
    const hLabel = document.createElement('label');
    hLabel.className = 'sl-importer-dim';
    hLabel.append('frame h ', hInput);
    dims.append(wLabel, hLabel);
    // Typing reslices debounced with the size clamped ≥MIN_FRAME; Enter/blur
    // (change) applies immediately.
    const wireDim = (input: HTMLInputElement, apply: (v: number) => void): void => {
      const parse = (): number | null => {
        const v = Math.floor(Number(input.value));
        if (!Number.isFinite(v) || v < 1) return null;
        return Math.max(MIN_FRAME, Math.min(MAX_FRAME, v));
      };
      input.addEventListener('input', () => {
        const v = parse();
        if (v === null) return;
        apply(v);
        this.queueReslice();
      });
      input.addEventListener('change', () => {
        const v = parse();
        if (v === null) return;
        input.value = String(v);
        apply(v);
        this.resliceNow();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
    };
    wireDim(wInput, (v) => { this.frameW = v; });
    wireDim(hInput, (v) => { this.frameH = v; });

    const summary = document.createElement('div');
    summary.className = 'sl-importer-summary';
    this.summaryEl = summary;

    const rows = document.createElement('div');
    rows.className = 'sl-importer-rows';
    this.rowsEl = rows;

    const actions = document.createElement('div');
    actions.className = 'sl-importer-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'cancel';
    cancel.addEventListener('click', () => this.close());
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'sl-importer-import';
    importBtn.addEventListener('click', () => this.importNow());
    this.importBtn = importBtn;
    actions.append(cancel, importBtn);

    side.append(dims, summary, rows, actions);
    body.append(stage, side);
    panel.append(head, body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this.overlay = overlay;
    panel.focus();
  }

  private queueReslice(): void {
    if (this.resliceTimer !== null) window.clearTimeout(this.resliceTimer);
    this.resliceTimer = window.setTimeout(() => {
      this.resliceTimer = null;
      this.reslice();
    }, RESLICE_DEBOUNCE_MS);
  }

  private resliceNow(): void {
    if (this.resliceTimer !== null) {
      window.clearTimeout(this.resliceTimer);
      this.resliceTimer = null;
    }
    this.reslice();
  }

  private reslice(): void {
    const slices = sliceGrid(this.pixels, this.sheetW, this.sheetH, this.frameW, this.frameH);
    const byRow = new Map<number, SheetSlice[]>();
    for (const s of slices) {
      const list = byRow.get(s.row);
      if (list) list.push(s);
      else byRow.set(s.row, [s]);
    }
    const prev = new Map(this.entries.map((e) => [e.row, e]));
    this.entries = [...byRow.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([row, rowSlices]) => {
        const old = prev.get(row);
        return {
          row,
          slices: rowSlices,
          name: old?.name ?? '',
          fps: old?.fps ?? DEFAULT_FPS,
          include: old?.include ?? true,
        };
      });
    this.renderPreview();
    this.renderRows();
    this.syncCounts();
  }

  private renderPreview(): void {
    const ctx = this.previewCtx;
    const src = this.srcCanvas;
    if (!ctx || !src) return;
    const s = this.scale;
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, cw, ch);

    const cols = Math.floor(this.sheetW / this.frameW);
    const rows = Math.floor(this.sheetH / this.frameH);
    const filled = new Set<string>();
    for (const e of this.entries) for (const sl of e.slices) filled.add(`${sl.row}:${sl.col}`);

    const cellW = this.frameW * s;
    const cellH = this.frameH * s;
    const gridW = cols * cellW;
    const gridH = rows * cellH;

    ctx.fillStyle = tokenColor('--shadow', 'rgba(0, 0, 0, 0.55)');
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (filled.has(`${r}:${c}`)) continue;
        ctx.fillRect(c * cellW, r * cellH, cellW, cellH);
      }
    }
    if (gridW < cw) ctx.fillRect(gridW, 0, cw - gridW, ch);
    if (gridH < ch) ctx.fillRect(0, gridH, gridW, ch - gridH);

    ctx.fillStyle = tokenColor('--accent', '#ffb454');
    ctx.globalAlpha = 0.8;
    for (let c = 0; c <= cols; c++) {
      const x = Math.min(Math.round(c * cellW), cw - 1);
      ctx.fillRect(x, 0, 1, gridH);
    }
    for (let r = 0; r <= rows; r++) {
      const y = Math.min(Math.round(r * cellH), ch - 1);
      ctx.fillRect(0, y, gridW, 1);
    }
    ctx.globalAlpha = 1;
  }

  private renderRows(): void {
    const host = this.rowsEl;
    if (!host) return;
    host.replaceChildren();
    for (const entry of this.entries) {
      const row = document.createElement('div');
      row.className = 'sl-importer-row';
      row.classList.toggle('off', !entry.include);

      const strip = document.createElement('canvas');
      strip.className = 'sl-importer-strip';
      strip.title = `row ${entry.row} · ${entry.slices.length} frames`;
      this.drawStrip(strip, entry);

      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'sl-importer-label';
      name.placeholder = 'idle, walk, sleep…';
      name.value = entry.name;
      name.addEventListener('input', () => {
        entry.name = name.value;
      });

      const fps = numberInput('sl-importer-fps', entry.fps, 1, 60);
      fps.title = 'row fps';
      fps.addEventListener('input', () => {
        const v = Math.floor(Number(fps.value));
        if (!Number.isFinite(v) || v < 1) return;
        entry.fps = Math.min(60, v);
      });

      const include = document.createElement('input');
      include.type = 'checkbox';
      include.className = 'sl-importer-inc';
      include.checked = entry.include;
      include.title = 'include this row';
      include.addEventListener('change', () => {
        entry.include = include.checked;
        row.classList.toggle('off', !entry.include);
        this.syncCounts();
      });

      row.append(strip, name, fps, include);
      host.appendChild(row);
    }
  }

  private drawStrip(canvas: HTMLCanvasElement, entry: RowEntry): void {
    const n = Math.min(STRIP_CELLS, entry.slices.length);
    canvas.width = Math.max(1, n * this.frameW * 2);
    canvas.height = Math.max(1, this.frameH * 2);
    const ctx = canvas.getContext('2d');
    const src = this.srcCanvas;
    if (!ctx || !src) return;
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < n; i++) {
      const slice = entry.slices[i];
      if (!slice) continue;
      const { rect } = slice;
      ctx.drawImage(
        src, rect.x, rect.y, rect.w, rect.h,
        i * this.frameW * 2, 0, this.frameW * 2, this.frameH * 2,
      );
    }
  }

  private includedFrameCount(): number {
    let n = 0;
    for (const e of this.entries) if (e.include) n += e.slices.length;
    return n;
  }

  private syncCounts(): void {
    const total = this.entries.reduce((n, e) => n + e.slices.length, 0);
    if (this.summaryEl) {
      this.summaryEl.textContent = `${total} frames in ${this.entries.length} rows`;
    }
    if (this.importBtn) {
      const n = this.includedFrameCount();
      this.importBtn.textContent = `import ${n} ${n === 1 ? 'frame' : 'frames'}`;
      this.importBtn.disabled = n === 0;
    }
  }

  private importNow(): void {
    const included = this.entries.filter((e) => e.include && e.slices.length > 0);
    const total = included.reduce((n, e) => n + e.slices.length, 0);
    if (total === 0) return;

    // Import builds a fresh doc before any history exists — the one place
    // direct doc mutation (no commands) is allowed.
    const doc = SpriteDoc.blank(this.frameW, this.frameH, this.docName);
    const layer = doc.layers[0];
    const first = doc.frames[0];
    if (!layer || !first) return;
    doc.tags = [];

    let frameIndex = 0;
    for (const entry of included) {
      const fps = entry.fps >= 1 ? entry.fps : DEFAULT_FPS;
      const durationMs = Math.max(1, Math.round(1000 / fps));
      const from = frameIndex;
      for (const slice of entry.slices) {
        let frame: Frame;
        if (frameIndex === 0) {
          first.durationMs = durationMs;
          frame = first;
        } else {
          frame = { id: doc.allocFrameId(), durationMs };
          doc.frames.push(frame);
        }
        const buf = makeBuffer(this.frameW, this.frameH);
        const { rect } = slice;
        for (let y = 0; y < rect.h; y++) {
          const src = (rect.y + y) * this.sheetW + rect.x;
          const dst = y * this.frameW;
          for (let x = 0; x < rect.w; x++) buf[dst + x] = this.pixels[src + x] ?? 0;
        }
        doc.setCel(doc.celKey(layer.id, frame.id), buf);
        frameIndex++;
      }
      doc.tags.push({
        name: entry.name.trim() || `row-${entry.row}`,
        from,
        to: frameIndex - 1,
        mode: 'loop',
      });
    }

    const colors = extractPalette(this.pixels);
    if (colors.length > 0) doc.palette.colors = colors;

    const rows = included.length;
    this.opts.adopt(doc);
    this.opts.bus.emit('status:message', {
      text: `imported ${total} frames · ${rows} ${rows === 1 ? 'row' : 'rows'}`,
    });
    this.close();
  }
}
