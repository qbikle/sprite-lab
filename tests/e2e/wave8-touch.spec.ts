import { expect, test, type CDPSession, type Page } from '@playwright/test';

/* Wave 8 touch gate: single-finger draws, a second finger cancels the live
   stroke and pinches/pans without painting, pen pressure sizes the stamp
   (opt-in), palms are rejected while the pen is down, and touch-action is
   declared so the browser never hijacks canvas gestures — while the timeline
   strip keeps native horizontal touch scroll. */

test.use({ hasTouch: true });

interface P8 {
  nonZero: number;
  canUndo: boolean;
  historyLabels: string[];
  zoom: number;
  panX: number;
  panY: number;
}

function probe(page: Page): Promise<P8> {
  return page.evaluate(() => {
    const lab = (window as unknown as {
      __lab: {
        editor: {
          doc: {
            celKeyAt(l: number, f: number): string;
            getCel(k: string): Uint32Array | undefined;
          };
          activeFrame: number;
          activeLayer: number;
        };
        history: { canUndo: boolean; entries(): { labels: readonly string[] } };
        camera: { zoom: number; panX: number; panY: number };
      };
    }).__lab;
    const { editor, history, camera } = lab;
    const cel = editor.doc.getCel(editor.doc.celKeyAt(editor.activeLayer, editor.activeFrame));
    let nonZero = 0;
    if (cel) for (const v of cel) if (v !== 0) nonZero++;
    return {
      nonZero,
      canUndo: history.canUndo,
      historyLabels: [...history.entries().labels],
      zoom: camera.zoom,
      panX: camera.panX,
      panY: camera.panY,
    };
  });
}

async function canvasCenter(page: Page): Promise<{ cx: number; cy: number }> {
  const box = await page.locator('.sl-canvas canvas').boundingBox();
  if (!box) throw new Error('no canvas box');
  return { cx: Math.round(box.x + box.width / 2), cy: Math.round(box.y + box.height / 2) };
}

type TouchPt = { x: number; y: number; id: number };

function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd',
  touchPoints: TouchPt[]): Promise<unknown> {
  return cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
}

function pen(cdp: CDPSession, type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
  x: number, y: number, force: number): Promise<unknown> {
  return cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen', force,
  } as never);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

test('single-finger touch draws and commits one stroke', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  const { cx, cy } = await canvasCenter(page);

  await touch(cdp, 'touchStart', [{ x: cx - 40, y: cy, id: 1 }]);
  await touch(cdp, 'touchMove', [{ x: cx, y: cy, id: 1 }]);
  await touch(cdp, 'touchMove', [{ x: cx + 40, y: cy, id: 1 }]);
  await touch(cdp, 'touchEnd', []);

  const p = await probe(page);
  expect(p.nonZero).toBeGreaterThan(0);
  expect(p.historyLabels).toEqual(['pencil stroke']);
  await expect(page.locator('.sl-history-row', { hasText: 'pencil stroke' })).toBeVisible();

  // canvas gestures never scroll the page
  const scrolled = await page.evaluate(() => ({
    x: window.scrollX, y: window.scrollY,
    el: document.scrollingElement ? document.scrollingElement.scrollTop : 0,
  }));
  expect(scrolled).toEqual({ x: 0, y: 0, el: 0 });
});

test('second finger cancels the live stroke; pinch zooms without painting', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  const { cx, cy } = await canvasCenter(page);
  const before = await probe(page);

  // finger 1 starts a stroke…
  await touch(cdp, 'touchStart', [{ x: cx, y: cy - 40, id: 1 }]);
  await touch(cdp, 'touchMove', [{ x: cx, y: cy - 20, id: 1 }]);
  // …finger 2 lands: the stroke must cancel and the pair must pinch
  await touch(cdp, 'touchStart', [{ x: cx, y: cy - 20, id: 1 }, { x: cx, y: cy + 40, id: 2 }]);
  for (let i = 1; i <= 4; i++) {
    await touch(cdp, 'touchMove', [
      { x: cx, y: cy - 20 - i * 20, id: 1 },
      { x: cx, y: cy + 40 + i * 20, id: 2 },
    ]);
  }
  await touch(cdp, 'touchEnd', []);

  const p = await probe(page);
  expect(p.zoom).toBeGreaterThan(before.zoom);
  expect(p.nonZero).toBe(0); // canceled stage discarded — nothing committed
  expect(p.canUndo).toBe(false);
  expect(p.historyLabels).toEqual([]);
  // only the panel's root 'open' row — no stroke row ever appeared
  await expect(page.locator('.sl-history-row')).toHaveCount(1);
  await expect(page.locator('.sl-history-row', { hasText: 'pencil stroke' })).toHaveCount(0);
  // the statusbar zoom (DOM) moved with the camera
  await expect(page.locator('.sl-status-zoom'))
    .not.toHaveText(`${Math.round(before.zoom * 100)}%`);
});

