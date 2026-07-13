/** Left rail: tool buttons (hotkey badges) + brush size + undo/redo. */
import type { ToolId } from '../../core/contracts';
import type { Bus } from '../../core/bus';
import type { Tool } from '../../tools/tool';

export interface ToolbarOpts {
  host: HTMLElement;
  bus: Bus;
  tools: readonly Tool[];
  getActive(): ToolId;
  onSelect(id: ToolId): void;
  getBrush(): number;
  onBrush(size: number): void;
  onUndo(): void;
  onRedo(): void;
}

const IS_MAC = /mac|iphone|ipad|ipod/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform,
);
const MOD = IS_MAC ? 'cmd' : 'ctrl';

const UNDO_PX = [
  '..#......',
  '.##......',
  '#########',
  '.##.....#',
  '..#.....#',
  '........#',
  '.....####',
] as const;

/* 12×12 px-map tool icons, keyed by ToolId (fallback: label monogram). */
const TOOL_PX: Partial<Record<ToolId, readonly string[]>> = {
  pencil: [
    '........##..',
    '.......#..#.',
    '......#..##.',
    '.....#..#.#.',
    '....#..#.##.',
    '...#..#..#..',
    '..#..#..#...',
    '.#..#..#....',
    '.#.#..#.....',
    '.##..#......',
    '.####.......',
    '............',
  ],
  eraser: [
    '............',
    '.....######.',
    '....#....##.',
    '...#....#.#.',
    '..#....#..#.',
    '.#....#..##.',
    '.#...#..##..',
    '.#..#..##...',
    '.#.#..##....',
    '.####.##....',
    '............',
    '............',
  ],
  eyedropper: [
    '.......###..',
    '......#####.',
    '.......###..',
    '......#.##..',
    '.....#..#...',
    '....#..#....',
    '...#..#.....',
    '..#..#......',
    '.##.#.......',
    '.#.#........',
    '..#.........',
    '............',
  ],
  fill: [
    '....#.......',
    '...###......',
    '..##.##.....',
    '.##...##....',
    '##..#..##...',
    '.##..#..##..',
    '..##..#.###.',
    '...##..##.#.',
    '....####..#.',
    '.......#.#..',
    '........#...',
    '............',
  ],
};

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

function mirrored(rows: readonly string[]): string[] {
  return rows.map((row) => [...row].reverse().join(''));
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function miniBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sl-mini-btn';
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

export class ToolbarPanel {
  private readonly opts: ToolbarOpts;
  private readonly unsubs: Array<() => void> = [];
  private readonly toolBtns = new Map<ToolId, HTMLButtonElement>();
  private brushDot: HTMLElement | null = null;
  private brushNum: HTMLElement | null = null;
  private brushTile: HTMLElement | null = null;
  private undoBtn: HTMLButtonElement | null = null;
  private redoBtn: HTMLButtonElement | null = null;

  constructor(opts: ToolbarOpts) {
    this.opts = opts;
  }

  mount(): void {
    const o = this.opts;

    const tools = div('sl-tools');
    for (const tool of o.tools) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sl-tool-btn';
      btn.title = `${tool.label} (${tool.hotkey.toUpperCase()})`;
      const glyph = document.createElement('span');
      glyph.className = 'sl-tool-glyph';
      const px = TOOL_PX[tool.id];
      if (px) glyph.appendChild(pxIcon(px, 22));
      else glyph.textContent = (tool.label.charAt(0) || '?').toUpperCase();
      const key = document.createElement('span');
      key.className = 'sl-tool-key';
      key.textContent = tool.hotkey.toLowerCase();
      btn.append(glyph, key);
      btn.addEventListener('click', () => o.onSelect(tool.id));
      this.toolBtns.set(tool.id, btn);
      tools.appendChild(btn);
    }

    const brush = div('sl-brush');
    const tile = div('sl-brush-tile');
    const dot = document.createElement('span');
    dot.className = 'sl-brush-dot';
    const num = document.createElement('span');
    num.className = 'sl-brush-num';
    tile.append(dot, num);
    const row = div('sl-brush-row');
    row.append(
      miniBtn('-', 'smaller brush ([)', () => o.onBrush(Math.max(1, o.getBrush() - 1))),
      miniBtn('+', 'larger brush (])', () => o.onBrush(Math.min(8, o.getBrush() + 1))),
    );
    brush.append(tile, row);
    this.brushDot = dot;
    this.brushNum = num;
    this.brushTile = tile;

    const hist = div('sl-hist');
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'sl-hist-btn';
    undo.title = `undo (${MOD}+z)`;
    undo.disabled = true;
    undo.appendChild(pxIcon(UNDO_PX, 18));
    undo.addEventListener('click', () => o.onUndo());
    const redo = document.createElement('button');
    redo.type = 'button';
    redo.className = 'sl-hist-btn';
    redo.title = `redo (${MOD}+shift+z)`;
    redo.disabled = true;
    redo.appendChild(pxIcon(mirrored(UNDO_PX), 18));
    redo.addEventListener('click', () => o.onRedo());
    hist.append(undo, redo);
    this.undoBtn = undo;
    this.redoBtn = redo;

    o.host.append(tools, div('sl-sep'), brush, div('sl-sep'), hist);

    this.unsubs.push(
      o.bus.on('tool:changed', () => this.syncActive()),
      o.bus.on('brush:changed', ({ size }) => this.syncBrush(size)),
      o.bus.on('history:changed', ({ canUndo, canRedo }) => {
        if (this.undoBtn) this.undoBtn.disabled = !canUndo;
        if (this.redoBtn) this.redoBtn.disabled = !canRedo;
      }),
    );
    this.syncActive();
    this.syncBrush(o.getBrush());
  }

  unmount(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.toolBtns.clear();
    this.opts.host.replaceChildren();
    this.brushDot = this.brushNum = this.brushTile = null;
    this.undoBtn = this.redoBtn = null;
  }

  private syncActive(): void {
    const active = this.opts.getActive();
    for (const [id, btn] of this.toolBtns) {
      const on = id === active;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }

  private syncBrush(size: number): void {
    const px = `${size * 3 + 2}px`;
    if (this.brushDot) {
      this.brushDot.style.width = px;
      this.brushDot.style.height = px;
    }
    if (this.brushNum) this.brushNum.textContent = String(size);
    if (this.brushTile) this.brushTile.title = `brush size ${size}`;
  }
}
