/** Hand-rolled HSV color picker on the shared Modal primitive — Wave 10.
 *  SV square + hue/alpha strips (dpr-crisp canvases), before/after chips,
 *  hex field (.sl-hex idiom), EyeDropper when the platform has it.
 *  HSV↔RGB math is pure and exported for unit tests. */
import type { Rgba } from '../core/contracts';
import { hexToRgba, packRgba, rgbaToHex, unpackRgba } from '../core/pixels';
import { icon } from './icons';
import { Modal } from './modal';

/* ── pure math ──────────────────────────────────────────── */

/** [h 0..360, s 0..1, v 0..1]. Achromatic input reports h=0 (hue undefined). */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const v = max;
  if (d === 0) return [0, 0, v];
  const s = d / max;
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, v];
}

/** h wraps mod 360; s/v expected 0..1. Returns 0..255 channel ints. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Packed → [h, s, v, a(0..255)]. Alpha rides through untouched. */
export function rgbaToHsva(c: Rgba): [number, number, number, number] {
  const [r, g, b, a] = unpackRgba(c);
  const [h, s, v] = rgbToHsv(r, g, b);
  return [h, s, v, a];
}

/** [h, s, v, a] → packed. a=0 collapses to canonical transparent 0. */
export function hsvaToRgba(h: number, s: number, v: number, a: number): Rgba {
  const [r, g, b] = hsvToRgb(h, s, v);
  return packRgba(r, g, b, a);
}

/* ── component ──────────────────────────────────────────── */

const SV_W = 216;
const SV_H = 148;
const STRIP_H = 16;
const HEX_RE = /^#?(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function shake(el: HTMLElement): void {
  el.classList.remove('sl-shake');
  void el.offsetWidth;
  el.classList.add('sl-shake');
}

/** dpr-sized canvas at a fixed CSS box — crisp on hidpi, like the viewport. */
function makeCanvas(className: string, w: number, h: number, label: string): HTMLCanvasElement {
  const el = document.createElement('canvas');
  el.className = className;
  const dpr = window.devicePixelRatio || 1;
  el.width = Math.max(1, Math.round(w * dpr));
  el.height = Math.max(1, Math.round(h * dpr));
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.setAttribute('aria-label', label);
  return el;
}

function ctx2d(el: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = el.getContext('2d');
  if (!g) throw new Error('2d context unavailable');
  const dpr = window.devicePixelRatio || 1;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

/** Pointer-captured drag → normalized (0..1, 0..1) content coords. Edges are
 *  reachable exactly: /(size-1) so the last pixel maps to 1.0. Corrects for
 *  clientLeft/Top (canvas borders — see gotcha ledger). */
function dragXY(el: HTMLCanvasElement, onXY: (fx: number, fy: number) => void): void {
  const apply = (e: PointerEvent): void => {
    const rect = el.getBoundingClientRect();
    const w = el.clientWidth;
    const h = el.clientHeight;
    const x = e.clientX - rect.left - el.clientLeft;
    const y = e.clientY - rect.top - el.clientTop;
    onXY(w > 1 ? clamp01(x / (w - 1)) : 0, h > 1 ? clamp01(y / (h - 1)) : 0);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    apply(e);
  });
  el.addEventListener('pointermove', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    apply(e);
  });
}

interface EyeDropperHandle {
  open(): Promise<{ sRGBHex: string }>;
}

