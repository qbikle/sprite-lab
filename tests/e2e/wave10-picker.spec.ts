import { expect, test, type Page } from '@playwright/test';

/* Wave 10 (agent P): the hex-only color flow is dead.
 * `+` opens the picker, edit-mode swatch clicks route through it, the main
 * chip is a picker entry, and the ramp button grew a step control.
 * DOM-asserting throughout (gotcha ledger: never trust __lab alone). */

const PAL_SW = '.sl-color .sl-swatches:not(.sl-recent) .sl-sw';
const PICKER = '.sl-modal-card.sl-picker';

async function setPanelHex(page: Page, hex: string): Promise<void> {
  await page.locator('.sl-hex').fill(hex);
  await page.locator('.sl-hex').press('Enter');
}

/** The card slides in over 120ms — drag targets measured mid-transition land
 *  offset (settle gotcha). Wait until the transform finishes. */
async function pickerSettled(page: Page): Promise<void> {
  await expect(page.locator(PICKER)).toBeVisible();
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el !== null && getComputedStyle(el).transform === 'none';
  }, PICKER);
}

/** Drag from (fx0,fy0) to (fx1,fy1), fractions of the canvas CONTENT box
 *  (2px border corrected). */
async function dragCanvas(
  page: Page, selector: string,
  fx0: number, fy0: number, fx1: number, fy1: number,
): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  const b = 2;
  const w = box.width - 2 * b;
  const h = box.height - 2 * b;
  await page.mouse.move(box.x + b + fx0 * (w - 1), box.y + b + fy0 * (h - 1));
  await page.mouse.down();
  await page.mouse.move(box.x + b + fx1 * (w - 1), box.y + b + fy1 * (h - 1), { steps: 4 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

test('+ opens the picker; SV + hue drag picks; confirm adds an undoable swatch', async ({ page }) => {
  const swatches = page.locator(PAL_SW);
  const before = await swatches.count();

  await page.locator('.sl-sw-add').click();
  await pickerSettled(page);

  await dragCanvas(page, '.sl-picker-sv', 0.5, 0.5, 0.72, 0.3);
  await dragCanvas(page, '.sl-picker-hue', 0.5, 0.5, 0.62, 0.5);

  const picked = await page.locator('.sl-picker-after').getAttribute('data-color');
  expect(picked).toMatch(/^#[0-9a-f]{6}$/);
  if (picked === null) throw new Error('no after-chip color');

  await page.locator('.sl-picker-ok').click();
  await expect(page.locator(PICKER)).toHaveCount(0);

  await expect(swatches).toHaveCount(before + 1);
  await expect(page.locator(`${PAL_SW}[data-color="${picked}"]`)).toBeVisible();

  // wave7 pattern: palette add must be a real history step in the DOM
  await page.keyboard.press('ControlOrMeta+z');
  await expect(swatches).toHaveCount(before);
  await expect(page.locator(`${PAL_SW}[data-color="${picked}"]`)).toHaveCount(0);
});

test('main chip opens the picker seeded with the current color; pick lands in .sl-hex', async ({ page }) => {
  await setPanelHex(page, '#336699');

  await page.locator('.sl-chip-main').click();
  await pickerSettled(page);
  // seeded with the current color
  await expect(page.locator('.sl-picker-hex')).toHaveValue('#336699');

  // top-left of the SV square is exactly white (s=0, v=1)
  await dragCanvas(page, '.sl-picker-sv', 0.5, 0.5, 0, 0);
  await expect(page.locator('.sl-picker-after')).toHaveAttribute('data-color', '#ffffff');

  await page.locator('.sl-picker-ok').click();
  await expect(page.locator(PICKER)).toHaveCount(0);
  await expect(page.locator('.sl-hex')).toHaveValue('#ffffff');
});

test('Esc cancels without adding', async ({ page }) => {
  const swatches = page.locator(PAL_SW);
  const before = await swatches.count();

  await page.locator('.sl-sw-add').click();
  await expect(page.locator(PICKER)).toBeVisible();
  await dragCanvas(page, '.sl-picker-sv', 0.5, 0.5, 0.8, 0.2);

  await page.keyboard.press('Escape');
  await expect(page.locator(PICKER)).toHaveCount(0);
  await expect(swatches).toHaveCount(before);
});

test('edit-mode swatch click routes through the picker seeded with that swatch', async ({ page }) => {
  await page.locator('.sl-color .sl-edit-btn').click();

  const target = page.locator(`${PAL_SW}[data-color]`).first();
  const seed = await target.getAttribute('data-color');
  if (seed === null) throw new Error('no colored swatch to edit');

  await target.click();
  await pickerSettled(page);
  await expect(page.locator('.sl-picker-hex')).toHaveValue(seed);

  // Enter in the hex field commits + confirms in one stroke
  await page.locator('.sl-picker-hex').fill('#0a141e');
  await page.locator('.sl-picker-hex').press('Enter');
  await expect(page.locator(PICKER)).toHaveCount(0);

  await expect(page.locator(`${PAL_SW}[data-color="#0a141e"]`)).toBeVisible();
  await expect(page.locator(`${PAL_SW}[data-color="${seed}"]`)).toHaveCount(0);

  // replace is undoable in the DOM too
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator(`${PAL_SW}[data-color="${seed}"]`)).toBeVisible();
  await expect(page.locator(`${PAL_SW}[data-color="#0a141e"]`)).toHaveCount(0);
});

test('alt-click remove in edit mode still works (no picker)', async ({ page }) => {
  await page.locator('.sl-color .sl-edit-btn').click();
  const swatches = page.locator(PAL_SW);
  const before = await swatches.count();

  await page.locator(`${PAL_SW}[data-color]`).first().click({ modifiers: ['Alt'] });
  await expect(page.locator(PICKER)).toHaveCount(0);
  await expect(swatches).toHaveCount(before - 1);
});

test('ramp stepper drives the generated ramp length', async ({ page }) => {
  const swatches = page.locator(PAL_SW);
  const stepDown = page.locator('.sl-ramp-stepbtn[title="ramp steps -1"]');
  const stepUp = page.locator('.sl-ramp-stepbtn[title="ramp steps +1"]');
  const readout = page.locator('.sl-ramp-n');
  await expect(readout).toHaveText('5');

  // 5 → 3, down disables at the floor
  await stepDown.click();
  await stepDown.click();
  await expect(readout).toHaveText('3');
  await expect(stepDown).toBeDisabled();

  await setPanelHex(page, '#c04a53');
  const before3 = await swatches.count();
  await page.locator('.sl-ramp-btn').click();
  await expect(swatches).toHaveCount(before3 + 3);

  // 3 → 7 with a fresh base
  await stepUp.click();
  await stepUp.click();
  await stepUp.click();
  await stepUp.click();
  await expect(readout).toHaveText('7');

  await setPanelHex(page, '#4a6a8a');
  const before7 = await swatches.count();
  await page.locator('.sl-ramp-btn').click();
  await expect(swatches).toHaveCount(before7 + 7);
});