test('two-finger pan moves the camera without painting', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  const { cx, cy } = await canvasCenter(page);
  const before = await probe(page);

  await touch(cdp, 'touchStart', [{ x: cx - 60, y: cy, id: 1 }, { x: cx + 60, y: cy, id: 2 }]);
  for (let i = 1; i <= 4; i++) {
    await touch(cdp, 'touchMove', [
      { x: cx - 60 + i * 25, y: cy + i * 15, id: 1 },
      { x: cx + 60 + i * 25, y: cy + i * 15, id: 2 },
    ]);
  }
  await touch(cdp, 'touchEnd', []);

  const p = await probe(page);
  expect(p.panX - before.panX).toBeGreaterThan(50);
  expect(p.panY - before.panY).toBeGreaterThan(30);
  expect(Math.abs(p.zoom - before.zoom)).toBeLessThan(0.01); // constant spread = no zoom
  expect(p.nonZero).toBe(0);
  expect(p.historyLabels).toEqual([]);
});

test('pen pressure sizes the stamp — only when the mode is on', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  const { cx, cy } = await canvasCenter(page);
  for (let i = 0; i < 7; i++) await page.keyboard.press(']'); // brush → 8

  // mode OFF (default): a light pen tap still stamps the full 8×8
  await pen(cdp, 'mousePressed', cx, cy, 0.25);
  await pen(cdp, 'mouseReleased', cx, cy, 0.25);
  expect((await probe(page)).nonZero).toBe(64);
  await page.keyboard.press('ControlOrMeta+z');

  // mode ON via the container data-attribute (the app-wireable channel)
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.sl-canvas');
    if (!host) throw new Error('no canvas host');
    host.dataset['penPressure'] = 'on';
  });

  await pen(cdp, 'mousePressed', cx, cy, 0.25); // ceil(0.25 × 8) = 2 → 2×2
  await pen(cdp, 'mouseReleased', cx, cy, 0.25);
  let p = await probe(page);
  expect(p.nonZero).toBe(4);
  expect(p.historyLabels).toEqual(['pencil stroke']);
  await page.keyboard.press('ControlOrMeta+z');

  await pen(cdp, 'mousePressed', cx, cy, 1); // full pressure → full 8×8
  await pen(cdp, 'mouseReleased', cx, cy, 1);
  p = await probe(page);
  expect(p.nonZero).toBe(64);
});

test('palm rejection: touch is inert while the pen is down, live after', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  const { cx, cy } = await canvasCenter(page);
  const before = await probe(page);

  await pen(cdp, 'mousePressed', cx, cy, 0.5); // pen contact, stroke open
  // palm lands as a two-finger touch and tries to pinch
  await touch(cdp, 'touchStart', [{ x: cx - 80, y: cy + 60, id: 1 }, { x: cx + 80, y: cy + 60, id: 2 }]);
  for (let i = 1; i <= 3; i++) {
    await touch(cdp, 'touchMove', [
      { x: cx - 80 - i * 20, y: cy + 60, id: 1 },
      { x: cx + 80 + i * 20, y: cy + 60, id: 2 },
    ]);
  }
  await touch(cdp, 'touchEnd', []);
  await pen(cdp, 'mouseReleased', cx, cy, 0);

  const p = await probe(page);
  expect(p.zoom).toBe(before.zoom); // palm pinch ignored
  expect(p.panX).toBe(before.panX);
  expect(p.historyLabels).toEqual(['pencil stroke']); // the pen stroke survived
  expect(p.nonZero).toBeGreaterThan(0);

  // pen lifted → touch gestures work again
  await touch(cdp, 'touchStart', [{ x: cx, y: cy - 50, id: 3 }, { x: cx, y: cy + 50, id: 4 }]);
  await touch(cdp, 'touchMove', [{ x: cx, y: cy - 90, id: 3 }, { x: cx, y: cy + 90, id: 4 }]);
  await touch(cdp, 'touchEnd', []);
  expect((await probe(page)).zoom).toBeGreaterThan(before.zoom);
});

test('touch-action: canvas owns gestures, chrome taps stay taps, strip pans', async ({ page }) => {
  const ta = (sel: string): Promise<string> =>
    page.locator(sel).first().evaluate((el) => getComputedStyle(el).touchAction);
  expect(await ta('.sl-canvas')).toBe('none');
  expect(await ta('.sl-canvas canvas')).toBe('none');
  expect(await ta('.sl-act-new')).toBe('manipulation');
  expect(await ta('.sl-toolbar button')).toBe('manipulation');
  expect(await ta('.sl-tl-scroll')).toBe('pan-x');
});

test('timeline strip still scrolls horizontally under touch', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 760 });
  const cdp = await page.context().newCDPSession(page);
  for (let i = 0; i < 16; i++) await page.keyboard.press('n'); // overflow the strip

  const strip = page.locator('.sl-tl-scroll');
  const canScroll = await strip.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(canScroll).toBe(true);

  const box = await strip.boundingBox();
  if (!box) throw new Error('no strip box');
  const y = Math.round(box.y + box.height / 2);
  const x0 = Math.round(box.x + box.width - 40);
  await touch(cdp, 'touchStart', [{ x: x0, y, id: 1 }]);
  for (let i = 1; i <= 5; i++) await touch(cdp, 'touchMove', [{ x: x0 - i * 40, y, id: 1 }]);
  await touch(cdp, 'touchEnd', []);

  await expect
    .poll(() => strip.evaluate((el) => el.scrollLeft), { timeout: 3000 })
    .toBeGreaterThan(10);
});
