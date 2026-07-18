/** The coat-swap engine: remap colors across EVERY cel in one undoable command. */
import type { CelKey, Command, DirtyScope, Rgba } from '../contracts';
import type { SpriteDoc } from '../doc';

export interface SwapPair { from: Rgba; to: Rgba }

interface CelCapture { key: CelKey; before: Uint32Array; after: Uint32Array }

interface PaletteCapture {
  prevColors: Rgba[];
  nextColors: Rgba[];
}

/** Swap can touch every frame — dirty 'all' is both cheap and correct.
 *  First apply remaps in place, capturing before+after per CHANGED cel only
 *  (byte-stable redo, immune to mapping-chain ambiguity); untouched cels are
 *  never copied. Pairs are map semantics: each pixel remapped once against
 *  its ORIGINAL value, later pair wins on a duplicate `from`. */
export class SwapColors implements Command {
  readonly label = 'swap colors';
  readonly dirty: DirtyScope = { kind: 'all' };

  private readonly map: Map<Rgba, Rgba>;
  private readonly alsoPalette: boolean;
  private captured = false;
  private readonly cels: CelCapture[] = [];
  private pal: PaletteCapture | null = null;
  private _sizeBytes = 256;

  constructor(pairs: readonly SwapPair[], alsoPalette = true) {
    this.map = new Map(pairs.map((p) => [p.from, p.to]));
    this.alsoPalette = alsoPalette;
  }

  get sizeBytes(): number {
    return this._sizeBytes;
  }

  apply(doc: SpriteDoc): void {
    if (!this.captured) {
      this.firstApply(doc);
      return;
    }
    for (const { key, after } of this.cels) doc.ensureCel(key).set(after);
    if (this.pal) doc.palette.colors = this.pal.nextColors;
  }

  revert(doc: SpriteDoc): void {
    for (const { key, before } of this.cels) doc.ensureCel(key).set(before);
    if (this.pal) doc.palette.colors = this.pal.prevColors;
  }

  private firstApply(doc: SpriteDoc): void {
    this.captured = true;
    for (const layer of doc.layers) {
      for (const [key, cel] of doc.celEntriesForLayer(layer.id)) {
        let before: Uint32Array | null = null;
        for (let i = 0; i < cel.length; i++) {
          const to = this.map.get(cel[i] ?? 0);
          if (to === undefined || to === cel[i]) continue;
          before ??= new Uint32Array(cel);
          cel[i] = to;
        }
        if (!before) continue;
        this.cels.push({ key, before, after: new Uint32Array(cel) });
        this._sizeBytes += 2 * cel.byteLength;
      }
    }
    if (!this.alsoPalette) return;
    // recent is ephemeral UX state (see EditorState.setColor) — never captured
    // or restored here: the live array aliases would corrupt the undo capture.
    const remap = (c: Rgba): Rgba => this.map.get(c) ?? c;
    this.pal = {
      prevColors: doc.palette.colors,
      nextColors: doc.palette.colors.map(remap),
    };
    doc.palette.colors = this.pal.nextColors;
  }
}

/** Frequency-ordered opaque colors actually used in the doc's cels (max `cap`). */
export function usedColors(doc: SpriteDoc, cap = 32): Rgba[] {
  const counts = new Map<Rgba, number>();
  for (const layer of doc.layers) {
    for (const [, cel] of doc.celEntriesForLayer(layer.id)) {
      for (let i = 0; i < cel.length; i++) {
        const c = cel[i] ?? 0;
        if (((c >>> 24) & 0xff) === 0) continue;
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((p, q) => q[1] - p[1])
    .slice(0, cap)
    .map((e) => e[0]);
}
