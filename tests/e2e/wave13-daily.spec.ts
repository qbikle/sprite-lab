import { expect, test, type Page } from '@playwright/test';

/* Wave 13 (agent D): daily dare strip + lospec palette import — both live
 * inside the new-doc modal, so the existing `.sl-act-new` wiring carries
 * them with NO new app.ts wiring. lospec.com is mocked via page.route
 * (fulfilled cross-origin responses still face CORS — the mock must send
 * access-control-allow-origin, mirroring what lospec really sends).
 * Expected seeds come from the REAL dailySeed in-page (string-body import —
 * the transpile gotcha). */

interface Probe13 {
  name: string;
  w: number;
  h: number;
  palette: number[];
  celClear: boolean;
}

function probe(page: Page): Promise<Probe13> {
  return page.evaluate(() => {
    const lab = (window as unknown as {
      __lab: {
        editor: {
          doc: {
            width: number;
            height: number;
            meta: { name: string };
            palette: { colors: number[] };
            celKeyAt(l: number, f: number): string;
            getCel(k: string): Uint32Array | undefined;
          };
        };
      };
    }).__lab;
    const d = lab.editor.doc;
    const cel = d.getCel(d.celKeyAt(0, 0));
    return {
      name: d.meta.name,
      w: d.width,
      h: d.height,
      palette: [...d.palette.colors],
      celClear: cel === undefined || cel.every((v) => v === 0),
    };
  });
}

const SEED_OF_TODAY = `(async () => {
  const { dailySeed } = await import('/src/app/daily.ts');
  const { rgbaToHex } = await import('/src/core/pixels.ts');
  const s = dailySeed();
  return { prompt: s.prompt, colors: s.colors, hexes: s.colors.map(rgbaToHex) };
})()`;

const LOSPEC_JSON = {
  name: 'Sweetie 16',
  colors: ['1a1c2c', '5d275d', 'b13e53', 'f4f4f4'],
};

const PACK_LOSPEC = `(async () => {
  const { hexToRgba } = await import('/src/core/pixels.ts');
  return ${JSON.stringify(LOSPEC_JSON.colors)}.map((c) => hexToRgba('#' + c));
})()`;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

test("dare strip shows today's prompt + 4 chips; take the dare seeds the new doc", async ({ page }) => {
  const seed = await page.evaluate(SEED_OF_TODAY) as {
    prompt: string; colors: number[]; hexes: string[];
  };
  expect(seed.prompt).toMatch(/^an? [a-z]+ [a-z]+$/);

  await page.locator('.sl-act-new').click();
  await expect(page.locator('.sl-modal-card.sl-newdoc')).toBeVisible();

  const strip = page.locator('.sl-daily');
  await expect(strip).toBeVisible();
  await expect(strip.locator('.sl-daily-prompt')).toHaveText(seed.prompt);
  const chips = strip.locator('.sl-daily-chip');
  await expect(chips).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await expect(chips.nth(i)).toHaveAttribute('data-color', seed.hexes[i] ?? '');
  }

  await strip.locator('.sl-daily-take').click();
  await expect(page.locator('.sl-newdoc-name')).toHaveValue(seed.prompt);
  await expect(page.locator('.sl-newdoc-radios input[value="empty"]')).toBeChecked();
  // size untouched
  await expect(page.locator('.sl-newdoc-w')).toHaveValue('32');
  await expect(page.locator('.sl-newdoc-h')).toHaveValue('32');

  await page.locator('.sl-newdoc-create').click();
  await expect(page.locator('.sl-modal-card.sl-newdoc')).toHaveCount(0);

  const p = await probe(page);
  expect(p.name).toBe(seed.prompt);
  expect(p.w).toBe(32);
  expect(p.h).toBe(32);
  // exactly the 4 dare colors, none transparent (the panel's clear slot is
  // synthetic — palette.colors never holds a 0), pixels untouched
  expect(p.palette).toEqual(seed.colors);
  expect(p.palette).toHaveLength(4);
  expect(p.palette.every((c) => c !== 0)).toBe(true);
  expect(p.celClear).toBe(true);
});

