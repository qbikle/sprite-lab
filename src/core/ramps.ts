/** Color ramp generation — pixel-art shading ladders from a base color. */
import type { Rgba } from './contracts';
import { packRgba, unpackRgba } from './pixels';

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** [h 0..360, s 0..100, l 0..100] */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s * 100, l * 100];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = ((h % 360) + 360) % 360 / 60;
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

/**
 * `steps` colors dark→light around base (base lands near the middle).
 * Hue-shifted like pixel artists like it: shadows push cool, highlights warm.
 * Lightness spreads evenly max(8, L-32)…min(94, L+34); shadows rotate up to
 * -14° toward 240 and gain +8 saturation, highlights +10° toward 60 and -6.
 * Pure and deterministic; steps clamps to 3..9; alpha is always 255.
 */
export function makeRamp(base: Rgba, steps: number): Rgba[] {
  const n = clamp(Math.round(steps), 3, 9);
  const [r, g, b] = unpackRgba(base);
  const [h, s, l] = rgbToHsl(r, g, b);
  const lo = Math.max(8, l - 32);
  const hi = Math.min(94, l + 34);
  const mid = (n - 1) / 2;
  const out: Rgba[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i - mid) / mid; // -1 darkest … 0 base … +1 lightest
    const li = lo + ((hi - lo) * i) / (n - 1);
    let hh = h;
    let ss = s;
    if (t < 0) {
      hh = shiftHue(h, 240, 14 * -t);
      ss = s + 8 * -t;
    } else if (t > 0) {
      hh = shiftHue(h, 60, 10 * t);
      ss = s - 6 * t;
    }
    const [rr, gg, bb] = hslToRgb(hh, clamp(ss, 0, 100), clamp(li, 0, 100));
    out.push(packRgba(rr, gg, bb, 255));
  }
  return out;
}
