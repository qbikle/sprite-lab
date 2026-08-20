/* The 88×31 badge — a classic web button ("built with ♥ / qbikle"), drawn
   as real pixels with a real beating heart. Theme-following: colors are read
   from the CSS tokens at paint time and it repaints on theme:changed. The
   heart beats faster while the user draws (doc:changed warms it, each beat
   cools it). Click = pixel-heart burst + a one-liner in the statusbar.
   Shift-click hands the badge over as an ACTUAL 2-frame .sprite doc — the
   badge is itself a sprite you can open and remix. */
import type { Bus } from '../core/bus';
import { SpriteDoc, type DocJson } from '../core/doc';
import { packRgba } from '../core/pixels';

export const BADGE_W = 88;
export const BADGE_H = 31;

/* ── 3×5 pixel font (just the letters the badge needs) ── */

/* Small 3×5 caps — fine at 1× for "BUILT WITH". */
const FONT: Readonly<Record<string, readonly string[]>> = {
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  L: ['#..', '#..', '#..', '#..', '###'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  W: ['#.#', '#.#', '#.#', '###', '#.#'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
};

/* Wordmark 4×5 caps — 3-wide letterforms turn to mush at 2×; the name
 *  deserves real bowls and real diagonals. Variable width (row length). */
const WORDMARK: Readonly<Record<string, readonly string[]>> = {
  Q: ['.##.', '#..#', '#..#', '.##.', '...#'],
  B: ['###.', '#..#', '###.', '#..#', '###.'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  K: ['#..#', '#.#.', '##..', '#.#.', '#..#'],
  L: ['#...', '#...', '#...', '#...', '####'],
  E: ['####', '#...', '###.', '#...', '####'],
};

const HEART_BIG: readonly string[] = [
  '.##.##.',
  '#######',
  '#######',
  '.#####.',
  '..###..',
  '...#...',
];

const HEART_SMALL: readonly string[] = [
  '.......',
  '..#.#..',
  '.#####.',
  '.#####.',
  '..###..',
  '...#...',
];

export interface BadgeColors {
  bg: number;
  border: number;
  text: number;
  accent: number;
  heart: number;
}

function stampRows(
  out: Uint32Array,
  rows: readonly string[],
  x0: number,
  y0: number,
  color: number,
  scale = 1,
): void {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '#') continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = x0 + x * scale + sx;
          const py = y0 + y * scale + sy;
          if (px < 0 || py < 0 || px >= BADGE_W || py >= BADGE_H) continue;
          out[py * BADGE_W + px] = color;
        }
      }
    }
  }
}

function stampText(
  out: Uint32Array,
  font: Readonly<Record<string, readonly string[]>>,
  text: string,
  x0: number,
  y0: number,
  color: number,
  scale = 1,
): number {
  let x = x0;
  for (const ch of text) {
    const glyph = font[ch];
    if (glyph) stampRows(out, glyph, x, y0, color, scale);
    x += ((glyph?.[0]?.length ?? 3) + 1) * scale;
  }
  return x - scale; // right edge after the trailing gap is trimmed
}

/** Pure 88×31 pixel builder — the single source for both the live canvas
 *  and the remixable .sprite doc. */
export function buildBadgePixels(colors: BadgeColors, heartBig: boolean): Uint32Array {
  const out = new Uint32Array(BADGE_W * BADGE_H);
  out.fill(colors.bg);
  // 1px border, classic button
  for (let x = 0; x < BADGE_W; x++) {
    out[x] = colors.border;
    out[(BADGE_H - 1) * BADGE_W + x] = colors.border;
  }
  for (let y = 0; y < BADGE_H; y++) {
    out[y * BADGE_W] = colors.border;
    out[y * BADGE_W + (BADGE_W - 1)] = colors.border;
  }
  // Geometry is solved, not eyeballed: line1 spans exactly the wordmark's
  // ink (x=8, the optical left behind Q's blank column, through x=61, the
  // E's right edge). BUILT(19) + WITH(15) + ♥(7) + BY(7) + 3 equal 2px gaps
  // = 54. The heart is 7 wide so the equation closes on integers.
  stampText(out, FONT, 'BUILT', 8, 6, colors.text, 1);
  stampText(out, FONT, 'WITH', 29, 6, colors.text, 1);
  stampRows(out, heartBig ? HEART_BIG : HEART_SMALL, 46, 5, colors.heart, 1);
  stampText(out, FONT, 'BY', 55, 6, colors.text, 1);
  stampText(out, WORDMARK, 'QBIKLE', 6, 14, colors.accent, 2);
  // corner studs — the cozy rivets classic buttons wear
  for (const [cx, cy] of [
    [2, 2],
    [BADGE_W - 3, 2],
    [2, BADGE_H - 3],
    [BADGE_W - 3, BADGE_H - 3],
  ] as const) {
    out[cy * BADGE_W + cx] = colors.accent;
  }
  return out;
}

function bytesToBase64(pixels: Uint32Array): string {
  const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin);
}

