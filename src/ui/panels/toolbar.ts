/** Left rail: tool buttons (hotkey badges) + brush size + symmetry/dither + undo/redo. */
import type { DitherMode, SymmetryMode, ToolId } from '../../core/contracts';
import type { Bus } from '../../core/bus';
import type { Tool } from '../../tools/tool';
import { icon, type IconName } from '../icons';

export interface ToolbarOpts {
  host: HTMLElement;
  bus: Bus;
  tools: readonly Tool[];
  getActive(): ToolId;
  onSelect(id: ToolId): void;
  getBrush(): number;
  onBrush(size: number): void;
  getSymmetry(): SymmetryMode;
  onSymmetry(): void;
  getDither(): DitherMode;
  onDither(): void;
  onUndo(): void;
  onRedo(): void;
}

const IS_MAC = /mac|iphone|ipad|ipod/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform,
);
const MOD = IS_MAC ? 'cmd' : 'ctrl';

const SYM_ICON: Record<SymmetryMode, IconName> = {
  off: 'sym-off',
  x: 'sym-x',
  y: 'sym-y',
  quad: 'sym-quad',
};

const DITHER_ICON: Record<DitherMode, IconName> = {
  off: 'dither-off',
  bayer2: 'dither-2x',
  bayer4: 'dither-4x',
};

function modeIcon(name: IconName): SVGSVGElement {
  return icon(name);
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
  private symBtn: HTMLButtonElement | null = null;
  private ditherBtn: HTMLButtonElement | null = null;
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
      glyph.appendChild(icon(tool.id));
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

    const modes = div('sl-modes');
    const sym = document.createElement('button');
    sym.type = 'button';
    sym.className = 'sl-mode-btn';
    sym.addEventListener('click', () => o.onSymmetry());
    const dither = document.createElement('button');
    dither.type = 'button';
    dither.className = 'sl-mode-btn';
    dither.addEventListener('click', () => o.onDither());
    modes.append(sym, dither);
    this.symBtn = sym;
    this.ditherBtn = dither;

    const hist = div('sl-hist');
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'sl-hist-btn';
    undo.title = `undo (${MOD}+z)`;
    undo.disabled = true;
    undo.appendChild(icon('undo'));
    undo.addEventListener('click', () => o.onUndo());
    const redo = document.createElement('button');
    redo.type = 'button';
    redo.className = 'sl-hist-btn';
    redo.title = `redo (${MOD}+shift+z)`;
    redo.disabled = true;
    redo.appendChild(icon('redo'));
    redo.addEventListener('click', () => o.onRedo());
    hist.append(undo, redo);
    this.undoBtn = undo;
    this.redoBtn = redo;

    o.host.append(tools, div('sl-sep'), brush, div('sl-sep'), modes, div('sl-sep'), hist);

    this.unsubs.push(
      o.bus.on('tool:changed', () => this.syncActive()),
      o.bus.on('brush:changed', ({ size }) => this.syncBrush(size)),
      o.bus.on('symmetry:changed', () => this.syncModes()),
      o.bus.on('dither:changed', () => this.syncModes()),
      o.bus.on('history:changed', ({ canUndo, canRedo }) => {
        if (this.undoBtn) this.undoBtn.disabled = !canUndo;
        if (this.redoBtn) this.redoBtn.disabled = !canRedo;
      }),
    );
    this.syncActive();
    this.syncBrush(o.getBrush());
    this.syncModes();
  }

  unmount(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.toolBtns.clear();
    this.opts.host.replaceChildren();
    this.brushDot = this.brushNum = this.brushTile = null;
    this.symBtn = this.ditherBtn = null;
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

  private syncModes(): void {
    const sym = this.symBtn;
    if (sym) {
      const mode = this.opts.getSymmetry();
      sym.classList.toggle('active', mode !== 'off');
      sym.setAttribute('aria-pressed', String(mode !== 'off'));
      sym.title = `symmetry: ${mode} (S)`;
      // off state still renders its glyph — an empty tile reads as broken
      sym.replaceChildren(modeIcon(SYM_ICON[mode]));
    }
    const dither = this.ditherBtn;
    if (dither) {
      const mode = this.opts.getDither();
      dither.classList.toggle('active', mode !== 'off');
      dither.setAttribute('aria-pressed', String(mode !== 'off'));
      dither.title =
        `dither: ${mode === 'bayer2' ? '2×2' : mode === 'bayer4' ? '4×4' : 'off'} (D)`;
      dither.replaceChildren(modeIcon(DITHER_ICON[mode]));
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
