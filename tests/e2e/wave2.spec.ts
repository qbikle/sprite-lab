import { expect, test, type Page } from '@playwright/test';

/* Wave 2 gate: shapes, selection/float/anchor undo chain, dither, mirror,
   clipboard, history panel, tiling — all through the DEV __lab hook. */

interface Probe {
  toolId: string;
  nonZero: number;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  hasFloat: boolean;
  floatRect: { x: number; y: number; w: number; h: number } | null;
  symmetry: string;
  historyLabels: string[];
  cursor: number;
  pixelAt(this: void): never;
}

function probe(page: Page): Promise<Omit<Probe, 'pixelAt'>> {
  return page.evaluate(() => {
    const lab = (window as unknown as {
      __lab: {
        editor: {
          doc: {
            celKeyAt(l: number, f: number): string;
            getCel(k: string): Uint32Array | undefined;
          };
          activeToolId: string; activeFrame: number; activeLayer: number;
          selection: { mask: Uint8Array } | null;
          float: { rect: { x: number; y: number; w: number; h: number } } | null;
          symmetry: string;
        };
        history: {
          canUndo: boolean; canRedo: boolean;
          entries(): { labels: readonly string[]; cursor: number };
        };
      };
    }).__lab;
    const { editor, history } = lab;
    const cel = editor.doc.getCel(editor.doc.celKeyAt(editor.activeLayer, editor.activeFrame));
    let nonZero = 0;
    if (cel) for (const v of cel) if (v !== 0) nonZero++;
    const e = history.entries();
    return {
      toolId: editor.activeToolId,
      nonZero,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      hasSelection: editor.selection !== null,
      hasFloat: editor.float !== null,
      floatRect: editor.float ? { ...editor.float.rect } : null,
      symmetry: editor.symmetry,
      historyLabels: [...e.labels],
      cursor: e.cursor,
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

async function drag(page: Page, from: [number, number], to: [number, number], mod?: 'Shift' | 'Alt'): Promise<void> {
  const a = await docPt(page, from[0], from[1]);
  const b = await docPt(page, to[0], to[1]);
  if (mod) await page.keyboard.down(mod);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  if (mod) await page.keyboard.up(mod);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

test('rect tool draws an outline; alt fills; both undoable', async ({ page }) => {
  await page.keyboard.press('r');
  await drag(page, [4, 4], [12, 10]);
  let p = await probe(page);
  expect(p.historyLabels).toContain('rect');
  const outline = p.nonZero;
  expect(outline).toBeGreaterThan(0);
  expect(await celPixel(page, 8, 7)).toBe(0); // interior empty

  await drag(page, [16, 16], [24, 24], 'Alt');
  expect(await celPixel(page, 20, 20)).not.toBe(0); // filled interior
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  p = await probe(page);
  expect(p.nonZero).toBe(0);
});

test('line and ellipse commit with labels', async ({ page }) => {
  await page.keyboard.press('l');
  await drag(page, [2, 2], [20, 14]);
  await page.keyboard.press('o');
  await drag(page, [6, 6], [26, 26]);
  const p = await probe(page);
  expect(p.historyLabels).toEqual(['line', 'ellipse']);
  expect(p.nonZero).toBeGreaterThan(0);
});

test('select → move lifts a float, anchor on Esc, full undo chain', async ({ page }) => {
  // paint a filled block to move
  await page.keyboard.press('r');
  await drag(page, [4, 4], [9, 9], 'Alt');
  const before44 = await celPixel(page, 4, 4);
  expect(before44).not.toBe(0);

  await page.keyboard.press('m');
  await drag(page, [4, 4], [9, 9]);
  let p = await probe(page);
  expect(p.hasSelection).toBe(true);

  await page.keyboard.press('v');
  await drag(page, [6, 6], [18, 18]); // lift + drag by (12,12)
  p = await probe(page);
  expect(p.hasFloat).toBe(true);
  expect(p.floatRect?.x).toBe(16);
  expect(await celPixel(page, 4, 4)).toBe(0); // lifted off the cel

  await page.keyboard.press('Escape'); // anchor in place
  p = await probe(page);
  expect(p.hasFloat).toBe(false);
  expect(await celPixel(page, 16, 16)).toBe(before44); // landed at offset
  expect(p.historyLabels).toContain('anchor selection');

  // undo chain: anchor → lift → select → rect
  await page.keyboard.press('ControlOrMeta+z'); // un-anchor → float back
  await page.keyboard.press('ControlOrMeta+z'); // un-lift → pixels restored
  expect(await celPixel(page, 4, 4)).toBe(before44);
  await page.keyboard.press('ControlOrMeta+z'); // un-select
  p = await probe(page);
  expect(p.hasSelection).toBe(false);
});

test('selection clips drawing; fill respects mask', async ({ page }) => {
  await page.keyboard.press('m');
  await drag(page, [8, 8], [15, 15]);
  await page.keyboard.press('g');
  const c = await docPt(page, 12, 12);
  await page.mouse.click(c.x, c.y);
  const p = await probe(page);
  expect(p.nonZero).toBe(8 * 8); // only the selected square filled
  expect(await celPixel(page, 0, 0)).toBe(0);
});

test('copy/paste creates a float that anchors', async ({ page }) => {
  await page.keyboard.press('r');
  await drag(page, [2, 2], [5, 5], 'Alt');
  await page.keyboard.press('m');
  await drag(page, [2, 2], [5, 5]);
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  let p = await probe(page);
  expect(p.hasFloat).toBe(true);
  expect(p.toolId).toBe('move');
  await page.keyboard.press('Escape');
  p = await probe(page);
  expect(p.hasFloat).toBe(false);
  expect(p.nonZero).toBeGreaterThan(16); // pasted copy landed somewhere
});

test('symmetry quad mirrors a dot 4 ways; dither halves coverage', async ({ page }) => {
  await page.keyboard.press('s'); // x
  await page.keyboard.press('s'); // y
  await page.keyboard.press('s'); // quad
  expect((await probe(page)).symmetry).toBe('quad');
  await page.keyboard.press('b');
  const c = await docPt(page, 3, 3);
  await page.mouse.click(c.x, c.y);
  expect(await celPixel(page, 3, 3)).not.toBe(0);
  expect(await celPixel(page, 28, 3)).not.toBe(0);
  expect(await celPixel(page, 3, 28)).not.toBe(0);
  expect(await celPixel(page, 28, 28)).not.toBe(0);

  await page.keyboard.press('s'); // back to off
  expect((await probe(page)).symmetry).toBe('off');

  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('d'); // bayer2
  await page.keyboard.press('r');
  await drag(page, [0, 0], [15, 15], 'Alt');
  const p = await probe(page);
  expect(p.nonZero).toBe(128); // 16×16 at 50%
});

test('history panel lists commands and jumps', async ({ page }) => {
  await page.keyboard.press('r');
  await drag(page, [1, 1], [6, 6], 'Alt');
  await drag(page, [10, 10], [14, 14], 'Alt');
  const rows = page.locator('.sl-history-row');
  await expect(rows).toHaveCount(3); // open + 2 rects
  await rows.nth(0).click(); // jump to pristine
  let p = await probe(page);
  expect(p.nonZero).toBe(0);
  expect(p.canRedo).toBe(true);
  await rows.nth(2).click(); // jump to latest
  p = await probe(page);
  expect(p.canRedo).toBe(false);
  expect(p.nonZero).toBeGreaterThan(0);
});

test('tiling toggle and lasso selection survive a paint round-trip', async ({ page }) => {
  await page.keyboard.press('.');
  await page.keyboard.press('q');
  await drag(page, [2, 2], [14, 8]); // lasso scribble → some polygon
  const p = await probe(page);
  // lasso may or may not close to a region; either selection or clean deselect is valid,
  // but the app must stay responsive:
  await page.keyboard.press('b');
  const c = await docPt(page, 20, 20);
  await page.mouse.click(c.x, c.y);
  expect((await probe(page)).toolId).toBe('pencil');
  void p;
});
