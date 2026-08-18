/** Export modal — one surface for every way pixels leave the app. Seven format
 *  cards (roving-tabindex grid), an honest manifest line naming EXACTLY which
 *  files download, and a nearest-neighbor scale row for the raster formats
 *  (chips + custom integer, output-side caps: png/sheet 4096, gif/webp 1024).
 *  Last format+scale persist in localStorage; Enter runs the selected card. */
import type { SpriteDoc } from '../../core/doc';
import { packSheetLayout, sheetFileName } from '../../io/exporters/sheet';
import { Modal } from '../modal';

export interface ExportRunners {
  png(o: { scale: number }): void;
  sheet(o: { scale: number }): void;
  gif(o: { scale: number }): void;
  webp(o: { scale: number }): void;
  pxmap(): void;
  sprite(): void;
  /** Wave 13 (optional so pre-wiring callers stay green — the app wires it;
   *  an un-wired runner makes the card's run a no-op): history-replay
   *  "watch me draw" GIF. */
  timelapse?(o: { scale: number }): void;
}

type FormatId = keyof ExportRunners;

const STORE_KEY = 'sprite-lab:v2:export';
const CHIP_SCALES = [1, 2, 4, 8, 16] as const;
const GRID_COLS = 3;
const TIMES = '×';
const WEBP_HINT = 'needs a chromium browser — try gif';
const TIMELAPSE_HINT = 'draw something first — the timelapse replays your history';

interface FormatDef {
  id: FormatId;
  label: string;
  note: string;
  /** Output-side pixel cap; null = not scalable (no scale row). */
  cap: number | null;
}

const FORMATS: readonly FormatDef[] = [
  { id: 'png', label: 'png', note: 'current frame', cap: 4096 },
  { id: 'sheet', label: 'sheet + json', note: 'all frames, tagged rows', cap: 4096 },
  { id: 'gif', label: 'gif', note: 'animation', cap: 1024 },
  { id: 'webp', label: 'animated webp', note: 'animation', cap: 1024 },
  { id: 'pxmap', label: 'px map', note: 'paste-ready TS', cap: null },
  { id: 'sprite', label: '.sprite', note: 'project file', cap: null },
  { id: 'timelapse', label: 'timelapse', note: 'watch it drawn — gif', cap: 1024 },
];

/** Live per-doc card notes (frame counts beat static copy). */
function noteFor(def: FormatDef, doc: SpriteDoc, activeFrame: number): string {
  const n = doc.frames.length;
  if (def.id === 'png') return n > 1 ? `frame ${activeFrame + 1} of ${n}` : def.note;
  if (def.id === 'gif' || def.id === 'webp') return `${n} frame${n === 1 ? '' : 's'}`;
  return def.note;
}

interface Persisted {
  format: FormatId;
  scale: number;
}

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw === null) return null;
    const p = JSON.parse(raw) as Partial<Persisted>;
    const format = FORMATS.find((f) => f.id === p.format)?.id;
    const scale = typeof p.scale === 'number' && Number.isInteger(p.scale) && p.scale >= 1
      ? p.scale
      : 1;
    if (format === undefined) return null;
    return { format, scale };
  } catch {
    return null;
  }
}

function savePersisted(p: Persisted): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable — persistence is a nicety, never a failure */
  }
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function button(className: string, text: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = text;
  return el;
}

function shake(el: HTMLElement): void {
  el.classList.remove('sl-shake');
  void el.offsetWidth;
  el.classList.add('sl-shake');
}

/** Pre-scale output dims for a format (png/gif/webp = frame; sheet = packed grid). */
function baseDims(doc: SpriteDoc, id: FormatId): { w: number; h: number } {
  if (id === 'sheet') {
    const layout = packSheetLayout(doc);
    return { w: Math.max(1, layout.cols * doc.width), h: Math.max(1, layout.rows.length * doc.height) };
  }
  return { w: doc.width, h: doc.height };
}

