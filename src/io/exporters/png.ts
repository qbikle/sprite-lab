/** PNG out — flattened frame (doc.flattenFrame → canvas → blob).
 *  `scale` (integer ≥1) upscales nearest-neighbor BEFORE the canvas — the
 *  buffer lands via putImageData, which never resamples, so pixels stay crisp
 *  regardless of any imageSmoothingEnabled state. */
import type { SpriteDoc } from '../../core/doc';
import { upscaleNearest } from '../../core/pixels';

export async function exportPng(doc: SpriteDoc, frameIndex: number, scale = 1): Promise<Blob> {
  const flat = doc.flattenFrame(frameIndex);
  const pixels = scale === 1 ? flat : upscaleNearest(flat, doc.width, doc.height, scale);
  const w = doc.width * scale;
  const h = doc.height * scale;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(w, h);
  img.data.set(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length * 4));
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG encoding failed.');
  return blob;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
