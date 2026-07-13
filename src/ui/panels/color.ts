/** Right rail: active/prev color chips, hex input, palette swatches, recent colors. */
import type { Palette, Rgba } from '../../core/contracts';
import type { Bus } from '../../core/bus';
import { hexToRgba, rgbaToHex } from '../../core/pixels';
import { makeRamp } from '../../core/ramps';
import { downloadText, openPaletteFile, paletteToGpl } from '../../io/palettes';

export interface ColorPanelOpts {
  host: HTMLElement;
  bus: Bus;
  getColor(): Rgba;
  setColor(c: Rgba): void;
  swapColors(): void;
  getPalette(): Palette;
  /** Undoable palette add (AddPaletteColor via history). */
  addColor(c: Rgba): void;
  /** Undoable swatch replace (ReplacePaletteColor via history). */
  replaceColor(index: number, c: Rgba): void;
  /** Undoable swatch remove (RemovePaletteColor via history). */
  removeColor(index: number): void;
  /** Undoable ramp append (SetPalette via history; app dedupes vs existing). */
  addRamp(colors: Rgba[]): void;
  /** Undoable whole-palette replace (SetPalette via history). */
  setPalette(name: string, colors: Rgba[]): void;
  /** Doc name, for the .gpl download filename. */
  getDocName(): string;
}

const HEX_RE = /^#?(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

const SWAP_PX = [
  '....#..',
  '.....#.',
  '#######',
  '.....#.',
  '....#..',
  '.......',
  '..#....',
  '.#.....',
  '#######',
  '.#.....',
  '..#....',
] as const;

const EDIT_PX = [
  '.....##',
  '....###',
  '...###.',
  '..###..',
  '.###...',
  '###....',
  '#......',
] as const;

const RAMP_PX = [
  '....##',
  '....##',
  '..####',
  '..####',
  '######',
  '######',
] as const;

const SAVE_PX = [
  '...#...',
  '...#...',
  '.#####.',
  '..###..',
  '...#...',
  '#.....#',
  '#######',
] as const;

const LOAD_PX = [
  '...#...',
  '..###..',
  '.#####.',
  '...#...',
  '...#...',
  '#.....#',
  '#######',
] as const;

const SVG_NS = 'http://www.w3.org/2000/svg';

function pxIcon(rows: readonly string[], width: number): SVGSVGElement {
  const cols = rows[0]?.length ?? 1;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${cols} ${rows.length}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(Math.round((width * rows.length) / cols)));
  svg.setAttribute('aria-hidden', 'true');
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '#') continue;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', '1');
      rect.setAttribute('height', '1');
      rect.setAttribute('fill', 'currentColor');
      rect.setAttribute('shape-rendering', 'crispEdges');
      svg.appendChild(rect);
    }
  });
  return svg;
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function headBtn(rows: readonly string[], title: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sl-head-btn';
  btn.title = title;
  btn.appendChild(pxIcon(rows, 10));
  return btn;
}

export class ColorPanel {
  private readonly opts: ColorPanelOpts;
  private readonly unsubs: Array<() => void> = [];
  private rootEl: HTMLElement | null = null;
  private mainFill: HTMLElement | null = null;
  private prevFill: HTMLElement | null = null;
  private hexInput: HTMLInputElement | null = null;
  private paletteGrid: HTMLElement | null = null;
  private recentHead: HTMLElement | null = null;
  private recentGrid: HTMLElement | null = null;
  private editBtn: HTMLButtonElement | null = null;
  private editMode = false;
  private editHintShown = false;
  private cur: Rgba = 0;
  private prev: Rgba = 0;

  constructor(opts: ColorPanelOpts) {
    this.opts = opts;
  }

