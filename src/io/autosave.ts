/** localStorage scratch persistence — debounced on doc:changed, restored on boot.
 *  Scratch buffer only, never the source of truth (files in, files out). */
import type { Bus } from '../core/bus';
import { SpriteDoc, type DocJson } from '../core/doc';

export const AUTOSAVE_KEY = 'sprite-lab:v2:doc';

const DEBOUNCE_MS = 800;

export class Autosave {
  private readonly bus: Bus;
  private readonly getDoc: () => SpriteDoc;
  private timer: number | null = null;
  private readonly unsubs: Array<() => void> = [];
  private onBeforeUnload: (() => void) | null = null;

  constructor(bus: Bus, getDoc: () => SpriteDoc) {
    this.bus = bus;
    this.getDoc = getDoc;
  }

  /** Subscribe to doc:changed / doc:replaced / palette:changed; debounce ~800ms. */
  start(): void {
    const schedule = (): void => {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.save();
      }, DEBOUNCE_MS);
    };
    this.unsubs.push(this.bus.on('doc:changed', schedule));
    this.unsubs.push(this.bus.on('doc:replaced', schedule));
    this.unsubs.push(this.bus.on('palette:changed', schedule));
    this.onBeforeUnload = (): void => {
      if (this.timer === null) return;
      clearTimeout(this.timer);
      this.timer = null;
      this.save();
    };
    window.addEventListener('beforeunload', this.onBeforeUnload);
  }

  stop(): void {
    for (const unsub of this.unsubs.splice(0)) unsub();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.onBeforeUnload) {
      window.removeEventListener('beforeunload', this.onBeforeUnload);
      this.onBeforeUnload = null;
    }
  }

  private save(): void {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.getDoc().toJSON()));
    } catch {
      this.bus.emit('status:message', { text: 'autosave paused: storage full' });
    }
  }

  /** Saved doc from a previous session, or null (corrupt entries cleared). */
  static restore(): SpriteDoc | null {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return null;
      return SpriteDoc.fromJSON(JSON.parse(raw) as DocJson);
    } catch {
      try {
        localStorage.removeItem(AUTOSAVE_KEY);
      } catch {
        /* storage unavailable */
      }
      return null;
    }
  }

  static clear(): void {
    localStorage.removeItem(AUTOSAVE_KEY);
  }
}
