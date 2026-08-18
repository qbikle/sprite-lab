import { expect, test, type Page, type Route } from '@playwright/test';

/* Wave 12: the arcade overlay, run against a MOCKED backend via route
   interception on the /v1/sl surface — the REAL net/arcade client does the
   talking (sessions, problem+json, cursor mapping), the mock answers
   deterministically. Fixture post payloads are produced by the real
   `encodeDoc` in-page (string-body evaluate — the transpile gotcha), so
   card thumbs and remix exercise the real decodePost path end to end.

   The overlay is driven through the DEV `__labArcade` harness (the panel
   is opened by an app button after integration, but openArcade itself is
   the seam either way). adoptRemix here mirrors the app wiring sketch:
   seed the remix parent, replace the editor doc. */

interface FxEncoded {
  data: string;
  width: number;
  height: number;
  frames: number;
}

interface FxPost {
  id: string;
  handle: string;
  title: string;
  width: number;
  height: number;
  frames: number;
  hearts: number;
  parentId: string | null;
  createdAt: string;
  data: string;
}

interface MockOpts {
  pages?: Array<{ posts: FxPost[]; nextCursor: string | null }>;
  parents?: Record<string, FxPost[]>;
  totalPosts?: number;
  heartDelayMs?: number;
  publishError?: { status: number; body: Record<string, unknown> };
}

interface Captured {
  listCalls: string[];
  publishBodies: Array<Record<string, unknown>>;
}

const OPAQUE_RED = 0xff0000ff;
const OPAQUE_BLUE = 0xffff0000;

/** Build fixture payloads with the REAL encodeDoc + load the panel module
 *  (registers the __labArcade DEV harness). String body: in-page dynamic
 *  import() must not pass through playwright's transpile. */
const FX_SETUP = `(async () => {
  const { SpriteDoc } = await import('/src/core/doc.ts');
  const { encodeDoc } = await import('/src/net/arcade.ts');
  await import('/src/ui/panels/arcade.ts');
  const mk = async (name, color) => {
    const px = new Uint32Array(8 * 8).fill(color);
    return encodeDoc(SpriteDoc.fromImage(px, 8, 8, name));
  };
  window.__fx = {
    red: await mk('crimson cat', ${OPAQUE_RED}),
    blue: await mk('cobalt slime', ${OPAQUE_BLUE}),
  };
  return true;
})()`;

/** Give the editor a small publishable doc of its own (independent of the
 *  first-run demo), named so the publish pane's prefill is assertable. */
const ADOPT_LOCAL = `(async () => {
  const { SpriteDoc } = await import('/src/core/doc.ts');
  const px = new Uint32Array(8 * 8).fill(${OPAQUE_RED});
  window.__lab.editor.replaceDoc(SpriteDoc.fromImage(px, 8, 8, 'sunny sprout'));
  return true;
})()`;

const OPEN_ARCADE = `(() => {
  const arc = window.__labArcade;
  if (!arc) throw new Error('__labArcade harness missing');
  window.__remix = null;
  arc.setRemixParent(null);
  arc.openArcade({
    getDoc: () => window.__lab.editor.doc,
    adoptRemix: (doc, post) => {
      arc.setRemixParent(post);
      window.__lab.editor.replaceDoc(doc);
      window.__remix = post.id;
    },
  });
  return true;
})()`;

function fxPost(
  id: string,
  title: string,
  handle: string,
  enc: FxEncoded,
  extra?: Partial<FxPost>,
): FxPost {
  return {
    id,
    title,
    handle,
    width: enc.width,
    height: enc.height,
    frames: enc.frames,
    hearts: 0,
    parentId: null,
    createdAt: '2026-08-18T12:00:00.000Z',
    data: enc.data,
    ...extra,
  };
}

