import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/* Wave 5 gate: the v1-retirement loop — import sheet via labeler, edit,
   export sheet+json/gif/sprite/px-map. */

interface P5 {
  docW: number;
  frames: number;
  tags: { name: string; from: number; to: number }[];
  nonZeroActive: number;
}

function probe(page: Page): Promise<P5> {
  return page.evaluate(() => {
    const lab = (window as unknown as {
      __lab: {
        editor: {
          doc: {
            width: number;
            frames: unknown[];
            tags: { name: string; from: number; to: number }[];
            celKeyAt(l: number, f: number): string;
            getCel(k: string): Uint32Array | undefined;
          };
          activeFrame: number; activeLayer: number;
        };
      };
    }).__lab;
    const doc = lab.editor.doc;
    const cel = doc.getCel(doc.celKeyAt(lab.editor.activeLayer, lab.editor.activeFrame));
    let nz = 0;
    if (cel) for (const v of cel) if (v !== 0) nz++;
    return {
      docW: doc.width,
      frames: doc.frames.length,
      tags: doc.tags.map((t) => ({ name: t.name, from: t.from, to: t.to })),
      nonZeroActive: nz,
    };
  });
}

async function importCatSheet(page: Page, nameRows = false): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.sl-act-open').click();
  await (await chooser).setFiles('tests/fixtures/cat-sheet.png');
  await expect(page.locator('.sl-importer')).toBeVisible();
  if (nameRows) {
    const first = page.locator('.sl-importer-rows input[type="text"]').first();
    await first.fill('idle');
  }
  await page.locator('.sl-importer-import').click();
  await expect(page.locator('.sl-importer')).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

test('big png routes through the labeler; rows become tags', async ({ page }) => {
  await importCatSheet(page, true);
  const p = await probe(page);
  expect(p.docW).toBe(32);
  expect(p.frames).toBeGreaterThan(50); // the cat sheet is dense
  expect(p.tags.length).toBeGreaterThan(10); // one per detected row
  expect(p.tags[0]?.name).toBe('idle');
  expect(p.nonZeroActive).toBeGreaterThan(0); // frame 0 carries pixels
});

test('sheet+json export matches the v1 shape', async ({ page }) => {
  await importCatSheet(page);
  await page.locator('.sl-act-more').click();
  const downloads: import('@playwright/test').Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await page.getByRole('menuitem', { name: /sheet/ }).click();
  await expect.poll(() => downloads.length, { timeout: 10_000 }).toBe(2);
  const [a, b] = downloads;
  const files = [a!, b!].map((d) => d.suggestedFilename()).sort();
  expect(files.some((f) => f.endsWith('-sheet.png'))).toBe(true);
  expect(files.some((f) => f.endsWith('.sheet.json'))).toBe(true);
  const jsonDl = [a!, b!].find((d) => d.suggestedFilename().endsWith('.json'));
  const data = JSON.parse(readFileSync(await jsonDl!.path(), 'utf8'));
  expect(data).toHaveProperty('sheet');
  expect(data).toHaveProperty('frameW', 32);
  expect(Array.isArray(data.rows)).toBe(true);
  expect(data.rows[0]).toHaveProperty('label');
  expect(data.rows[0]).toHaveProperty('fps');
  expect(Array.isArray(data.rows[0].frames)).toBe(true);
});

test('gif export produces a real GIF89a', async ({ page }) => {
  // small doc: 2 frames drawn quickly
  await page.keyboard.press('g');
  const box = await page.locator('.sl-canvas canvas').boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.press('Shift+n');
  await page.locator('.sl-act-more').click();
  const dl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /^gif$/ }).click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe('untitled.gif');
  const bytes = readFileSync(await download.path());
  expect(bytes.subarray(0, 6).toString()).toBe('GIF89a');
  expect(bytes[bytes.length - 1]).toBe(0x3b);
});

test('.sprite round-trips through save and open', async ({ page }) => {
  await page.keyboard.press('g');
  const box = await page.locator('.sl-canvas canvas').boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const painted = (await probe(page)).nonZeroActive;
  expect(painted).toBe(32 * 32);

  await page.locator('.sl-act-more').click();
  const dl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /save \.sprite/ }).click();
  const file = await (await dl).path();

  // wave 9 flow: themed discard confirm → new-doc modal → create (32×32 default)
  await page.locator('.sl-act-new').click();
  await page.locator('.sl-modal-danger').click();
  await page.locator('.sl-newdoc-create').click();
  await expect
    .poll(async () => (await probe(page)).nonZeroActive)
    .toBe(0);

  await page.locator('.sl-act-more').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /open \.sprite/ }).click();
  await (await chooser).setFiles(file);
  await expect
    .poll(async () => (await probe(page)).nonZeroActive, { timeout: 3000 })
    .toBe(painted);
});

test('px map lands as paste-ready TS', async ({ page }) => {
  await page.keyboard.press('b');
  const box = await page.locator('.sl-canvas canvas').boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.locator('.sl-act-more').click();
  await page.getByRole('menuitem', { name: /px map/ }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  if (clip) {
    expect(clip).toContain('const COLORS = {');
    expect(clip).toContain('const ROWS = [');
    expect(clip).toContain('// px(ROWS, COLORS)');
  } else {
    await expect(page.locator('.sl-status')).toContainText(/px map/);
  }
});
