/** Bottom panel: frame thumbnails + durations + playback + onion + tags. */
import type { OnionConfig, Tag, TagMode } from '../../core/contracts';
import type { Bus } from '../../core/bus';
import type { SpriteDoc } from '../../core/doc';
import { icon } from '../icons';

export interface TimelineOpts {
  host: HTMLElement;
  bus: Bus;
  getDoc(): SpriteDoc;
  getFrame(): number;
  setFrame(index: number): void;
  /** Structural ops — all commit commands via history. */
  addFrame(): void;
  duplicateFrame(): void;
  removeFrame(): void;
  reorderFrame(from: number, to: number): void;
  reverseFrames(): void;
  setDuration(index: number, ms: number): void;
  /* playback */
  isPlaying(): boolean;
  togglePlay(): void;
  /* onion */
  getOnion(): OnionConfig;
  setOnion(config: OnionConfig): void;
  /* tags */
  addTag(tag: Tag): void;
  removeTag(index: number): void;
  updateTag(index: number, next: Tag): void;
  /** Set/clear the playback loop range from a tag. */
  setRangeFromTag(index: number | null): void;
}

/* Cell geometry — mirrored in app.css (.sl-tl-cell / .sl-tl-scroll padding). */
const THUMB = 48;
const CELL_W = 50; // 48px canvas + 1px hard border each side
const GAP = 2;
const PITCH = CELL_W + GAP;
const PAD = 6; // .sl-tl-scroll horizontal padding
const DRAG_THRESHOLD = 4;
const MODES: readonly TagMode[] = ['loop', 'pingpong', 'hold'];

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

interface FrameDrag {
  pointerId: number;
  from: number;
  to: number;
  startX: number;
  startY: number;
  active: boolean;
}

interface TagDrag {
  pointerId: number;
  index: number;
  edge: 'l' | 'r';
  from: number;
  to: number;
  el: HTMLElement;
}

interface Scratch {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  img: ImageData;
  buf: Uint32Array;
  w: number;
  h: number;
}

export class TimelinePanel {
  private readonly opts: TimelineOpts;
  private readonly unsubs: Array<() => void> = [];
  private rootEl: HTMLElement | null = null;
  private playBtn: HTMLButtonElement | null = null;
  private counterEl: HTMLElement | null = null;
  private delBtn: HTMLButtonElement | null = null;
  private revBtn: HTMLButtonElement | null = null;
  private onionBtn: HTMLButtonElement | null = null;
  private onionCtl: HTMLElement | null = null;
  private onionNum: HTMLElement | null = null;
  private alphaInput: HTMLInputElement | null = null;
  private scrollEl: HTMLElement | null = null;
  private stripEl: HTMLElement | null = null;
  private tagsEl: HTMLElement | null = null;
  private ghostEl: HTMLElement | null = null;
  private cells: HTMLElement[] = [];
  private thumbs: HTMLCanvasElement[] = [];
  private scratch: Scratch | null = null;
  private frameDrag: FrameDrag | null = null;
  private tagDrag: TagDrag | null = null;
  private activeTagIdx: number | null = null;
  private pendingRename: number | null = null;
  private repaintRaf: number | null = null;

  constructor(opts: TimelineOpts) {
    this.opts = opts;
  }

