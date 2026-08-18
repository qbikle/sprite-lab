import { expect, test, type Page } from '@playwright/test';

/* Wave 10 (agent V): live preview panel + canvas transforms.
   All flows run against the real app wiring (wave 10 integration landed). */

interface P10 {
  w: number;
  h: number;
  cel: number[];
}

function probe(page: Page): Promise<P10> {
  return page.evaluate(() => {
    const lab = (window as unknown as {
      __lab: {
        editor: {
          doc: {
            width: number;
            height: number;
            celKeyAt(l: number, f: number): string;
            getCel(k: string): Uint32Array | undefined;
          };
          activeFrame: number;
          activeLayer: number;
        };
      };
    }).__lab;
    const d = lab.editor.doc;
    const cel = d.getCel(d.celKeyAt(lab.editor.activeLayer, lab.editor.activeFrame));
    return { w: d.width, h: d.height, cel: cel ? Array.from(cel) : [] };
  });
}

/** Rebuild the toolbar with the wave-10 transform handlers wired the way
 *  app.ts will wire them (frame index = editor.activeFrame at click time). */
const MOUNT_TOOLBAR = `(async () => {
  const { ToolbarPanel } = await import('/src/ui/panels/toolbar.ts');
  const { FlipFrameX, FlipFrameY, Rotate90CW } =
    await import('/src/core/commands/transform.ts');
  const lab = window.__lab;
  const editor = lab.editor;
  const history = lab.history;
  const host = document.querySelector('.sl-toolbar');
  host.replaceChildren();
  new ToolbarPanel({
    host,
    bus: lab.bus,
    tools: editor.tools,
    getActive: () => editor.activeToolId,
    onSelect: (id) => editor.setTool(id),
    getBrush: () => editor.brushSize,
    onBrush: (s) => editor.setBrush(s),
    getSymmetry: () => editor.symmetry,
    onSymmetry: () => editor.cycleSymmetry(),
    getDither: () => editor.dither,
    onDither: () => editor.cycleDither(),
    onUndo: () => { if (history.canUndo) history.undo(); },
    onRedo: () => { if (history.canRedo) history.redo(); },
    onFlipX: () => history.commit(new FlipFrameX(editor.activeFrame)),
    onFlipY: () => history.commit(new FlipFrameY(editor.activeFrame)),
    onRotate: () => history.commit(new Rotate90CW()),
  }).mount();
})()`;

const ROTATE_CW = `(async () => {
  const { Rotate90CW } = await import('/src/core/commands/transform.ts');
  window.__lab.history.commit(new Rotate90CW());
})()`;

async function drawDot(page: Page, fx: number, fy: number): Promise<void> {
  await page.keyboard.press('b');
  const box = await page.locator('.sl-canvas canvas').boundingBox();
  if (!box) throw new Error('no canvas box');
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

/* ── panel flows ─────────────────── */

test('preview panel mounts at the TOP of the side rail and repaints as frames advance', async ({ page }) => {
  // two distinct frames: a dot on frame 0, an empty frame 1
  await drawDot(page, 0.5, 0.5);
  await page.keyboard.press('n');

  const canvas = page.locator('.sl-preview-canvas');
  await expect(canvas).toBeVisible();
  await expect(page.locator('.sl-side > :first-child')).toHaveClass(/sl-preview/);

  // own duration-driven loop: samples across ~100ms frames must differ
  const first = await canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  await expect
    .poll(async () => canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL()), {
      timeout: 3000,
    })
    .not.toBe(first);

  // the preview never touches the main Player
  const playing = await page.evaluate(
    () => (window as unknown as { __lab: { editor: { playing: boolean } } }).__lab.editor.playing,
  );
  expect(playing).toBe(false);
});

test('preview collapse persists across reload (localStorage sprite-lab:v2:preview)', async ({ page }) => {
  await expect(page.locator('.sl-preview-body')).toBeVisible();

  await page.locator('.sl-preview-head').click();
  await expect(page.locator('.sl-preview-body')).toBeHidden();

  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
  await expect(page.locator('.sl-preview')).toBeAttached();
  await expect(page.locator('.sl-preview-body')).toBeHidden();

  // reopening restores the live canvas
  await page.locator('.sl-preview-head').click();
  await expect(page.locator('.sl-preview-body')).toBeVisible();
  await expect(page.locator('.sl-preview-canvas')).toBeVisible();
});