export function openExportModal(opts: {
  doc: () => SpriteDoc;
  activeFrame: () => number;
  run: ExportRunners;
  canWebp: () => Promise<boolean>;
  /** Wave 13 (additive, default true): false disables the timelapse card
   *  ('nothing to replay' — history holds fewer than 2 entries). */
  canTimelapse?: () => boolean;
}): void {
  const doc = opts.doc();
  const name = doc.meta.name;

  const manifestFor = (id: FormatId): string => {
    switch (id) {
      case 'png': return `${name}.png`;
      case 'sheet': return `${sheetFileName(name)} + ${name}.sheet.json`;
      case 'gif': return `${name}.gif`;
      case 'webp': return `${name}.webp`;
      case 'pxmap': return `clipboard (falls back to ${name}.pxmap.ts)`;
      case 'sprite': return `${name}.sprite`;
      case 'timelapse': return `${name}-timelapse.gif`;
    }
  };

  const persisted = loadPersisted();
  let selected: FormatId = persisted?.format ?? 'png';
  let scale = Math.max(1, persisted?.scale ?? 1);
  let webpOk = true;
  const timelapseOk = opts.canTimelapse?.() ?? true;
  // persisted timelapse falls back rather than opening on a dead selection
  if (selected === 'timelapse' && !timelapseOk) selected = 'gif';
  const cardDisabled = (id: FormatId): boolean =>
    (id === 'webp' && !webpOk) || (id === 'timelapse' && !timelapseOk);

  /* The Modal swallows ALL non-typing keydowns at window capture — card
     navigation must register its own capture listener BEFORE modal.open()
     (registration order on the same target is the sanctioned escape hatch;
     see the cheat sheet's '?'-close handler). Removed on every close path. */
  let onKeyNav: ((e: KeyboardEvent) => void) | null = null;
  const modal = new Modal({
    label: 'export',
    className: 'sl-export',
    onClose: () => {
      if (onKeyNav) window.removeEventListener('keydown', onKeyNav, true);
      onKeyNav = null;
    },
  });

  const title = document.createElement('h2');
  title.className = 'sl-modal-title';
  title.textContent = 'export';

  /* ── format cards ─────────────────────────────────────── */

  const grid = div('sl-export-grid');
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'format');
  const cards = new Map<FormatId, HTMLButtonElement>();

  for (const f of FORMATS) {
    const card = button(`sl-export-card sl-export-card-${f.id}`, '');
    const label = document.createElement('span');
    label.className = 'sl-export-card-label';
    label.textContent = f.label;
    const note = document.createElement('span');
    note.className = 'sl-export-card-note';
    note.textContent = noteFor(f, doc, opts.activeFrame());
    card.append(label, note);
    card.addEventListener('click', () => select(f.id));
    cards.set(f.id, card);
    grid.appendChild(card);
  }

  /* ── manifest + scale row ─────────────────────────────── */

  const manifest = div('sl-export-manifest');
  const manifestCaption = document.createElement('span');
  manifestCaption.className = 'sl-export-caption';
  manifestCaption.textContent = 'files';
  const manifestLine = document.createElement('code');
  manifestLine.className = 'sl-export-files';
  manifest.append(manifestCaption, manifestLine);

  const scaleRow = div('sl-export-scale');
  const scaleCaption = document.createElement('span');
  scaleCaption.className = 'sl-export-caption';
  scaleCaption.textContent = 'scale';
  const chipsWrap = div('sl-export-chips');
  const chips = new Map<number, HTMLButtonElement>();
  for (const s of CHIP_SCALES) {
    const chip = button('sl-export-chip', `${s}${TIMES}`);
    chip.dataset['scale'] = String(s);
    chip.addEventListener('click', () => setScale(s));
    chips.set(s, chip);
    chipsWrap.appendChild(chip);
  }

  const custom = document.createElement('input');
  custom.type = 'number';
  custom.className = 'sl-export-custom';
  custom.min = '1';
  custom.step = '1';
  custom.autocomplete = 'off';
  custom.setAttribute('aria-label', 'custom scale factor');
  custom.addEventListener('blur', () => {
    commitCustom();
  });
  custom.addEventListener('animationend', () => custom.classList.remove('sl-shake'));

  const dims = div('sl-export-dims');
  dims.setAttribute('aria-live', 'polite');
  scaleRow.append(scaleCaption, chipsWrap, custom, dims);

  /* ── actions ──────────────────────────────────────────── */

  const actions = div('sl-modal-actions');
  const cancel = button('sl-export-cancel', 'cancel');
  cancel.addEventListener('click', () => modal.close());
  const runBtn = button('sl-modal-primary sl-export-run', 'export');
  runBtn.addEventListener('click', () => run());
  actions.append(cancel, runBtn);

  /* ── state sync ───────────────────────────────────────── */

  const defFor = (id: FormatId): FormatDef => {
    const def = FORMATS.find((f) => f.id === id);
    if (!def) throw new Error(`unknown export format ${id}`);
    return def;
  };

  const maxScaleFor = (id: FormatId): number => {
    const cap = defFor(id).cap;
    if (cap === null) return 1;
    const d = baseDims(doc, id);
    return Math.max(1, Math.floor(cap / Math.max(d.w, d.h)));
  };

  const sync = (): void => {
    const def = defFor(selected);
    for (const f of FORMATS) {
      const card = cards.get(f.id);
      if (!card) continue;
      const on = f.id === selected;
      card.classList.toggle('active', on);
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
      const disabled = cardDisabled(f.id);
      card.disabled = disabled;
      card.tabIndex = on ? 0 : -1;
      const note = card.querySelector<HTMLElement>('.sl-export-card-note');
      if (note && f.id === 'webp') {
        note.textContent = disabled ? WEBP_HINT : noteFor(f, doc, opts.activeFrame());
      }
      if (note && f.id === 'timelapse') {
        note.textContent = disabled ? TIMELAPSE_HINT : noteFor(f, doc, opts.activeFrame());
      }
    }
    manifestLine.textContent = manifestFor(selected);

    const scalable = def.cap !== null;
    scaleRow.hidden = !scalable;
    if (scalable) {
      const max = maxScaleFor(selected);
      if (scale > max) scale = max;
      const base = baseDims(doc, selected);
      for (const [s, chip] of chips) {
        chip.disabled = s > max;
        chip.classList.toggle('active', s === scale);
        chip.setAttribute('aria-pressed', s === scale ? 'true' : 'false');
      }
      custom.max = String(max);
      custom.value = String(scale);
      const capped = max < (CHIP_SCALES[CHIP_SCALES.length - 1] ?? 16);
      dims.textContent =
        `${base.w}${TIMES}${base.h} → ${base.w * scale}${TIMES}${base.h * scale} px` +
        (capped ? ` · max ${max}${TIMES} (${def.label} output caps at ${def.cap} px)` : '');
    }
    savePersisted({ format: selected, scale });
  };

  const select = (id: FormatId): void => {
    if (cardDisabled(id)) return;
    selected = id;
    sync();
  };

  const setScale = (s: number): void => {
    scale = Math.max(1, Math.min(maxScaleFor(selected), Math.round(s)));
    sync();
  };

  /** Garbage → revert + shake + null; else the clamped committed scale. */
  const commitCustom = (): number | null => {
    const n = custom.valueAsNumber;
    if (!Number.isFinite(n)) {
      custom.value = String(scale);
      shake(custom);
      return null;
    }
    setScale(n);
    return scale;
  };

  const run = (): void => {
    const id = selected;
    const s = scale;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    modal.close();
    switch (id) {
      case 'png': opts.run.png({ scale: s }); break;
      case 'sheet': opts.run.sheet({ scale: s }); break;
      case 'gif': opts.run.gif({ scale: s }); break;
      case 'webp': opts.run.webp({ scale: s }); break;
      case 'pxmap': opts.run.pxmap(); break;
      case 'sprite': opts.run.sprite(); break;
      case 'timelapse': opts.run.timelapse?.({ scale: s }); break;
    }
  };

  /* ── keyboard: roving cards + Enter runs ──────────────── */

  onKeyNav = (e: KeyboardEvent): void => {
    if (!modal.isOpen) return;
    const active = document.activeElement;
    const onCard = active instanceof HTMLElement && active.classList.contains('sl-export-card');
    if (onCard && (e.key === 'ArrowRight' || e.key === 'ArrowLeft'
      || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      let next: FormatId | undefined;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        // horizontal: ring over the ENABLED cards (disabled ones are skipped)
        const order = FORMATS.filter((f) => !cardDisabled(f.id)).map((f) => f.id);
        const at = order.indexOf(selected);
        next = e.key === 'ArrowRight'
          ? order[(at + 1) % order.length]
          : order[(at - 1 + order.length) % order.length];
      } else {
        // vertical: FULL grid geometry (a disabled card still occupies its
        // slot), clamped to the edge, then nudged off a disabled landing —
        // filtered-index math here would shear columns whenever a mid-grid
        // card (webp, timelapse) is disabled.
        const grid = FORMATS.map((f) => f.id);
        const at = grid.indexOf(selected);
        let t = e.key === 'ArrowDown'
          ? Math.min(grid.length - 1, at + GRID_COLS)
          : Math.max(0, at - GRID_COLS);
        while (t !== at && cardDisabled(grid[t] ?? selected)) t += t > at ? -1 : 1;
        next = grid[t];
      }
      e.preventDefault();
      e.stopPropagation();
      if (next !== undefined && next !== selected) {
        select(next);
        cards.get(next)?.focus();
      }
      return;
    }
    if (e.key !== 'Enter') return;
    if (active === custom) {
      e.preventDefault();
      e.stopPropagation();
      if (commitCustom() !== null) run();
      return;
    }
    if (onCard) {
      // arrows select, Enter confirms — never a re-select click
      e.preventDefault();
      e.stopPropagation();
      run();
      return;
    }
    if (active instanceof HTMLButtonElement && modal.root.contains(active)) {
      return; // cancel / export keep their native Enter activation
    }
    e.preventDefault();
    e.stopPropagation();
    run();
  };
  window.addEventListener('keydown', onKeyNav, true);

  modal.root.append(title, grid, manifest, scaleRow, actions);
  modal.open();
  sync();
  cards.get(selected)?.focus();

  void opts.canWebp().then((ok) => {
    if (!modal.isOpen) return;
    webpOk = ok;
    if (!ok && selected === 'webp') selected = 'gif';
    sync();
  });
}
