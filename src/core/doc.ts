/** SpriteDoc — the document model. DOM-free. Mutated ONLY by commands. */
import type {
  CelKey, DocMeta, Frame, FrameId, Layer, LayerId, Palette, Rect, Rgba, Tag,
} from './contracts';
import { makeBuffer, packRgba } from './pixels';

/** Serialized form (.sprite envelope + autosave). Cel buffers are base64. */
export interface DocJson {
  version: 1;
  width: number;
  height: number;
  layers: Layer[];
  frames: Frame[];
  tags: Tag[];
  palette: { name: string; colors: number[]; recent: number[] };
  meta: DocMeta;
  cels: Record<string, string>;
}

/** Pico-8-ish 16-color starter ramp (transparent is the eraser, not a swatch). */
const STARTER_RAMP: ReadonlyArray<readonly [number, number, number]> = [
  [0x00, 0x00, 0x00], [0x1d, 0x2b, 0x53], [0x7e, 0x25, 0x53], [0x00, 0x87, 0x51],
  [0xab, 0x52, 0x36], [0x5f, 0x57, 0x4f], [0xc2, 0xc3, 0xc7], [0xff, 0xf1, 0xe8],
  [0xff, 0x00, 0x4d], [0xff, 0xa3, 0x00], [0xff, 0xec, 0x27], [0x00, 0xe4, 0x36],
  [0x29, 0xad, 0xff], [0x83, 0x76, 0x9c], [0xff, 0x77, 0xa8], [0xff, 0xcc, 0xaa],
];

export class SpriteDoc {
  readonly width: number;
  readonly height: number;
  layers: Layer[] = [];
  frames: Frame[] = [];
  tags: Tag[] = [];
  palette: Palette = { name: 'sprite', colors: [], recent: [] };
  meta: DocMeta = { name: 'untitled' };

  private readonly cels = new Map<CelKey, Uint32Array>();
  private layerSeq = 0;
  private frameSeq = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  /** One layer ('layer 1'), one frame (100ms), empty cel, starter palette. */
  static blank(w: number, h: number, name: string): SpriteDoc {
    const doc = new SpriteDoc(w, h);
    doc.meta = { name };
    const lid = doc.newLayerId();
    const fid = doc.newFrameId();
    doc.layers.push({ id: lid, name: 'layer 1', opacity: 1, visible: true });
    doc.frames.push({ id: fid, durationMs: 100 });
    doc.setCel(doc.celKey(lid, fid), makeBuffer(w, h));
    doc.palette.colors = STARTER_RAMP.map(([r, g, b]) => packRgba(r, g, b, 255));
    return doc;
  }

