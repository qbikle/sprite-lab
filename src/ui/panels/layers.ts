/** Side panel: layer stack — active row, eye, opacity, rename, reorder, merge. */
import type { Bus } from '../../core/bus';
import type { SpriteDoc } from '../../core/doc';

export interface LayersOpts {
  host: HTMLElement;
  bus: Bus;
  getDoc(): SpriteDoc;
  getLayer(): number;
  setLayer(index: number): void;
  addLayer(): void;
  removeLayer(): void;
  moveLayer(dir: 1 | -1): void; // active layer up/down in the stack
  mergeDown(): void;
  setOpacity(index: number, opacity: number): void;
  setVisible(index: number, visible: boolean): void;
  rename(index: number, name: string): void;
}

const EYE_PX = [
  '...#####...',
  '..#.....#..',
  '.#..###..#.',
  '#..#####..#',
  '.#..###..#.',
  '..#.....#..',
  '...#####...',
] as const;

const UP_PX = [
  '...#...',
  '..###..',
  '.#####.',
  '#######',
] as const;

const TRASH_PX = [
  '..####..',
  '########',
  '.#....#.',
  '.#.##.#.',
  '.#.##.#.',
  '.#.##.#.',
  '.#....#.',
  '..####..',
] as const;

const MERGE_PX = [
  '...##...',
  '...##...',
  '.######.',
  '..####..',
  '...##...',
  '........',
  '########',
  '########',
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

export class LayersPanel {
  private readonly opts: LayersOpts;
  private readonly unsubs: Array<() => void> = [];
  private rootEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private delBtn: HTMLButtonElement | null = null;
  private upBtn: HTMLButtonElement | null = null;
  private downBtn: HTMLButtonElement | null = null;
  private mergeBtn: HTMLButtonElement | null = null;
  private rows: HTMLElement[] = []; // indexed by DOC index (bottom→top)
  private sliding = false;
  private pendingRefresh = false;

  constructor(opts: LayersOpts) {
    this.opts = opts;
  }

  mount(): void {
    const o = this.opts;
    const root = div('sl-layers');
    const head = div('sl-layers-head');
    const title = document.createElement('span');
    title.className = 'sl-layers-title';
    title.textContent = 'layers';
    const line = document.createElement('span');
    line.className = 'sl-layers-line';

    const headBtn = (title2: string, onClick: () => void): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sl-mini-btn';
      btn.title = title2;
      btn.addEventListener('click', onClick);
      return btn;
    };
    const add = headBtn('new layer', () => o.addLayer());
    add.textContent = '+';
    const del = headBtn('delete layer', () => o.removeLayer());
    del.appendChild(pxIcon(TRASH_PX, 12));
    const up = headBtn('move layer up (PgUp)', () => o.moveLayer(1));
    up.appendChild(pxIcon(UP_PX, 12));
    const down = headBtn('move layer down (PgDn)', () => o.moveLayer(-1));
    down.appendChild(pxIcon([...UP_PX].reverse(), 12));
    const merge = headBtn('merge down', () => o.mergeDown());
    merge.appendChild(pxIcon(MERGE_PX, 12));
    this.delBtn = del;
    this.upBtn = up;
    this.downBtn = down;
    this.mergeBtn = merge;

    head.append(title, line, add, del, up, down, merge);
    const list = div('sl-layers-list');
    root.append(head, list);
    o.host.appendChild(root);
    this.rootEl = root;
    this.listEl = list;

    this.unsubs.push(
      o.bus.on('doc:changed', ({ scope }) => {
        if (scope.kind === 'layers' || scope.kind === 'all') this.maybeRebuild();
      }),
      o.bus.on('doc:replaced', () => this.maybeRebuild()),
      o.bus.on('layer:active', () => this.syncActive()),
    );
    this.rebuild();
  }

  unmount(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.rootEl?.remove();
    this.rootEl = null;
    this.listEl = null;
    this.delBtn = this.upBtn = this.downBtn = this.mergeBtn = null;
    this.rows = [];
  }

  /** Opacity slider drags fire doc:changed per input — defer the rebuild until
   *  pointer-up so the range input under the pointer never gets replaced. */
  private maybeRebuild(): void {
    if (this.sliding) {
      this.pendingRefresh = true;
      return;
    }
    this.rebuild();
  }

  private endSlide(): void {
    if (!this.sliding) return;
    this.sliding = false;
    if (this.pendingRefresh) {
      this.pendingRefresh = false;
      this.rebuild();
    }
  }

  private rebuild(): void {
    const list = this.listEl;
    if (!list) return;
    const doc = this.opts.getDoc();

    const focused = document.activeElement;
    const focusIndex =
      focused instanceof HTMLInputElement && focused.classList.contains('sl-layer-alpha')
        ? Number(focused.dataset['index'])
        : null;

    list.replaceChildren();
    this.rows = new Array<HTMLElement>(doc.layers.length);
    for (let d = doc.layers.length - 1; d >= 0; d--) {
      const layer = doc.layers[d];
      if (!layer) continue;
      const row = this.buildRow(d, layer.name, layer.opacity, layer.visible);
      this.rows[d] = row;
      list.appendChild(row);
    }
    this.syncActive();

    if (focusIndex !== null && Number.isInteger(focusIndex)) {
      const next = list.querySelector<HTMLInputElement>(
        `.sl-layer-alpha[data-index="${focusIndex}"]`,
      );
      next?.focus();
    }
  }

  private buildRow(
    docIndex: number, name: string, opacity: number, visible: boolean,
  ): HTMLElement {
    const o = this.opts;
    const row = div('sl-layer-row');
    row.classList.toggle('off', !visible);

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'sl-layer-eye';
    eye.title = visible ? 'hide layer' : 'show layer';
    eye.setAttribute('aria-pressed', String(visible));
    eye.appendChild(pxIcon(EYE_PX, 13));
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      o.setVisible(docIndex, !visible);
    });

    const label = document.createElement('span');
    label.className = 'sl-layer-name';
    label.textContent = name;
    label.title = `${name} — double-click to rename`;
    label.addEventListener('dblclick', () => this.startRename(docIndex, label));

    const alpha = document.createElement('input');
    alpha.type = 'range';
    alpha.className = 'sl-range sl-layer-alpha';
    alpha.min = '0';
    alpha.max = '100';
    alpha.step = '1';
    alpha.value = String(Math.round(opacity * 100));
    alpha.title = `opacity ${Math.round(opacity * 100)}%`;
    alpha.dataset['index'] = String(docIndex);
    alpha.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.sliding = true;
    });
    alpha.addEventListener('pointerup', () => this.endSlide());
    alpha.addEventListener('pointercancel', () => this.endSlide());
    alpha.addEventListener('click', (e) => e.stopPropagation());
    alpha.addEventListener('input', () => {
      const v = Number(alpha.value);
      if (!Number.isFinite(v)) return;
      alpha.title = `opacity ${Math.round(v)}%`;
      o.setOpacity(docIndex, v / 100);
    });

    row.append(eye, label, alpha);
    row.addEventListener('click', () => {
      if (docIndex !== o.getLayer()) o.setLayer(docIndex);
    });
    return row;
  }

  private startRename(docIndex: number, label: HTMLElement): void {
    const layer = this.opts.getDoc().layers[docIndex];
    if (!layer) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sl-layer-rename';
    input.value = layer.name;
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== layer.name) this.opts.rename(docIndex, name);
      else this.rebuild();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  private syncActive(): void {
    const active = this.opts.getLayer();
    this.rows.forEach((row, d) => row.classList.toggle('active', d === active));
    const n = this.opts.getDoc().layers.length;
    if (this.delBtn) this.delBtn.disabled = n < 2;
    if (this.upBtn) this.upBtn.disabled = active >= n - 1;
    if (this.downBtn) this.downBtn.disabled = active <= 0;
    if (this.mergeBtn) this.mergeBtn.disabled = active <= 0;
  }
}
