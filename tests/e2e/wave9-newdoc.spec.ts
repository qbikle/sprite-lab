import { expect, test, type Page } from '@playwright/test';

/* Wave 9 (agent N): new-doc modal + canvas resize.
 *
 * The first two tests assert POST-INTEGRATION behavior — they need the app.ts
 * wiring the orchestrator applies (`.sl-act-new` → openNewDocModal, statusbar
 * size cell → openResizeModal → ResizeCanvas commit + render resync). They are
 * EXPECTED TO FAIL until that wiring lands. Everything from 'modal internals'
 * down drives the panels directly (vite dev module import) and must pass now. */

interface P9 {
  w: number;
  h: number;
  name: string;
  cel: number[];
  playing: boolean;
}

function probe(page: Page): Promise<P9> {
  return page.evaluate(() => {
    const lab = (window as unknown as {
      __lab: {
        editor: {
          doc: {
            width: number;
            height: number;
            meta: { name: string };
            celKeyAt(l: number, f: number): string;
            getCel(k: string): Uint32Array | undefined;
          };
          activeFrame: number;
          activeLayer: number;
          playing: boolean;
        };
      };
    }).__lab;
    const d = lab.editor.doc;
    const cel = d.getCel(d.celKeyAt(lab.editor.activeLayer, lab.editor.activeFrame));
    return {
      w: d.width,
      h: d.height,
      name: d.meta.name,
      cel: cel ? Array.from(cel) : [],
      playing: lab.editor.playing,
    };
  });
}

/** Browser-side hook the direct-drive tests stash results on. */
interface W9 {
  __resizeResult?: { w: number; h: number; anchor: string };
  __newDocChoice?: {
    width: number; height: number; name: string; palette: string; background: number;
  };
}

const NEWDOC_MOD = '/src/ui/panels/newdoc.ts';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

/* ── post-integration flows (see header note) ───────────── */

test('new button opens the modal; 48 preset + name creates a 48×48 doc', async ({ page }) => {
  await page.locator('.sl-act-new').click();
  await expect(page.locator('.sl-modal-card.sl-newdoc')).toBeVisible();

  await page.locator('.sl-newdoc-preset', { hasText: /^48$/ }).click();
  await expect(page.locator('.sl-newdoc-w')).toHaveValue('48');
  await expect(page.locator('.sl-newdoc-h')).toHaveValue('48');
  await page.locator('.sl-newdoc-name').fill('hero');
  await page.locator('.sl-newdoc-create').click();

  await expect(page.locator('.sl-modal-card.sl-newdoc')).toHaveCount(0);
  const p = await probe(page);
  expect(p.w).toBe(48);
  expect(p.h).toBe(48);
  expect(p.name).toBe('hero');
  await expect(page.locator('.sl-status-size')).toHaveText('48×48');
});

test('statusbar size cell → shrink 16×16 tl → undo restores dims AND pixels', async ({ page }) => {
  // draw a dot so the round-trip has pixels to lose
  await page.keyboard.press('b');
  const box = await page.locator('.sl-canvas canvas').boundingBox();
  if (!box) throw new Error('no canvas box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const before = await probe(page);
  expect(before.cel.some((v) => v !== 0)).toBe(true);

  await page.locator('.sl-status-size').click();
  await expect(page.locator('.sl-modal-card.sl-resize')).toBeVisible();
  await page.locator('.sl-resize-w').fill('16');
  await page.locator('.sl-resize-h').fill('16');
  await page.locator('.sl-resize-anchor[data-anchor="tl"]').click();
  await page.locator('.sl-resize-apply').click();

  await expect(page.locator('.sl-status-size')).toHaveText('16×16');
  let p = await probe(page);
  expect(p.w).toBe(16);
  expect(p.h).toBe(16);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.sl-status-size')).toHaveText('32×32');
  p = await probe(page);
  expect(p.w).toBe(32);
  expect(p.h).toBe(32);
  expect(p.cel).toEqual(before.cel); // byte-identical round-trip, dot included

  // redo/undo again — cached-buffer gotcha holds end-to-end
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('.sl-status-size')).toHaveText('16×16');
  await page.keyboard.press('ControlOrMeta+z');
  p = await probe(page);
  expect(p.cel).toEqual(before.cel);
});

