/** OPFS + localStorage scratch persistence — debounced on doc:changed, restored on boot.
 *  Scratch buffer only, never the source of truth (files in, files out). */
import type { Bus } from '../core/bus';
import { SpriteDoc, type DocJson } from '../core/doc';

export const AUTOSAVE_KEY = 'sprite-lab:v2:doc';

const OPFS_FILE = 'sprite-lab-autosave.json';

const DEBOUNCE_MS = 800;

/** Saved payload wrapper — the stamp lets restore pick the newer of the two stores. */
interface SaveEnvelope {
  v: 1;
  savedAt: number;
  doc: DocJson;
}

interface Candidate {
  savedAt: number;
  doc: SpriteDoc;
}

function isEnvelope(value: unknown): value is SaveEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const env = value as { v?: unknown; savedAt?: unknown; doc?: unknown };
  return env.v === 1 && typeof env.savedAt === 'number'
    && typeof env.doc === 'object' && env.doc !== null;
}

/** Parse a stored payload: enveloped, or legacy bare DocJson (stamped 0 so any
 *  enveloped save wins). Corrupt/unparseable → null. */
function parseCandidate(raw: string | null): Candidate | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isEnvelope(parsed)) {
      return { savedAt: parsed.savedAt, doc: SpriteDoc.fromJSON(parsed.doc) };
    }
    return { savedAt: 0, doc: SpriteDoc.fromJSON(parsed as DocJson) };
  } catch {
    return null;
  }
}

function localRead(): string | null {
  try {
    return localStorage.getItem(AUTOSAVE_KEY);
  } catch {
    return null;
  }
}

function localRemove(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    /* storage unavailable */
  }
}

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
  private onFlush: (() => void) | null = null;
  private onVisibility: (() => void) | null = null;

  constructor(bus: Bus, getDoc: () => SpriteDoc) {
    this.bus = bus;
    this.getDoc = getDoc;
  }

  /** Subscribe to doc:changed / doc:replaced / palette:changed; debounce ~800ms.
   *  Pending saves flush on beforeunload, pagehide, and visibility→hidden
   *  (beforeunload alone never fires on iOS/tab-discard). */
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
    this.onFlush = (): void => this.flush();
    window.addEventListener('beforeunload', this.onFlush);
    window.addEventListener('pagehide', this.onFlush);
    this.onVisibility = (): void => {
      if (document.visibilityState === 'hidden') this.flush();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  stop(): void {
    for (const unsub of this.unsubs.splice(0)) unsub();
    this.flush();
    if (this.onFlush) {
      window.removeEventListener('beforeunload', this.onFlush);
      window.removeEventListener('pagehide', this.onFlush);
      this.onFlush = null;
    }
    if (this.onVisibility) {
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.onVisibility = null;
    }
  }

  /** Run a pending debounced save now instead of dropping it. */
  private flush(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.save();
  }

  /** Write to BOTH stores: localStorage is belt-and-suspenders while docs are
   *  small and keeps the sync restore() path alive where OPFS is missing. */
  private save(): void {
    const envelope: SaveEnvelope = { v: 1, savedAt: Date.now(), doc: this.getDoc().toJSON() };
    const json = JSON.stringify(envelope);
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
   *  Sync localStorage path only — restoreAsync() also checks OPFS. */
  static restore(): SpriteDoc | null {
    const raw = localRead();
    const candidate = parseCandidate(raw);
    if (candidate === null && raw !== null) localRemove();
    return candidate?.doc ?? null;
  }

  /** Restore from whichever store holds the newer save — a flush can land in
   *  localStorage while the in-flight OPFS write dies uncommitted (and the
   *  other way around), so neither store is trusted unconditionally. */
  static async restoreAsync(): Promise<SpriteDoc | null> {
    const opfsRaw = await opfsRead();
    const fromOpfs = parseCandidate(opfsRaw);
    if (fromOpfs === null && opfsRaw !== null) void opfsRemove();
    const localRaw = localRead();
    const fromLocal = parseCandidate(localRaw);
    if (fromLocal === null && localRaw !== null) localRemove();
    if (fromOpfs && fromLocal) {
      return fromOpfs.savedAt >= fromLocal.savedAt ? fromOpfs.doc : fromLocal.doc;
    }
    return fromOpfs?.doc ?? fromLocal?.doc ?? null;
  }
}
