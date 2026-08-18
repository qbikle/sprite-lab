import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/* Wave 13 (agent T): timelapse export — replay the command history into a
 * watch-me-draw GIF.
 *
 * Most flows drive openExportModal + captureTimelapse + the REAL worker gif
 * encoder via vite-served module imports (string bodies — the transpile
 * gotcha), mirroring the app wiring exactly, so they are green before app.ts
 * integration and stay valid after it (the wave-10 export spec's surviving
 * pattern; nothing here mounts a panel twice).
 *
 * The two tests in the 'post-integration' describe block exercise the app's
 * OWN export button and are RED until app.ts wires the timelapse runner +
 * canTimelapse (see the wave-13 wiring snippet):
 *   - 'app export button runs the wired timelapse runner end-to-end'
 *     (red: run() is a no-op without the runner → the download never lands)
 *   - 'app modal disables the timelapse card on a pristine doc'
 *     (red: canTimelapse defaults true when the app does not pass it) */

/* ── tiny structural GIF walker (node-side oracle) ───────── */

function parseGifStructure(bytes: Buffer): { w: number; h: number; delays: number[] } {
  const u16 = (o: number): number => (bytes[o] ?? 0) | ((bytes[o + 1] ?? 0) << 8);
  if (bytes.subarray(0, 6).toString('latin1') !== 'GIF89a') throw new Error('not GIF89a');
  const w = u16(6);
  const h = u16(8);
  const packed = bytes[10] ?? 0;
  let off = 13 + ((packed & 0x80) !== 0 ? 3 * (2 << (packed & 7)) : 0);
  const skipSubBlocks = (o: number): number => {
    for (;;) {
      const len = bytes[o] ?? 0;
      o += 1;
      if (len === 0) return o;
      o += len;
    }
  };
  const delays: number[] = [];
  let delay = 0;
  for (;;) {
    const b = bytes[off] ?? 0;
    if (b === 0x3b) break;
    if (b === 0x21) {
      if ((bytes[off + 1] ?? 0) === 0xf9) delay = u16(off + 4);
      off = skipSubBlocks(off + 2);
    } else if (b === 0x2c) {
      const local = bytes[off + 9] ?? 0;
      let o = off + 10;
      if ((local & 0x80) !== 0) o += 3 * (2 << (local & 7));
      o += 1; // LZW min code size
      off = skipSubBlocks(o);
      delays.push(delay);
    } else {
      throw new Error(`unexpected gif block 0x${b.toString(16)} at ${off}`);
    }
  }
  return { w, h, delays };
}

/* ── in-page drivers ─────────────────────────────────────── */

/* Direct-drive modal with the REAL capture + worker gif encode wired for the
   timelapse card — the other runners are inert (their flows live in wave10). */
const OPEN_TL = `(async (canTimelapse) => {
  const [modal, tl, protocol, png] = await Promise.all([
    import('/src/ui/panels/exportmodal.ts'),
    import('/src/app/timelapse.ts'),
    import('/src/io/workers/protocol.ts'),
    import('/src/io/exporters/png.ts'),
  ]);
  const lab = window.__lab;
  const doc = () => lab.editor.doc;
  modal.openExportModal({
    doc,
    activeFrame: () => lab.editor.activeFrame,
    canWebp: () => Promise.resolve(true),
    canTimelapse: () => (canTimelapse === undefined ? lab.history.canUndo : canTimelapse),
    run: {
      png: () => {}, sheet: () => {}, gif: () => {},
      webp: () => {}, pxmap: () => {}, sprite: () => {},
      timelapse: ({ scale }) => {
        const result = tl.captureTimelapse({
          history: lab.history, editor: lab.editor, scale,
        });
        if (!result) return;
        const enc = new protocol.EncoderClient();
        void enc.request(
          { kind: 'gif', w: result.w, h: result.h, frames: result.frames },
          result.frames.map((f) => f.pixels),
        ).then((blob) => {
          png.downloadBlob(blob, doc().meta.name + '-timelapse.gif');
          enc.dispose();
        });
      },
    },
  });
})`;

function openTl(page: Page, canTimelapse?: boolean): Promise<unknown> {
  return page.evaluate(`(${OPEN_TL})(${canTimelapse === undefined ? 'undefined' : canTimelapse})`);
}

