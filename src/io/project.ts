/** .sprite project files — DocJson envelope, download/open. */
import { SpriteDoc, type DocJson } from '../core/doc';

/** Name convention: '<doc name>.sprite'. */
export function spriteFileName(doc: SpriteDoc): string {
  return `${doc.meta.name}.sprite`;
}

export function docToSpriteFile(doc: SpriteDoc): Blob {
  return new Blob([JSON.stringify(doc.toJSON())], { type: 'application/json' });
}

export async function spriteFileToDoc(file: Blob): Promise<SpriteDoc> {
  const text = await file.text();
  try {
    return SpriteDoc.fromJSON(JSON.parse(text) as DocJson);
  } catch {
    throw new Error('Could not open that file as a .sprite project — is it a valid save?');
  }
}

export function openSpritePicker(
  onDoc: (d: SpriteDoc) => void,
  onError?: (message: string) => void,
): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.sprite,application/json';
  input.style.display = 'none';
  const cleanup = (): void => input.remove();
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    cleanup();
    if (!file) return;
    void spriteFileToDoc(file)
      .then(onDoc)
      .catch((err: unknown) => {
        onError?.(err instanceof Error ? err.message : 'could not open .sprite file');
      });
  }, { once: true });
  input.addEventListener('cancel', cleanup, { once: true });
  document.body.appendChild(input);
  input.click();
}
