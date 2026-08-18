/**
 * Custom stamp brushes — a module-level store (max 8 stamps, each ≤48×48),
 * persisted to localStorage. Storage failures are swallowed (stamps stay
 * session-local); corrupt persisted entries are dropped on load. The store
 * emits through its own tiny emitter — the frozen EventMap stays untouched.
 */
import type { EditorState } from './editor';

export interface Stamp {
  readonly id: string;
  readonly w: number;
  readonly h: number;
  readonly pixels: Uint32Array; // w × h, packed ABGR (0 = transparent)
}

/** What StampsPanel captures and StampTool paints — a plain pixel block. */
export interface StampSource {
  w: number;
  h: number;
  pixels: Uint32Array;
}

export const STAMPS_MAX = 8;
export const STAMP_MAX_SIDE = 48;

const STORE_KEY = 'sprite-lab:v2:stamps';

let loaded: Stamp[] | null = null;
let activeId: string | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function encodePixels(px: Uint32Array): string {
  const bytes = new Uint8Array(px.buffer, px.byteOffset, px.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin);
}

function decodePixels(b64: string, count: number): Uint32Array | null {
  try {
    const bin = atob(b64);
    if (bin.length !== count * 4) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Uint32Array(bytes.buffer);
  } catch {
    return null;
  }
}

function decodeEntry(entry: unknown): Stamp | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as { id?: unknown; w?: unknown; h?: unknown; px?: unknown };
  if (typeof e.id !== 'string' || e.id === '') return null;
  if (typeof e.w !== 'number' || typeof e.h !== 'number' || typeof e.px !== 'string') return null;
  if (!Number.isInteger(e.w) || !Number.isInteger(e.h)) return null;
  if (e.w < 1 || e.h < 1 || e.w > STAMP_MAX_SIDE || e.h > STAMP_MAX_SIDE) return null;
  const pixels = decodePixels(e.px, e.w * e.h);
  if (!pixels) return null;
  return { id: e.id, w: e.w, h: e.h, pixels };
}

function load(): Stamp[] {
  if (loaded) return loaded;
  const list: Stamp[] = [];
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as { stamps?: unknown };
      if (Array.isArray(data.stamps)) {
        for (const entry of data.stamps) {
          if (list.length >= STAMPS_MAX) break;
          const stamp = decodeEntry(entry);
          if (stamp && !list.some((s) => s.id === stamp.id)) list.push(stamp);
        }
      }
    }
  } catch {
    /* storage unavailable or corrupt — start empty */
  }
  for (const s of list) {
    const n = Number(s.id.replace(/^st/, ''));
    if (Number.isInteger(n) && n >= nextId) nextId = n + 1;
  }
  loaded = list;
  return list;
}

function save(): void {
  try {
    const stamps = load().map((s) => ({ id: s.id, w: s.w, h: s.h, px: encodePixels(s.pixels) }));
    localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, stamps }));
  } catch {
    /* storage unavailable — stamps stay session-local */
  }
}

function notify(): void {
  for (const cb of [...listeners]) cb();
}

export function stamps(): readonly Stamp[] {
  return load();
}

/** Add a stamp (copies the buffer) and make it active. null = full or oversize. */
export function addStamp(w: number, h: number, pixels: Uint32Array): Stamp | null {
  const all = load();
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return null;
  if (w > STAMP_MAX_SIDE || h > STAMP_MAX_SIDE) return null;
  if (pixels.length !== w * h) return null;
  if (all.length >= STAMPS_MAX) return null;
  const stamp: Stamp = { id: `st${nextId++}`, w, h, pixels: pixels.slice() };
  all.push(stamp);
  activeId = stamp.id;
  save();
  notify();
  return stamp;
}

export function removeStamp(id: string): void {
  const all = load();
  const at = all.findIndex((s) => s.id === id);
  if (at === -1) return;
  all.splice(at, 1);
  if (activeId === id) activeId = null;
  save();
  notify();
}

export function activeStamp(): Stamp | null {
  return load().find((s) => s.id === activeId) ?? null;
}

export function setActiveStamp(id: string | null): void {
  if (id !== null && !load().some((s) => s.id === id)) return;
  if (id === activeId) return;
  activeId = id;
  notify();
}

export function onStampsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Mirror of the clipboard extraction (EditorState.copyData) over the editor's
 * public surface: a live float wins, else the selection's masked pixels from
 * the active cel. Unmasked pixels inside the bounds stay transparent.
 */
export function selectionPixels(editor: EditorState): StampSource | null {
  const f = editor.float;
  if (f) return { w: f.rect.w, h: f.rect.h, pixels: f.pixels.slice() };
  const sel = editor.selection;
  if (!sel) return null;
  const { x, y, w, h } = sel.bounds;
  const doc = editor.doc;
  const cel = doc.getCel(doc.celKeyAt(editor.activeLayer, editor.activeFrame));
  const out = new Uint32Array(w * h);
  if (cel) {
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const di = (y + yy) * doc.width + (x + xx);
        if (sel.mask[di] === 1) out[yy * w + xx] = cel[di] ?? 0;
      }
    }
  }
  return { w, h, pixels: out };
}
