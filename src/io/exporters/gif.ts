/** Hand-rolled animated GIF encoder — median-cut quantize + LZW. Pure, worker-safe. */

export interface GifFrame {
  pixels: Uint32Array; // LE-ABGR
  durationMs: number;
}

const MAX_COLORS = 255; // index 0 reserved for transparency

class ByteWriter {
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(4096);
  private len = 0;

  u8(v: number): void {
    if (this.len === this.buf.length) this.grow(this.len + 1);
    this.buf[this.len++] = v & 0xff;
  }

  u16(v: number): void {
    this.u8(v);
    this.u8(v >>> 8);
  }

  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }

  bytes(b: Uint8Array): void {
    if (this.len + b.length > this.buf.length) this.grow(this.len + b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  take(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.len);
  }

  private grow(min: number): void {
    let cap = this.buf.length * 2;
    while (cap < min) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
  }
}

/** Opaque-color histogram, keyed 0xbbggrr (low 24 bits of LE-ABGR). */
function collectColors(frames: readonly GifFrame[], count: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (const f of frames) {
    const px = f.pixels;
    for (let i = 0; i < count; i++) {
      const c = px[i] ?? 0;
      if (c >>> 24 < 128) continue;
      const key = c & 0xffffff;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

interface WeightedColor { r: number; g: number; b: number; n: number }

function medianCut(counts: Map<number, number>, max: number): number[] {
  const all: WeightedColor[] = [];
  for (const [key, n] of counts) {
    all.push({ r: key & 0xff, g: (key >>> 8) & 0xff, b: (key >>> 16) & 0xff, n });
  }
  const boxes: WeightedColor[][] = [all];
  const channels = ['r', 'g', 'b'] as const;
  while (boxes.length < max) {
    let bestBox = -1;
    let bestRange = 0;
    let bestCh: (typeof channels)[number] = 'r';
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (!box || box.length < 2) continue;
      for (const ch of channels) {
        let lo = 255;
        let hi = 0;
        for (const c of box) {
          if (c[ch] < lo) lo = c[ch];
          if (c[ch] > hi) hi = c[ch];
        }
        if (hi - lo > bestRange) {
          bestRange = hi - lo;
          bestBox = i;
          bestCh = ch;
        }
      }
    }
    if (bestBox < 0) break;
    const box = boxes[bestBox];
    if (!box) break;
    const ch = bestCh;
    box.sort((a, b) => a[ch] - b[ch]);
    const half = box.reduce((s, c) => s + c.n, 0) / 2;
    let acc = 0;
    let split = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i]?.n ?? 0;
      split = i + 1;
      if (acc >= half) break;
    }
    boxes.splice(bestBox, 1, box.slice(0, split), box.slice(split));
  }
  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const c of box) {
      r += c.r * c.n;
      g += c.g * c.n;
      b += c.b * c.n;
      n += c.n;
    }
    return Math.round(r / n) | (Math.round(g / n) << 8) | (Math.round(b / n) << 16);
  });
}

/** 1-based palette slot nearest to key by squared RGB distance. */
function nearestSlot(palette: readonly number[], key: number): number {
  const r = key & 0xff;
  const g = (key >>> 8) & 0xff;
  const b = (key >>> 16) & 0xff;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i] ?? 0;
    const dr = r - (p & 0xff);
    const dg = g - ((p >>> 8) & 0xff);
    const db = b - ((p >>> 16) & 0xff);
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best + 1;
}

/** Standard GIF LZW: 12-bit max codes, clear-code reset when the table fills,
 *  LSB-first bit packing into 255-byte sub-blocks. */
function writeLzw(indices: Uint8Array, minCodeSize: number, out: ByteWriter): void {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map<number, number>();
  let bitBuf = 0;
  let bitCount = 0;
  const block = new Uint8Array(255);
  let blockLen = 0;

  const flushBlock = (): void => {
    if (blockLen === 0) return;
    out.u8(blockLen);
    out.bytes(block.subarray(0, blockLen));
    blockLen = 0;
  };
  const emit = (code: number): void => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      block[blockLen++] = bitBuf & 0xff;
      if (blockLen === 255) flushBlock();
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };

  emit(clear);
  let cur = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i] ?? 0;
    const key = (cur << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      cur = found;
      continue;
    }
    emit(cur);
    if (next === 4096) {
      emit(clear);
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    } else {
      if (next >= 1 << codeSize) codeSize++;
      dict.set(key, next++);
    }
    cur = k;
  }
  emit(cur);
  emit(eoi);
  if (bitCount > 0) {
    block[blockLen++] = bitBuf & 0xff;
    if (blockLen === 255) flushBlock();
  }
  flushBlock();
  out.u8(0);
}

/** Encode frames (all w×h) into GIF89a bytes. Transparent px (alpha<128) honored. */
export function encodeGif(
  frames: readonly GifFrame[],
  w: number,
  h: number,
  onFrame?: (frame: number, total: number) => void,
): Uint8Array<ArrayBuffer> {
  if (frames.length === 0) throw new Error('encodeGif: no frames');

  const counts = collectColors(frames, w * h);
  const exact = counts.size <= MAX_COLORS;
  const palette = exact ? [...counts.keys()] : medianCut(counts, MAX_COLORS);
  const slotByKey = new Map<number, number>();
  if (exact) palette.forEach((key, i) => slotByKey.set(key, i + 1));
  const slotFor = (key: number): number => {
    const hit = slotByKey.get(key);
    if (hit !== undefined) return hit;
    const slot = nearestSlot(palette, key);
    slotByKey.set(key, slot);
    return slot;
  };

  let sizeBits = 1; // GCT size = 2^sizeBits >= palette + transparent slot 0
  while (1 << sizeBits < palette.length + 1) sizeBits++;
  const minCodeSize = Math.max(2, sizeBits);

  const out = new ByteWriter();
  out.ascii('GIF89a');
  out.u16(w);
  out.u16(h);
  out.u8(0x80 | 0x70 | (sizeBits - 1)); // GCT flag, 8-bit color resolution
  out.u8(0); // bg color index
  out.u8(0); // pixel aspect
  for (let i = 0; i < 1 << sizeBits; i++) {
    const key = i >= 1 ? (palette[i - 1] ?? 0) : 0;
    out.u8(key);
    out.u8(key >>> 8);
    out.u8(key >>> 16);
  }
  out.u8(0x21); // NETSCAPE2.0 — loop forever
  out.u8(0xff);
  out.u8(11);
  out.ascii('NETSCAPE2.0');
  out.u8(3);
  out.u8(1);
  out.u16(0);
  out.u8(0);

  const indices = new Uint8Array(w * h);
  for (let f = 0; f < frames.length; f++) {
    onFrame?.(f, frames.length);
    const frame = frames[f];
    if (!frame) continue;
    const px = frame.pixels;
    for (let i = 0; i < indices.length; i++) {
      const c = px[i] ?? 0;
      indices[i] = c >>> 24 < 128 ? 0 : slotFor(c & 0xffffff);
    }
    out.u8(0x21); // graphic control: dispose-to-bg, transparent index 0
    out.u8(0xf9);
    out.u8(4);
    out.u8(0x09);
    out.u16(Math.max(2, Math.round(frame.durationMs / 10)));
    out.u8(0);
    out.u8(0);
    out.u8(0x2c); // image descriptor: full frame, no local table
    out.u16(0);
    out.u16(0);
    out.u16(w);
    out.u16(h);
    out.u8(0);
    out.u8(minCodeSize);
    writeLzw(indices, minCodeSize, out);
  }
  out.u8(0x3b);
  return out.take();
}
