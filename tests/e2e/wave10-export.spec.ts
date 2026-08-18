import { expect, test, type Download, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/* Wave 10 (agent E): the export modal — format cards, exact file manifest,
 * nearest-neighbor scale with output-side caps, persistence.
 *
 * Every flow here drives the panel directly via vite-served module import
 * (string bodies — the transpile gotcha) with REAL exporter runners wired to
 * the live __lab editor, so nothing below needs the app.ts wiring. The
 * trigger-button flow lives in wave7's modal keyboard test instead. */

interface W10 {
  __w10?: { ran: string; scale?: number };
}

/* Opens the modal with runners that exercise the REAL export pipeline for
   png/sheet/sprite (actual downloads) and record gif/webp/pxmap invocations. */
const OPEN_REAL = `(async () => {
  const [modal, png, sheet, palettes, project] = await Promise.all([
    import('/src/ui/panels/exportmodal.ts'),
    import('/src/io/exporters/png.ts'),
    import('/src/io/exporters/sheet.ts'),
    import('/src/io/palettes.ts'),
    import('/src/io/project.ts'),
  ]);
  const lab = window.__lab;
  const doc = () => lab.editor.doc;
  modal.openExportModal({
    doc,
    activeFrame: () => lab.editor.activeFrame,
    canWebp: () => Promise.resolve(true),
    run: {
      png: ({ scale }) => {
        void png.exportPng(doc(), lab.editor.activeFrame, scale)
          .then((b) => png.downloadBlob(b, doc().meta.name + '.png'));
      },
      sheet: ({ scale }) => {
        void sheet.exportSheet(doc(), scale).then(({ png: p, json }) => {
          png.downloadBlob(p, sheet.sheetFileName(doc().meta.name));
          palettes.downloadText(json, doc().meta.name + '.sheet.json');
        });
      },
      gif: ({ scale }) => { window.__w10 = { ran: 'gif', scale }; },
      webp: ({ scale }) => { window.__w10 = { ran: 'webp', scale }; },
      pxmap: () => { window.__w10 = { ran: 'pxmap' }; },
      sprite: () => {
        png.downloadBlob(project.docToSpriteFile(doc()), project.spriteFileName(doc()));
      },
    },
  });
})()`;

/* A detached 128×128 doc — cap math without touching the live editor. */
const OPEN_BIG = `(async (webpOk) => {
  const [modal, core] = await Promise.all([
    import('/src/ui/panels/exportmodal.ts'),
    import('/src/core/doc.ts'),
  ]);
  const doc = core.SpriteDoc.blank(128, 128, 'big');
  modal.openExportModal({
    doc: () => doc,
    activeFrame: () => 0,
    canWebp: () => Promise.resolve(webpOk),
    run: {
      png: ({ scale }) => { window.__w10 = { ran: 'png', scale }; },
      sheet: ({ scale }) => { window.__w10 = { ran: 'sheet', scale }; },
      gif: ({ scale }) => { window.__w10 = { ran: 'gif', scale }; },
      webp: ({ scale }) => { window.__w10 = { ran: 'webp', scale }; },
      pxmap: () => { window.__w10 = { ran: 'pxmap' }; },
      sprite: () => { window.__w10 = { ran: 'sprite' }; },
    },
  });
})`;

function openReal(page: Page): Promise<unknown> {
  return page.evaluate(OPEN_REAL);
}

function openBig(page: Page, webpOk = true): Promise<unknown> {
  return page.evaluate(`(${OPEN_BIG})(${webpOk})`);
}

function ran(page: Page): Promise<W10['__w10'] | null> {
  return page.evaluate(() => (window as unknown as W10).__w10 ?? null);
}

/** Decode a downloaded PNG inside the page (createImageBitmap — no deps). */
async function decodePng(
  page: Page, download: Download,
): Promise<{ w: number; h: number; rgba: number[] }> {
  const path = await download.path();
  const b64 = readFileSync(path).toString('base64');
  return page.evaluate(`(async () => {
    const bin = atob('${b64}');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    return { w: c.width, h: c.height, rgba: Array.from(d) };
  })()`) as Promise<{ w: number; h: number; rgba: number[] }>;
}

/** The single painted pixel of the active cel: doc coords + rgba channels. */
function paintedDot(page: Page): Promise<{ x: number; y: number; rgba: number[] }> {
  return page.evaluate(() => {
    const lab = (window as unknown as {
      __lab: {
        editor: {
          doc: {
            width: number;
            celKeyAt(l: number, f: number): string;
            getCel(k: string): Uint32Array | undefined;
          };
          activeFrame: number;
          activeLayer: number;
        };
      };
    }).__lab;
    const doc = lab.editor.doc;
    const cel = doc.getCel(doc.celKeyAt(lab.editor.activeLayer, lab.editor.activeFrame));
    if (!cel) throw new Error('no cel');
    const at = cel.findIndex((v) => v !== 0);
    if (at < 0) throw new Error('no painted pixel');
    const v = cel[at] ?? 0;
    return {
      x: at % doc.width,
      y: Math.floor(at / doc.width),
      rgba: [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff],
    };
  });
}

async function drawDot(page: Page): Promise<void> {
  await page.keyboard.press('b');
  const box = await page.locator('.sl-canvas canvas').boundingBox();
  if (!box) throw new Error('viewport canvas not found');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const card = (page: Page, id: string): ReturnType<Page['locator']> =>
  page.locator(`.sl-export-card-${id}`);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

test('png at 4x downloads a 128x128 file with block-replicated pixels', async ({ page }) => {
  await drawDot(page);
  const dot = await paintedDot(page);

  await openReal(page);
  await card(page, 'png').click();
  await expect(page.locator('.sl-export-files')).toHaveText('untitled.png');
  await page.locator('.sl-export-chip[data-scale="4"]').click();
  await expect(page.locator('.sl-export-dims')).toContainText('32×32 → 128×128 px');

  const dl = page.waitForEvent('download');
  await page.locator('.sl-export-run').click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe('untitled.png');

  const img = await decodePng(page, download);
  expect(img.w).toBe(128);
  expect(img.h).toBe(128);
  // the lone dot became EXACTLY one 4×4 block of the source color
  let painted = 0;
  for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] !== 0) painted++;
  expect(painted).toBe(16);
  for (let by = 0; by < 4; by++) {
    for (let bx = 0; bx < 4; bx++) {
      const px = dot.x * 4 + bx;
      const py = dot.y * 4 + by;
      const off = (py * 128 + px) * 4;
      expect(img.rgba.slice(off, off + 4)).toEqual(dot.rgba);
    }
  }
});