async function mockArcade(page: Page, opts: MockOpts): Promise<Captured> {
  const captured: Captured = { listCalls: [], publishBodies: [] };
  const hearted = new Map<string, { hearted: boolean; hearts: number }>();
  const json = (route: Route, status: number, body: unknown): Promise<void> =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/v1/sl/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.slice(url.pathname.indexOf('/v1/sl') + 6);

    if (req.method() === 'POST' && path === '/session') {
      return json(route, 200, { token: 'e2e-token' });
    }
    if (req.method() === 'GET' && path === '/stats') {
      return json(route, 200, { totalPosts: opts.totalPosts ?? 3, flags: {} });
    }
    if (req.method() === 'GET' && path === '/posts') {
      captured.listCalls.push(url.search);
      const parent = url.searchParams.get('parent');
      if (parent !== null) {
        return json(route, 200, { posts: opts.parents?.[parent] ?? [], nextCursor: null });
      }
      const cursor = url.searchParams.get('cursor');
      const pages = opts.pages ?? [{ posts: [], nextCursor: null }];
      const i = cursor === null ? 0 : Number(cursor);
      const pageBody = pages[Number.isFinite(i) ? i : 0] ?? { posts: [], nextCursor: null };
      return json(route, 200, pageBody);
    }
    if (req.method() === 'POST' && path === '/posts') {
      if (opts.publishError) {
        return json(route, opts.publishError.status, opts.publishError.body);
      }
      const body = req.postDataJSON() as Record<string, unknown>;
      captured.publishBodies.push(body);
      return json(route, 201, {
        post: {
          id: 'fresh-1',
          handle: String(body.handle),
          title: String(body.title),
          width: Number(body.width),
          height: Number(body.height),
          frames: Number(body.frames),
          hearts: 0,
          parentId: typeof body.parentId === 'string' ? body.parentId : null,
          createdAt: '2026-08-18T12:34:00.000Z',
          data: String(body.data),
        },
      });
    }
    const heartMatch = /^\/posts\/([^/]+)\/heart$/.exec(path);
    if (req.method() === 'POST' && heartMatch !== null) {
      const id = heartMatch[1] ?? '';
      const state = hearted.get(id) ?? { hearted: false, hearts: 5 };
      state.hearted = !state.hearted;
      state.hearts += state.hearted ? 1 : -1;
      hearted.set(id, state);
      if (opts.heartDelayMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.heartDelayMs));
      }
      return json(route, 200, { hearted: state.hearted, hearts: state.hearts });
    }
    if (req.method() === 'POST' && path === '/report') {
      return route.fulfill({ status: 202, body: '' });
    }
    return json(route, 404, { code: 'not_found' });
  });
  return captured;
}

/** goto + wait for the app + fixture payloads + local doc, in order.
 *  The client's base is pointed at a SAME-ORIGIN '/v1/sl' (net/arcade's
 *  localStorage override) so intercepted fetches never meet CORS. */
async function boot(page: Page): Promise<{ red: FxEncoded; blue: FxEncoded }> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as { __lab?: object }).__lab));
  await page.evaluate(() => localStorage.setItem('sprite-lab:v2:arcade-api', '/v1/sl'));
  await page.evaluate(FX_SETUP);
  await page.evaluate(ADOPT_LOCAL);
  return page.evaluate(() => (window as unknown as { __fx: { red: FxEncoded; blue: FxEncoded } }).__fx);
}

function wallCards(page: Page) {
  return page.locator('.sl-arcade-wall .sl-arcade-card:not(.sl-arcade-post-yours)');
}

