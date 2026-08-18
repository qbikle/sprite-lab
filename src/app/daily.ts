/** Daily seed — a deterministic drawing dare for the local date: a two-word
 *  prompt plus a 4-color palette that always looks good together. Pure and
 *  DOM-free; same local date → byte-identical output (unit-pinned). HSL math
 *  mirrors core/ramps.ts (its helpers are private — local pure copies). */
import type { Rgba } from '../core/contracts';
import { packRgba } from '../core/pixels';

export interface DailySeed {
  /** Local date, YYYY-MM-DD. */
  date: string;
  /** e.g. 'a grumpy slime' — article included. */
  prompt: string;
  /** [dark shade, mid tone, light tone, accent] — all opaque, all distinct. */
  colors: Rgba[];
}

/** Bare words — the article is added at render time ('an' before vowels). */
export const DAILY_ADJECTIVES: readonly string[] = [
  'grumpy', 'tiny', 'sleepy', 'brave', 'sneaky', 'ancient', 'dizzy',
  'cozy', 'spooky', 'mighty', 'soggy', 'fluffy', 'rusty', 'shiny',
  'lonely', 'jolly', 'icy', 'molten', 'crooked', 'gentle', 'wobbly',
  'hungry', 'curious', 'dapper', 'bashful', 'electric', 'mossy', 'grand',
];

export const DAILY_NOUNS: readonly string[] = [
  'slime', 'wizard', 'robot', 'mushroom', 'dragon', 'ghost', 'knight',
  'frog', 'cactus', 'lighthouse', 'teapot', 'comet', 'snail', 'crab',
  'lantern', 'golem', 'fox', 'jellyfish', 'acorn', 'sword', 'potion',
  'castle', 'raccoon', 'moth', 'cloud', 'skeleton', 'pumpkin', 'whale',
];

/** mulberry32 — tiny seeded PRNG, plenty for a daily draw. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
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
  const m = ln - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Rotate h toward target by up to `amount` degrees along the shortest path. */
function shiftHue(h: number, target: number, amount: number): number {
  const d = ((target - h + 540) % 360) - 180;
  const move = Math.sign(d) * Math.min(Math.abs(d), amount);
  return (h + move + 360) % 360;
}

function opaque(h: number, s: number, l: number): Rgba {
  const [r, g, b] = hslToRgb(h, Math.min(100, Math.max(0, s)), l);
  return packRgba(r, g, b, 255);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The dare for `now`'s LOCAL date (defaults to today). Deterministic: the
 * PRNG is seeded with the yyyymmdd int, so every open of the new-doc modal
 * on one day agrees. Palette rule: random hue → dark shade (L22, cooled
 * toward 240, +10 sat), mid tone (L47), light tone (L76, warmed toward 60,
 * -8 sat), accent at hue+120..180° (L55, +15 sat) — the lightness ladder
 * keeps the four distinct for every hue, nothing is ever transparent.
 */
export function dailySeed(now: Date = new Date()): DailySeed {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const rand = mulberry32(y * 10000 + m * 100 + d);

  const adj = DAILY_ADJECTIVES[Math.floor(rand() * DAILY_ADJECTIVES.length)] ?? 'tiny';
  const noun = DAILY_NOUNS[Math.floor(rand() * DAILY_NOUNS.length)] ?? 'slime';
  const article = /^[aeiou]/.test(adj) ? 'an' : 'a';

  const hue = rand() * 360;
  const sat = 45 + rand() * 30;
  const accentHue = (hue + 120 + rand() * 60) % 360;

  return {
    date: `${y}-${pad2(m)}-${pad2(d)}`,
    prompt: `${article} ${adj} ${noun}`,
    colors: [
      opaque(shiftHue(hue, 240, 10), sat + 10, 22),
      opaque(hue, sat, 47),
      opaque(shiftHue(hue, 60, 8), sat - 8, 76),
      opaque(accentHue, sat + 15, 55),
    ],
  };
}