/** Canonical byte snapshot of the live doc + history (base64 cels included). */
function liveSnap(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const lab = window.__lab;
    const j = lab.editor.doc.toJSON();
    const cels = Object.fromEntries(Object.entries(j.cels).sort((a, b) => a[0] < b[0] ? -1 : 1));
    return JSON.stringify({
      doc: { ...j, cels },
      history: lab.history.entries(),
      canUndo: lab.history.canUndo,
      canRedo: lab.history.canRedo,
    });
  })()`) as Promise<string>;
}

/** N distinct pencil dots — each click commits one PixelPatch command. */
async function drawDots(page: Page, n: number): Promise<void> {
  await page.keyboard.press('b');
  const box = await page.locator('.sl-canvas canvas').boundingBox();
  if (!box) throw new Error('viewport canvas not found');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let i = 0; i < n; i++) {
    await page.mouse.click(cx + i * 24, cy + (i % 2) * 24);
  }
  const commits = await page.evaluate(
    `window.__lab.history.entries().labels.length`,
  ) as number;
  if (commits < n) throw new Error(`expected ${n} commands, got ${commits}`);
}

const card = (page: Page, id: string): ReturnType<Page['locator']> =>
  page.locator(`.sl-export-card-${id}`);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

/* ── direct-drive: real capture + real encoder ───────────── */

test('timelapse card exports a real watch-me-draw gif', async ({ page }) => {
  await drawDots(page, 4);
  await openTl(page);

  await card(page, 'timelapse').click();
  await expect(page.locator('.sl-export-files')).toHaveText('untitled-timelapse.gif');
  await page.locator('.sl-export-chip[data-scale="2"]').click();
  await expect(page.locator('.sl-export-dims')).toContainText('32×32 → 64×64 px');

  const dl = page.waitForEvent('download');
  await page.locator('.sl-export-run').click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe('untitled-timelapse.gif');

  const bytes = readFileSync(await download.path());
  expect(bytes.length).toBeGreaterThan(100);
  const gif = parseGifStructure(bytes);
  expect(gif.w).toBe(64);
  expect(gif.h).toBe(64);
  expect(gif.delays).toHaveLength(4); // one frame per stroke
  // 66ms steps (accumulated-timeline encoder → 6–7cs), last frame holds 1s
  for (const d of gif.delays.slice(0, -1)) {
    expect(d).toBeGreaterThanOrEqual(6);
    expect(d).toBeLessThanOrEqual(7);
  }
  expect(gif.delays[gif.delays.length - 1]).toBeGreaterThanOrEqual(99);
});

test('capture leaves the live doc + history byte-identical, redo tail intact', async ({ page }) => {
  await drawDots(page, 3);
  await page.evaluate(() => (window as unknown as {
    __lab: { history: { undo(): void } };
  }).__lab.history.undo()); // park mid-stack — the walk must respect the cursor
  const before = await liveSnap(page);

  const result = await page.evaluate(`(async () => {
    const tl = await import('/src/app/timelapse.ts');
    const lab = window.__lab;
    const r = tl.captureTimelapse({ history: lab.history, editor: lab.editor, scale: 1 });
    return r ? { frames: r.frames.length, w: r.w, h: r.h } : null;
  })()`) as { frames: number; w: number; h: number } | null;

  expect(result).toEqual({ frames: 2, w: 32, h: 32 }); // only steps ≤ cursor
  expect(await liveSnap(page)).toBe(before);

  // the parked redo still replays the third stroke
  await page.evaluate(() => (window as unknown as {
    __lab: { history: { redo(): void } };
  }).__lab.history.redo());
  const after = await liveSnap(page);
  expect(after).not.toBe(before);
  expect(JSON.parse(after) as { canRedo: boolean }).toMatchObject({ canRedo: false });
});

test('card is disabled with the draw-something note when there is nothing to replay', async ({ page }) => {
  await openTl(page, false);
  const tl = card(page, 'timelapse');
  await expect(tl).toBeDisabled();
  await expect(tl).toContainText('draw something first — the timelapse replays your history');
  // clicking a dead card never selects it
  await expect(card(page, 'png')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
});

test('persisted timelapse format restores, and falls back to gif when disabled', async ({ page }) => {
  await page.evaluate(() =>
    localStorage.setItem('sprite-lab:v2:export', JSON.stringify({ format: 'timelapse', scale: 2 })),
  );
  await drawDots(page, 2);
  await openTl(page);
  await expect(card(page, 'timelapse')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.sl-export-chip[data-scale="2"]')).toHaveClass(/active/);
  await page.keyboard.press('Escape');

  await openTl(page, false);
  await expect(card(page, 'timelapse')).toBeDisabled();
  await expect(card(page, 'gif')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
});

test('scale row is live with the gif 1024 output cap', async ({ page }) => {
  await drawDots(page, 2);
  await openTl(page);
  await card(page, 'timelapse').click();
  await expect(page.locator('.sl-export-scale')).toBeVisible();
  await page.locator('.sl-export-chip[data-scale="16"]').click();
  await expect(page.locator('.sl-export-dims')).toContainText('32×32 → 512×512 px');
  // 32× would hit the 1024 side exactly; 99 clamps down to it
  await page.locator('.sl-export-custom').fill('99');
  await page.locator('.sl-export-custom').blur();
  await expect(page.locator('.sl-export-dims')).toContainText('→ 1024×1024 px');
  await page.keyboard.press('Escape');
});

/* ── post-integration: the app's own export button ───────── */
/* RED until app.ts wires ExportRunners.timelapse + canTimelapse. */

test('app export button runs the wired timelapse runner end-to-end', async ({ page }) => {
  await drawDots(page, 3);
  await page.locator('.sl-act-more').click();
  await card(page, 'timelapse').click();
  const dl = page.waitForEvent('download');
  await page.locator('.sl-export-run').click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe('untitled-timelapse.gif');
  const gif = parseGifStructure(readFileSync(await download.path()));
  expect(gif.delays.length).toBeGreaterThanOrEqual(2);
  expect(gif.w).toBeGreaterThanOrEqual(32);
});

test('app modal disables the timelapse card on a pristine doc', async ({ page }) => {
  await page.locator('.sl-act-more').click();
  const tl = card(page, 'timelapse');
  await expect(tl).toBeVisible();
  await expect(tl).toBeDisabled();
  await expect(tl).toContainText('draw something first — the timelapse replays your history');
  await page.keyboard.press('Escape');
});