test('wall renders posts with live thumbs, stats, pagination to the end line', async ({ page }) => {
  const fx = await boot(page);
  const p1 = fxPost('p1', 'crimson cat', 'plum-goblin', fx.red, { hearts: 5 });
  const p2 = fxPost('p2', 'cobalt slime', 'mossy-wizard', fx.blue, { hearts: 2, parentId: 'p1' });
  const p3 = fxPost('p3', 'spare toad', 'dusty-knight', fx.red);
  await mockArcade(page, {
    pages: [
      { posts: [p1, p2], nextCursor: '1' },
      { posts: [p3], nextCursor: null },
    ],
    totalPosts: 3,
  });
  await page.evaluate(OPEN_ARCADE);

  await expect(page.locator('.sl-arcade')).toBeVisible();
  await expect(page.locator('.sl-arcade-title')).toHaveText('the arcade');
  await expect(page.locator('.sl-arcade-stats')).toHaveText('3 sprites on the wall');
  await expect(page.locator('.sl-arcade-name', { hasText: 'crimson cat' })).toBeVisible();
  await expect(page.locator('.sl-arcade-name', { hasText: 'cobalt slime' })).toBeVisible();
  // the short wall self-fills the next cursor page and lands on the end line
  await expect(page.locator('.sl-arcade-name', { hasText: 'spare toad' })).toBeVisible();
  await expect(wallCards(page)).toHaveCount(3);
  await expect(page.locator('.sl-arcade-tail')).toContainText("that's the whole wall (=^..^=)");
  // hearts arrive with the post
  await expect(
    wallCards(page).first().locator('.sl-arcade-heart-count'),
  ).toHaveText('5');
  // only the child post wears the remix tag
  await expect(page.locator('.sl-arcade-remixtag')).toHaveCount(1);

  // a thumb canvas actually paints (real decodePost path) — non-blank bitmap
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '.sl-arcade-wall .sl-arcade-card:not(.sl-arcade-post-yours) canvas',
    );
    if (!canvas || canvas.width === 0) return false;
    const blank = document.createElement('canvas');
    blank.width = canvas.width;
    blank.height = canvas.height;
    return canvas.toDataURL() !== blank.toDataURL();
  });
});

test('heart is optimistic, reconciles to server truth, and un-hearts', async ({ page }) => {
  const fx = await boot(page);
  const p1 = fxPost('p1', 'crimson cat', 'plum-goblin', fx.red, { hearts: 5 });
  await mockArcade(page, {
    pages: [{ posts: [p1], nextCursor: null }],
    heartDelayMs: 400,
  });
  await page.evaluate(OPEN_ARCADE);
  const card = wallCards(page).first();
  const heart = card.locator('.sl-arcade-heart');
  const count = card.locator('.sl-arcade-heart-count');
  await expect(count).toHaveText('5');

  await heart.click();
  // optimistic, before the delayed response lands
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await expect(count).toHaveText('6');
  await expect(heart).toHaveClass(/sl-hearted/);
  // server truth reconciles (mock answers 6 as well — state settles)
  await page.waitForTimeout(500);
  await expect(count).toHaveText('6');
  await expect(heart).toHaveAttribute('aria-pressed', 'true');

  // un-heart: obvious off state, count returns
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'false');
  await expect(count).toHaveText('5');
  await page.waitForTimeout(500);
  await expect(count).toHaveText('5');
  await expect(heart).not.toHaveClass(/sl-hearted/);
});

test('publish posts the current doc (body decodes back to it) and drops the card in', async ({ page }) => {
  await boot(page);
  const captured = await mockArcade(page, {
    pages: [{ posts: [], nextCursor: null }],
    totalPosts: 0,
  });
  await page.evaluate(OPEN_ARCADE);
  await expect(page.locator('.sl-arcade-tail')).toContainText('the wall is bare');

  await page.locator('.sl-arcade-post-yours').click();
  await expect(page.locator('.sl-arcade-publish')).toBeVisible();
  await expect(page.locator('#sl-arcade-title-input')).toHaveValue('sunny sprout');
  await expect(page.locator('#sl-arcade-handle-input')).not.toHaveValue('');
  await expect(page.locator('.sl-arcade-pub-dims')).toHaveText('8×8 · 1 frame');
  await expect(page.locator('.sl-arcade-pub-verdict')).toHaveText('ready for the wall.');

  await page.locator('#sl-arcade-title-input').fill('wall test');
  await page.locator('.sl-arcade-pub-post').click();

  await expect(page.locator('.sl-arcade-name', { hasText: 'wall test' })).toBeVisible();
  await expect(page.locator('.sl-arcade-status')).toHaveText('on the wall.');
  await expect(page.locator('.sl-arcade-stats')).toHaveText('1 sprite on the wall');
  expect(captured.publishBodies).toHaveLength(1);
  const body = captured.publishBodies[0] ?? {};
  expect(body.title).toBe('wall test');
  expect(body.width).toBe(8);
  expect(body.height).toBe(8);
  expect(body.frames).toBe(1);
  expect(body.parentId).toBeUndefined();

  // the intercepted payload decodes (real decodePost) to the editor's doc
  const same = await page.evaluate(`(async () => {
    const { decodePost } = await import('/src/net/arcade.ts');
    const doc = await decodePost(${JSON.stringify(String(body.data))});
    const cur = window.__lab.editor.doc;
    if (doc.width !== cur.width || doc.height !== cur.height) return 'dims differ';
    if (doc.frames.length !== cur.frames.length) return 'frame counts differ';
    const a = doc.flattenFrame(0);
    const b = cur.flattenFrame(0);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return 'pixel ' + i + ' differs';
    return 'same';
  })()`);
  expect(same).toBe('same');
});