export function openColorPicker(opts: {
  /** Rgba (LE-ABGR u32) — 0 seeds full-alpha black. */
  initial: Rgba;
  /** Fired ONCE on confirm; never on cancel/Esc/backdrop. */
  onPick: (c: Rgba) => void;
  title?: string;
}): void {
  const seed: Rgba = opts.initial === 0 ? packRgba(0, 0, 0, 255) : opts.initial;
  let [h, s, v, a] = rgbaToHsva(seed);
  let picked = false;

  /* theme-resolved checker colors for the alpha strip (canvas can't var()) */
  const rootStyle = getComputedStyle(document.documentElement);
  const checkerA = rootStyle.getPropertyValue('--checker-a').trim() || '#20213a';
  const checkerB = rootStyle.getPropertyValue('--checker-b').trim() || '#2a2c48';

  /** New color from packed rgba, keeping axes the source can't express:
   *  achromatic keeps the old hue; v=0 additionally keeps old saturation. */
  const setFromRgba = (c: Rgba): void => {
    const [r, g, b, na] = unpackRgba(c);
    const [nh, ns, nv] = rgbToHsv(r, g, b);
    if (nv > 0 && ns > 0) h = nh;
    if (nv > 0) s = ns;
    v = nv;
    a = na;
  };

  const current = (): Rgba => hsvaToRgba(h, s, v, a);

  /* ── DOM ── */
  const title = document.createElement('h2');
  title.className = 'sl-modal-title';
  title.textContent = opts.title ?? 'pick a color';

  const sv = makeCanvas('sl-picker-sv', SV_W, SV_H, 'saturation and value');
  sv.tabIndex = 0;
  const hue = makeCanvas('sl-picker-strip sl-picker-hue', SV_W, STRIP_H, 'hue');
  const alpha = makeCanvas('sl-picker-strip sl-picker-alpha', SV_W, STRIP_H, 'alpha');

  const row = document.createElement('div');
  row.className = 'sl-picker-row';
  const chips = document.createElement('div');
  chips.className = 'sl-picker-chips';
  const before = document.createElement('button');
  before.type = 'button';
  before.className = 'sl-picker-chip sl-picker-before';
  before.title = `original ${rgbaToHex(seed)} — click to reset`;
  const beforeFill = document.createElement('span');
  beforeFill.className = 'sl-picker-fill';
  beforeFill.style.background = rgbaToHex(seed);
  before.appendChild(beforeFill);
  const after = document.createElement('span');
  after.className = 'sl-picker-chip sl-picker-after';
  after.title = 'new color';
  const afterFill = document.createElement('span');
  afterFill.className = 'sl-picker-fill';
  after.appendChild(afterFill);
  chips.append(before, after);

  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.className = 'sl-picker-hex';
  hexInput.maxLength = 9;
  hexInput.placeholder = '#rrggbb';
  hexInput.autocomplete = 'off';
  hexInput.spellcheck = false;
  hexInput.setAttribute('aria-label', 'hex color');

  row.append(chips, hexInput);

  if ('EyeDropper' in window) {
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'sl-picker-eye';
    eye.title = 'pick from screen';
    eye.appendChild(icon('eyedropper'));
    eye.addEventListener('click', () => {
      const Ctor = (window as unknown as { EyeDropper: new () => EyeDropperHandle }).EyeDropper;
      new Ctor()
        .open()
        .then((res) => {
          const c = hexToRgba(res.sRGBHex);
          if (c === null) return;
          const [r, g, b] = unpackRgba(c);
          // screen samples are opaque; keep the dialed-in alpha unless it
          // would make the sample invisible
          setFromRgba(packRgba(r, g, b, a === 0 ? 255 : a));
          sync();
        })
        .catch(() => {
          /* user cancelled the dropper */
        });
    });
    row.appendChild(eye);
  }

  const actions = document.createElement('div');
  actions.className = 'sl-modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sl-picker-cancel';
  cancel.textContent = 'cancel';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'sl-modal-primary sl-picker-ok';
  ok.textContent = 'use color';
  actions.append(cancel, ok);

  /* ── rendering ── */
  const renderSV = (): void => {
    const g = ctx2d(sv);
    const [hr, hg, hb] = hsvToRgb(h, 1, 1);
    g.fillStyle = `rgb(${hr},${hg},${hb})`;
    g.fillRect(0, 0, SV_W, SV_H);
    const white = g.createLinearGradient(0, 0, SV_W, 0);
    white.addColorStop(0, 'rgba(255,255,255,1)');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = white;
    g.fillRect(0, 0, SV_W, SV_H);
    const black = g.createLinearGradient(0, 0, 0, SV_H);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = black;
    g.fillRect(0, 0, SV_W, SV_H);
    const mx = s * (SV_W - 1);
    const my = (1 - v) * (SV_H - 1);
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.beginPath();
    g.arc(mx, my, 5, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 1.5;
    g.strokeStyle = '#ffffff';
    g.beginPath();
    g.arc(mx, my, 5, 0, Math.PI * 2);
    g.stroke();
  };

  /** Marker stays fully inside the strip even at 0/255 — the extremes are the
   *  common states and a half-clipped notch reads as a rendering bug. */
  const notch = (g: CanvasRenderingContext2D, x: number): void => {
    const nx = Math.max(3.5, Math.min(SV_W - 3.5, x));
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.strokeRect(nx - 2, 1.5, 4, STRIP_H - 3);
    g.lineWidth = 1.5;
    g.strokeStyle = '#ffffff';
    g.strokeRect(nx - 2, 1.5, 4, STRIP_H - 3);
  };

  const renderHue = (): void => {
    const g = ctx2d(hue);
    const grad = g.createLinearGradient(0, 0, SV_W, 0);
    const stops = ['#f00', '#ff0', '#0f0', '#0ff', '#00f', '#f0f', '#f00'];
    stops.forEach((c, i) => grad.addColorStop(i / (stops.length - 1), c));
    g.fillStyle = grad;
    g.fillRect(0, 0, SV_W, STRIP_H);
    notch(g, (h / 360) * (SV_W - 1));
  };

  const renderAlpha = (): void => {
    const g = ctx2d(alpha);
    const cell = 8;
    for (let y = 0; y * cell < STRIP_H; y++) {
      for (let x = 0; x * cell < SV_W; x++) {
        g.fillStyle = (x + y) % 2 === 0 ? checkerA : checkerB;
        g.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    const [r, gg, b] = hsvToRgb(h, s, v);
    const grad = g.createLinearGradient(0, 0, SV_W, 0);
    grad.addColorStop(0, `rgba(${r},${gg},${b},0)`);
    grad.addColorStop(1, `rgba(${r},${gg},${b},1)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, SV_W, STRIP_H);
    notch(g, (a / 255) * (SV_W - 1));
  };

  const sync = (forceHex = false): void => {
    renderSV();
    renderHue();
    renderAlpha();
    const c = current();
    const hex = rgbaToHex(c);
    afterFill.style.background = hex;
    after.dataset['color'] = hex;
    if (forceHex || document.activeElement !== hexInput) hexInput.value = hex;
  };

  /* ── interactions ── */
  dragXY(sv, (fx, fy) => {
    s = fx;
    v = 1 - fy;
    sync();
  });
  dragXY(hue, (fx) => {
    h = fx * 360;
    sync();
  });
  dragXY(alpha, (fx) => {
    a = Math.round(fx * 255);
    sync();
  });

  before.addEventListener('click', () => {
    [h, s, v, a] = rgbaToHsva(seed);
    sync();
  });

  /** .sl-hex idiom: valid → apply, garbage → revert + shake. */
  const commitHex = (): boolean => {
    const raw = hexInput.value.trim();
    if (HEX_RE.test(raw)) {
      const c = hexToRgba(raw.startsWith('#') ? raw : `#${raw}`);
      if (c !== null) {
        setFromRgba(c);
        sync(true);
        return true;
      }
    }
    sync(true);
    shake(hexInput);
    return false;
  };
  hexInput.addEventListener('blur', () => {
    if (picked) return;
    commitHex();
  });
  hexInput.addEventListener('animationend', () => hexInput.classList.remove('sl-shake'));

  const confirm = (): void => {
    if (picked) return;
    picked = true;
    const c = current();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    modal.close();
    opts.onPick(c);
  };

  /* Registered BEFORE modal.open(): capture listeners fire in registration
     order, so this sees keys the modal's own capture guard would swallow
     (gotcha ledger — the `?`-close idiom). Enter confirms, arrows nudge SV
     (1% step, shift = 10%); both stay away from the hex input's caret and
     from focused buttons' native activation. */
  const onKey = (e: KeyboardEvent): void => {
    if (!modal.isOpen || picked) return;
    if (e.key === 'Enter') {
      if (e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.target === hexInput) {
        if (commitHex()) confirm();
        return;
      }
      confirm();
      return;
    }
    if (e.target === hexInput) return;
    const step = e.shiftKey ? 0.1 : 0.01;
    let used = true;
    if (e.key === 'ArrowLeft') s = clamp01(s - step);
    else if (e.key === 'ArrowRight') s = clamp01(s + step);
    else if (e.key === 'ArrowUp') v = clamp01(v + step);
    else if (e.key === 'ArrowDown') v = clamp01(v - step);
    else used = false;
    if (used) {
      e.preventDefault();
      e.stopPropagation();
      sync();
    }
  };

  const modal = new Modal({
    label: opts.title ?? 'pick a color',
    className: 'sl-picker',
    onClose: () => window.removeEventListener('keydown', onKey, true),
  });
  cancel.addEventListener('click', () => modal.close());
  ok.addEventListener('click', confirm);

  modal.root.append(title, sv, hue, alpha, row, actions);
  window.addEventListener('keydown', onKey, true);
  modal.open();
  sync(true);
  ok.focus();
}