  mount(): void {
    const o = this.opts;
    const root = div('sl-tl');

    const transport = div('sl-tl-transport');
    const play = this.tlBtn('', () => o.togglePlay());
    this.playBtn = play;
    const prev = this.tlBtn('previous frame (←)', () => this.step(-1));
    prev.appendChild(icon('frame-prev'));
    const next = this.tlBtn('next frame (→)', () => this.step(1));
    next.appendChild(icon('frame-next'));
    const counter = document.createElement('span');
    counter.className = 'sl-tl-count';
    this.counterEl = counter;
    const add = this.tlBtn('new frame (N)', () => o.addFrame());
    add.appendChild(icon('plus'));
    const dup = this.tlBtn('duplicate frame (shift+N)', () => o.duplicateFrame());
    dup.appendChild(icon('frame-dup'));
    const del = this.tlBtn('delete frame', () => o.removeFrame());
    del.appendChild(icon('trash'));
    this.delBtn = del;
    const rev = this.tlBtn('reverse frames', () => o.reverseFrames());
    rev.appendChild(icon('reverse'));
    this.revBtn = rev;

    const right = div('sl-tl-right');
    const onion = this.tlBtn('onion skin (K)', () => {
      const cfg = o.getOnion();
      o.setOnion({ ...cfg, enabled: !cfg.enabled });
    });
    onion.appendChild(icon('onion'));
    this.onionBtn = onion;
    const ctl = document.createElement('span');
    ctl.className = 'sl-tl-onionctl';
    const num = document.createElement('span');
    num.className = 'sl-tl-onion-n';
    num.title = 'onion frames: past|future';
    this.onionNum = num;
    const alpha = document.createElement('input');
    alpha.type = 'range';
    alpha.className = 'sl-range sl-tl-alpha';
    alpha.min = '0.1';
    alpha.max = '0.8';
    alpha.step = '0.05';
    alpha.title = 'onion opacity';
    alpha.addEventListener('input', () => {
      const v = Number(alpha.value);
      if (Number.isFinite(v)) o.setOnion({ ...o.getOnion(), opacity: v });
    });
    this.alphaInput = alpha;
    ctl.append(this.stepper('past'), num, this.stepper('future'), alpha);
    this.onionCtl = ctl;
    right.append(onion, ctl);

    transport.append(
      play, prev, next, counter, div('sl-tl-sep'), add, dup, del, rev, right,
    );

    const scroll = div('sl-tl-scroll');
    const strip = div('sl-tl-strip');
    const tags = div('sl-tl-tags');
    const ghost = div('sl-tl-ghost');
    ghost.hidden = true;
    scroll.append(strip, tags, ghost);
    this.scrollEl = scroll;
    this.stripEl = strip;
    this.tagsEl = tags;
    this.ghostEl = ghost;

    strip.addEventListener('pointerdown', (e) => this.onStripDown(e));
    strip.addEventListener('pointermove', (e) => this.onStripMove(e));
    strip.addEventListener('pointerup', (e) => this.onStripUp(e, true));
    strip.addEventListener('pointercancel', (e) => this.onStripUp(e, false));

    root.append(transport, scroll);
    o.host.appendChild(root);
    this.rootEl = root;

    this.unsubs.push(
      o.bus.on('doc:changed', ({ scope }) => {
        if (scope.kind === 'frames' || scope.kind === 'all') this.rebuildAll();
        else if (scope.kind === 'cels' || scope.kind === 'layers') this.scheduleRepaint();
      }),
      o.bus.on('doc:replaced', () => {
        this.scratch = null;
        this.activeTagIdx = null;
        this.pendingRename = null;
        this.rebuildAll();
        this.syncPlay();
        this.syncOnion();
      }),
      o.bus.on('frame:active', ({ index }) => this.syncActive(index)),
      o.bus.on('playback:changed', () => this.syncPlay()),
      o.bus.on('onion:changed', () => this.syncOnion()),
    );

    this.rebuildAll();
    this.syncPlay();
    this.syncOnion();
  }

  unmount(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    if (this.repaintRaf !== null) cancelAnimationFrame(this.repaintRaf);
    this.repaintRaf = null;
    this.rootEl?.remove();
    this.rootEl = null;
    this.playBtn = this.delBtn = this.revBtn = this.onionBtn = null;
    this.counterEl = this.onionCtl = this.onionNum = null;
    this.alphaInput = null;
    this.scrollEl = this.stripEl = this.tagsEl = this.ghostEl = null;
    this.cells = [];
    this.thumbs = [];
    this.scratch = null;
    this.frameDrag = null;
    this.tagDrag = null;
  }

  /* ── transport ─────────────────────────────────────────── */

  private tlBtn(title: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sl-tl-btn';
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private stepper(key: 'past' | 'future'): HTMLElement {
    const wrap = div('sl-tl-step');
    const make = (d: 1 | -1): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sl-tl-stepbtn';
      btn.title = `onion ${key} ${d > 0 ? '+1' : '-1'}`;
      btn.appendChild(icon(d > 0 ? 'step-up' : 'step-down'));
      btn.addEventListener('click', () => {
        const cfg = this.opts.getOnion();
        const v = Math.max(0, Math.min(4, cfg[key] + d));
        if (v !== cfg[key]) this.opts.setOnion({ ...cfg, [key]: v });
      });
      return btn;
    };
    wrap.append(make(1), make(-1));
    return wrap;
  }

  private step(d: 1 | -1): void {
    const n = this.opts.getDoc().frames.length;
    if (n < 1) return;
    this.opts.setFrame((this.opts.getFrame() + d + n) % n);
  }

