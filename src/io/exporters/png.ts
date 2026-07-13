/** PNG out — flattened frame (doc.flattenFrame → canvas → blob). */
import type { SpriteDoc } from '../../core/doc';

export async function exportPng(doc: SpriteDoc, frameIndex: number): Promise<Blob> {
  const flat = doc.flattenFrame(frameIndex);
  const canvas = document.createElement('canvas');
  canvas.width = doc.width;
  canvas.height = doc.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
  const img = ctx.createImageData(doc.width, doc.height);
  img.data.set(new Uint8ClampedArray(flat.buffer, flat.byteOffset, flat.length * 4));
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
