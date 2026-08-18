/** New-document + canvas-resize dialogs, built on the shared Modal primitive.
 *  Number inputs follow the .sl-hex idiom: commit on Enter/blur, garbage
 *  reverts to the last good value with a shake, commits always blur. */
import type { Rgba } from '../../core/contracts';
import type { ResizeAnchor } from '../../core/commands/resize';
import { dailySeed } from '../../app/daily';
import { SpriteDoc } from '../../core/doc';
import { hexToRgba, rgbaToHex } from '../../core/pixels';
import { Modal } from '../modal';
import { openLospecModal } from './lospec';

export interface NewDocChoice {
  width: number;
  height: number;
  name: string;
  palette: 'starter' | 'current' | 'empty';
  /** Rgba fill for the first cel; 0 = transparent. */
  background: number;
  /** When present, these become the new doc's palette (daily dare / lospec
   *  import) — applied after the `palette` source. Wave 13, additive. */
  seedColors?: number[];
}

const SIZE_MIN = 4;
const SIZE_MAX = 512;
const PRESETS = [16, 24, 32, 48, 64, 128] as const;
const ANCHORS: readonly ResizeAnchor[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];
const ANCHOR_NAMES: Record<ResizeAnchor, string> = {
  tl: 'top left', t: 'top', tr: 'top right',
  l: 'left', c: 'center', r: 'right',
  bl: 'bottom left', b: 'bottom', br: 'bottom right',
};
const TIMES = '×';

function clampSize(n: number): number {
  return Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(n)));
}

