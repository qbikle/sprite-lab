/** PNG + .sprite in: file picker + drag-drop. Images decode to raw pixels and
 *  route via onImage (app decides direct adopt vs sheet importer); .sprite
 *  files load through the project loader and route via onSprite. */
import { SpriteDoc } from '../core/doc';
import { spriteFileToDoc } from './project';

export interface DecodedImage {
  pixels: Uint32Array;
  w: number;
  h: number;
  name: string;
}

function docName(file: Blob, name?: string): string {
  if (name) return name;
  if (file instanceof File) {
    const base = file.name.replace(/\.[^.]*$/, '').trim();
    if (base) return base;
  }
  return 'imported';
}

function isSpriteFile(file: File): boolean {
  return /\.sprite$/i.test(file.name);
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

export async function decodePng(file: Blob, name?: string): Promise<DecodedImage> {
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
    return { pixels, w: img.width, h: img.height, name: docName(file, name) };
  } finally {
    bmp.close();
  }
}

/** Whole image as a single-frame doc (small images; sheets go via onImage routing). */
export async function pngToDoc(file: Blob, name?: string): Promise<SpriteDoc> {
  const img = await decodePng(file, name);
  return SpriteDoc.fromImage(img.pixels, img.w, img.h, img.name);
}

function routeFile(
  file: File,
  onImage: (img: DecodedImage) => void,
  onSprite: (doc: SpriteDoc) => void,
): void {
  if (isSpriteFile(file)) {
    void spriteFileToDoc(file).then(onSprite).catch(() => undefined);
    return;
  }
  void decodePng(file).then(onImage).catch(() => undefined);
}

/** Whole-window drag-drop: images → onImage, .sprite files → onSprite. Returns uninstall. */
export function installDragDrop(
  onImage: (img: DecodedImage) => void,
  onSprite: (doc: SpriteDoc) => void,
): () => void {
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
    const all = Array.from(files);
    const file = all.find(isSpriteFile) ?? all.find((f) => f.type.startsWith('image/'));
    if (!file) return;
    routeFile(file, onImage, onSprite);
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

export function openFilePicker(
  onImage: (img: DecodedImage) => void,
  onSprite: (doc: SpriteDoc) => void,
): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/*,.sprite';
  input.style.display = 'none';
  const cleanup = (): void => input.remove();
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    cleanup();
    if (file) routeFile(file, onImage, onSprite);
  }, { once: true });
  input.addEventListener('cancel', cleanup, { once: true });
  document.body.appendChild(input);
  input.click();
}
