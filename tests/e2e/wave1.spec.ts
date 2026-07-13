import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/* Wave 1 gate: real draw → edit → export flows against the DEV __lab hook. */

interface LabProbe {
  color: number;
  toolId: string;
  brush: number;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  docW: number;
  docH: number;
  nonZero: number;
  firstPixel: number;
}

declare global {
  interface Window {
    __lab: {
      editor: {
        doc: {
          width: number; height: number;
          celKeyAt(l: number, f: number): string;
          getCel(k: string): Uint32Array | undefined;
        };
        color: number; activeToolId: string; brushSize: number;
        activeFrame: number; activeLayer: number;
      };
      history: { canUndo: boolean; canRedo: boolean };
      camera: { zoom: number };
    };
  }
}

function probe(page: Page): Promise<LabProbe> {
  return page.evaluate(() => {
    const { editor, history, camera } = window.__lab;
    const cel = editor.doc.getCel(editor.doc.celKeyAt(editor.activeLayer, editor.activeFrame));
    let nonZero = 0;
    if (cel) for (const v of cel) if (v !== 0) nonZero++;
    return {
      color: editor.color,
      toolId: editor.activeToolId,
      brush: editor.brushSize,
      zoom: camera.zoom,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      docW: editor.doc.width,
      docH: editor.doc.height,
      nonZero,
      firstPixel: cel?.[0] ?? 0,
    };
  });
}

async function canvasCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('.sl-canvas canvas').boundingBox();
  if (!box) throw new Error('viewport canvas not found');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drawStroke(page: Page, dx = 30): Promise<void> {
  const c = await canvasCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + dx, c.y, { steps: 6 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

test('boots a blank 32×32 doc with shell chrome', async ({ page }) => {
  await expect(page.locator('.sl-topbar')).toBeVisible();
  await expect(page.locator('.sl-toolbar .sl-tool-btn')).toHaveCount(10);
  await expect(page.locator('.sl-status')).toContainText('32×32');
  const p = await probe(page);
  expect(p.docW).toBe(32);
  expect(p.nonZero).toBe(0);
  expect(p.canUndo).toBe(false);
});

test('pencil stroke commits one undoable command', async ({ page }) => {
  await drawStroke(page);
  let p = await probe(page);
  expect(p.nonZero).toBeGreaterThan(0);
  expect(p.canUndo).toBe(true);
  const painted = p.nonZero;

  await page.keyboard.press('ControlOrMeta+z');
  p = await probe(page);
  expect(p.nonZero).toBe(0);
  expect(p.canRedo).toBe(true);

  await page.keyboard.press('ControlOrMeta+Shift+z');
  p = await probe(page);
  expect(p.nonZero).toBe(painted);
});

test('brush size hotkeys and tool hotkeys', async ({ page }) => {
  await page.keyboard.press(']');
  await page.keyboard.press(']');
  expect((await probe(page)).brush).toBe(3);
  await page.keyboard.press('[');
  expect((await probe(page)).brush).toBe(2);

  for (const [key, id] of [['e', 'eraser'], ['g', 'fill'], ['i', 'eyedropper'], ['b', 'pencil']] as const) {
    await page.keyboard.press(key);
    expect((await probe(page)).toolId).toBe(id);
  }
});

test('fill floods the empty doc, eraser removes', async ({ page }) => {
  await page.keyboard.press('g');
  const c = await canvasCenter(page);
  await page.mouse.click(c.x, c.y);
  let p = await probe(page);
  expect(p.nonZero).toBe(32 * 32);
  expect(p.firstPixel).toBe(p.color);

  await page.keyboard.press('e');
  await drawStroke(page, 20);
  p = await probe(page);
  expect(p.nonZero).toBeLessThan(32 * 32);
});

test('hex input sets color; eyedropper picks it back after drawing', async ({ page }) => {
  const hex = page.locator('.sl-hex');
  await hex.fill('#ff0000');
  await hex.press('Enter');
  const red = (await probe(page)).color;
  expect(red >>> 0).toBe(0xff0000ff); // ABGR: a=ff b=00 g=00 r=ff

  await drawStroke(page, 10);
  await hex.fill('#00ff00');
  await hex.press('Enter');
  expect((await probe(page)).color).not.toBe(red);

  await page.keyboard.press('i');
  const c = await canvasCenter(page);
  await page.mouse.click(c.x, c.y);
  expect((await probe(page)).color).toBe(red);
});

test('zoom keys, fit, grid toggle survive', async ({ page }) => {
  const z0 = (await probe(page)).zoom;
  await page.keyboard.press('+');
  expect((await probe(page)).zoom).toBeGreaterThan(z0);
  await page.keyboard.press('0');
  expect((await probe(page)).zoom).toBe(z0);
  await page.keyboard.press(',');
  await drawStroke(page, 5);
  expect((await probe(page)).nonZero).toBeGreaterThan(0);
});

test('wheel zooms to cursor', async ({ page }) => {
  const z0 = (await probe(page)).zoom;
  const c = await canvasCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, -120);
  expect((await probe(page)).zoom).toBeGreaterThan(z0);
});

test('cheat sheet opens on ? and closes on Escape', async ({ page }) => {
  await page.keyboard.press('?');
  await expect(page.locator('.sl-cheatsheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.sl-cheatsheet')).toBeHidden();
});

test('theme toggle flips data-theme and persists', async ({ page }) => {
  const t0 = await page.evaluate(() => document.documentElement.dataset['theme']);
  await page.keyboard.press('t');
  const t1 = await page.evaluate(() => document.documentElement.dataset['theme']);
  expect(t1).not.toBe(t0);
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
  expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe(t1);
});

test('png export downloads the drawn frame', async ({ page }) => {
  await page.keyboard.press('g');
  const c = await canvasCenter(page);
  await page.mouse.click(c.x, c.y);
  const dl = page.waitForEvent('download');
  await page.locator('.sl-act-export').click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe('untitled.png');
  const path = await download.path();
  const bytes = readFileSync(path);
  expect(bytes.length).toBeGreaterThan(100);
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
});

test('autosave restores edits across reload', async ({ page }) => {
  await drawStroke(page);
  const painted = (await probe(page)).nonZero;
  expect(painted).toBeGreaterThan(0);
  await page.waitForTimeout(1200); // debounce 800ms
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
  const p = await probe(page);
  expect(p.nonZero).toBe(painted);
  expect(p.canUndo).toBe(false);
});

test('open file picker routes the cat sheet through the labeler', async ({ page }) => {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.sl-act-open').click();
  await (await chooser).setFiles('tests/fixtures/cat-sheet.png');
  await expect(page.locator('.sl-importer')).toBeVisible(); // wave 5: sheets go to the importer
  await page.locator('.sl-importer-import').click();
  await expect(page.locator('.sl-status')).toContainText('32×32');
  const p = await probe(page);
  expect(p.docW).toBe(32);
  expect(p.docH).toBe(32);
});