  private syncPlay(): void {
    const btn = this.playBtn;
    if (!btn) return;
    const playing = this.opts.isPlaying();
    btn.replaceChildren(icon(playing ? 'pause' : 'play'));
    btn.title = playing ? 'pause (Enter)' : 'play (Enter)';
    btn.classList.toggle('active', playing);
    btn.setAttribute('aria-pressed', String(playing));
  }

  private syncOnion(): void {
    const cfg = this.opts.getOnion();
    const btn = this.onionBtn;
    if (btn) {
      btn.classList.toggle('active', cfg.enabled);
      btn.setAttribute('aria-pressed', String(cfg.enabled));
    }
    if (this.onionCtl) this.onionCtl.hidden = !cfg.enabled;
    if (this.onionNum) this.onionNum.textContent = `${cfg.past}|${cfg.future}`;
    if (this.alphaInput) this.alphaInput.value = String(cfg.opacity);
  }

  private syncTransport(): void {
    const n = this.opts.getDoc().frames.length;
    if (this.counterEl) {
      this.counterEl.textContent = `${this.opts.getFrame() + 1}/${n}`;
    }
    if (this.delBtn) this.delBtn.disabled = n < 2;
    if (this.revBtn) this.revBtn.disabled = n < 2;
  }

  /* ── frames strip ──────────────────────────────────────── */

  private rebuildAll(): void {
    this.rebuildStrip();
    this.rebuildTags();
    this.syncTransport();
    this.repaintThumbsNow();
    this.syncActive(this.opts.getFrame());
  }

