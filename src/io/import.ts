/** PNG in: file picker + drag-drop. Whole image → single layer/frame doc (Wave 1). */
import { SpriteDoc } from '../core/doc';

function docName(file: Blob, name?: string): string {
  if (name) return name;
  if (file instanceof File) {
    const base = file.name.replace(/\.[^.]*$/, '').trim();
    if (base) return base;
  }
  return 'imported';
}

function rasterize(bmp: ImageBitmap): ImageData {
  const w = bmp.width;
  const h = bmp.height;
  if (typeof OffscreenCanvas !== 'undefined') {
    const ctx = new OffscreenCanvas(w, h).getContext('2d');
    if (ctx) {
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, w, h);
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

export async function pngToDoc(file: Blob, name?: string): Promise<SpriteDoc> {
  if (file.type !== '' && !file.type.startsWith('image/')) {
    throw new Error('That file is not an image — drop a PNG instead.');
  }
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('Could not decode that file as an image — is it a valid PNG?');
  }
  try {
    const img = rasterize(bmp);
    const pixels = new Uint32Array(img.data.buffer).slice();
    return SpriteDoc.fromImage(pixels, img.width, img.height, docName(file, name));
  } finally {
    bmp.close();
  }
}

/** Whole-window drag-drop of image files. Returns uninstall. */
export function installDragDrop(onDoc: (d: SpriteDoc) => void): () => void {
  const hasFiles = (e: DragEvent): boolean =>
    e.dataTransfer !== null && Array.from(e.dataTransfer.types).includes('Files');

  const onDragOver = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.add('sl-dropping');
  };
  const onDragLeave = (e: DragEvent): void => {
    if (e.relatedTarget === null) document.body.classList.remove('sl-dropping');
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    document.body.classList.remove('sl-dropping');
    const files = e.dataTransfer?.files;
    if (!files) return;
    const image = Array.from(files).find((f) => f.type.startsWith('image/'));
    if (!image) return;
    void pngToDoc(image).then(onDoc).catch(() => undefined);
  };

  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
  return () => {
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDrop);
    document.body.classList.remove('sl-dropping');
  };
}

export function openFilePicker(onDoc: (d: SpriteDoc) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/*';
  input.style.display = 'none';
  const cleanup = (): void => input.remove();
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    cleanup();
    if (file) void pngToDoc(file).then(onDoc).catch(() => undefined);
  }, { once: true });
  input.addEventListener('cancel', cleanup, { once: true });
  document.body.appendChild(input);
  input.click();
}
