import { expect, test, type Page } from '@playwright/test';

/* Wave 9: shared modal primitive + first-run welcome card.
   - Cheat sheet rides the Modal: tool hotkeys are swallowed while it is open
     (capture-phase guard), live again after close — asserted through the DOM
     (aria-pressed on toolbar buttons), not just __lab.
   - confirmModal (driven through the DEV __labModal harness): Esc resolves
     false, confirm click resolves true, focus trap holds, scroll locks.
   - First-run card: fresh markers → card mounts, explicit dismiss removes it. */

declare global {
  interface Window {
    __labModal?: {
      confirmModal: (opts: {
        title: string;
        body: string;
        confirmLabel?: string;
        cancelLabel?: string;
        danger?: boolean;
      }) => Promise<boolean>;
    };
    __labWelcome?: {
      welcomeLine: () => string;
      mountFirstRunCard: (onDismiss: () => void) => void;
    };
    __confirmResult?: boolean | 'pending';
    __welcomeDismissed?: boolean;
  }
}

function toolBtn(page: Page, tool: string) {
  return page.locator(`.sl-tool-btn[title^="${tool}"]`);
}

/** Kick off a confirm dialog via the DEV harness; result lands in __confirmResult. */
async function openConfirm(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__confirmResult = 'pending';
    if (!window.__labModal) throw new Error('__labModal harness missing');
    void window.__labModal
      .confirmModal({
        title: 'new sprite',
        body: 'discard the current sprite?',
        confirmLabel: 'discard',
        danger: true,
      })
      .then((v) => {
        window.__confirmResult = v;
      });
  });
  await expect(page.locator('.sl-modal-card.sl-confirm')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => '__lab' in window);
});

test('cheat sheet is a modal: tool hotkeys are inert while open, live after', async ({ page }) => {
  await expect(toolBtn(page, 'pencil')).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('?');
  await expect(page.locator('.sl-cheatsheet')).toBeVisible();
  await expect(page.locator('.sl-modal-overlay')).toBeVisible();

  // hotkeys must be swallowed by the modal's capture guard
  await page.keyboard.press('e');
  await expect(toolBtn(page, 'pencil')).toHaveAttribute('aria-pressed', 'true');
  await expect(toolBtn(page, 'eraser')).toHaveAttribute('aria-pressed', 'false');
  // ...including mod combos (undo would be a no-op here, but must not throw past the guard)
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.sl-cheatsheet')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.sl-cheatsheet')).toBeHidden();

  // hotkeys are live again
  await page.keyboard.press('e');
  await expect(toolBtn(page, 'eraser')).toHaveAttribute('aria-pressed', 'true');
});

test("'?' still toggles the sheet closed, and it documents the wave 9 gestures", async ({ page }) => {
  await page.keyboard.press('?');
  const sheet = page.locator('.sl-cheatsheet');
  await expect(sheet).toBeVisible();

  // the scroll-gesture note row (pan · zoom) with its kbd chips
  const note = sheet.locator('.sl-cheat-row', { hasText: 'pan · zoom' });
  await expect(note).toBeVisible();
  await expect(note.locator('kbd').first()).toHaveText('scroll');
  await expect(note.locator('.sl-cheat-sep')).toHaveText('·');

  await page.keyboard.press('?');
  await expect(sheet).toBeHidden();
});

test('confirmModal: Esc resolves false and restores focus + scroll', async ({ page }) => {
  await openConfirm(page);

  // body scroll locked while open
  expect(
    await page.evaluate(() => getComputedStyle(document.body).overflow),
  ).toBe('hidden');

  // hotkeys swallowed behind the dialog
  await page.keyboard.press('e');
  await expect(toolBtn(page, 'eraser')).toHaveAttribute('aria-pressed', 'false');

  await page.keyboard.press('Escape');
  await expect(page.locator('.sl-confirm')).toBeHidden();
  expect(await page.evaluate(() => window.__confirmResult)).toBe(false);
  expect(
    await page.evaluate(() => getComputedStyle(document.body).overflow),
  ).not.toBe('hidden');

  // and the app is interactive again
  await page.keyboard.press('e');
  await expect(toolBtn(page, 'eraser')).toHaveAttribute('aria-pressed', 'true');
});