  /** Whole image as single layer+frame; palette extracted (≤64 colors by frequency). */
  static fromImage(pixels: Uint32Array, w: number, h: number, name: string): SpriteDoc {
    const doc = new SpriteDoc(w, h);
    doc.meta = { name };
    const lid = doc.newLayerId();
    const fid = doc.newFrameId();
    doc.layers.push({ id: lid, name: 'layer 1', opacity: 1, visible: true });
    doc.frames.push({ id: fid, durationMs: 100 });
    doc.setCel(doc.celKey(lid, fid), new Uint32Array(pixels));
    const counts = new Map<Rgba, number>();
    for (let i = 0; i < pixels.length; i++) {
      const c = pixels[i] ?? 0;
      if (((c >>> 24) & 0xff) !== 255) continue;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    doc.palette.colors = [...counts.entries()]
      .sort((p, q) => q[1] - p[1])
      .slice(0, 64)
      .map((e) => e[0]);
    return doc;
  }

  celKey(l: LayerId, f: FrameId): CelKey {
    return `${l}:${f}` as CelKey;
  }

  /** Cel key for layer/frame INDICES (bounds-checked). */
  celKeyAt(layerIndex: number, frameIndex: number): CelKey {
    const layer = this.layers[layerIndex];
    const frame = this.frames[frameIndex];
    if (!layer) throw new RangeError(`celKeyAt: bad layer index ${layerIndex}`);
    if (!frame) throw new RangeError(`celKeyAt: bad frame index ${frameIndex}`);
    return this.celKey(layer.id, frame.id);
  }

  getCel(key: CelKey): Uint32Array | undefined {
    return this.cels.get(key);
  }

  /** Existing cel or a new transparent one (registered on the doc). */
  ensureCel(key: CelKey): Uint32Array {
    const existing = this.cels.get(key);
    if (existing) return existing;
    const buf = makeBuffer(this.width, this.height);
    this.cels.set(key, buf);
    return buf;
  }

  setCel(key: CelKey, pixels: Uint32Array): void {
    this.cels.set(key, pixels);
  }

  /** Delete a cel, returning its buffer (commands capture it for revert). */
  removeCel(key: CelKey): Uint32Array | undefined {
    const buf = this.cels.get(key);
    if (buf) this.cels.delete(key);
    return buf;
  }

  /** Existing [key, buffer] cel entries belonging to a frame (all layers). */
  celEntriesForFrame(frameId: FrameId): Array<[CelKey, Uint32Array]> {
    const suffix = `:${frameId}`;
    const out: Array<[CelKey, Uint32Array]> = [];
    for (const [key, buf] of this.cels) if (key.endsWith(suffix)) out.push([key, buf]);
    return out;
  }

  /** Existing [key, buffer] cel entries belonging to a layer (all frames). */
  celEntriesForLayer(layerId: LayerId): Array<[CelKey, Uint32Array]> {
    const prefix = `${layerId}:`;
    const out: Array<[CelKey, Uint32Array]> = [];
    for (const [key, buf] of this.cels) if (key.startsWith(prefix)) out.push([key, buf]);
    return out;
  }

  /** Allocate a fresh layer id. Commands allocate ONCE (first apply) and
   *  reuse the captured id on redo — never re-allocate. */
  allocLayerId(): LayerId {
    return this.newLayerId();
  }

  /** Frame twin of allocLayerId — same capture-once rule. */
  allocFrameId(): FrameId {
    return this.newFrameId();
  }

  /**
   * Flatten visible layers of a frame (opacity applied, straight-alpha "over").
   * With `into`+`rect`, composites only that sub-rect into the docW×docH buffer.
   * Single source of flattening truth — compositor and exporters both use it.
   */
  flattenFrame(frameIndex: number, into?: Uint32Array, rect?: Rect): Uint32Array {
    const frame = this.frames[frameIndex];
    if (!frame) throw new RangeError(`flattenFrame: bad frame index ${frameIndex}`);
    const w = this.width;
    const out = into ?? makeBuffer(w, this.height);
    const r = rect ?? { x: 0, y: 0, w, h: this.height };
    for (let y = r.y; y < r.y + r.h; y++) {
      const row = y * w;
      for (let x = r.x; x < r.x + r.w; x++) out[row + x] = 0;
    }
    for (const layer of this.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const cel = this.cels.get(this.celKey(layer.id, frame.id));
      if (!cel) continue;
      for (let y = r.y; y < r.y + r.h; y++) {
        const row = y * w;
        for (let x = r.x; x < r.x + r.w; x++) {
          const i = row + x;
          const s = cel[i] ?? 0;
          const sa = (((s >>> 24) & 0xff) / 255) * layer.opacity;
          if (sa <= 0) continue;
          const d = out[i] ?? 0;
          const da = ((d >>> 24) & 0xff) / 255;
          const oa = sa + da * (1 - sa);
          const dw = da * (1 - sa);
          const rr = Math.round(((s & 0xff) * sa + (d & 0xff) * dw) / oa);
          const gg = Math.round((((s >>> 8) & 0xff) * sa + ((d >>> 8) & 0xff) * dw) / oa);
          const bb = Math.round((((s >>> 16) & 0xff) * sa + ((d >>> 16) & 0xff) * dw) / oa);
          out[i] = packRgba(rr, gg, bb, Math.round(oa * 255));
        }
      }
    }
    return out;
  }

  toJSON(): DocJson {
    const cels: Record<string, string> = {};
    for (const [key, buf] of this.cels) {
      cels[key] = bytesToBase64(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    }
    return {
      version: 1,
      width: this.width,
      height: this.height,
      layers: this.layers.map((l) => ({ ...l })),
      frames: this.frames.map((f) => ({ ...f })),
      tags: this.tags.map((t) => ({ ...t })),
      palette: {
        name: this.palette.name,
        colors: [...this.palette.colors],
        recent: [...this.palette.recent],
      },
      meta: { ...this.meta },
      cels,
    };
  }

  static fromJSON(json: DocJson): SpriteDoc {
    const version = (json as { version: number }).version;
    if (version !== 1) throw new Error(`unsupported doc version: ${version}`);
    const doc = new SpriteDoc(json.width, json.height);
    doc.layers = json.layers.map((l) => ({ ...l }));
    doc.frames = json.frames.map((f) => ({ ...f }));
    doc.tags = json.tags.map((t) => ({ ...t }));
    doc.palette = {
      name: json.palette.name,
      colors: [...json.palette.colors],
      recent: [...json.palette.recent],
    };
    doc.meta = { ...json.meta };
    for (const [key, b64] of Object.entries(json.cels)) {
      const bytes = base64ToBytes(b64);
      doc.cels.set(key as CelKey, new Uint32Array(bytes.buffer, 0, bytes.byteLength >>> 2));
    }
    doc.layerSeq = maxIdSeq(doc.layers.map((l) => l.id), 'l');
    doc.frameSeq = maxIdSeq(doc.frames.map((f) => f.id), 'f');
    return doc;
  }

  private newLayerId(): LayerId {
    this.layerSeq += 1;
    return `l${this.layerSeq}`;
  }

  private newFrameId(): FrameId {
    this.frameSeq += 1;
    return `f${this.frameSeq}`;
  }
}

/** Highest '<prefix><n>' among ids — keeps generated ids collision-free after load. */
function maxIdSeq(ids: readonly string[], prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

/* hand-rolled base64 — core/ must run in node AND browser (no btoa/atob) */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64.charAt((n >>> 18) & 63) + B64.charAt((n >>> 12) & 63);
    out += b1 === undefined ? '=' : B64.charAt((n >>> 6) & 63);
    out += b2 === undefined ? '=' : B64.charAt(n & 63);
  }
  return out;
}

function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error(`invalid base64 character: ${ch}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}
