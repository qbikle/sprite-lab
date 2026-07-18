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
