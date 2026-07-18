import { expect, test, type Page } from '@playwright/test';

/* Wave 7 fix gate: palette undo refreshes the DOM, cut is a history step,
   Esc stays scoped to panel inputs, the importer modal swallows shortcuts,
   export-menu keyboard activation restores focus to the trigger. */

interface P7 {
  nonZero: number;
  frames: number;
  playing: boolean;
  canUndo: boolean;
  hasSelection: boolean;
  historyLabels: string[];
}

function probe(page: Page): Promise<P7> {
  return page.evaluate(() => {
    const lab = (window as unknown as {
      __lab: {
        editor: {
          doc: {
            frames: unknown[];
            celKeyAt(l: number, f: number): string;
            getCel(k: string): Uint32Array | undefined;
          };
          activeFrame: number;
          activeLayer: number;
          playing: boolean;
          selection: unknown;
        };
        history: {
          canUndo: boolean;
          entries(): { labels: readonly string[]; cursor: number };
        };
      };
    }).__lab;
    const { editor, history } = lab;
    const cel = editor.doc.getCel(editor.doc.celKeyAt(editor.activeLayer, editor.activeFrame));
    let nonZero = 0;
    if (cel) for (const v of cel) if (v !== 0) nonZero++;
    return {
      nonZero,
      frames: editor.doc.frames.length,
      playing: editor.playing,
      canUndo: history.canUndo,
      hasSelection: editor.selection !== null,
      historyLabels: [...history.entries().labels],
    };
  });
}

async function fillCanvas(page: Page): Promise<void> {
  await page.keyboard.press('g');
  const box = await page.locator('.sl-canvas canvas').boundingBox();
  if (!box) throw new Error('no canvas box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

test('palette add via + is undoable in the DOM, not just the model', async ({ page }) => {
  const swatches = page.locator('.sl-color .sl-swatches:not(.sl-recent) .sl-sw');
  const before = await swatches.count();

  await page.locator('.sl-hex').fill('#123456');
  await page.locator('.sl-hex').press('Enter');
  await page.locator('.sl-sw-add').click();
  await expect(swatches).toHaveCount(before + 1);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(swatches).toHaveCount(before);
});

test('cut is a real history step: undo restores, redo re-cuts', async ({ page }) => {
  await fillCanvas(page);
  const painted = (await probe(page)).nonZero;
  expect(painted).toBe(32 * 32);

  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+x');
  let p = await probe(page);
  expect(p.nonZero).toBe(0);
  expect(p.historyLabels).toContain('cut');
  await expect(page.locator('.sl-history-row', { hasText: 'cut' })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+z');
  p = await probe(page);
  expect(p.nonZero).toBe(painted);

  await page.keyboard.press('ControlOrMeta+Shift+z');
  p = await probe(page);
  expect(p.nonZero).toBe(0);
});

test('Esc cancels a layer rename without touching the selection', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+a');
  expect((await probe(page)).hasSelection).toBe(true);

  await page.locator('.sl-layer-name').dblclick();
  const rename = page.locator('.sl-layer-rename');
  await expect(rename).toBeVisible();
  await rename.fill('scrapped');
  await rename.press('Escape');

  await expect(rename).toHaveCount(0);
  await expect(page.locator('.sl-layer-name')).toHaveText('layer 1');
  expect((await probe(page)).hasSelection).toBe(true);
});

test('importer modal swallows app shortcuts until import is clicked', async ({ page }) => {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.sl-act-open').click();
  await (await chooser).setFiles('tests/fixtures/cat-sheet.png');
  await expect(page.locator('.sl-importer')).toBeVisible();

  await page.keyboard.press('Enter'); // would toggle playback
  await page.keyboard.press('n'); // would add a frame
  const p = await probe(page);
  expect(p.playing).toBe(false);
  expect(p.frames).toBe(1);
  expect(p.canUndo).toBe(false);

  await page.locator('.sl-importer-import').click();
  await expect(page.locator('.sl-importer')).toBeHidden();
  expect((await probe(page)).frames).toBeGreaterThan(50);
});

test('export menu opens on ArrowDown and returns focus to the trigger', async ({ page }) => {
  await page.keyboard.press('b');
  const box = await page.locator('.sl-canvas canvas').boundingBox();
  if (!box) throw new Error('no canvas box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const trigger = page.locator('.sl-act-more');
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem', { name: /sheet \+ json/ })).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: /px map/ })).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect((await probe(page)).playing).toBe(false); // Enter stayed in the menu
});