test('sheet card manifests BOTH files and both download, scaled', async ({ page }) => {
  await drawDot(page);
  await openReal(page);
  await card(page, 'sheet').click();
  await expect(page.locator('.sl-export-files'))
    .toHaveText('untitled-sheet.png + untitled.sheet.json');

  await page.locator('.sl-export-chip[data-scale="2"]').click();
  await expect(page.locator('.sl-export-dims')).toContainText('32×32 → 64×64 px');

  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await page.locator('.sl-export-run').click();
  await expect.poll(() => downloads.length, { timeout: 10_000 }).toBe(2);
  const names = downloads.map((d) => d.suggestedFilename()).sort();
  expect(names).toEqual(['untitled-sheet.png', 'untitled.sheet.json']);

  const pngDl = downloads.find((d) => d.suggestedFilename().endsWith('.png'));
  const img = await decodePng(page, pngDl!);
  expect(img.w).toBe(64);
  expect(img.h).toBe(64);
  const jsonDl = downloads.find((d) => d.suggestedFilename().endsWith('.json'));
  const data = JSON.parse(readFileSync(await jsonDl!.path(), 'utf8')) as {
    sheet: string; frameW: number; frameH: number;
  };
  expect(data.sheet).toBe('untitled-sheet.png');
  expect(data.frameW).toBe(64); // JSON stays honest about the scaled PNG
  expect(data.frameH).toBe(64);
});

test('format and scale persist across close and reopen', async ({ page }) => {
  await openReal(page);
  await card(page, 'gif').click();
  await page.locator('.sl-export-chip[data-scale="4"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.sl-modal-card.sl-export')).toHaveCount(0);

  const stored = await page.evaluate(() => localStorage.getItem('sprite-lab:v2:export'));
  expect(JSON.parse(stored ?? '{}')).toEqual({ format: 'gif', scale: 4 });

  await openReal(page);
  await expect(card(page, 'gif')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.sl-export-chip[data-scale="4"]')).toHaveClass(/active/);
  await expect(page.locator('.sl-export-custom')).toHaveValue('4');
  await page.keyboard.press('Escape');
});

