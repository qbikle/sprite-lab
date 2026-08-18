import { expect, test, type Page } from '@playwright/test';

/* Wave 13 gate: custom stamp brushes — capture a selection into the stamps
   panel, paint with the stamp tool, undo in one step, alt-click removal,
   localStorage persistence. NOTE: needs the app.ts wiring (StampTool in the
   tools array + StampsPanel mount) — see the wave 13 wiring snippet. */

function probe(page: Page): Promise<{
  toolId: string;
  historyLabels: string[];
  hasSelection: boolean;
  statusMsg: string;
}> {
  return page.evaluate(() => {
    const lab = (window as unknown as {
      __lab: {
        editor: { activeToolId: string; selection: unknown };
        history: { entries(): { labels: readonly string[]; cursor: number } };
      };
    }).__lab;
    return {
      toolId: lab.editor.activeToolId,
      historyLabels: [...lab.history.entries().labels],
      hasSelection: lab.editor.selection !== null,
      statusMsg: document.querySelector('.sl-status-msg')?.textContent ?? '',
    };
  });
}

function celPixel(page: Page, x: number, y: number): Promise<number> {
  return page.evaluate(([px, py]) => {
    const lab = (window as unknown as {
      __lab: {
        editor: {
          doc: {
            width: number;
            celKeyAt(l: number, f: number): string;
            getCel(k: string): Uint32Array | undefined;
          };
          activeFrame: number; activeLayer: number;
        };
      };
    }).__lab;
    const { editor } = lab;
    const cel = editor.doc.getCel(editor.doc.celKeyAt(editor.activeLayer, editor.activeFrame));
    return cel?.[(py ?? 0) * editor.doc.width + (px ?? 0)] ?? 0;
  }, [x, y]);
}

/** Screen point of a doc pixel center. */
function docPt(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([px, py]) => {
    const lab = (window as unknown as {
      __lab: { camera: { docToScreen(p: { x: number; y: number }): { x: number; y: number } } };
    }).__lab;
    const s = lab.camera.docToScreen({ x: (px ?? 0) + 0.5, y: (py ?? 0) + 0.5 });
    const canvas = document.querySelector('.sl-canvas canvas');
    if (!canvas) throw new Error('no canvas');
    const r = canvas.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, [x, y]);
}

async function drag(
  page: Page, from: [number, number], to: [number, number], mod?: 'Shift' | 'Alt',
): Promise<void> {
  const a = await docPt(page, from[0], from[1]);
  const b = await docPt(page, to[0], to[1]);
  if (mod) await page.keyboard.down(mod);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  if (mod) await page.keyboard.up(mod);
}

async function clickAt(page: Page, x: number, y: number): Promise<void> {
  const s = await docPt(page, x, y);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** Filled block + marquee over it — the capture source for most tests. */
async function drawAndSelectBlock(page: Page): Promise<void> {
  await page.keyboard.press('r');
  await drag(page, [4, 4], [9, 9], 'Alt');
  await page.keyboard.press('m');
  await drag(page, [4, 4], [9, 9]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

test('capture → tile → stamp tool paints → single-step undo → alt-click removes', async ({ page }) => {
  const capture = page.locator('.sl-stamps-capture');
  await expect(capture).toBeDisabled(); // no selection yet

  await drawAndSelectBlock(page);
  const ink = await celPixel(page, 5, 5);
  expect(ink).not.toBe(0);
  await expect(capture).toBeEnabled();

  await capture.click();
  const tile = page.locator('.sl-stamp-tile');
  await expect(tile).toHaveCount(1);

  // click the tile: active highlight + the stamp tool takes over
  await tile.click();
  await expect(tile).toHaveClass(/active/);
  let p = await probe(page);
  expect(p.toolId).toBe('stamp');
  expect(p.hasSelection).toBe(false); // tile click drops the capture selection

  // 6×6 stamp centered on (20,20) → covers 18..23 (even bias up-left)
  await clickAt(page, 20, 20);
  expect(await celPixel(page, 20, 20)).toBe(ink);
  expect(await celPixel(page, 18, 18)).toBe(ink);
  expect(await celPixel(page, 23, 23)).toBe(ink);
  expect(await celPixel(page, 17, 17)).toBe(0);
  expect(await celPixel(page, 24, 24)).toBe(0);
  p = await probe(page);
  expect(p.historyLabels).toContain('stamp');

  await page.keyboard.press('ControlOrMeta+z');
  expect(await celPixel(page, 20, 20)).toBe(0); // one undo clears the mark…
  expect(await celPixel(page, 5, 5)).toBe(ink); // …and only the mark

  await tile.click({ modifiers: ['Alt'] });
  await expect(tile).toHaveCount(0);
});

test('stamp drags paint at every visited pixel as ONE command', async ({ page }) => {
  await drawAndSelectBlock(page);
  await page.locator('.sl-stamps-capture').click();
  await page.locator('.sl-stamp-tile').click();

  await drag(page, [16, 16], [26, 26]);
  expect(await celPixel(page, 16, 16)).not.toBe(0);
  expect(await celPixel(page, 26, 26)).not.toBe(0);
  const labels = (await probe(page)).historyLabels;
  expect(labels.filter((l) => l === 'stamp')).toHaveLength(1);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await celPixel(page, 16, 16)).toBe(0);
  expect(await celPixel(page, 26, 26)).toBe(0);
});

test('stamp hotkey + empty shelf hints in the status bar', async ({ page }) => {
  await page.keyboard.press('a');
  const p = await probe(page);
  expect(p.toolId).toBe('stamp');
  expect(p.statusMsg).toContain('no stamp yet');
});

test('capturing an empty selection refuses with a status hint', async ({ page }) => {
  await page.keyboard.press('m');
  await drag(page, [20, 20], [25, 25]); // marquee over blank pixels
  await page.locator('.sl-stamps-capture').click();
  await expect(page.locator('.sl-stamp-tile')).toHaveCount(0);
  expect((await probe(page)).statusMsg).toContain('selection is empty');
});

test('stamps persist across reload (localStorage sprite-lab:v2:stamps)', async ({ page }) => {
  await drawAndSelectBlock(page);
  await page.locator('.sl-stamps-capture').click();
  await expect(page.locator('.sl-stamp-tile')).toHaveCount(1);

  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
  await expect(page.locator('.sl-stamp-tile')).toHaveCount(1);

  // and the reloaded stamp still paints (tile click reactivates it)
  await page.locator('.sl-stamp-tile').click();
  await clickAt(page, 20, 20);
  expect(await celPixel(page, 20, 20)).not.toBe(0);
});