test('remix hands the decoded doc to the editor and seeds the remix parent', async ({ page }) => {
  const fx = await boot(page);
  const p1 = fxPost('p1', 'crimson cat', 'plum-goblin', fx.red, { hearts: 5 });
  await mockArcade(page, { pages: [{ posts: [p1], nextCursor: null }] });
  await page.evaluate(OPEN_ARCADE);
  await expect(wallCards(page)).toHaveCount(1);

  await wallCards(page).first().locator('.sl-arcade-remix').click();
  await expect(page.locator('.sl-arcade')).toHaveCount(0);

  const probe = await page.evaluate(() => {
    const w = window as unknown as {
      __remix: string | null;
      __lab: { editor: { doc: { width: number; height: number; flattenFrame(i: number): Uint32Array } } };
      __labArcade: { getRemixParent(): { id: string } | null };
    };
    return {
      remix: w.__remix,
      w: w.__lab.editor.doc.width,
      h: w.__lab.editor.doc.height,
      px: w.__lab.editor.doc.flattenFrame(0)[0],
      parent: w.__labArcade.getRemixParent()?.id ?? null,
    };
  });
  expect(probe.remix).toBe('p1');
  expect(probe.w).toBe(8);
  expect(probe.h).toBe(8);
  expect(probe.px).toBe(OPAQUE_RED);
  expect(probe.parent).toBe('p1');

  // reopening the arcade: publish pane shows the remix credit, parentId rides the post
  const captured = await mockArcade(page, { pages: [{ posts: [], nextCursor: null }] });
  await page.evaluate(`(() => {
    window.__labArcade.openArcade({
      getDoc: () => window.__lab.editor.doc,
      adoptRemix: () => {},
    });
    return true;
  })()`);
  await page.locator('.sl-arcade-post-yours').click();
  await expect(page.locator('.sl-arcade-pub-remix')).toBeVisible();
  await expect(page.locator('.sl-arcade-pub-remix-name')).toHaveText("'crimson cat'");
  await page.locator('#sl-arcade-title-input').fill('cat, remixed');
  await page.locator('.sl-arcade-pub-post').click();
  await expect(page.locator('.sl-arcade-status')).toHaveText('on the wall.');
  expect(captured.publishBodies[0]?.parentId).toBe('p1');
  // a successful post clears the lineage
  const parentAfter = await page.evaluate(
    () => (window as unknown as { __labArcade: { getRemixParent(): object | null } }).__labArcade.getRemixParent(),
  );
  expect(parentAfter).toBeNull();
});