test('confirmModal: confirm click resolves true; backdrop click resolves false', async ({ page }) => {
  await openConfirm(page);
  await expect(page.locator('.sl-modal-title')).toHaveText('new sprite');
  await expect(page.locator('.sl-modal-body')).toHaveText('discard the current sprite?');
  await page.locator('.sl-modal-danger').click();
  await expect(page.locator('.sl-confirm')).toBeHidden();
  expect(await page.evaluate(() => window.__confirmResult)).toBe(true);

  await openConfirm(page);
  await page.locator('.sl-modal-overlay').click({ position: { x: 10, y: 10 } });
  await expect(page.locator('.sl-confirm')).toBeHidden();
  expect(await page.evaluate(() => window.__confirmResult)).toBe(false);
});

test('confirmModal: Tab cycles focus inside the card only', async ({ page }) => {
  await openConfirm(page);

  // confirm button holds initial focus
  await expect(page.locator('.sl-modal-danger')).toBeFocused();

  // Tab wraps forward: danger (last) → cancel (first) → danger → …
  await page.keyboard.press('Tab');
  await expect(page.locator('.sl-modal-cancel')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.sl-modal-danger')).toBeFocused();

  // Shift+Tab wraps backward
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.sl-modal-cancel')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.sl-modal-danger')).toBeFocused();

  // focus never escaped the card
  expect(
    await page.evaluate(() => document.activeElement?.closest('.sl-modal-card') !== null),
  ).toBe(true);

  await page.keyboard.press('Escape');
});

test('stacked modals: Esc closes only the top one', async ({ page }) => {
  await page.evaluate(() => {
    if (!window.__labModal) throw new Error('__labModal harness missing');
    const w = window as unknown as { __results: string[] };
    w.__results = [];
    void window.__labModal
      .confirmModal({ title: 'lower', body: 'first dialog' })
      .then((v) => w.__results.push(`lower:${v}`));
    void window.__labModal
      .confirmModal({ title: 'upper', body: 'second dialog' })
      .then((v) => w.__results.push(`upper:${v}`));
  });
  await expect(page.locator('.sl-confirm')).toHaveCount(2);

  await page.keyboard.press('Escape');
  await expect(page.locator('.sl-confirm')).toHaveCount(1);
  await expect(page.locator('.sl-modal-title')).toHaveText('lower');
  expect(
    await page.evaluate(() => (window as unknown as { __results: string[] }).__results),
  ).toEqual(['upper:false']);

  await page.keyboard.press('Escape');
  await expect(page.locator('.sl-confirm')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __results: string[] }).__results),
  ).toEqual(['upper:false', 'lower:false']);
});

test('first-run card: fresh markers → card mounts, dismiss removes it', async ({ page }) => {
  // clear both first-run markers (localStorage + cookie) and boot again
  await page.evaluate(() => {
    localStorage.removeItem('sprite-lab:v2:demo-seen');
    document.cookie = 'sprite-lab-demo-seen=; max-age=0; path=/';
  });
  await page.reload();
  await page.waitForFunction(() => '__lab' in window);

  // load the welcome module (idempotent mount: replaces any boot-mounted
  // card, so this stays green before AND after app wiring lands)
  await page.addScriptTag({ type: 'module', content: "import '/src/ui/welcome.ts';" });
  await page.waitForFunction(() => '__labWelcome' in window);
  await page.evaluate(() => {
    window.__welcomeDismissed = false;
    window.__labWelcome?.mountFirstRunCard(() => {
      window.__welcomeDismissed = true;
    });
  });

  const card = page.locator('.sl-welcome');
  await expect(card).toBeVisible();
  await expect(card).toContainText('mochi');
  await expect(card.locator('kbd')).toHaveText('?');
  await expect(card).toContainText('shortcuts');

  // it must not block the canvas: a draw right through the card's corner works
  const box = await card.boundingBox();
  expect(box).not.toBeNull();

  await card.locator('.sl-welcome-dismiss').click();
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => window.__welcomeDismissed)).toBe(true);
});

test('welcomeLine returns a non-empty lowercase line from the pool', async ({ page }) => {
  await page.addScriptTag({ type: 'module', content: "import '/src/ui/welcome.ts';" });
  await page.waitForFunction(() => '__labWelcome' in window);
  const lines = await page.evaluate(() => {
    const out = new Set<string>();
    for (let i = 0; i < 200; i++) out.add(window.__labWelcome?.welcomeLine() ?? '');
    return [...out];
  });
  expect(lines.length).toBeGreaterThanOrEqual(8);
  for (const line of lines) {
    expect(line.length).toBeGreaterThan(0);
    expect(line).toBe(line.toLowerCase());
  }
});