test('picking a plain source after taking the dare drops the seed again', async ({ page }) => {
  await page.locator('.sl-act-new').click();
  await page.locator('.sl-daily-take').click();
  await page.locator('.sl-newdoc-radios input[value="starter"]').check();
  await page.locator('.sl-newdoc-create').click();
  const p = await probe(page);
  expect(p.palette.length).toBe(16); // the starter ramp, not the 4 dare colors
});

test('lospec radio → modal → mocked fetch → palette lands in the created doc', async ({ page }) => {
  await page.route('https://lospec.com/palette-list/**', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(LOSPEC_JSON),
    });
  });
  const expected = await page.evaluate(PACK_LOSPEC) as number[];

  await page.locator('.sl-act-new').click();
  await page.locator('.sl-newdoc-radios input[value="lospec"]').click();
  const card = page.locator('.sl-modal-card.sl-lospec');
  await expect(card).toBeVisible();

  await page.locator('.sl-lospec-input').fill('https://lospec.com/palette-list/sweetie-16');
  await page.locator('.sl-lospec-input').press('Enter');

  await expect(card).toHaveCount(0);
  await expect(page.locator('.sl-modal-card.sl-newdoc')).toBeVisible();
  await expect(page.locator('.sl-newdoc-lospec-caption')).toHaveText('lospec: Sweetie 16 (4)');
  await expect(page.locator('.sl-newdoc-radios input[value="lospec"]')).toBeChecked();

  await page.locator('.sl-newdoc-create').click();
  const p = await probe(page);
  expect(p.palette).toEqual(expected);
  expect(p.name).toBe('untitled'); // lospec seeds colors, never the name
});

test('lospec modal: garbage shakes without fetching; 404 shows a typed message', async ({ page }) => {
  let hits = 0;
  await page.route('https://lospec.com/palette-list/**', (route) => {
    hits += 1;
    void route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: '{"error":"palette not found"}',
    });
  });

  await page.locator('.sl-act-new').click();
  await page.locator('.sl-newdoc-radios input[value="lospec"]').click();
  const card = page.locator('.sl-modal-card.sl-lospec');
  await expect(card).toBeVisible();

  // garbage: shake + refuse, nothing hits the network
  await page.locator('.sl-lospec-input').fill('not a slug!');
  await page.locator('.sl-lospec-input').press('Enter');
  await expect(page.locator('.sl-lospec-input')).toHaveClass(/sl-shake/);
  await expect(card).toBeVisible();
  expect(hits).toBe(0);

  // real slug, mocked 404: typed message, modal stays, input usable again
  await page.locator('.sl-lospec-input').fill('no-such-palette');
  await page.locator('.sl-lospec-fetch').click();
  await expect(page.locator('.sl-lospec-status')).toHaveText(
    "no palette called 'no-such-palette' on lospec",
  );
  await expect(page.locator('.sl-lospec-status')).toHaveClass(/error/);
  await expect(card).toBeVisible();
  await expect(page.locator('.sl-lospec-input')).toBeEnabled();
  expect(hits).toBe(1);
});

test('cancelling the lospec modal reverts the palette radio to the last choice', async ({ page }) => {
  await page.locator('.sl-act-new').click();
  await expect(page.locator('.sl-newdoc-radios input[value="starter"]')).toBeChecked();
  await page.locator('.sl-newdoc-radios input[value="lospec"]').click();
  await expect(page.locator('.sl-modal-card.sl-lospec')).toBeVisible();

  await page.keyboard.press('Escape');
  // stacked modals: one Esc closes only the top card
  await expect(page.locator('.sl-modal-card.sl-lospec')).toHaveCount(0);
  await expect(page.locator('.sl-modal-card.sl-newdoc')).toBeVisible();
  await expect(page.locator('.sl-newdoc-radios input[value="lospec"]')).not.toBeChecked();
  await expect(page.locator('.sl-newdoc-radios input[value="starter"]')).toBeChecked();
});