test('the remix tag filters the wall to one family, breadcrumb clears it', async ({ page }) => {
  const fx = await boot(page);
  const p1 = fxPost('p1', 'crimson cat', 'plum-goblin', fx.red, { hearts: 5 });
  const p2 = fxPost('p2', 'cobalt slime', 'mossy-wizard', fx.blue, { parentId: 'p1' });
  const captured = await mockArcade(page, {
    pages: [{ posts: [p1, p2], nextCursor: null }],
    parents: { p1: [p2] },
  });
  await page.evaluate(OPEN_ARCADE);
  await expect(wallCards(page)).toHaveCount(2);

  await page.locator('.sl-arcade-remixtag').click();
  await expect(page.locator('.sl-arcade-crumb')).toBeVisible();
  await expect(wallCards(page)).toHaveCount(1);
  await expect(page.locator('.sl-arcade-name', { hasText: 'cobalt slime' })).toBeVisible();
  // post-yours stays off the filtered wall
  await expect(page.locator('.sl-arcade-post-yours')).toBeHidden();
  expect(captured.listCalls.some((q) => q.includes('parent=p1'))).toBe(true);

  await page.locator('.sl-arcade-crumb-back').click();
  await expect(page.locator('.sl-arcade-crumb')).toBeHidden();
  await expect(wallCards(page)).toHaveCount(2);
  await expect(page.locator('.sl-arcade-post-yours')).toBeVisible();
});

test('report flow flags for the curator and the card stays', async ({ page }) => {
  const fx = await boot(page);
  const p1 = fxPost('p1', 'crimson cat', 'plum-goblin', fx.red);
  await mockArcade(page, { pages: [{ posts: [p1], nextCursor: null }] });
  await page.evaluate(OPEN_ARCADE);
  const card = wallCards(page).first();

  await card.locator('.sl-arcade-more').click();
  await expect(card.locator('.sl-arcade-report-ask')).toHaveText('flag this for the curator?');
  await card.locator('.sl-arcade-report-reason').fill('not cozy');
  await card.locator('.sl-arcade-report-flag').click();
  await expect(card.locator('.sl-arcade-report-thanks')).toHaveText(
    'flagged for the curator. thank you.',
  );
  // queue semantics: nothing auto-hides
  await expect(card.locator('.sl-arcade-name')).toHaveText('crimson cat');
});

test('offline wall shows the unreachable state, editor unbothered', async ({ page }) => {
  await boot(page);
  await page.route('**/v1/sl/**', (route) => route.abort());
  await page.evaluate(OPEN_ARCADE);
  await expect(page.locator('.sl-arcade-void')).toBeVisible();
  await expect(page.locator('.sl-arcade-void-line')).toHaveText(
    "the arcade is unreachable — your editor doesn't care, keep drawing.",
  );
  await expect(page.locator('.sl-arcade-retry')).toBeVisible();
});

test('a blank canvas cannot be posted — verdict says so, button disabled', async ({ page }) => {
  await boot(page);
  await page.evaluate(`(async () => {
    const { SpriteDoc } = await import('/src/core/doc.ts');
    window.__lab.editor.replaceDoc(SpriteDoc.blank(16, 16, 'blank slate'));
    return true;
  })()`);
  await mockArcade(page, { pages: [{ posts: [], nextCursor: null }] });
  await page.evaluate(OPEN_ARCADE);
  await page.locator('.sl-arcade-post-yours').click();
  await expect(page.locator('.sl-arcade-pub-verdict')).toHaveText(
    'nothing to post yet — the canvas is blank',
  );
  await expect(page.locator('.sl-arcade-pub-verdict')).toHaveClass(/sl-verdict-bad/);
  await expect(page.locator('.sl-arcade-pub-post')).toBeDisabled();
});

test('daily budget 429 answers with the cozy copy', async ({ page }) => {
  await boot(page);
  await mockArcade(page, {
    pages: [{ posts: [], nextCursor: null }],
    publishError: {
      status: 429,
      body: { code: 'sl/daily_budget', title: 'daily budget exhausted', retryAfterSeconds: 9000 },
    },
  });
  await page.evaluate(OPEN_ARCADE);
  await page.locator('.sl-arcade-post-yours').click();
  await page.locator('#sl-arcade-title-input').fill('one too many');
  await page.locator('.sl-arcade-pub-post').click();
  await expect(page.locator('.sl-arcade-pub-status')).toHaveText(
    '3 a day keeps the wall fresh — come back tomorrow.',
  );
  // the pane stays live for tomorrow's optimist
  await expect(page.locator('.sl-arcade-pub-post')).toBeEnabled();
});
