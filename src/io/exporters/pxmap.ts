/** px() char-map export — paste-ready TS for the mOS icon pipeline:
 *  a small char→hex map plus row strings for the active frame. */
import type { SpriteDoc } from '../../core/doc';
import { rgbaToHex } from '../../core/pixels';

/** '.' is reserved for transparent; opaque colors get chars by frequency. */
const CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Throws (friendly message) when the frame uses more colors than the charset. */
export function framePxMap(doc: SpriteDoc, frameIndex: number): string {
  const flat = doc.flattenFrame(frameIndex);
  const counts = new Map<number, number>();
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i] ?? 0;
    if (((c >>> 24) & 0xff) === 0) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  if (counts.size > CHARSET.length) {
    throw new Error('too many colors for a px map (62 max)');
  }

  const ordered = [...counts.entries()].sort((p, q) => q[1] - p[1]);
  const chars = new Map<number, string>();
  const colorLines: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i];
    if (!entry) continue;
    const ch = CHARSET.charAt(i);
    chars.set(entry[0], ch);
    colorLines.push(`  ${ch}: '${rgbaToHex(entry[0])}',`);
  }

  const rowLines: string[] = [];
  for (let y = 0; y < doc.height; y++) {
    let row = '';
    for (let x = 0; x < doc.width; x++) {
      const c = flat[y * doc.width + x] ?? 0;
      row += ((c >>> 24) & 0xff) === 0 ? '.' : (chars.get(c) ?? '.');
    }
    rowLines.push(`  '${row}',`);
  }

  return [
    `// ${doc.meta.name} — frame ${frameIndex}`,
    'const COLORS = {',
    ...colorLines,
    '} as const;',
    '',
    'const ROWS = [',
    ...rowLines,
    '];',
    '',
    '// px(ROWS, COLORS)',
    '',
  ].join('\n');
}