test('gif 16x chip is disabled for a 128px doc; custom input clamps', async ({ page }) => {
  await openBig(page);
  await card(page, 'gif').click();
  await expect(page.locator('.sl-export-chip[data-scale="16"]')).toBeDisabled();
  await expect(page.locator('.sl-export-chip[data-scale="8"]')).toBeEnabled();
  await expect(page.locator('.sl-export-dims')).toContainText('max 8×');
  await expect(page.locator('.sl-export-dims')).toContainText('1024');

  // custom input clamps to the cap, then Enter runs with the clamped value
  await page.locator('.sl-export-custom').fill('99');
  await page.locator('.sl-export-custom').press('Enter');
  await expect(page.locator('.sl-modal-card.sl-export')).toHaveCount(0);
  expect(await ran(page)).toEqual({ ran: 'gif', scale: 8 });

  // png on the same doc allows more headroom (4096 cap → 32×)
  await openBig(page);
  await card(page, 'png').click();
  await expect(page.locator('.sl-export-chip[data-scale="16"]')).toBeEnabled();
  await page.locator('.sl-export-custom').fill('32');
  await page.locator('.sl-export-custom').press('Enter');
  expect(await ran(page)).toEqual({ ran: 'png', scale: 32 });
});

test('px map card shows the clipboard manifest, no scale row', async ({ page }) => {
  await openReal(page);
  await card(page, 'pxmap').click();
  await expect(page.locator('.sl-export-files'))
    .toHaveText('clipboard (falls back to untitled.pxmap.ts)');
  await expect(page.locator('.sl-export-scale')).toBeHidden();
  await card(page, 'sprite').click();
  await expect(page.locator('.sl-export-files')).toHaveText('untitled.sprite');
  await page.keyboard.press('Escape');
});

test('cards are arrow-navigable and Enter runs the focused card', async ({ page }) => {
  await openReal(page);
  await expect(card(page, 'png')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'sheet')).toBeFocused();
  await expect(card(page, 'sheet')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowDown'); // one grid row down (3 columns)
  await expect(card(page, 'pxmap')).toBeFocused();
  await expect(card(page, 'pxmap')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(card(page, 'sheet')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.sl-modal-card.sl-export')).toHaveCount(0);
  expect(await ran(page)).toEqual({ ran: 'pxmap' });
});

test('webp card disables with the browser hint when canWebp is false', async ({ page }) => {
  await page.evaluate(() =>
    localStorage.setItem('sprite-lab:v2:export', JSON.stringify({ format: 'webp', scale: 2 })),
  );
  await openBig(page, false);
  await expect(card(page, 'webp')).toBeDisabled();
  await expect(card(page, 'webp')).toContainText('needs a chromium browser — try gif');
  // persisted webp falls back to gif rather than a dead selection
  await expect(card(page, 'gif')).toHaveAttribute('aria-pressed', 'true');
  // arrows skip the disabled card: sheet → gif → pxmap
  await card(page, 'sheet').click();
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'gif')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'pxmap')).toBeFocused();
  await page.keyboard.press('Escape');
});

test('new-doc modal grows a demo footer link only when onDemo is wired', async ({ page }) => {
  await page.evaluate(`(async () => {
    const m = await import('/src/ui/panels/newdoc.ts');
    m.openNewDocModal({
      currentPalette: () => [],
      onCreate: () => {},
      onDemo: () => { window.__w10 = { ran: 'demo' }; },
    });
  })()`);
  const link = page.locator('.sl-newdoc-demo');
  await expect(link).toHaveText('or open mochi, the demo cat');
  await link.click();
  await expect(page.locator('.sl-modal-card.sl-newdoc')).toHaveCount(0);
  expect(await ran(page)).toEqual({ ran: 'demo' });

  await page.evaluate(`(async () => {
    const m = await import('/src/ui/panels/newdoc.ts');
    m.openNewDocModal({ currentPalette: () => [], onCreate: () => {} });
  })()`);
  await expect(page.locator('.sl-modal-card.sl-newdoc')).toBeAttached();
  await expect(page.locator('.sl-newdoc-demo')).toHaveCount(0);
  await page.keyboard.press('Escape');
});
