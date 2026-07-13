/** Tag (named animation range) commands. */
import type { Command, DirtyScope, Tag } from '../contracts';
import type { SpriteDoc } from '../doc';

export class AddTag implements Command {
  readonly label = 'add tag';
  readonly sizeBytes = 64;
  readonly dirty: DirtyScope = { kind: 'frames' };

  private readonly tag: Tag;

  constructor(tag: Tag) {
    this.tag = { ...tag };
  }

  apply(doc: SpriteDoc): void {
    doc.tags.push(this.tag);
  }

  revert(doc: SpriteDoc): void {
    const i = doc.tags.indexOf(this.tag);
    if (i >= 0) doc.tags.splice(i, 1);
  }
}

export class RemoveTag implements Command {
  readonly label = 'delete tag';
  readonly sizeBytes = 64;
  readonly dirty: DirtyScope = { kind: 'frames' };

  private readonly index: number;
  private removed: Tag | null = null;

  constructor(index: number) {
    this.index = index;
  }

  apply(doc: SpriteDoc): void {
    const [removed] = doc.tags.splice(this.index, 1);
    if (!removed) throw new RangeError(`RemoveTag: bad index ${this.index}`);
    this.removed = removed;
  }

  revert(doc: SpriteDoc): void {
    if (this.removed) doc.tags.splice(this.index, 0, this.removed);
  }
}

export class UpdateTag implements Command {
  readonly label = 'edit tag';
  readonly sizeBytes = 64;
  readonly dirty: DirtyScope = { kind: 'frames' };

  private readonly index: number;
  private readonly next: Tag;
  private prev: Tag | null = null;

  constructor(index: number, next: Tag) {
    this.index = index;
    this.next = { ...next };
  }

  apply(doc: SpriteDoc): void {
    const prev = doc.tags[this.index];
    if (!prev) throw new RangeError(`UpdateTag: bad index ${this.index}`);
    this.prev ??= prev;
    doc.tags[this.index] = this.next;
  }

  revert(doc: SpriteDoc): void {
    if (this.prev) doc.tags[this.index] = this.prev;
  }
}