test('flip-x button mirrors the painted pixel; viewport repaints; undo restores', async ({ page }) => {
  await page.evaluate(MOUNT_TOOLBAR);
  await expect(page.locator('.sl-toolbar .sl-flip-x')).toBeVisible();
  await expect(page.locator('.sl-toolbar .sl-flip-y')).toBeVisible();
  await expect(page.locator('.sl-toolbar .sl-rotate-cw')).toBeVisible();

  // slightly left of center — inside the fitted doc, but the mirror moves it
  await drawDot(page, 0.45, 0.5);
  const before = await probe(page);
  const painted = before.cel
    .map((v, i) => (v !== 0 ? i : -1))
    .filter((i) => i >= 0);
  expect(painted.length).toBeGreaterThan(0);
  const idx = painted[0] ?? 0;
  const x = idx % before.w;
  const y = Math.floor(idx / before.w);
  expect(x).not.toBe(before.w - 1 - x);
  const viewport = page.locator('.sl-canvas canvas');
  const shot = await viewport.evaluate((c) => (c as HTMLCanvasElement).toDataURL());

  await page.locator('.sl-toolbar .sl-flip-x').click();
  const flipped = await probe(page);
  expect(flipped.cel[y * flipped.w + (flipped.w - 1 - x)]).toBe(before.cel[idx]);
  expect(flipped.cel[idx]).toBe(0);
  // the viewport composite repainted (DOM, not just __lab)
  await expect
    .poll(async () => viewport.evaluate((c) => (c as HTMLCanvasElement).toDataURL()))
    .not.toBe(shot);

  await page.keyboard.press('ControlOrMeta+z');
  const restored = await probe(page);
  expect(restored.cel).toEqual(before.cel);
});

test('rotate on a 48×32 doc (newdoc flow): statusbar swaps to 32×48, undo/redo byte-exact', async ({ page }) => {
  await page.locator('.sl-act-new').click();
  await expect(page.locator('.sl-modal-card.sl-newdoc')).toBeVisible();
  await page.locator('.sl-newdoc-w').fill('48');
  await page.locator('.sl-newdoc-h').fill('32');
  await page.locator('.sl-newdoc-create').click();
  await expect(page.locator('.sl-status-size')).toHaveText('48×32');

  await drawDot(page, 0.3, 0.6);
  const before = await probe(page);
  expect(before.w).toBe(48);
  expect(before.h).toBe(32);
  expect(before.cel.some((v) => v !== 0)).toBe(true);

  await page.evaluate(ROTATE_CW);
  await expect(page.locator('.sl-status-size')).toHaveText('32×48');
  const rotated = await probe(page);
  expect(rotated.w).toBe(32);
  expect(rotated.h).toBe(48);
  expect(rotated.cel.filter((v) => v !== 0).length)
    .toBe(before.cel.filter((v) => v !== 0).length);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.sl-status-size')).toHaveText('48×32');
  let p = await probe(page);
  expect(p.cel).toEqual(before.cel);

  // redo/undo again — first-apply caching holds end-to-end
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('.sl-status-size')).toHaveText('32×48');
  await page.keyboard.press('ControlOrMeta+z');
  p = await probe(page);
  expect(p.cel).toEqual(before.cel);
});

/* ── boot wiring (real app, no direct drive) ── */

test('boot wiring: preview panel and transform buttons are present without direct drive', async ({ page }) => {
  await expect(page.locator('.sl-side > :first-child')).toHaveClass(/sl-preview/);
  await expect(page.locator('.sl-preview-canvas')).toBeVisible();
  await expect(page.locator('.sl-toolbar .sl-flip-x')).toBeVisible();
  await expect(page.locator('.sl-toolbar .sl-flip-y')).toBeVisible();
  await expect(page.locator('.sl-toolbar .sl-rotate-cw')).toBeVisible();
});
