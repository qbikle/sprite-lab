import { expect, test, type Page } from '@playwright/test';

/* Wave 8 gate: first-run onboarding — a fresh browser boots into the demo
   sprite (the mochi cat), 'open demo' brings it back, and a user's autosaved
   work always wins over the demo on reload. */

interface DemoProbe {
  docW: number;
  docH: number;
  frames: number;
  tags: Array<{ name: string; from: number; to: number; mode: string }>;
  layers: number;
  activeFrame: number;
  playing: boolean;
  canUndo: boolean;
  nonZero: number;
}

function probe(page: Page): Promise<DemoProbe> {
  return page.evaluate(() => {
    const lab = (window as unknown as {
      __lab: {
        editor: {
          doc: {
            width: number; height: number;
            frames: unknown[];
            layers: unknown[];
            tags: Array<{ name: string; from: number; to: number; mode: string }>;
            celKeyAt(l: number, f: number): string;
            getCel(k: string): Uint32Array | undefined;
          };
          activeFrame: number;
          activeLayer: number;
          playing: boolean;
        };
        history: { canUndo: boolean };
      };
    }).__lab;
    const { editor, history } = lab;
    const cel = editor.doc.getCel(editor.doc.celKeyAt(editor.activeLayer, editor.activeFrame));
    let nonZero = 0;
    if (cel) for (const v of cel) if (v !== 0) nonZero++;
    return {
      docW: editor.doc.width,
      docH: editor.doc.height,
      frames: editor.doc.frames.length,
      tags: editor.doc.tags,
      layers: editor.doc.layers.length,
      activeFrame: editor.activeFrame,
      playing: editor.playing,
      canUndo: history.canUndo,
      nonZero,
    };
  });
}

async function drawStroke(page: Page, dx = 30): Promise<void> {
  const box = await page.locator('.sl-canvas canvas').boundingBox();
  if (!box) throw new Error('viewport canvas not found');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy, { steps: 6 });
  await page.mouse.up();
}

/* The demo doc has pixels, so 'new' asks for confirmation (wave 9: themed
   confirm → new-doc modal → create with the 32×32 default). */
async function newBlankDoc(page: Page): Promise<void> {
  await page.locator('.sl-act-new').click();
  await page.locator('.sl-modal-danger').click();
  await page.locator('.sl-newdoc-create').click();
  await expect(page.locator('.sl-status')).toContainText('32×32');
}

/* No storage-clear dance here: a brand-new context IS the first run. */
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => '__lab' in window);
});

test('a fresh browser boots into the animated demo sprite', async ({ page }) => {
  const p = await probe(page);
  expect(p.docW).toBe(24);
  expect(p.docH).toBe(24);
  expect(p.frames).toBeGreaterThan(1);
  expect(p.layers).toBe(2);
  expect(p.tags).toEqual([{ name: 'idle', from: 0, to: 5, mode: 'loop' }]);
  expect(p.nonZero).toBeGreaterThan(0);
  // lands on frame 1, paused, with a clean history (like opening a file)
  expect(p.activeFrame).toBe(0);
  expect(p.playing).toBe(false);
  expect(p.canUndo).toBe(false);
  // and the DOM agrees: doc size + all six frames + the tag lane
  await expect(page.locator('.sl-status')).toContainText('24×24');
  await expect(page.locator('.sl-tl-thumb')).toHaveCount(6);
  await expect(page.locator('.sl-tag-name')).toContainText('idle');
});

test("'open demo' menu item reloads the demo after a 'new'", async ({ page }) => {
  await newBlankDoc(page);
  let p = await probe(page);
  expect(p.docW).toBe(32);
  expect(p.frames).toBe(1);
  expect(p.nonZero).toBe(0);

  await page.locator('.sl-act-more').click();
  const item = page.locator('.sl-act-demo');
  await expect(item).toHaveText('open demo');
  await item.click();

  p = await probe(page);
  expect(p.docW).toBe(24);
  expect(p.frames).toBe(6);
  expect(p.tags[0]?.name).toBe('idle');
  expect(p.nonZero).toBeGreaterThan(0);
  expect(p.canUndo).toBe(false);
  await expect(page.locator('.sl-status')).toContainText('24×24');
});

test('autosaved user work restores instead of the demo on reload', async ({ page }) => {
  await newBlankDoc(page);
  await drawStroke(page);
  const painted = (await probe(page)).nonZero;
  expect(painted).toBeGreaterThan(0);
  await page.waitForTimeout(1200); // autosave debounce 800ms

  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
  const p = await probe(page);
  expect(p.docW).toBe(32);
  expect(p.frames).toBe(1);
  expect(p.nonZero).toBe(painted);
  await expect(page.locator('.sl-status')).toContainText('32×32');
});
