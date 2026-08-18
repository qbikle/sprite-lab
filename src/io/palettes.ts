/** Palette files: GIMP .gpl in/out + a tiny JSON form.
 *  Parsers/serializers are pure (node-testable); only the picker/download touch the DOM. */
import type { Palette, Rgba } from '../core/contracts';
import { hexToRgba, packRgba, rgbaToHex, unpackRgba } from '../core/pixels';
import { downloadBlob } from './exporters/png';

export function paletteToGpl(name: string, colors: readonly Rgba[]): string {
  const pad = (v: number): string => String(v).padStart(3, ' ');
  const lines = ['GIMP Palette', `Name: ${name}`, '#'];
  for (const c of colors) {
    const [r, g, b] = unpackRgba(c);
    lines.push(`${pad(r)} ${pad(g)} ${pad(b)}\t${rgbaToHex(c)}`);
  }
  return lines.join('\n') + '\n';
}

/** Parse .gpl text → colors (opaque, unless an Aseprite `Channels: RGBA`
 *  header marks the 4th int per line as alpha). Throws on garbage. */
export function gplToColors(text: string): { name: string; colors: Rgba[] } {
  let name = 'imported';
  let rgba = false;
  const colors: Rgba[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const nameMatch = /^name:\s*(.*)$/i.exec(line);
    if (nameMatch) {
      const n = (nameMatch[1] ?? '').trim();
      if (n) name = n;
      continue;
    }
    if (/^channels:\s*rgba$/i.test(line)) {
      rgba = true;
      continue;
    }
    if (/^(gimp|columns|channels)/i.test(line)) continue;
    const ints = line.match(/\d+/g);
    if (!ints || ints.length < 3) continue;
    const r = Number(ints[0]);
    const g = Number(ints[1]);
    const b = Number(ints[2]);
    if (r > 255 || g > 255 || b > 255) continue;
    const a4 = Number(ints[3] ?? Infinity);
    const a = rgba && a4 <= 255 ? a4 : 255;
    colors.push(packRgba(r, g, b, a));
  }
  if (colors.length === 0) throw new Error('not a GIMP palette (.gpl)');
  return { name, colors };
}

export function paletteToJson(p: Palette): string {
  return JSON.stringify({ name: p.name, colors: p.colors.map(rgbaToHex) }, null, 2);
}

/** JSON `{name?, colors: [#hex, …]}` if it parses as that shape, else .gpl. */
function parsePaletteText(text: string): { name: string; colors: Rgba[] } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') throw new Error('not a palette JSON');
    const obj = parsed as { name?: unknown; colors?: unknown };
    if (!Array.isArray(obj.colors)) throw new Error('not a palette JSON');
    const colors: Rgba[] = [];
    for (const c of obj.colors) {
      if (typeof c !== 'string') continue;
      const v = hexToRgba(c);
      if (v !== null) colors.push(v);
    }
    if (colors.length === 0) throw new Error('no colors in palette JSON');
    const name = typeof obj.name === 'string' && obj.name !== '' ? obj.name : 'imported';
    return { name, colors };
  } catch {
    return gplToColors(text);
  }
}

/** Open a picker for .gpl/.json palette files. */
export function openPaletteFile(onColors: (name: string, colors: Rgba[]) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.gpl,.json,application/json';
  input.style.display = 'none';
  const cleanup = (): void => input.remove();
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    cleanup();
    if (!file) return;
    void file.text()
      .then((text) => {
        const { name, colors } = parsePaletteText(text);
        onColors(name, colors);
      })
      .catch((err: unknown) => console.error('palette import failed:', err));
  }, { once: true });
  input.addEventListener('cancel', cleanup, { once: true });
  document.body.appendChild(input);
  input.click();
}

export function downloadText(text: string, filename: string): void {
  downloadBlob(new Blob([text], { type: 'text/plain' }), filename);
}

/* ── lospec.com palette import (Wave 13) ─────────────────────────────────
   lospec serves `/palette-list/<slug>.json` with `access-control-allow-origin:
   *` (verified 2026-08-18), so a plain browser fetch works. Every failure —
   including a CORS/offline block, which fetch surfaces as a bare TypeError —
   maps to a typed LospecError with a human message; raw errors never leak. */

/** Typed failure from fetchLospecPalette — `message` is always human-safe. */
export interface LospecError extends Error {
  code: 'bad_input' | 'network' | 'not_found' | 'http' | 'bad_data';
}

export function isLospecError(err: unknown): err is LospecError {
  return err instanceof Error && err.name === 'LospecError' &&
    typeof (err as { code?: unknown }).code === 'string';
}

function lospecError(code: LospecError['code'], message: string): LospecError {
  const err = new Error(message) as LospecError;
  err.name = 'LospecError';
  err.code = code;
  return err;
}

const SLUG_RE = /^[a-z0-9-]+$/;

/** `https://lospec.com/palette-list/<slug>` (any suffix) or a bare slug →
 *  the slug, lowercased; null when it can't be one. Pure. */
export function lospecSlug(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (s === '') return null;
  if (s.includes('lospec.com')) {
    const m = /lospec\.com\/palette-list\/([a-z0-9-]+)/.exec(s);
    if (!m || m[1] === undefined) return null;
    s = m[1];
  } else if (s.includes('/') || s.includes('.') || s.includes(' ')) {
    // bare-slug form may only carry a stray .json / wrapping slashes
    s = s.replace(/^\/+|\/+$/g, '');
    if (s.endsWith('.json')) s = s.slice(0, -'.json'.length);
    if (!SLUG_RE.test(s)) return null;
  }
  if (s.endsWith('.json')) s = s.slice(0, -'.json'.length);
  return SLUG_RE.test(s) ? s : null;
}

/**
 * Fetch a palette from lospec.com by URL or bare slug. Resolves to
 * `{name, colors}` with colors packed via core/pixels; rejects with a
 * `LospecError` (`bad_input` / `network` / `not_found` / `http` / `bad_data`).
 */
export async function fetchLospecPalette(
  slugOrUrl: string,
): Promise<{ name: string; colors: Rgba[] }> {
  const slug = lospecSlug(slugOrUrl);
  if (slug === null) {
    throw lospecError('bad_input', 'that does not look like a lospec palette URL or slug');
  }
  let res: Response;
  try {
    res = await fetch(`https://lospec.com/palette-list/${slug}.json`);
  } catch {
    throw lospecError(
      'network',
      'lospec said no — offline or blocked; download the .gpl from lospec instead',
    );
  }
  if (res.status === 404) {
    throw lospecError('not_found', `no palette called '${slug}' on lospec`);
  }
  if (!res.ok) {
    throw lospecError('http', `lospec said no (HTTP ${res.status}) — try again later`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw lospecError('bad_data', 'lospec sent something unreadable — not palette JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw lospecError('bad_data', 'lospec sent something unreadable — not palette JSON');
  }
  const obj = parsed as { name?: unknown; colors?: unknown };
  if (!Array.isArray(obj.colors)) {
    throw lospecError('bad_data', 'that palette has no colors field');
  }
  const colors: Rgba[] = [];
  for (const c of obj.colors) {
    if (typeof c !== 'string') continue;
    const v = hexToRgba(c.startsWith('#') ? c : `#${c}`);
    if (v !== null) colors.push(v);
  }
  if (colors.length === 0) {
    throw lospecError('bad_data', 'no usable colors in that palette');
  }
  const name = typeof obj.name === 'string' && obj.name.trim() !== '' ? obj.name.trim() : slug;
  return { name, colors };
}
