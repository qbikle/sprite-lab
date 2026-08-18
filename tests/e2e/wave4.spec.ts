import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/* Wave 4 gate: the coat-swap engine + palette editing/ramps/gpl. */

function paletteLen(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as { __lab: { editor: { doc: { palette: { colors: number[] } } } } })
      .__lab.editor.doc.palette.colors.length);
}

function celCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const lab = (window as unknown as {
      __lab: {
        editor: {
          doc: {
            frames: unknown[];
            celKeyAt(l: number, f: number): string;
            getCel(k: string): Uint32Array | undefined;
          };
        };
      };
    }).__lab;
    const counts: Record<string, number> = {};
    const doc = lab.editor.doc;
    for (let f = 0; f < doc.frames.length; f++) {
      const cel = doc.getCel(doc.celKeyAt(0, f));
      if (!cel) continue;
      for (const v of cel) {
        if (v === 0) continue;
        const k = v.toString(16);
        counts[k] = (counts[k] ?? 0) + 1;
      }
    }
    return counts;
  });
}

function labels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...(window as unknown as { __lab: { history: { entries(): { labels: readonly string[] } } } })
      .__lab.history.entries().labels]);
}

async function paintDot(page: Page, x: number, y: number): Promise<void> {
  const pt = await page.evaluate(([px, py]) => {
    const lab = (window as unknown as {
      __lab: { camera: { docToScreen(p: { x: number; y: number }): { x: number; y: number } } };
    }).__lab;
    const s = lab.camera.docToScreen({ x: (px ?? 0) + 0.5, y: (py ?? 0) + 0.5 });
    const r = document.querySelector('.sl-canvas canvas')!.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, [x, y]);
  await page.mouse.click(pt.x, pt.y);
}

async function setHex(page: Page, hex: string): Promise<void> {
  const input = page.locator('.sl-hex');
  await input.fill(hex);
  await input.press('Enter');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
  await page.keyboard.press('b');
});

test('coat swap remaps every frame in ONE undo step', async ({ page }) => {
  await setHex(page, '#ff0000');
  await paintDot(page, 5, 5);
  await page.keyboard.press('Shift+n'); // frame 2 carries red too
  await paintDot(page, 8, 8);

  const before = await celCounts(page);
  const redKey = Object.keys(before).find((k) => (before[k] ?? 0) >= 3);
  expect(redKey).toBeTruthy();

  await setHex(page, '#00aaff'); // replacement color = current
  await page.locator('.sl-swap .sl-panel-head').click(); // expand coat swap
  const firstTarget = page.locator('.sl-swap-row .sl-swap-target').first();
  await firstTarget.click(); // assign current color as target
  const historyBefore = (await labels(page)).length;
  await page.locator('.sl-swap-apply').click();

  const after = await celCounts(page);
  expect(after[redKey as string]).toBeUndefined(); // red gone in ALL frames
  const ls = await labels(page);
  expect(ls.length).toBe(historyBefore + 1);
  expect(ls[ls.length - 1]).toBe('swap colors');

  await page.keyboard.press('ControlOrMeta+z'); // single undo restores
  const restored = await celCounts(page);
  expect(restored[redKey as string]).toBe(before[redKey as string]);
});

test('edit mode replaces and removes swatches undoably', async ({ page }) => {
  const n0 = await paletteLen(page);
  await page.locator('.sl-head-btn[title^="edit palette"]').click();
  // wave 10: swatch click routes through the color picker (seeded with it)
  await page.locator('.sl-swatches .sl-sw').nth(1).click();
  await page.locator('.sl-picker-hex').fill('#123456');
  await page.locator('.sl-picker-hex').press('Enter'); // commit + confirm
  await expect(page.locator('.sl-modal-card.sl-picker')).toHaveCount(0);
  let ls = await labels(page);
  expect(ls[ls.length - 1]).toBe('edit swatch');

  await page.locator('.sl-swatches .sl-sw').nth(2).click({ modifiers: ['Alt'] });
  ls = await labels(page);
  expect(ls[ls.length - 1]).toBe('remove swatch');
  expect(await paletteLen(page)).toBe(n0 - 1);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await paletteLen(page)).toBe(n0);
});

test('ramp appends 5 shades as one command', async ({ page }) => {
  const n0 = await paletteLen(page);
  await setHex(page, '#8a4b2d');
  await page.locator('.sl-head-btn[title^="add a 5-step ramp"]').click();
  expect(await paletteLen(page)).toBe(n0 + 5);
  expect((await labels(page)).pop()).toBe('add ramp');
  await page.keyboard.press('ControlOrMeta+z');
  expect(await paletteLen(page)).toBe(n0);
});

test('palette saves as a valid .gpl file', async ({ page }) => {
  const dl = page.waitForEvent('download');
  await page.locator('.sl-head-btn[title^="save palette"]').click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe('untitled.gpl');
  const text = readFileSync(await download.path(), 'utf8');
  expect(text.startsWith('GIMP Palette')).toBe(true);
  expect(text.split('\n').filter((l) => /^\s*\d+\s+\d+\s+\d+/.test(l)).length).toBeGreaterThan(8);
});