/* ── modal internals (no app wiring — must pass now) ────── */

test('resize modal: garbage refuses with a shake, clamp, anchor pick, Enter applies', async ({ page }) => {
  await page.evaluate(async (mod) => {
    const m = (await import(/* @vite-ignore */ mod)) as {
      openResizeModal(o: {
        width: number; height: number;
        onResize(w: number, h: number, anchor: string): void;
      }): void;
    };
    m.openResizeModal({
      width: 32,
      height: 32,
      onResize: (w, h, anchor) => {
        (window as unknown as W9).__resizeResult = { w, h, anchor };
      },
    });
  }, NEWDOC_MOD);
  const card = page.locator('.sl-modal-card.sl-resize');
  await expect(card).toBeAttached();
  await expect(page.locator('.sl-resize-current')).toHaveText('current 32×32');

  // garbage width + Enter: refused (modal stays, no result), value self-heals.
  // (The click path can never see garbage — clicking apply blurs the input
  // first and blur heals it, the .sl-hex idiom.)
  await page.locator('.sl-resize-w').fill('');
  await page.locator('.sl-resize-w').press('Enter');
  await expect(card).toBeAttached();
  await expect(page.locator('.sl-resize-w')).toHaveValue('32');
  expect(await page.evaluate(() => (window as unknown as W9).__resizeResult ?? null)).toBeNull();

  // out-of-range clamps on blur
  await page.locator('.sl-resize-w').fill('900');
  await page.locator('.sl-resize-h').focus();
  await expect(page.locator('.sl-resize-w')).toHaveValue('512');

  // pick an anchor, Enter from an input applies + blurs (typing-guard gotcha)
  await page.locator('.sl-resize-anchor[data-anchor="br"]').click();
  await expect(page.locator('.sl-resize-anchor[data-anchor="br"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.sl-resize-anchor[data-anchor="tl"]')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.sl-resize-w').fill('16');
  await page.locator('.sl-resize-h').fill('20');
  await page.locator('.sl-resize-h').press('Enter');

  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as W9).__resizeResult ?? null))
    .toEqual({ w: 16, h: 20, anchor: 'br' });
  // Enter never leaked to the global play/pause shortcut
  expect((await probe(page)).playing).toBe(false);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('resize modal: unchanged size closes without firing onResize', async ({ page }) => {
  await page.evaluate(async (mod) => {
    const m = (await import(/* @vite-ignore */ mod)) as {
      openResizeModal(o: {
        width: number; height: number;
        onResize(w: number, h: number, anchor: string): void;
      }): void;
    };
    m.openResizeModal({
      width: 32,
      height: 32,
      onResize: (w, h, anchor) => {
        (window as unknown as W9).__resizeResult = { w, h, anchor };
      },
    });
  }, NEWDOC_MOD);
  await page.locator('.sl-resize-apply').click();
  await expect(page.locator('.sl-modal-card.sl-resize')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as W9).__resizeResult ?? null)).toBeNull();
});

