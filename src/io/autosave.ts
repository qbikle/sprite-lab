/** OPFS + localStorage scratch persistence — debounced on doc:changed, restored on boot.
 *  Scratch buffer only, never the source of truth (files in, files out). */
import type { Bus } from '../core/bus';
import { SpriteDoc, type DocJson } from '../core/doc';

export const AUTOSAVE_KEY = 'sprite-lab:v2:doc';

const OPFS_FILE = 'sprite-lab-autosave.json';

const DEBOUNCE_MS = 800;

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const storage: StorageManager | undefined = navigator.storage;
    if (!storage || typeof storage.getDirectory !== 'function') return null;
    return await storage.getDirectory();
  } catch {
    return null;
  }
}

async function opfsWrite(json: string): Promise<boolean> {
  const dir = await opfsRoot();
  if (!dir) return false;
  try {
    const handle = await dir.getFileHandle(OPFS_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(json);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

async function opfsRead(): Promise<string | null> {
  const dir = await opfsRoot();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(OPFS_FILE);
    const file = await handle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

async function opfsRemove(): Promise<void> {
  const dir = await opfsRoot();
  if (!dir) return;
  try {
    await dir.removeEntry(OPFS_FILE);
  } catch {
    /* already absent or OPFS unavailable */
  }
}

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

  /** Write to BOTH stores: localStorage is belt-and-suspenders while docs are
   *  small and keeps the sync restore() path alive where OPFS is missing. */
  private save(): void {
    const json = JSON.stringify(this.getDoc().toJSON());
    let localOk = true;
    try {
      localStorage.setItem(AUTOSAVE_KEY, json);
    } catch {
      localOk = false;
    }
    void opfsWrite(json).then((opfsOk) => {
      if (!opfsOk && !localOk) {
        this.bus.emit('status:message', { text: 'autosave paused: storage full' });
      }
    });
  }

  /** Saved doc from a previous session, or null (corrupt entries cleared).
   *  Sync localStorage path only — restoreAsync() checks OPFS first. */
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

  /** OPFS-first restore, falling back to the sync localStorage path. */
  static async restoreAsync(): Promise<SpriteDoc | null> {
    const raw = await opfsRead();
    if (raw !== null) {
      try {
        return SpriteDoc.fromJSON(JSON.parse(raw) as DocJson);
      } catch {
        void opfsRemove();
      }
    }
    return Autosave.restore();
  }

  static clear(): void {
    localStorage.removeItem(AUTOSAVE_KEY);
    void opfsRemove();
  }
}