function shake(el: HTMLElement): void {
  el.classList.remove('sl-shake');
  void el.offsetWidth;
  el.classList.add('sl-shake');
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

interface NumField {
  input: HTMLInputElement;
  /** Validate + normalize. Garbage → revert + shake + null; else clamped value. */
  commit(): number | null;
  set(v: number): void;
}

/** Size input (4..512): number box that self-heals on blur. */
function numField(className: string, label: string, initial: number): NumField {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = className;
  input.min = String(SIZE_MIN);
  input.max = String(SIZE_MAX);
  input.step = '1';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', label);
  let lastGood = clampSize(initial);
  input.value = String(lastGood);
  const commit = (): number | null => {
    const n = input.valueAsNumber;
    if (!Number.isFinite(n)) {
      input.value = String(lastGood);
      shake(input);
      return null;
    }
    lastGood = clampSize(n);
    input.value = String(lastGood);
    return lastGood;
  };
  input.addEventListener('blur', () => { commit(); });
  input.addEventListener('animationend', () => input.classList.remove('sl-shake'));
  return {
    input,
    commit,
    set: (v: number) => {
      lastGood = clampSize(v);
      input.value = String(lastGood);
    },
  };
}

/** `W × H` input pair inside a row. */
function sizeRow(
  rowClass: string, xClass: string, w: NumField, h: NumField,
): HTMLElement {
  const row = div(rowClass);
  const x = document.createElement('span');
  x.className = xClass;
  x.textContent = TIMES;
  row.append(w.input, x, h.input);
  return row;
}

/** Enter routing for a modal card: buttons keep their native activation,
 *  everywhere else Enter submits; both stay out of the global shortcut map. */
function routeEnter(root: HTMLElement, submit: () => void): void {
  root.addEventListener('keydown', (e) => {
    const onButton = e.target instanceof HTMLButtonElement;
    if (e.key === 'Enter') {
      e.stopPropagation();
      if (onButton) return;
      e.preventDefault();
      submit();
    } else if (e.key === ' ' && onButton) {
      e.stopPropagation();
    }
  });
}

export function openNewDocModal(opts: {
  currentPalette: () => number[];
  onCreate: (c: NewDocChoice) => void;
  /** When present, a quiet footer link offers the demo sprite instead. */
  onDemo?: () => void;
}): void {
  const modal = new Modal({ label: 'new sprite', className: 'sl-newdoc' });

  const title = document.createElement('h2');
  title.className = 'sl-modal-title';
  title.textContent = 'new sprite';

  const w = numField('sl-newdoc-num sl-newdoc-w', 'width', 32);
  const h = numField('sl-newdoc-num sl-newdoc-h', 'height', 32);

  const presets = div('sl-newdoc-presets');
  const chips: HTMLButtonElement[] = [];
  const syncChips = (): void => {
    for (const chip of chips) {
      const on = chip.textContent === w.input.value && chip.textContent === h.input.value;
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
  for (const size of PRESETS) {
    const chip = button('sl-newdoc-preset', String(size));
    chip.title = `${size}${TIMES}${size}`;
    chip.addEventListener('click', () => {
      w.set(size);
      h.set(size);
      syncChips();
    });
    chips.push(chip);
    presets.appendChild(chip);
  }
  w.input.addEventListener('input', syncChips);
  h.input.addEventListener('input', syncChips);

  const nameLabel = document.createElement('label');
  nameLabel.className = 'sl-newdoc-row';
  const nameCaption = document.createElement('span');
  nameCaption.className = 'sl-newdoc-caption';
  nameCaption.textContent = 'name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'sl-newdoc-name';
  nameInput.value = 'untitled';
  nameInput.maxLength = 64;
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameLabel.append(nameCaption, nameInput);

  const palRow = div('sl-newdoc-row');
  const palCaption = document.createElement('span');
  palCaption.className = 'sl-newdoc-caption';
  palCaption.textContent = 'palette';
  const palChoices = div('sl-newdoc-radios');
  const currentCount = opts.currentPalette().length;
  const sources: ReadonlyArray<{ value: NewDocChoice['palette']; text: string }> = [
    { value: 'starter', text: 'starter ramp' },
    { value: 'current', text: `keep current (${currentCount})` },
    { value: 'empty', text: 'empty' },
  ];
  const radios: Array<{ radio: HTMLInputElement; value: NewDocChoice['palette'] }> = [];
  for (const { value, text } of sources) {
    const label = document.createElement('label');
    label.className = 'sl-newdoc-radio';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'sl-newdoc-palette';
    radio.value = value;
    radio.checked = value === 'starter';
    if (value === 'current' && currentCount === 0) {
      radio.disabled = true;
      label.classList.add('disabled');
    }
    const caption = document.createElement('span');
    caption.textContent = text;
    label.append(radio, caption);
    radios.push({ radio, value });
    palChoices.appendChild(label);
  }

  /* Fourth source: lospec import. The radio opens the fetch dialog; a loaded
   * palette rides the seedColors mechanism (source 'empty' + seeded colors). */
  let lospecColors: number[] | null = null;
  let lastStandard: NewDocChoice['palette'] = 'starter';
  const lospecLabel = document.createElement('label');
  lospecLabel.className = 'sl-newdoc-radio sl-newdoc-lospec';
  const lospecRadio = document.createElement('input');
  lospecRadio.type = 'radio';
  lospecRadio.name = 'sl-newdoc-palette';
  lospecRadio.value = 'lospec';
  const lospecCaption = document.createElement('span');
  lospecCaption.className = 'sl-newdoc-lospec-caption';
  lospecCaption.textContent = 'lospec…';
  lospecLabel.append(lospecRadio, lospecCaption);
  palChoices.appendChild(lospecLabel);
  palRow.append(palCaption, palChoices);

  const bgRow = div('sl-newdoc-row');
  const bgCaption = document.createElement('span');
  bgCaption.className = 'sl-newdoc-caption';
  bgCaption.textContent = 'background';
  const bgChip = document.createElement('span');
  bgChip.className = 'sl-newdoc-bg-chip';
  const bgInput = document.createElement('input');
  bgInput.type = 'text';
  bgInput.className = 'sl-newdoc-bg';
  bgInput.placeholder = 'transparent';
  bgInput.maxLength = 9;
  bgInput.autocomplete = 'off';
  bgInput.spellcheck = false;
  bgInput.setAttribute('aria-label', 'background color (hex, empty = transparent)');
  /** '' → transparent, else hex; null = invalid. */
  const parseBg = (): Rgba | null => {
    const raw = bgInput.value.trim();
    if (raw === '') return 0;
    return hexToRgba(raw);
  };
  const syncBgChip = (): void => {
    const c = parseBg();
    bgChip.classList.toggle('is-clear', c === 0 || c === null);
    bgChip.style.background = c === null || c === 0 ? '' : rgbaToHex(c);
  };
  bgInput.addEventListener('input', syncBgChip);
  bgInput.addEventListener('blur', () => {
    if (parseBg() === null) {
      bgInput.value = '';
      syncBgChip();
      shake(bgInput);
    }
  });
  bgInput.addEventListener('animationend', () => bgInput.classList.remove('sl-shake'));
  syncBgChip();
  bgRow.append(bgCaption, bgChip, bgInput);

  /* ── today's dare: one quiet line — prompt + 4 chips + take ─────────── */
  const seed = dailySeed();
  let dareSeed: number[] | null = null;
  const dare = div('sl-daily');
  const darePrompt = document.createElement('span');
  darePrompt.className = 'sl-daily-prompt';
  darePrompt.textContent = seed.prompt;
  darePrompt.title = `today's dare — a new one every day`;
  const dareChips = div('sl-daily-chips');
  for (const c of seed.colors) {
    const chip = document.createElement('span');
    chip.className = 'sl-daily-chip';
    chip.dataset['color'] = rgbaToHex(c);
    chip.style.background = rgbaToHex(c);
    dareChips.appendChild(chip);
  }
  const takeBtn = button('sl-daily-take', 'take the dare');
  takeBtn.title = `name it '${seed.prompt}' and start from its 4 colors`;
  takeBtn.setAttribute('aria-pressed', 'false');
  const clearDare = (): void => {
    dareSeed = null;
    dare.classList.remove('active');
    takeBtn.setAttribute('aria-pressed', 'false');
  };
  takeBtn.addEventListener('click', () => {
    nameInput.value = seed.prompt;
    const empty = radios.find((r) => r.value === 'empty');
    if (empty) empty.radio.checked = true;
    lastStandard = 'empty';
    dareSeed = [...seed.colors];
    dare.classList.add('active');
    takeBtn.setAttribute('aria-pressed', 'true');
  });
  dare.append(dareChips, darePrompt, takeBtn);

  /* A hand-picked standard source drops the dare seed; programmatic checks
   * (take / lospec-cancel revert) fire no 'change' and keep it. */
  for (const { radio, value } of radios) {
    radio.addEventListener('change', () => {
      lastStandard = value;
      clearDare();
    });
  }

  let lospecOpen = false;
  const openLospec = (): void => {
    if (lospecOpen) return;
    lospecOpen = true;
    openLospecModal({
      onLoad: (p) => {
        lospecOpen = false;
        lospecColors = [...p.colors];
        lospecCaption.textContent = `lospec: ${p.name} (${p.colors.length})`;
        lospecRadio.checked = true;
        clearDare();
      },
      onCancel: () => {
        lospecOpen = false;
        if (lospecColors !== null) return; // keep the palette already loaded
        lospecRadio.checked = false;
        const back = radios.find((r) => r.value === lastStandard);
        if (back) back.radio.checked = true;
      },
    });
  };
  // click AND change (keyboard arrows) both land here; the flag dedupes
  lospecRadio.addEventListener('click', openLospec);
  lospecRadio.addEventListener('change', openLospec);

  const actions = div('sl-modal-actions');
  const cancel = button('sl-newdoc-cancel', 'cancel');
  cancel.addEventListener('click', () => modal.close());
  const create = button('sl-modal-primary sl-newdoc-create', 'create');
  actions.append(cancel, create);

  const submit = (): void => {
    const width = w.commit();
    if (width === null) {
      w.input.focus();
      return;
    }
    const height = h.commit();
    if (height === null) {
      h.input.focus();
      return;
    }
    const background = parseBg();
    if (background === null) {
      shake(bgInput);
      bgInput.focus();
      return;
    }
    let palette = radios.find((r) => r.radio.checked)?.value ?? 'starter';
    let seedColors: number[] | undefined;
    if (lospecRadio.checked) {
      palette = 'empty';
      if (lospecColors !== null) seedColors = [...lospecColors];
    } else if (dareSeed !== null && palette === 'empty') {
      seedColors = [...dareSeed];
    }
    const name = nameInput.value.trim() || 'untitled';
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    modal.close();
    const choice: NewDocChoice = { width, height, name, palette, background };
    if (seedColors !== undefined) choice.seedColors = seedColors;
    opts.onCreate(choice);
  };
  create.addEventListener('click', submit);
  routeEnter(modal.root, submit);

  const sizeCaption = document.createElement('span');
  sizeCaption.className = 'sl-newdoc-caption';
  sizeCaption.textContent = 'size';
  const sizeWrap = div('sl-newdoc-row');
  sizeWrap.append(sizeCaption, sizeRow('sl-newdoc-size', 'sl-newdoc-x', w, h));

  modal.root.append(title, presets, sizeWrap, nameLabel, palRow, bgRow, dare, actions);
  const onDemo = opts.onDemo;
  if (onDemo) {
    const foot = div('sl-newdoc-foot');
    const demo = button('sl-newdoc-demo', 'or open mochi, the demo cat');
    demo.addEventListener('click', () => {
      modal.close();
      onDemo();
    });
    foot.appendChild(demo);
    modal.root.appendChild(foot);
  }
  modal.open();
  syncChips();
  w.input.select();
}

export function openResizeModal(opts: {
  width: number;
  height: number;
  onResize: (w: number, h: number, anchor: ResizeAnchor) => void;
}): void {
  const modal = new Modal({ label: 'resize canvas', className: 'sl-resize' });

  const title = document.createElement('h2');
  title.className = 'sl-modal-title';
  title.textContent = 'resize canvas';

  const current = document.createElement('p');
  current.className = 'sl-resize-current';
  current.textContent = `current ${opts.width}${TIMES}${opts.height}`;

  const w = numField('sl-resize-num sl-resize-w', 'new width', opts.width);
  const h = numField('sl-resize-num sl-resize-h', 'new height', opts.height);

  let anchor: ResizeAnchor = 'tl';
  const grid = div('sl-resize-grid');
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'anchor');
  const anchorBtns = new Map<ResizeAnchor, HTMLButtonElement>();
  const syncAnchors = (): void => {
    for (const [a, btn] of anchorBtns) {
      const on = a === anchor;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
  for (const a of ANCHORS) {
    const btn = button('sl-resize-anchor', '');
    btn.dataset['anchor'] = a;
    btn.title = `anchor ${ANCHOR_NAMES[a]}`;
    btn.setAttribute('aria-label', `anchor ${ANCHOR_NAMES[a]}`);
    const dot = document.createElement('span');
    dot.className = 'sl-resize-dot';
    btn.appendChild(dot);
    btn.addEventListener('click', () => {
      anchor = a;
      syncAnchors();
    });
    anchorBtns.set(a, btn);
    grid.appendChild(btn);
  }
  syncAnchors();

  const anchorRow = div('sl-resize-row');
  const anchorCaption = document.createElement('span');
  anchorCaption.className = 'sl-resize-caption';
  anchorCaption.textContent = 'anchor';
  anchorRow.append(anchorCaption, grid);

  const sizeCaption = document.createElement('span');
  sizeCaption.className = 'sl-resize-caption';
  sizeCaption.textContent = 'new size';
  const sizeWrap = div('sl-resize-row');
  sizeWrap.append(sizeCaption, sizeRow('sl-resize-size', 'sl-resize-x', w, h));

  const actions = div('sl-modal-actions');
  const cancel = button('sl-resize-cancel', 'cancel');
  cancel.addEventListener('click', () => modal.close());
  const apply = button('sl-modal-primary sl-resize-apply', 'apply');
  actions.append(cancel, apply);

  const submit = (): void => {
    const width = w.commit();
    if (width === null) {
      w.input.focus();
      return;
    }
    const height = h.commit();
    if (height === null) {
      h.input.focus();
      return;
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    modal.close();
    if (width === opts.width && height === opts.height) return;
    opts.onResize(width, height, anchor);
  };
  apply.addEventListener('click', submit);
  routeEnter(modal.root, submit);

  modal.root.append(title, current, sizeWrap, anchorRow, actions);
  modal.open();
  w.input.select();
}

/** NewDocChoice → SpriteDoc: blank doc, palette source applied, background
 *  filled into the first cel. `currentColors` feeds the 'current' source
 *  (the app passes the live palette's colors). `seedColors`, when present,
 *  become the palette after the source (daily dare / lospec import). */
export function docFromChoice(choice: NewDocChoice, currentColors: readonly Rgba[]): SpriteDoc {
  const doc = SpriteDoc.blank(choice.width, choice.height, choice.name);
  if (choice.palette === 'current') doc.palette.colors = [...currentColors];
  else if (choice.palette === 'empty') doc.palette.colors = [];
  if (choice.seedColors !== undefined) doc.palette.colors = [...choice.seedColors];
  if (choice.background !== 0) doc.ensureCel(doc.celKeyAt(0, 0)).fill(choice.background);
  return doc;
}