test('new-doc modal: presets fill inputs, bad hex refuses, create hands back the choice', async ({ page }) => {
  await page.evaluate(async (mod) => {
    const m = (await import(/* @vite-ignore */ mod)) as {
      openNewDocModal(o: {
        currentPalette(): number[];
        onCreate(c: W9['__newDocChoice']): void;
      }): void;
    };
    m.openNewDocModal({
      currentPalette: () => [1, 2, 3],
      onCreate: (c) => {
        (window as unknown as W9).__newDocChoice = c;
      },
    });
  }, NEWDOC_MOD);
  const card = page.locator('.sl-modal-card.sl-newdoc');
  await expect(card).toBeAttached();

  await page.locator('.sl-newdoc-preset', { hasText: /^48$/ }).click();
  await expect(page.locator('.sl-newdoc-w')).toHaveValue('48');
  await expect(page.locator('.sl-newdoc-h')).toHaveValue('48');
  await expect(page.locator('.sl-newdoc-preset', { hasText: /^48$/ })).toHaveClass(/active/);

  // invalid background hex + Enter → shake + refuse (blur would heal it first
  // on the click path, so Enter is the only route that reaches validation)
  await page.locator('.sl-newdoc-bg').fill('zzz');
  await page.locator('.sl-newdoc-bg').press('Enter');
  await expect(card).toBeAttached();
  expect(await page.evaluate(() => (window as unknown as W9).__newDocChoice ?? null)).toBeNull();

  await page.locator('.sl-newdoc-bg').fill('#ff0000');
  await page.locator('.sl-newdoc-name').fill('hero');
  await page.locator('.sl-newdoc-radios input[value="empty"]').check();
  await page.locator('.sl-newdoc-create').click();

  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as W9).__newDocChoice ?? null)).toEqual({
    width: 48,
    height: 48,
    name: 'hero',
    palette: 'empty',
    background: 0xff0000ff,
  });
});

test('new-doc modal: Escape cancels without creating', async ({ page }) => {
  await page.evaluate(async (mod) => {
    const m = (await import(/* @vite-ignore */ mod)) as {
      openNewDocModal(o: {
        currentPalette(): number[];
        onCreate(c: W9['__newDocChoice']): void;
      }): void;
    };
    m.openNewDocModal({
      currentPalette: () => [],
      onCreate: (c) => {
        (window as unknown as W9).__newDocChoice = c;
      },
    });
  }, NEWDOC_MOD);
  await expect(page.locator('.sl-modal-card.sl-newdoc')).toBeAttached();
  // empty current palette disables 'keep current'
  await expect(page.locator('.sl-newdoc-radios input[value="current"]')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('.sl-modal-card.sl-newdoc')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as W9).__newDocChoice ?? null)).toBeNull();
});

test('docFromChoice builds the doc: dims, name, palette source, background fill', async ({ page }) => {
  const res = await page.evaluate(async (mod) => {
    const m = (await import(/* @vite-ignore */ mod)) as {
      docFromChoice(
        c: { width: number; height: number; name: string; palette: string; background: number },
        colors: readonly number[],
      ): {
        width: number;
        height: number;
        meta: { name: string };
        palette: { colors: number[] };
        celKeyAt(l: number, f: number): string;
        getCel(k: string): Uint32Array | undefined;
      };
    };
    const red = 0xff0000ff;
    const filled = m.docFromChoice(
      { width: 8, height: 6, name: 'bg-doc', palette: 'empty', background: red }, [7, 8],
    );
    const filledCel = filled.getCel(filled.celKeyAt(0, 0));
    const current = m.docFromChoice(
      { width: 4, height: 4, name: 'cur', palette: 'current', background: 0 }, [7, 8],
    );
    const starter = m.docFromChoice(
      { width: 4, height: 4, name: 'st', palette: 'starter', background: 0 }, [7, 8],
    );
    const starterCel = starter.getCel(starter.celKeyAt(0, 0));
    return {
      dims: [filled.width, filled.height],
      name: filled.meta.name,
      emptyColors: filled.palette.colors.length,
      fillOk: !!filledCel && filledCel.length === 48 && filledCel.every((v) => v === red),
      currentColors: current.palette.colors,
      starterCount: starter.palette.colors.length,
      starterClear: !!starterCel && starterCel.every((v) => v === 0),
    };
  }, NEWDOC_MOD);
  expect(res.dims).toEqual([8, 6]);
  expect(res.name).toBe('bg-doc');
  expect(res.emptyColors).toBe(0);
  expect(res.fillOk).toBe(true);
  expect(res.currentColors).toEqual([7, 8]);
  expect(res.starterCount).toBe(16);
  expect(res.starterClear).toBe(true);
});