/** The badge as a real, remixable 2-frame document (the beat is a tag). */
export function badgeDoc(colors: BadgeColors): SpriteDoc {
  const big = buildBadgePixels(colors, true);
  const small = buildBadgePixels(colors, false);
  const json: DocJson = {
    version: 1,
    width: BADGE_W,
    height: BADGE_H,
    layers: [{ id: 'l1', name: 'badge', opacity: 1, visible: true }],
    frames: [
      { id: 'f1', durationMs: 640 },
      { id: 'f2', durationMs: 200 },
    ],
    cels: { 'l1:f1': bytesToBase64(big), 'l1:f2': bytesToBase64(small) },
    palette: {
      name: 'badge',
      colors: [colors.text, colors.accent, colors.heart, colors.bg, colors.border],
      recent: [],
    },
    tags: [{ name: 'beat', from: 0, to: 1, mode: 'loop' }],
    meta: { name: 'badge' },
  };
  return SpriteDoc.fromJSON(json);
}

/* ── the live component ── */

const CLICK_LINES: readonly string[] = [
  'built with <3 by qbikle.',
  'the heart is load-bearing.',
  'shift-click to remix this badge.',
  'no frameworks were harmed.',
  'draw faster — the heart keeps up.',
  '88 by 31, like the old web intended.',
];

function parseHex(v: string, fallback: number): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  if (!m || m[1] === undefined) return fallback;
  const n = Number.parseInt(m[1], 16);
  return packRgba((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255);
}

function themeColors(): BadgeColors {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: number): number =>
    parseHex(css.getPropertyValue(name), fallback);
  return {
    bg: read('--panel', packRgba(34, 36, 64, 255)),
    border: read('--border', packRgba(13, 14, 28, 255)),
    text: read('--text', packRgba(232, 230, 240, 255)),
    accent: read('--accent', packRgba(255, 180, 84, 255)),
    heart: read('--danger', packRgba(224, 85, 85, 255)),
  };
}

export interface BadgeOpts {
  host: HTMLElement;
  bus: Bus;
  onStatus: (text: string) => void;
  /** Shift-click: the badge as a fresh doc, ready to adopt. */
  onRemix: (doc: SpriteDoc) => void;
}

export class Badge {
  private readonly opts: BadgeOpts;
  private readonly root: HTMLButtonElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly disposers: Array<() => void> = [];
  private big = true;
  private hot = 0;
  private line = 0;
  private timer: number | null = null;

  constructor(opts: BadgeOpts) {
    this.opts = opts;
    this.root = document.createElement('button');
    this.root.type = 'button';
    this.root.className = 'sl-badge';
    this.root.title = 'built with <3 by qbikle — shift-click to remix the badge';
    this.root.setAttribute('aria-label', 'built with love by qbikle');
    this.canvas = document.createElement('canvas');
    this.canvas.width = BADGE_W;
    this.canvas.height = BADGE_H;
    this.canvas.className = 'sl-badge-canvas';
    this.root.append(this.canvas);
  }

  mount(): void {
    this.opts.host.append(this.root);
    this.paint();
    this.scheduleBeat();
    const offTheme = this.opts.bus.on('theme:changed', () => this.paint());
    const offDoc = this.opts.bus.on('doc:changed', () => {
      this.hot = 1;
    });
    const onClick = (e: MouseEvent): void => {
      if (e.shiftKey) {
        this.opts.onRemix(badgeDoc(themeColors()));
        return;
      }
      this.hot = 1;
      this.burst();
      this.opts.onStatus(CLICK_LINES[this.line % CLICK_LINES.length] ?? '');
      this.line += 1;
    };
    this.root.addEventListener('click', onClick);
    const onVis = (): void => {
      if (document.hidden) this.stopBeat();
      else this.scheduleBeat();
    };
    document.addEventListener('visibilitychange', onVis);
    this.disposers.push(
      offTheme,
      offDoc,
      () => this.root.removeEventListener('click', onClick),
      () => document.removeEventListener('visibilitychange', onVis),
      () => this.stopBeat(),
      () => this.root.remove(),
    );
  }

  unmount(): void {
    for (const d of this.disposers.splice(0).reverse()) d();
  }

  private paint(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const pixels = buildBadgePixels(themeColors(), this.big);
    const img = ctx.createImageData(BADGE_W, BADGE_H);
    img.data.set(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength));
    ctx.putImageData(img, 0, 0);
  }

  private scheduleBeat(): void {
    if (this.timer !== null) return;
    const tick = (): void => {
      this.big = !this.big;
      this.paint();
      this.hot *= 0.82;
      if (this.hot < 0.02) this.hot = 0;
      // resting ~66bpm; a busy canvas drives it toward ~240bpm
      const interval = Math.max(220, 900 - 650 * this.hot) / 2;
      this.timer = window.setTimeout(tick, interval);
    };
    this.timer = window.setTimeout(tick, 450);
  }

  private stopBeat(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private burst(): void {
    for (let i = 0; i < 6; i++) {
      const s = document.createElement('span');
      s.className = 'sl-badge-spark';
      const a = (Math.PI * 2 * i) / 6;
      s.style.setProperty('--dx', `${Math.round(Math.cos(a) * 26)}px`);
      s.style.setProperty('--dy', `${Math.round(Math.sin(a) * 22 - 8)}px`);
      s.addEventListener('animationend', () => s.remove());
      this.root.append(s);
    }
  }
}
