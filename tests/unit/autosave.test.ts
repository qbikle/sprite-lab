/** io/autosave — envelope stamping, newer-wins restore, legacy migration. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Autosave, AUTOSAVE_KEY } from '../../src/io/autosave';
import { SpriteDoc } from '../../src/core/doc';

const OPFS_FILE = 'sprite-lab-autosave.json';

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }
}

class FakeOpfsDir {
  readonly files = new Map<string, string>();

  getFileHandle(name: string, opts?: { create?: boolean }): Promise<{
    createWritable: () => Promise<{ write: (s: string) => Promise<void>; close: () => Promise<void> }>;
    getFile: () => Promise<{ text: () => Promise<string> }>;
  }> {
    if (!this.files.has(name)) {
      if (!opts?.create) return Promise.reject(new Error('NotFoundError'));
      this.files.set(name, '');
    }
    const files = this.files;
    return Promise.resolve({
      createWritable: () => {
        let buf = '';
        return Promise.resolve({
          write: (s: string): Promise<void> => {
            buf = s;
            return Promise.resolve();
          },
          close: (): Promise<void> => {
            files.set(name, buf);
            return Promise.resolve();
          },
        });
      },
      getFile: () => Promise.resolve({ text: () => Promise.resolve(files.get(name) ?? '') }),
    });
  }

  removeEntry(name: string): Promise<void> {
    this.files.delete(name);
    return Promise.resolve();
  }
}

function envelope(savedAt: number, name: string): string {
  return JSON.stringify({ v: 1, savedAt, doc: SpriteDoc.blank(4, 4, name).toJSON() });
}

function legacy(name: string): string {
  return JSON.stringify(SpriteDoc.blank(4, 4, name).toJSON());
}

let storage: MemoryStorage;
let opfs: FakeOpfsDir;

beforeEach(() => {
  storage = new MemoryStorage();
  opfs = new FakeOpfsDir();
  vi.stubGlobal('localStorage', storage as unknown as Storage);
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: () => Promise.resolve(opfs as unknown as FileSystemDirectoryHandle),
    },
  } as unknown as Navigator);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Autosave.restoreAsync — newer save wins', () => {
  it('prefers OPFS when its stamp is newer', async () => {
    opfs.files.set(OPFS_FILE, envelope(2000, 'from-opfs'));
    storage.setItem(AUTOSAVE_KEY, envelope(1000, 'from-local'));
    const doc = await Autosave.restoreAsync();
    expect(doc?.meta.name).toBe('from-opfs');
  });

  it('prefers localStorage when its stamp is newer (flush landed, OPFS write died)', async () => {
    opfs.files.set(OPFS_FILE, envelope(1000, 'from-opfs'));
    storage.setItem(AUTOSAVE_KEY, envelope(2000, 'from-local'));
    const doc = await Autosave.restoreAsync();
    expect(doc?.meta.name).toBe('from-local');
  });

  it('falls back to whichever store has a save at all', async () => {
    storage.setItem(AUTOSAVE_KEY, envelope(5, 'only-local'));
    expect((await Autosave.restoreAsync())?.meta.name).toBe('only-local');
    storage.removeItem(AUTOSAVE_KEY);
    opfs.files.set(OPFS_FILE, envelope(5, 'only-opfs'));
    expect((await Autosave.restoreAsync())?.meta.name).toBe('only-opfs');
    opfs.files.delete(OPFS_FILE);
    expect(await Autosave.restoreAsync()).toBeNull();
  });
});

describe('Autosave — legacy un-enveloped payloads', () => {
  it('migrates a bare DocJson payload on read', async () => {
    storage.setItem(AUTOSAVE_KEY, legacy('old-doc'));
    expect(Autosave.restore()?.meta.name).toBe('old-doc');
    expect((await Autosave.restoreAsync())?.meta.name).toBe('old-doc');
  });

  it('any enveloped save beats a legacy payload (legacy stamps as 0)', async () => {
    opfs.files.set(OPFS_FILE, legacy('legacy-opfs'));
    storage.setItem(AUTOSAVE_KEY, envelope(1, 'enveloped-local'));
    expect((await Autosave.restoreAsync())?.meta.name).toBe('enveloped-local');
  });
});

describe('Autosave — corrupt payloads', () => {
  it('restore() returns null on corrupt JSON and clears the entry', () => {
    storage.setItem(AUTOSAVE_KEY, '{not json');
    expect(Autosave.restore()).toBeNull();
    expect(storage.has(AUTOSAVE_KEY)).toBe(false);
  });

  it('restoreAsync() returns null when both stores are corrupt', async () => {
    opfs.files.set(OPFS_FILE, '{not json');
    storage.setItem(AUTOSAVE_KEY, 'also not json');
    expect(await Autosave.restoreAsync()).toBeNull();
  });

  it('restoreAsync() falls past a corrupt OPFS payload to localStorage', async () => {
    opfs.files.set(OPFS_FILE, '{not json');
    storage.setItem(AUTOSAVE_KEY, envelope(9, 'survivor'));
    expect((await Autosave.restoreAsync())?.meta.name).toBe('survivor');
  });

  it('restoreAsync() falls past a corrupt localStorage payload to OPFS', async () => {
    opfs.files.set(OPFS_FILE, envelope(9, 'survivor-opfs'));
    storage.setItem(AUTOSAVE_KEY, '{not json');
    expect((await Autosave.restoreAsync())?.meta.name).toBe('survivor-opfs');
  });
});
