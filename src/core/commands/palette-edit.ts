/** Palette edits beyond add: replace/remove a swatch, replace the whole set. */
import type { Command, DirtyScope, Rgba } from '../contracts';
import type { SpriteDoc } from '../doc';

export class ReplacePaletteColor implements Command {
  readonly label = 'edit swatch';
  readonly sizeBytes = 64;
  readonly dirty: DirtyScope = { kind: 'palette' };

  private readonly index: number;
  private readonly color: Rgba;
  private prev: Rgba = 0;

  constructor(index: number, color: Rgba) {
    this.index = index;
    this.color = color;
  }

  apply(doc: SpriteDoc): void {
    const prev = doc.palette.colors[this.index];
    if (prev === undefined) throw new RangeError(`ReplacePaletteColor: bad index ${this.index}`);
    this.prev = prev;
    doc.palette.colors[this.index] = this.color;
  }

  revert(doc: SpriteDoc): void {
    doc.palette.colors[this.index] = this.prev;
  }
}

export class RemovePaletteColor implements Command {
  readonly label = 'remove swatch';
  readonly sizeBytes = 64;
  readonly dirty: DirtyScope = { kind: 'palette' };

  private readonly index: number;
  private prev: Rgba = 0;

  constructor(index: number) {
    this.index = index;
  }

  apply(doc: SpriteDoc): void {
    const prev = doc.palette.colors[this.index];
    if (prev === undefined) throw new RangeError(`RemovePaletteColor: bad index ${this.index}`);
    this.prev = prev;
    doc.palette.colors.splice(this.index, 1);
  }

  revert(doc: SpriteDoc): void {
    doc.palette.colors.splice(this.index, 0, this.prev);
  }
}

/** Replace the whole palette (gpl import / ramp append hands the full next array). */
export class SetPalette implements Command {
  readonly label: string;
  readonly sizeBytes: number;
  readonly dirty: DirtyScope = { kind: 'palette' };

  private readonly next: Rgba[];
  private readonly name: string | null;
  private prev: { colors: Rgba[]; name: string } | null = null;

  constructor(next: readonly Rgba[], name: string | null, label?: string) {
    this.next = [...next];
    this.name = name;
    this.label = label ?? 'set palette';
    this.sizeBytes = next.length * 4 + 64;
  }

  apply(doc: SpriteDoc): void {
    this.prev ??= { colors: doc.palette.colors, name: doc.palette.name };
    doc.palette.colors = [...this.next];
    if (this.name !== null) doc.palette.name = this.name;
  }

  revert(doc: SpriteDoc): void {
    if (!this.prev) return;
    doc.palette.colors = this.prev.colors;
    doc.palette.name = this.prev.name;
  }
}
