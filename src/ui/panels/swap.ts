/** Coat-swap panel: map the doc's used colors to replacements, apply as ONE command. */
import type { Rgba } from '../../core/contracts';
import type { Bus } from '../../core/bus';
import type { SwapPair } from '../../core/commands/palette-swap';
import { rgbaToHex } from '../../core/pixels';

export interface SwapPanelOpts {
  host: HTMLElement;
  bus: Bus;
  /** Frequency-ordered colors in use (usedColors under the hood). */
  getUsedColors(): Rgba[];
  getCurrentColor(): Rgba;
  /** Commit the swap through history. */
  applySwap(pairs: readonly SwapPair[]): void;
}

const MAX_ROWS = 12;
const LONG_PRESS_MS = 500;

const CARET_RIGHT_PX = [
  '#....',
  '###..',
  '#####',
  '###..',
  '#....',
] as const;

const CARET_DOWN_PX = [
  '.....',
  '#####',
  '.###.',
  '..#..',
  '.....',
] as const;

const ARROW_PX = [
  '....#..',
  '.....#.',
  '#######',
  '.....#.',
  '....#..',
] as const;

const RESCAN_PX = [
  '..###.#',
  '.#...##',
  '#...###',
  '#......',
  '#......',
  '.#...#.',
  '..###..',
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

export class SwapPanel {
  private readonly opts: SwapPanelOpts;
  private readonly unsubs: Array<() => void> = [];
  private rootEl: HTMLElement | null = null;
  private caretEl: HTMLElement | null = null;
  private rescanBtn: HTMLButtonElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private rowsEl: HTMLElement | null = null;
  private applyBtn: HTMLButtonElement | null = null;
  private clearBtn: HTMLButtonElement | null = null;
  private expanded = false;
  private used: Rgba[] = [];
  private readonly mapping = new Map<Rgba, Rgba>();
  private pressTimer: number | null = null;
  private suppressClick = false;

  constructor(opts: SwapPanelOpts) {
    this.opts = opts;
  }

  mount(): void {
    const o = this.opts;
    const root = div('sl-swap');

    const head = div('sl-panel-head sl-head-row sl-swap-head');
    head.title = 'coat swap — map used colors to new ones, apply everywhere';
    const caret = document.createElement('span');
    caret.className = 'sl-swap-caret';
    const title = document.createElement('span');
    title.textContent = 'coat swap';
    const line = div('sl-head-line');
    const rescan = document.createElement('button');
    rescan.type = 'button';
    rescan.className = 'sl-head-btn';
    rescan.title = 'rescan used colors';
    rescan.appendChild(pxIcon(RESCAN_PX, 10));
    rescan.addEventListener('click', (e) => {
      e.stopPropagation();
      this.rescan();
    });
    head.append(caret, title, line, rescan);
    head.addEventListener('click', () => this.toggle());

    const body = div('sl-swap-body');
    const rows = div('sl-swap-rows');
    const actions = div('sl-swap-actions');
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'sl-swap-apply';
    apply.textContent = 'apply swap';
    apply.title = 'remaps every frame & layer — one undo step';
    apply.addEventListener('click', () => this.apply());
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'sl-swap-clearbtn';
    clear.textContent = 'clear';
    clear.title = 'reset mappings';
    clear.addEventListener('click', () => {
      this.mapping.clear();
      this.renderRows();
    });
    actions.append(apply, clear);
    body.append(rows, actions);

    root.append(head, body);
    o.host.appendChild(root);

    this.rootEl = root;
    this.caretEl = caret;
    this.rescanBtn = rescan;
    this.bodyEl = body;
    this.rowsEl = rows;
    this.applyBtn = apply;
    this.clearBtn = clear;

    this.unsubs.push(
      o.bus.on('doc:replaced', () => {
        this.mapping.clear();
        if (this.expanded) this.rescan();
        else this.used = [];
      }),
    );

    this.syncExpanded();
  }

  unmount(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.clearPressTimer();
    this.rootEl?.remove();
    this.rootEl = null;
    this.caretEl = null;
    this.rescanBtn = null;
    this.bodyEl = this.rowsEl = null;
    this.applyBtn = this.clearBtn = null;
  }

  private toggle(): void {
    this.expanded = !this.expanded;
    this.syncExpanded();
    if (this.expanded) this.rescan();
  }

  private syncExpanded(): void {
    if (this.caretEl) {
      this.caretEl.replaceChildren(
        pxIcon(this.expanded ? CARET_DOWN_PX : CARET_RIGHT_PX, 7),
      );
    }
    if (this.rescanBtn) this.rescanBtn.hidden = !this.expanded;
    if (this.bodyEl) this.bodyEl.hidden = !this.expanded;
  }

  private rescan(): void {
    this.used = this.opts.getUsedColors().slice(0, MAX_ROWS);
    for (const from of [...this.mapping.keys()]) {
      if (!this.used.includes(from)) this.mapping.delete(from);
    }
    this.renderRows();
  }

  private renderRows(): void {
    const rows = this.rowsEl;
    if (!rows) return;
    rows.replaceChildren();
    if (this.used.length === 0) {
      const empty = div('sl-swap-empty');
      empty.textContent = 'no colors in use';
      rows.appendChild(empty);
    }
    for (const from of this.used) rows.appendChild(this.row(from));
    this.syncButtons();
  }

  private row(from: Rgba): HTMLElement {
    const row = div('sl-swap-row');
    const to = this.mapping.get(from);
    if (to !== undefined) row.classList.add('mapped');

    const src = document.createElement('span');
    src.className = 'sl-swap-chip';
    src.title = rgbaToHex(from);
    const srcFill = document.createElement('span');
    srcFill.className = 'sl-swap-fill';
    srcFill.style.background = rgbaToHex(from);
    src.appendChild(srcFill);

    const arrow = document.createElement('span');
    arrow.className = 'sl-swap-arrow';
    arrow.appendChild(pxIcon(ARROW_PX, 12));

    row.append(src, arrow, this.targetChip(from, to));
    return row;
  }

  private targetChip(from: Rgba, to: Rgba | undefined): HTMLButtonElement {
    const target = document.createElement('button');
    target.type = 'button';
    target.className = 'sl-swap-chip sl-swap-target';
    if (to === undefined) {
      const dash = document.createElement('span');
      dash.className = 'sl-swap-dash';
      dash.textContent = '–';
      target.appendChild(dash);
      target.title = 'set target: current color';
    } else {
      target.classList.add('set');
      if (to === 0) {
        target.classList.add('clear');
        target.title = 'transparent — right-click to clear mapping';
      } else {
        const fill = document.createElement('span');
        fill.className = 'sl-swap-fill';
        fill.style.background = rgbaToHex(to);
        target.appendChild(fill);
        target.title = `${rgbaToHex(to)} — right-click to clear mapping`;
      }
    }

    target.addEventListener('click', () => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.mapping.set(from, this.opts.getCurrentColor());
      this.renderRows();
    });
    target.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.mapping.delete(from)) this.renderRows();
    });
    target.addEventListener('pointerdown', (e) => {
      this.suppressClick = false;
      if (e.pointerType === 'mouse') return;
      this.clearPressTimer();
      this.pressTimer = window.setTimeout(() => {
        this.pressTimer = null;
        this.suppressClick = true;
        if (this.mapping.delete(from)) this.renderRows();
      }, LONG_PRESS_MS);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const) {
      target.addEventListener(ev, () => this.clearPressTimer());
    }
    return target;
  }

  private apply(): void {
    if (this.mapping.size === 0) return;
    const pairs: SwapPair[] = [...this.mapping.entries()]
      .filter(([from, to]) => from !== to)
      .map(([from, to]) => ({ from, to }));
    if (pairs.length > 0) {
      this.opts.applySwap(pairs);
      const n = pairs.length;
      this.opts.bus.emit('status:message', {
        text: `swapped ${n} color${n === 1 ? '' : 's'} across all frames & layers`,
      });
    } else {
      this.opts.bus.emit('status:message', { text: 'nothing to swap' });
    }
    this.mapping.clear();
    this.rescan();
  }

  private syncButtons(): void {
    const none = this.mapping.size === 0;
    if (this.applyBtn) this.applyBtn.disabled = none;
    if (this.clearBtn) this.clearBtn.disabled = none;
  }

  private clearPressTimer(): void {
    if (this.pressTimer !== null) {
      window.clearTimeout(this.pressTimer);
      this.pressTimer = null;
    }
  }
}
