/** Command history — byte-budgeted undo/redo. All doc mutation flows through commit(). */
import type { Command } from './contracts';
import type { Bus } from './bus';
import type { SpriteDoc } from './doc';

/** cmd.sizeBytes can grow after commit (getter-backed captures) — each entry
 *  remembers the bytes it was charged so removal always subtracts exactly that. */
interface Entry {
  cmd: Command;
  bytes: number;
}

export class History {
  private doc: SpriteDoc;
  private readonly bus: Bus;
  private readonly budgetBytes: number;
  private stack: Entry[] = [];
  private cursor = 0;
  private totalBytes = 0;

  constructor(doc: SpriteDoc, bus: Bus, budgetBytes: number = 64 * 2 ** 20) {
    this.doc = doc;
    this.bus = bus;
    this.budgetBytes = budgetBytes;
  }

  /** Apply cmd to the doc, push it, emit doc:changed + history:changed.
   *  Evicts oldest entries past the byte budget. Drops the redo tail. */
  commit(cmd: Command): void {
    cmd.apply(this.doc);
    if (this.cursor < this.stack.length) {
      for (let i = this.cursor; i < this.stack.length; i++) {
        const dropped = this.stack[i];
        if (dropped) this.totalBytes -= dropped.bytes;
      }
      this.stack.length = this.cursor;
    }
    const bytes = cmd.sizeBytes;
    this.stack.push({ cmd, bytes });
    this.cursor = this.stack.length;
    this.totalBytes += bytes;
    while (this.totalBytes > this.budgetBytes && this.stack.length > 1) {
      const evicted = this.stack.shift();
      if (!evicted) break;
      this.totalBytes -= evicted.bytes;
      this.cursor -= 1;
    }
    this.bus.emit('doc:changed', { scope: cmd.dirty });
    this.emitHistoryChanged();
  }

  undo(): void {
    if (this.cursor <= 0) return;
    const entry = this.stack[this.cursor - 1];
    if (!entry) return;
    this.cursor -= 1;
    entry.cmd.revert(this.doc);
    this.recharge(entry);
    this.bus.emit('doc:changed', { scope: entry.cmd.dirty });
    this.emitHistoryChanged();
  }

  redo(): void {
    if (this.cursor >= this.stack.length) return;
    const entry = this.stack[this.cursor];
    if (!entry) return;
    this.cursor += 1;
    entry.cmd.apply(this.doc);
    this.recharge(entry);
    this.bus.emit('doc:changed', { scope: entry.cmd.dirty });
    this.emitHistoryChanged();
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.stack.length;
  }

  /** The command undo() would revert next — null at the pristine cursor. */
  peekUndo(): Command | null {
    return this.stack[this.cursor - 1]?.cmd ?? null;
  }

  /** Oldest→newest labels + cursor, for the (Wave 2) history panel. */
  entries(): { labels: readonly string[]; cursor: number } {
    return { labels: this.stack.map((e) => e.cmd.label), cursor: this.cursor };
  }

  /** Undo/redo until the cursor sits at index (0 = pristine, length = latest). */
  jumpTo(index: number): void {
    const target = Math.max(0, Math.min(index, this.stack.length));
    while (this.cursor > target) this.undo();
    while (this.cursor < target) this.redo();
  }

  /** New doc loaded: clear the stack, rebind. */
  replaceDoc(doc: SpriteDoc): void {
    this.doc = doc;
    this.stack = [];
    this.cursor = 0;
    this.totalBytes = 0;
    this.emitHistoryChanged();
  }

  /** Re-read sizeBytes after apply/revert — captures taken there get charged. */
  private recharge(entry: Entry): void {
    const bytes = entry.cmd.sizeBytes;
    this.totalBytes += bytes - entry.bytes;
    entry.bytes = bytes;
  }

  private emitHistoryChanged(): void {
    this.bus.emit('history:changed', { canUndo: this.canUndo, canRedo: this.canRedo });
  }
}
