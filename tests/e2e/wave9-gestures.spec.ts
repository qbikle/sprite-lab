import { expect, test, type CDPSession, type Page } from '@playwright/test';

/* Wave 9 gate: the Figma wheel model — plain wheel PANS (both axes),
   ctrl/cmd+wheel zooms smoothly to the cursor — and paste-to-import.
   Every camera/doc probe is paired with a DOM assertion (statusbar zoom or
   size), per the ledger rule: e2e must assert the DOM, not just __lab. */

interface Cam {
  zoom: number;
  panX: number;
  panY: number;
}

function cam(page: Page): Promise<Cam> {
  return page.evaluate(() => {
    const camera = (window as unknown as { __lab: { camera: Cam } }).__lab.camera;
    return { zoom: camera.zoom, panX: camera.panX, panY: camera.panY };
  });
}

interface DocProbe {
  name: string;
  w: number;
  h: number;
  nonZero: number;
  firstPixel: number;
}

function docProbe(page: Page): Promise<DocProbe> {
  return page.evaluate(() => {
    const { editor } = (window as unknown as {
      __lab: {
        editor: {
          doc: {
            width: number; height: number; meta: { name: string };
            celKeyAt(l: number, f: number): string;
            getCel(k: string): Uint32Array | undefined;
          };
          activeFrame: number;
          activeLayer: number;
        };
      };
    }).__lab;
    const cel = editor.doc.getCel(editor.doc.celKeyAt(editor.activeLayer, editor.activeFrame));
    let nonZero = 0;
    if (cel) for (const v of cel) if (v !== 0) nonZero++;
    return {
      name: editor.doc.meta.name,
      w: editor.doc.width,
      h: editor.doc.height,
      nonZero,
      firstPixel: (cel?.[0] ?? 0) >>> 0,
    };
  });
}

async function canvasCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('.sl-canvas canvas').boundingBox();
  if (!box) throw new Error('viewport canvas not found');
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** CDP wheel — the only way to compose modifier keys onto a wheel event.
 *  Modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
function cdpWheel(
  cdp: CDPSession, x: number, y: number,
  deltaX: number, deltaY: number, modifiers: number,
): Promise<unknown> {
  return cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX, deltaY, modifiers,
  });
}

/** Build an 8×8 solid #e5484d PNG File in-page and dispatch a paste event
 *  carrying it — on `onSelector`'s element when given (target matters for the
 *  typing guard), else on window. Chromium honors ClipboardEventInit.clipboardData;
 *  the defineProperty fallback covers engines that ignore the init member. */
function dispatchPaste(page: Page, onSelector?: string): Promise<void> {
  return page.evaluate(async (sel: string | null) => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2d context unavailable');
    g.fillStyle = '#e5484d';
    g.fillRect(0, 0, 8, 8);
    const blob = await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
    const file = new File([blob], 'clip.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    let ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    if (!ev.clipboardData) {
      ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(ev, 'clipboardData', { value: dt });
    }
    const target = sel ? document.querySelector(sel) : null;
    (target ?? window).dispatchEvent(ev);
  }, onSelector ?? null);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

test('wheel pans vertically; zoom and its statusbar readout hold still', async ({ page }) => {
  const c = await canvasCenter(page);
  await page.mouse.move(c.x, c.y);
  const before = await cam(page);
  const zoomText = await page.locator('.sl-status-zoom').textContent();
  await page.mouse.wheel(0, 120); // scroll down → content moves up
  await expect
    .poll(async () => (await cam(page)).panY)
    .toBeLessThanOrEqual(before.panY - 100);
  const after = await cam(page);
  expect(after.panX).toBe(before.panX);
  expect(after.zoom).toBe(before.zoom);
  await expect(page.locator('.sl-status-zoom')).toHaveText(zoomText ?? '');
});

test('horizontal wheel pans horizontally (deltaX is alive)', async ({ page }) => {
  const c = await canvasCenter(page);
  await page.mouse.move(c.x, c.y);
  const before = await cam(page);
  await page.mouse.wheel(80, 0);
  await expect
    .poll(async () => (await cam(page)).panX)
    .toBeLessThanOrEqual(before.panX - 60);
  const after = await cam(page);
  expect(after.panY).toBe(before.panY);
  expect(after.zoom).toBe(before.zoom);
});

test('ctrl+wheel and cmd+wheel zoom smoothly to the cursor; statusbar follows', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  const c = await canvasCenter(page);
  const before = await cam(page);
  const zoomText = await page.locator('.sl-status-zoom').textContent();

  await cdpWheel(cdp, c.x, c.y, 0, -100, 2); // Ctrl — zoom in ×e^1
  await expect
    .poll(async () => (await cam(page)).zoom)
    .toBeGreaterThan(before.zoom * 1.2);
  await expect(page.locator('.sl-status-zoom')).not.toHaveText(zoomText ?? '');

  const mid = await cam(page);
  await cdpWheel(cdp, c.x, c.y, 0, 100, 4); // Meta — mac cmd+scroll zooms out
  await expect
    .poll(async () => (await cam(page)).zoom)
    .toBeLessThan(mid.zoom);
});

test('paste replaces the doc: name "pasted", statusbar size follows', async ({ page }) => {
  await expect(page.locator('.sl-status-size')).toHaveText('32×32');
  await dispatchPaste(page);
  await expect(page.locator('.sl-status-size')).toHaveText('8×8');
  const d = await docProbe(page);
  expect(d.name).toBe('pasted');
  expect(d.w).toBe(8);
  expect(d.h).toBe(8);
  expect(d.nonZero).toBe(64);
  expect(d.firstPixel).toBe(0xff4d48e5); // ABGR of #e5484d
});

test('paste is inert while focus is in the hex input', async ({ page }) => {
  // module-level recorder instance — wiring-independent proof of the guard
  await page.evaluate(`(async () => {
    const { installPaste } = await import('/src/io/import.ts');
    window.__pasteLog = [];
    installPaste(
      (img) => window.__pasteLog.push(img.name),
      () => window.__pasteLog.push('sprite'),
      () => {},
    );
  })()`);
  const log = (): Promise<string[]> =>
    page.evaluate(() => (window as unknown as { __pasteLog: string[] }).__pasteLog);

  await page.locator('.sl-hex').click();
  await dispatchPaste(page, '.sl-hex'); // target = the focused input
  await page.waitForTimeout(400); // decode is async — let a would-be paste land
  expect(await log()).toEqual([]);
  await expect(page.locator('.sl-status-size')).toHaveText('32×32'); // doc untouched

  // sanity: the same paste away from the input DOES reach the handler
  await page.locator('.sl-hex').blur();
  await dispatchPaste(page);
  await expect.poll(log).toContain('pasted');
});