  private rebuildStrip(): void {
    const strip = this.stripEl;
    if (!strip) return;
    const doc = this.opts.getDoc();
    this.cells = [];
    this.thumbs = [];
    strip.replaceChildren();
    doc.frames.forEach((frame, i) => {
      const cell = div('sl-tl-cell');
      cell.dataset['index'] = String(i);
      const thumb = document.createElement('canvas');
      thumb.className = 'sl-tl-thumb';
      thumb.width = THUMB;
      thumb.height = THUMB;
      const num = document.createElement('span');
      num.className = 'sl-tl-num';
      num.textContent = String(i + 1);
      const dur = document.createElement('input');
      dur.type = 'number';
      dur.className = 'sl-tl-dur';
      dur.min = '10';
      dur.max = '60000';
      dur.value = String(frame.durationMs);
      dur.title = 'frame duration (ms)';
      dur.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') dur.blur();
      });
      dur.addEventListener('blur', () => this.commitDuration(i, dur));
      cell.append(thumb, num, dur);
      strip.appendChild(cell);
      this.cells.push(cell);
      this.thumbs.push(thumb);
    });
  }

  private commitDuration(index: number, input: HTMLInputElement): void {
    const frame = this.opts.getDoc().frames[index];
    if (!frame) return;
    const ms = Math.round(Number(input.value));
    if (!Number.isFinite(ms) || ms < 10 || ms > 60000) {
      input.value = String(frame.durationMs);
      return;
    }
    if (ms !== frame.durationMs) this.opts.setDuration(index, ms);
  }

  /** frame:active path stays light: ring class + counter only, no thumb redraw. */
  private syncActive(index: number): void {
    this.cells.forEach((cell, i) => cell.classList.toggle('active', i === index));
    this.syncTransport();
    this.cells[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Thumbs repaint whole-strip, rAF-coalesced — cheap at ≤64 frames, and
   *  collapses the per-pointermove doc:changed spam during a stroke. */
  private scheduleRepaint(): void {
    if (this.repaintRaf !== null) return;
    this.repaintRaf = requestAnimationFrame(() => {
      this.repaintRaf = null;
      this.repaintThumbsNow();
    });
  }

  private repaintThumbsNow(): void {
    const doc = this.opts.getDoc();
    const count = Math.min(this.thumbs.length, doc.frames.length);
    for (let i = 0; i < count; i++) {
      const thumb = this.thumbs[i];
      if (thumb) this.paintThumb(thumb, i);
    }
  }

  private ensureScratch(w: number, h: number): Scratch | null {
    if (this.scratch && this.scratch.w === w && this.scratch.h === h) return this.scratch;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) return null;
    const buf = new Uint32Array(w * h);
    const img = new ImageData(new Uint8ClampedArray(buf.buffer), w, h);
    this.scratch = { canvas, g, img, buf, w, h };
    return this.scratch;
  }

  private paintThumb(canvas: HTMLCanvasElement, frameIndex: number): void {
    const doc = this.opts.getDoc();
    if (frameIndex >= doc.frames.length) return;
    const s = this.ensureScratch(doc.width, doc.height);
    if (!s) return;
    doc.flattenFrame(frameIndex, s.buf);
    s.g.putImageData(s.img, 0, 0);
    const g = canvas.getContext('2d');
    if (!g) return;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, THUMB, THUMB);
    const scale = Math.min(THUMB / s.w, THUMB / s.h);
    const dw = Math.max(1, Math.floor(s.w * scale));
    const dh = Math.max(1, Math.floor(s.h * scale));
    g.drawImage(
      s.canvas, 0, 0, s.w, s.h,
      Math.floor((THUMB - dw) / 2), Math.floor((THUMB - dh) / 2), dw, dh,
    );
  }

  /* ── frame reorder drag ────────────────────────────────── */

  private frameIndexAt(clientX: number): number {
    const scroll = this.scrollEl;
    const n = this.opts.getDoc().frames.length;
    if (!scroll || n < 1) return 0;
    const rect = scroll.getBoundingClientRect();
    const x = clientX - rect.left + scroll.scrollLeft - PAD;
    return Math.max(0, Math.min(n - 1, Math.floor(x / PITCH)));
  }

  private onStripDown(e: PointerEvent): void {
    if (e.button !== 0 || this.frameDrag) return;
    if (e.target instanceof HTMLInputElement) return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.sl-tl-cell');
    if (!cell) return;
    const from = Number(cell.dataset['index']);
    if (!Number.isInteger(from)) return;
    this.frameDrag = {
      pointerId: e.pointerId, from, to: from,
      startX: e.clientX, startY: e.clientY, active: false,
    };
    this.stripEl?.setPointerCapture(e.pointerId);
  }

  private onStripMove(e: PointerEvent): void {
    const d = this.frameDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      const dist = Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY);
      if (dist < DRAG_THRESHOLD) return;
      d.active = true;
      this.cells[d.from]?.classList.add('dragging');
      if (this.ghostEl) this.ghostEl.hidden = false;
    }
    d.to = this.frameIndexAt(e.clientX);
    if (this.ghostEl) this.ghostEl.style.left = `${PAD + d.to * PITCH}px`;
  }

  private onStripUp(e: PointerEvent, commit: boolean): void {
    const d = this.frameDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.frameDrag = null;
    const strip = this.stripEl;
    if (strip?.hasPointerCapture(e.pointerId)) strip.releasePointerCapture(e.pointerId);
    this.cells[d.from]?.classList.remove('dragging');
    if (this.ghostEl) this.ghostEl.hidden = true;
    if (!commit) return;
    if (d.active) {
      if (d.to !== d.from) this.opts.reorderFrame(d.from, d.to);
    } else if (d.from !== this.opts.getFrame()) {
      this.opts.setFrame(d.from);
    }
  }

  /* ── tags lane ─────────────────────────────────────────── */

  private rebuildTags(): void {
    const tags = this.tagsEl;
    if (!tags) return;
    const doc = this.opts.getDoc();
    const n = doc.frames.length;
    if (this.activeTagIdx !== null && this.activeTagIdx >= doc.tags.length) {
      this.activeTagIdx = null;
    }
    tags.replaceChildren();
    tags.style.width = `${n * PITCH + 64}px`;
    doc.tags.forEach((tag, i) => tags.appendChild(this.buildTagSpan(tag, i, n)));

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'sl-tag-add';
    addBtn.textContent = '+tag';
    addBtn.title = 'new tag on the active frame';
    addBtn.style.left = `${n * PITCH + 4}px`;
    addBtn.addEventListener('click', () => {
      const cur = this.opts.getFrame();
      this.pendingRename = this.opts.getDoc().tags.length;
      this.opts.addTag({ name: 'tag', from: cur, to: cur, mode: 'loop' });
    });
    tags.appendChild(addBtn);

    const pending = this.pendingRename;
    if (pending !== null) {
      this.pendingRename = null;
      const span = tags.querySelector<HTMLElement>(`[data-tag="${pending}"]`);
      if (span && doc.tags[pending]) this.startTagRename(pending, span);
    }
  }

  private buildTagSpan(tag: Tag, index: number, frameCount: number): HTMLElement {
    const span = div('sl-tag');
    span.dataset['tag'] = String(index);
    const from = Math.max(0, Math.min(frameCount - 1, tag.from));
    const to = Math.max(from, Math.min(frameCount - 1, tag.to));
    span.style.left = `${from * PITCH}px`;
    span.style.width = `${(to - from + 1) * PITCH - GAP}px`;
    const hue = hueOf(tag.name);
    const line = `hsl(${hue} 65% 45%)`;
    const isActive = this.activeTagIdx === index;
    span.style.background = `hsl(${hue} 60% 50% / ${isActive ? 0.55 : 0.35})`;
    span.style.borderBottom = `1px solid ${line}`;
    if (isActive) {
      span.classList.add('active');
      span.style.boxShadow = `inset 0 0 0 1px ${line}`;
    }
    span.title =
      `${tag.name} · ${tag.mode} — click: loop range · ` +
      'alt-click: cycle mode · double-click: rename · drag edges: resize';

    const name = document.createElement('span');
    name.className = 'sl-tag-name';
    name.textContent = tag.name;

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'sl-tag-x';
    x.textContent = 'x';
    x.title = 'remove tag';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.activeTagIdx === index) {
        this.activeTagIdx = null;
        this.opts.setRangeFromTag(null);
      } else if (this.activeTagIdx !== null && this.activeTagIdx > index) {
        this.activeTagIdx -= 1;
      }
      this.opts.removeTag(index);
    });

    const edgeL = div('sl-tag-edge sl-tag-edge-l');
    const edgeR = div('sl-tag-edge sl-tag-edge-r');
    for (const [edgeEl, edge] of [[edgeL, 'l'], [edgeR, 'r']] as const) {
      edgeEl.addEventListener('pointerdown', (e) => this.beginTagResize(e, index, edge, span));
      edgeEl.addEventListener('pointermove', (e) => this.moveTagResize(e));
      edgeEl.addEventListener('pointerup', (e) => this.endTagResize(e, true));
      edgeEl.addEventListener('pointercancel', (e) => this.endTagResize(e, false));
    }

    span.append(name, x, edgeL, edgeR);
    span.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.sl-tag-edge, .sl-tag-x, .sl-tag-input')) return;
      if (e.altKey) this.cycleTagMode(index);
      else this.toggleTagRange(index);
    });
    span.addEventListener('dblclick', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.sl-tag-edge, .sl-tag-x, .sl-tag-input')) return;
      this.startTagRename(index, span);
    });
    return span;
  }

  private toggleTagRange(index: number): void {
    if (this.activeTagIdx === index) {
      this.activeTagIdx = null;
      this.opts.setRangeFromTag(null);
    } else {
      this.activeTagIdx = index;
      this.opts.setRangeFromTag(index);
    }
    this.rebuildTags();
  }

  private cycleTagMode(index: number): void {
    const tag = this.opts.getDoc().tags[index];
    if (!tag) return;
    const next = MODES[(MODES.indexOf(tag.mode) + 1) % MODES.length] ?? 'loop';
    this.opts.updateTag(index, { ...tag, mode: next });
  }

  private startTagRename(index: number, span: HTMLElement): void {
    const tag = this.opts.getDoc().tags[index];
    if (!tag) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sl-tag-input';
    input.value = tag.name;
    span.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== tag.name) this.opts.updateTag(index, { ...tag, name });
      else this.rebuildTags();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  private beginTagResize(
    e: PointerEvent, index: number, edge: 'l' | 'r', span: HTMLElement,
  ): void {
    if (e.button !== 0 || this.tagDrag) return;
    e.stopPropagation();
    const tag = this.opts.getDoc().tags[index];
    if (!tag) return;
    this.tagDrag = {
      pointerId: e.pointerId, index, edge, from: tag.from, to: tag.to, el: span,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  private moveTagResize(e: PointerEvent): void {
    const d = this.tagDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    const at = this.frameIndexAt(e.clientX);
    if (d.edge === 'l') d.from = Math.min(at, d.to);
    else d.to = Math.max(at, d.from);
    d.el.style.left = `${d.from * PITCH}px`;
    d.el.style.width = `${(d.to - d.from + 1) * PITCH - GAP}px`;
  }

  private endTagResize(e: PointerEvent, commit: boolean): void {
    const d = this.tagDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.tagDrag = null;
    const tag = this.opts.getDoc().tags[d.index];
    if (commit && tag && (tag.from !== d.from || tag.to !== d.to)) {
      this.opts.updateTag(d.index, { ...tag, from: d.from, to: d.to });
    } else {
      this.rebuildTags();
    }
  }
}
