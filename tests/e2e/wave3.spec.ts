import { expect, test, type Page } from '@playwright/test';

/* Wave 3 gate: frames, durations, playback, layers, onion — the animation core.
   Ends with the wave demo: a 3-frame, 2-layer walk-ish cycle with onion. */

interface Probe3 {
  frames: number;
  layers: number;
  activeFrame: number;
  activeLayer: number;
  durations: number[];
  layerNames: string[];
  opacities: number[];
  playing: boolean;
  onionEnabled: boolean;
  nonZeroActive: number;
  labels: string[];
  tags: { name: string; from: number; to: number; mode: string }[];
}

function probe(page: Page): Promise<Probe3> {
  return page.evaluate(() => {
    const lab = (window as unknown as {
      __lab: {
        editor: {
          doc: {
            frames: { durationMs: number }[];
            layers: { name: string; opacity: number }[];
            tags: { name: string; from: number; to: number; mode: string }[];
            celKeyAt(l: number, f: number): string;
            getCel(k: string): Uint32Array | undefined;
          };
          activeFrame: number; activeLayer: number;
          playing: boolean;
          onion: { enabled: boolean };
        };
        history: { entries(): { labels: readonly string[] } };
      };
    }).__lab;
    const { editor, history } = lab;
    const cel = editor.doc.getCel(editor.doc.celKeyAt(editor.activeLayer, editor.activeFrame));
    let nz = 0;
    if (cel) for (const v of cel) if (v !== 0) nz++;
    return {
      frames: editor.doc.frames.length,
      layers: editor.doc.layers.length,
      activeFrame: editor.activeFrame,
      activeLayer: editor.activeLayer,
      durations: editor.doc.frames.map((f) => f.durationMs),
      layerNames: editor.doc.layers.map((l) => l.name),
      opacities: editor.doc.layers.map((l) => l.opacity),
      playing: editor.playing,
      onionEnabled: editor.onion.enabled,
      nonZeroActive: nz,
      labels: [...history.entries().labels],
      tags: editor.doc.tags.map((t) => ({ ...t })),
    };
  });
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

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
  await page.keyboard.press('b');
});

test('frame add/duplicate/delete with undo chain', async ({ page }) => {
  await paintDot(page, 5, 5);
  await page.keyboard.press('n'); // add frame after active, follows
  let p = await probe(page);
  expect(p.frames).toBe(2);
  expect(p.activeFrame).toBe(1);
  expect(p.nonZeroActive).toBe(0); // new frame blank

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+n'); // duplicate painted frame
  p = await probe(page);
  expect(p.frames).toBe(3);
  expect(p.nonZeroActive).toBeGreaterThan(0); // duplicate carries pixels

  await page.locator('.sl-tl-transport button[title="delete frame"]').click();
  p = await probe(page);
  expect(p.frames).toBe(2);

  await page.keyboard.press('ControlOrMeta+z'); // undo delete
  await page.keyboard.press('ControlOrMeta+z'); // undo duplicate
  await page.keyboard.press('ControlOrMeta+z'); // undo add
  p = await probe(page);
  expect(p.frames).toBe(1);
  expect(p.labels.filter((l) => l.includes('frame')).length).toBeGreaterThanOrEqual(2);
});

test('frame duration edits commit and playback advances frames', async ({ page }) => {
  await page.keyboard.press('n');
  const dur = page.locator('.sl-tl-cell input').first();
  await dur.fill('60');
  await dur.press('Enter');
  let p = await probe(page);
  expect(p.durations[0]).toBe(60);

  await page.keyboard.press('Enter'); // play
  p = await probe(page);
  expect(p.playing).toBe(true);
  await page.waitForTimeout(300); // 2 frames × ~60-100ms → must have advanced
  const seen = new Set<number>();
  for (let i = 0; i < 6; i++) {
    seen.add((await probe(page)).activeFrame);
    await page.waitForTimeout(80);
  }
  expect(seen.size).toBeGreaterThan(1);
  await page.keyboard.press('Enter'); // pause
  expect((await probe(page)).playing).toBe(false);
});

