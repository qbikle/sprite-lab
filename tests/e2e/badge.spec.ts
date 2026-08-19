import { expect, test, type Page } from '@playwright/test';

/* The 88×31 badge: bottom of the side rail, theme-following, beating heart,
   click one-liners, shift-click opens the badge itself as a sprite. */

function docProbe(page: Page): Promise<{ w: number; h: number; name: string; frames: number }> {
  return page.evaluate(() => {
    const lab = (window as unknown as {
      __lab: {
        editor: {
          doc: { width: number; height: number; frames: unknown[]; meta: { name: string } };
        };
      };
    }).__lab;
    const d = lab.editor.doc;
    return { w: d.width, h: d.height, name: d.meta.name, frames: d.frames.length };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);
});

test('badge sits last in the side rail and its canvas is painted', async ({ page }) => {
  const badge = page.locator('.sl-badge');
  await expect(badge).toBeVisible();
  await expect(page.locator('.sl-side > :last-child')).toHaveClass(/sl-badge/);
  const url = await page
    .locator('.sl-badge-canvas')
    .evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  expect(url.length).toBeGreaterThan(200);
});

test('click drops a one-liner in the statusbar and never touches the doc', async ({ page }) => {
  const before = await docProbe(page);
  await page.locator('.sl-badge').click();
  await expect(page.locator('.sl-status-msg')).not.toHaveText('');
  const msg = await page.locator('.sl-status-msg').textContent();
  await page.locator('.sl-badge').click();
  await expect(page.locator('.sl-status-msg')).not.toHaveText(msg ?? '');
  expect(await docProbe(page)).toEqual(before);
});

test('shift-click opens the badge as an 88×31 two-frame sprite', async ({ page }) => {
  await page.locator('.sl-badge').click({ modifiers: ['Shift'] });
  const p = await docProbe(page);
  expect(p.w).toBe(88);
  expect(p.h).toBe(31);
  expect(p.name).toBe('badge');
  expect(p.frames).toBe(2);
  await expect(page.locator('.sl-status-size')).toHaveText('88×31');
});

test('theme toggle repaints the badge pixels', async ({ page }) => {
  const canvas = page.locator('.sl-badge-canvas');
  const dark = await canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  await page.locator('.sl-act-theme').click();
  await expect
    .poll(async () => canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL()))
    .not.toBe(dark);
});
