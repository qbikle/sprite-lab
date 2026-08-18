/** Sheet repack: frames → one PNG strip/grid + v1-compatible animation JSON.
 *  Pure packing math (node-testable) + a thin canvas/blob wrapper. */
import type { SpriteDoc } from '../../core/doc';
import type { Tag } from '../../core/contracts';
import { makeBuffer, upscaleNearest } from '../../core/pixels';

export interface SheetExport {
  png: Blob;
  json: string; // v1 shape: { sheet, frameW, frameH, rows: [{row,label,fps,frames}] }
}

export interface SheetLayoutRow {
  tag: Tag;
  frameIndices: number[];
}

export interface SheetLayout {
  cols: number; // widest row, in cells
  rows: SheetLayoutRow[];
}

/** One grid row per tag (fallback: a single 'all' row spanning every frame).
 *  Tag ranges are clamped to the doc's frames; empty rows are dropped. */
export function packSheetLayout(doc: SpriteDoc): SheetLayout {
  const last = doc.frames.length - 1;
  const tags: Tag[] = doc.tags.length > 0
    ? doc.tags
    : [{ name: 'all', from: 0, to: last, mode: 'loop' }];
  const rows: SheetLayoutRow[] = [];
  let cols = 0;
  for (const tag of tags) {
    const from = Math.max(0, tag.from);
    const to = Math.min(last, tag.to);
    if (to < from) continue;
    const frameIndices: number[] = [];
    for (let i = from; i <= to; i++) frameIndices.push(i);
    cols = Math.max(cols, frameIndices.length);
    rows.push({ tag, frameIndices });
  }
  return { cols, rows };
}

/** The sheet PNG's canonical file name — the JSON's `sheet` field and the
 *  downloaded file must agree, or consumers 404. */
export function sheetFileName(base: string): string {
  return `${base}-sheet.png`;
}

function medianDuration(durations: readonly number[]): number {
  const sorted = [...durations].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const m = sorted.length % 2 === 1
    ? sorted[mid] ?? 0
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return Math.max(1, m);
}

/** v1 parity: { sheet, frameW, frameH, rows: [{row,label,fps,frames}] },
 *  pretty-printed. fps = round(1000 / median(row frame durations)).
 *  `scale` keeps the JSON honest about a scaled PNG: frameW/frameH describe
 *  the cells of the file that actually downloads. */
export function buildSheetJson(doc: SpriteDoc, layout: SheetLayout, scale = 1): string {
  const data = {
    sheet: sheetFileName(doc.meta.name),
    frameW: doc.width * scale,
    frameH: doc.height * scale,
    rows: layout.rows.map((row, r) => {
      const durations = row.frameIndices.map((i) => doc.frames[i]?.durationMs ?? 100);
      return {
        row: r,
        label: row.tag.name || `row-${r}`,
        fps: Math.max(1, Math.round(1000 / medianDuration(durations))),
        frames: row.frameIndices.map((_, col) => col),
      };
    }),
  };
  return JSON.stringify(data, null, 2);
}

/** Composite every laid-out frame into one sheet-sized pixel buffer. Pure. */
export function renderSheetPixels(doc: SpriteDoc, layout: SheetLayout): Uint32Array {
  const sheetW = layout.cols * doc.width;
  const sheetH = layout.rows.length * doc.height;
  const out = makeBuffer(sheetW, sheetH);
  for (let r = 0; r < layout.rows.length; r++) {
    const row = layout.rows[r];
    if (!row) continue;
    for (let c = 0; c < row.frameIndices.length; c++) {
      const frameIndex = row.frameIndices[c];
      if (frameIndex === undefined) continue;
      const flat = doc.flattenFrame(frameIndex);
      const dx = c * doc.width;
      const dy = r * doc.height;
      for (let y = 0; y < doc.height; y++) {
        const src = y * doc.width;
        const dst = (dy + y) * sheetW + dx;
        for (let x = 0; x < doc.width; x++) out[dst + x] = flat[src + x] ?? 0;
      }
    }
  }
  return out;
}

/**
 * Pack every frame's composite into a grid (one TAG per row when tags exist,
 * else one row). fps per row derived from the tag's frames' durations (median).
 * `scale` (integer ≥1) upscales the packed sheet nearest-neighbor — cell grid
 * intact, JSON frameW/frameH scaled to match — before the crisp putImageData
 * path (never resampled, imageSmoothingEnabled pinned off).
 */
export async function exportSheet(doc: SpriteDoc, scale = 1): Promise<SheetExport> {
  const layout = packSheetLayout(doc);
  if (layout.cols === 0 || layout.rows.length === 0) {
    throw new Error('Nothing to export — the document has no frames.');
  }
  const base = renderSheetPixels(doc, layout);
  const baseW = layout.cols * doc.width;
  const baseH = layout.rows.length * doc.height;
  const pixels = scale === 1 ? base : upscaleNearest(base, baseW, baseH, scale);
  const sheetW = baseW * scale;
  const sheetH = baseH * scale;
  const canvas = document.createElement('canvas');
  canvas.width = sheetW;
  canvas.height = sheetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(sheetW, sheetH);
  img.data.set(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length * 4));
  ctx.putImageData(img, 0, 0);
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!png) throw new Error('PNG encoding failed.');
  return { png, json: buildSheetJson(doc, layout, scale) };
}
