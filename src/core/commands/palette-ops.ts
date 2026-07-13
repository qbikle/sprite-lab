/** Palette mutations as commands — palette edits are undoable like everything else. */
import type { Command, DirtyScope, Rgba } from '../contracts';
import type { SpriteDoc } from '../doc';

export class AddPaletteColor implements Command {
  readonly label = 'add palette color';
  readonly sizeBytes = 64;
  readonly dirty: DirtyScope = { kind: 'palette' };

  private readonly color: Rgba;
  private appliedIndex = -1;

  constructor(color: Rgba) {
    this.color = color;
  }

  apply(doc: SpriteDoc): void {
    if (doc.palette.colors.includes(this.color)) {
      this.appliedIndex = -1;
      return;
    }
    this.appliedIndex = doc.palette.colors.length;
    doc.palette.colors.push(this.color);
  }

  revert(doc: SpriteDoc): void {
    if (this.appliedIndex < 0) return;
    doc.palette.colors.splice(this.appliedIndex, 1);
    this.appliedIndex = -1;
  }
}