  mount(): void {
    const o = this.opts;
    this.cur = o.getColor();
    this.prev = this.cur;

    const root = div('sl-color');

    const chips = div('sl-color-chips');
    const main = div('sl-chip sl-chip-main');
    main.title = 'current color';
    const mainFill = document.createElement('span');
    mainFill.className = 'sl-chip-fill';
    main.appendChild(mainFill);
    const prev = div('sl-chip sl-chip-prev');
    prev.title = 'previous color';
    const prevFill = document.createElement('span');
    prevFill.className = 'sl-chip-fill';
    prev.appendChild(prevFill);
    const swap = document.createElement('button');
    swap.type = 'button';
    swap.className = 'sl-xswap';
    swap.title = 'swap colors (X)';
    swap.appendChild(pxIcon(SWAP_PX, 10));
    swap.addEventListener('click', () => o.swapColors());
    chips.append(main, prev, swap);

    const hex = document.createElement('input');
    hex.className = 'sl-hex';
    hex.type = 'text';
    hex.maxLength = 9;
    hex.placeholder = '#rrggbb';
    hex.autocomplete = 'off';
    hex.spellcheck = false;
    hex.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        this.commitHex();
        hex.blur(); // hand focus back to the canvas so hotkeys work immediately
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        this.syncHex(true);
        hex.blur();
      }
    });
    hex.addEventListener('blur', () => this.commitHex());
    hex.addEventListener('animationend', () => hex.classList.remove('sl-shake'));

    const palHead = div('sl-panel-head sl-head-row');
    const palTitle = document.createElement('span');
    palTitle.textContent = 'palette';
    const palLine = div('sl-head-line');
    const editBtn = headBtn(EDIT_PX, 'edit palette: click = replace with current, alt-click = remove');
    editBtn.addEventListener('click', () => this.toggleEdit());
    const rampBtn = headBtn(RAMP_PX, 'add a 5-step ramp from the current color');
    rampBtn.addEventListener('click', () => {
      const base = o.getColor();
      if (base === 0) {
        o.bus.emit('status:message', { text: 'pick a color first — ramps need a base' });
        return;
      }
      o.addRamp(makeRamp(base, 5));
    });
    const saveBtn = headBtn(SAVE_PX, 'save palette (.gpl)');
    saveBtn.addEventListener('click', () => this.savePalette());
    const loadBtn = headBtn(LOAD_PX, 'load palette (.gpl / .json)');
    loadBtn.addEventListener('click', () => {
      openPaletteFile((name, colors) => o.setPalette(name, colors));
    });
    palHead.append(palTitle, palLine, editBtn, rampBtn, saveBtn, loadBtn);
    const palGrid = div('sl-swatches');
    const recHead = div('sl-panel-head');
    recHead.textContent = 'recent';
    const recGrid = div('sl-swatches sl-recent');

    root.append(chips, hex, palHead, palGrid, recHead, recGrid);
    o.host.appendChild(root);

    this.rootEl = root;
    this.mainFill = mainFill;
    this.prevFill = prevFill;
    this.hexInput = hex;
    this.paletteGrid = palGrid;
    this.recentHead = recHead;
    this.recentGrid = recGrid;
    this.editBtn = editBtn;

    this.unsubs.push(
      o.bus.on('color:changed', ({ color }) => {
        if (color !== this.cur) {
          this.prev = this.cur;
          this.cur = color;
        }
        this.refresh();
      }),
      o.bus.on('palette:changed', () => this.refresh()),
      o.bus.on('doc:replaced', () => {
        this.cur = o.getColor();
        this.prev = this.cur;
        this.refresh();
      }),
    );
    this.refresh();
  }

  unmount(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.rootEl?.remove();
    this.rootEl = null;
    this.mainFill = this.prevFill = null;
    this.hexInput = null;
    this.paletteGrid = this.recentHead = this.recentGrid = null;
    this.editBtn = null;
  }

  private refresh(): void {
    if (this.mainFill) this.mainFill.style.background = this.cssColor(this.cur);
    if (this.prevFill) this.prevFill.style.background = this.cssColor(this.prev);
    this.syncHex();

    const pal = this.opts.getPalette();
    const grid = this.paletteGrid;
    if (grid) {
      grid.classList.toggle('editing', this.editMode);
      grid.replaceChildren();
      grid.appendChild(this.swatch(0, this.cur === 0, 'transparent (erase ink)'));
      pal.colors.forEach((c, i) => {
        if (c === 0) return;
        grid.appendChild(this.swatch(c, c === this.cur, undefined, i));
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'sl-sw sl-sw-add';
      add.textContent = '+';
      add.title = 'add current color';
      add.addEventListener('click', () => this.opts.addColor(this.opts.getColor()));
      grid.appendChild(add);
    }

    const recent = pal.recent.slice(0, 10);
    const empty = recent.length === 0;
    if (this.recentHead) this.recentHead.hidden = empty;
    if (this.recentGrid) {
      this.recentGrid.hidden = empty;
      this.recentGrid.replaceChildren(...recent.map((c) => this.swatch(c, c === this.cur)));
    }
  }

  private swatch(c: Rgba, active: boolean, title?: string, palIndex?: number): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = c === 0 ? 'sl-sw sl-sw-clear' : 'sl-sw';
    const editable = this.editMode && palIndex !== undefined;
    btn.title = editable
      ? `${rgbaToHex(c)} — click: replace with current, alt-click: remove`
      : title ?? rgbaToHex(c);
    if (active) btn.classList.add('active');
    if (c !== 0) {
      const fill = document.createElement('span');
      fill.className = 'sl-sw-fill';
      fill.style.background = rgbaToHex(c);
      btn.appendChild(fill);
    }
    btn.addEventListener('click', (e) => {
      if (this.editMode && palIndex !== undefined) {
        if (e.altKey) {
          this.opts.removeColor(palIndex);
          return;
        }
        const cur = this.opts.getColor();
        if (cur === 0) {
          this.opts.bus.emit('status:message', {
            text: 'current color is transparent — pick a color to replace with',
          });
          return;
        }
        this.opts.replaceColor(palIndex, cur);
        return;
      }
      this.opts.setColor(c);
    });
    return btn;
  }

  private toggleEdit(): void {
    this.editMode = !this.editMode;
    this.editBtn?.classList.toggle('active', this.editMode);
    if (this.editMode && !this.editHintShown) {
      this.editHintShown = true;
      this.opts.bus.emit('status:message', {
        text: 'edit palette: click = replace with current, alt-click = remove',
      });
    }
    this.refresh();
  }

  private savePalette(): void {
    const pal = this.opts.getPalette();
    const docName = this.opts.getDocName();
    downloadText(paletteToGpl(pal.name || docName, pal.colors), `${docName}.gpl`);
  }

  private cssColor(c: Rgba): string {
    return c === 0 ? 'transparent' : rgbaToHex(c);
  }

  private syncHex(force = false): void {
    const input = this.hexInput;
    if (!input) return;
    if (!force && document.activeElement === input) return;
    input.value = rgbaToHex(this.cur);
  }

  private commitHex(): void {
    const input = this.hexInput;
    if (!input) return;
    const raw = input.value.trim();
    if (HEX_RE.test(raw)) {
      const c = hexToRgba(raw.startsWith('#') ? raw : `#${raw}`);
      if (c !== null) {
        this.opts.setColor(c);
        input.value = rgbaToHex(c);
        return;
      }
    }
    this.syncHex(true);
    input.classList.remove('sl-shake');
    void input.offsetWidth;
    input.classList.add('sl-shake');
  }
}