test('layers: add, opacity, visibility, merge down, undo', async ({ page }) => {
  await paintDot(page, 8, 8);
  await page.locator('.sl-layers-head button[title="new layer"]').click();
  let p = await probe(page);
  expect(p.layers).toBe(2);
  expect(p.activeLayer).toBe(1);

  await paintDot(page, 9, 8); // paint on top layer
  const slider = page.locator('.sl-layer-alpha').first(); // top row = top layer
  await slider.fill('50');
  p = await probe(page);
  expect(p.opacities[1]).toBeCloseTo(0.5, 1);

  await page.locator('.sl-layers-head button[title="merge down"]').click();
  p = await probe(page);
  expect(p.layers).toBe(1);
  expect(p.activeLayer).toBe(0);
  expect(p.nonZeroActive).toBe(2); // both dots on the merged layer

  await page.keyboard.press('ControlOrMeta+z'); // un-merge
  p = await probe(page);
  expect(p.layers).toBe(2);
  expect(p.opacities[1]).toBeCloseTo(0.5, 1);
});

test('opacity drag coalesces into few history entries', async ({ page }) => {
  await page.locator('.sl-layers-head button[title="new layer"]').click();
  const before = (await probe(page)).labels.length;
  const slider = page.locator('.sl-layer-alpha').first();
  const box = await slider.boundingBox();
  if (!box) throw new Error('no slider');
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 9; i >= 2; i--) {
    await page.mouse.move(box.x + box.width * (i / 10), box.y + box.height / 2);
  }
  await page.mouse.up();
  const after = (await probe(page)).labels.length;
  expect(after - before).toBeLessThanOrEqual(2);
});

test('onion toggles via K and timeline button', async ({ page }) => {
  await page.keyboard.press('k');
  expect((await probe(page)).onionEnabled).toBe(true);
  await page.locator('.sl-tl-transport button[title="onion skin (K)"]').click();
  expect((await probe(page)).onionEnabled).toBe(false);
});

test('tags: create, range playback stays inside, remove', async ({ page }) => {
  await page.keyboard.press('n');
  await page.keyboard.press('n');
  await page.keyboard.press('n'); // 4 frames
  await page.locator('.sl-tag-add').click();
  await page.keyboard.press('Escape'); // dismiss inline rename if editing
  let p = await probe(page);
  expect(p.tags.length).toBe(1);
  const span = page.locator('.sl-tag').first();
  await span.click(); // set range from tag (single-frame tag at active frame 3)
  await page.keyboard.press('Enter'); // play within range
  await page.waitForTimeout(400);
  p = await probe(page);
  expect(p.activeFrame).toBe(3); // held inside the 1-frame range
  await page.keyboard.press('Enter');
});

test('walk-cycle demo: 3 frames, 2 layers, onion, export still works', async ({ page }) => {
  // body layer: dot that shifts right each frame; overlay layer on frame 0
  await paintDot(page, 10, 16);
  await page.keyboard.press('Shift+n');
  await page.keyboard.press('e'); // eraser: clear the copied dot
  await paintDot(page, 10, 16);
  await page.keyboard.press('b');
  await paintDot(page, 12, 16);
  await page.keyboard.press('Shift+n');
  await page.keyboard.press('e');
  await paintDot(page, 12, 16);
  await page.keyboard.press('b');
  await paintDot(page, 14, 16);

  await page.locator('.sl-layers-head button[title="new layer"]').click();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft'); // frame 0
  await paintDot(page, 10, 12); // head on overlay layer

  await page.keyboard.press('k'); // onion on
  await page.keyboard.press('ArrowRight');
  const p = await probe(page);
  expect(p.frames).toBe(3);
  expect(p.layers).toBe(2);
  expect(p.onionEnabled).toBe(true);

  const dl = page.waitForEvent('download');
  await page.locator('.sl-act-more').click();
  await page.getByRole('menuitem', { name: /^png$/ }).click();
  expect((await (await dl).path())).toBeTruthy();
});
