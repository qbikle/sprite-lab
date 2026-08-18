/** The arcade — community sprite wall (Wave 12). A large overlay on the shared
 *  Modal primitive: marquee header, live-animating gallery of posts, hearts
 *  with a pixel burst, remix-to-editor, a publish pane for the current doc,
 *  and a report flow. Talks to the wall through an injectable ArcadeClient
 *  (default `arcadeClient()`); every failure maps by ArcadeError.code to cozy
 *  copy, never raw messages.
 *
 *  Thumb loop budget: ONE shared rAF drives every card. Cards decode lazily
 *  (IntersectionObserver, root = the wall scroller) and at most LOOP_CAP of
 *  the visible ones animate; the rest park at frame 0. The publish pane's
 *  live thumb rides the same loop in its own slot.
 *
 *  Remix seam (module-level, documented for app wiring): remixing closes the
 *  overlay and hands `(doc, post)` to `opts.adoptRemix` — the APP owns the
 *  confirm-if-dirty and the adopt, so the app also owns seeding the remix
 *  parent: call `setRemixParent(post)` only after adoption actually happens
 *  (and `setRemixParent(null)` when it doesn't, or when a new/opened doc
 *  makes the lineage stale). The publish pane reads `getRemixParent()` for
 *  its "remixing <title>" banner + parentId, and clears it after a
 *  successful post.
 *
 *  Keyboard: Esc/Tab come from the Modal; publish fields sit in a <form> so
 *  Enter posts natively (typing passes the Modal's capture guard). No custom
 *  window-capture keys this wave — if arrow-nav lands later, register the
 *  listener BEFORE `modal.open()` (gotcha ledger). */
import { Modal } from '../modal';
import { icon } from '../icons';
import type { SpriteDoc } from '../../core/doc';
import {
  arcadeClient,
  decodePost,
  checkPublishable,
  type ArcadePost,
  type ArcadeClient,
} from '../../net/arcade';

const HANDLE_KEY = 'sprite-lab:v2:arcade-handle';
const MAX_TITLE = 60;
const MAX_HANDLE = 24;
/** Cap per-tick elapsed time so a suspended tab doesn't fast-forward. */
const MAX_TICK_MS = 250;
/** Simultaneously animating wall thumbs (publish thumb rides its own slot). */
const LOOP_CAP = 12;
const STAGGER_MS = 28;
const STATUS_MS = 4000;

/* ── handle generator ─────────────────────────────────────── */

const HANDLE_A = [
  'plum', 'mossy', 'minty', 'dusty', 'ember', 'pixel',
  'mochi', 'cozy', 'fuzzy', 'sunny', 'murky', 'tufty',
] as const;
const HANDLE_B = [
  'goblin', 'wizard', 'slime', 'ghost', 'fox', 'knight',
  'robot', 'bat', 'toad', 'moth', 'golem', 'sprout',
] as const;

/** A pixel-flavored default handle, e.g. 'plum-goblin'. */
export function generateHandle(): string {
  const a = HANDLE_A[Math.floor(Math.random() * HANDLE_A.length)] ?? 'plum';
  const b = HANDLE_B[Math.floor(Math.random() * HANDLE_B.length)] ?? 'goblin';
  return `${a}-${b}`;
}

/* ── remix seam ───────────────────────────────────────────── */

let remixParent: ArcadePost | null = null;

/** Seed (or clear) the parent the NEXT publish should credit. The app calls
 *  this after a remix adoption goes through; the publish pane clears it on
 *  success or via its banner's dismiss. */
export function setRemixParent(post: ArcadePost | null): void {
  remixParent = post;
}

export function getRemixParent(): ArcadePost | null {
  return remixParent;
}

/* ── error copy (by ArcadeError.code, never raw messages) ─── */

function errCode(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const c = (e as { code: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return 'unknown';
}

const NAP_COPY = 'the arcade is napping — come back soon.';
const OFFLINE_COPY = "the arcade is unreachable — your editor doesn't care, keep drawing.";
const BREATHER_COPY = 'the wall needs a breather — try again in a moment.';
const FALLBACK_COPY = 'something hiccuped — try again in a moment.';

const WALL_COPY: Readonly<Record<string, string>> = {
  offline: OFFLINE_COPY,
  'sl/closed': NAP_COPY,
  'sl/not_ready': NAP_COPY,
  rate_limited: BREATHER_COPY,
  'sl/min_play': BREATHER_COPY,
  'sl/daily_budget': "that's a lot of love for one day — the hearts recharge tomorrow.",
};

const PUBLISH_COPY: Readonly<Record<string, string>> = {
  offline: "can't reach the arcade — your sprite is safe here, try again soon.",
  'sl/closed': NAP_COPY,
  'sl/not_ready': NAP_COPY,
  'sl/daily_budget': '3 a day keeps the wall fresh — come back tomorrow.',
  rate_limited: BREATHER_COPY,
  'sl/min_play': 'the wall likes sprites with a little more play in them — draw on, then try again.',
};

function wallCopy(e: unknown): string {
  return WALL_COPY[errCode(e)] ?? FALLBACK_COPY;
}

function publishCopy(e: unknown): string {
  return PUBLISH_COPY[errCode(e)] ?? FALLBACK_COPY;
}

/* ── local px glyphs ──────────────────────────────────────── */
/* The heart pair is arcade-only chrome, drawn here on the registry's 16×16
   grid + 2px strokes so it can migrate into ui/icons.ts wholesale if the
   wall ever needs it elsewhere (icons.ts is not this wave's file). */

const HEART_FILL = [
  '................',
  '................',
  '................',
  '....##....##....',
  '...####..####...',
  '..############..',
  '..############..',
  '..############..',
  '...##########...',
  '....########....',
  '.....######.....',
  '......####......',
  '.......##.......',
  '................',
  '................',
  '................',
] as const;

const HEART_LINE = [
  '................',
  '................',
  '................',
  '....##....##....',
  '...####..####...',
  '..##..####..##..',
  '..##........##..',
  '..##........##..',
  '...##......##...',
  '....##....##....',
  '.....##..##.....',
  '......####......',
  '.......##.......',
  '................',
  '................',
  '................',
] as const;

function pxGlyph(rows: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  let d = '';
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '#') d += `M${x} ${y}h1v1h-1z`;
    }
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

/* ── DOM helpers ──────────────────────────────────────────── */

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function btn(className: string, label?: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  if (label !== undefined) el.textContent = label;
  return el;
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** checkPublishable guards dims/frames; the wall also deserves actual ink. */
function docHasInk(doc: SpriteDoc): boolean {
  for (const frame of doc.frames) {
    for (const [, buf] of doc.celEntriesForFrame(frame.id)) {
      for (const v of buf) if (v !== 0) return true;
    }
  }
  return false;
}

/* ── thumbs ───────────────────────────────────────────────── */

interface Thumb {
  post: ArcadePost | null;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  doc: SpriteDoc | null;
  buf: Uint32Array | null;
  img: ImageData | null;
  decoding: boolean;
  failed: boolean;
  visible: boolean;
  frame: number;
  acc: number;
}

function makeThumb(post: ArcadePost | null): Thumb {
  const canvas = document.createElement('canvas');
  canvas.className = 'sl-arcade-canvas';
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('arcade: 2d context unavailable');
  return {
    post, canvas, ctx,
    doc: null, buf: null, img: null,
    decoding: false, failed: false, visible: false, frame: 0, acc: 0,
  };
}

/** Seat a decoded doc: doc-dimension backing store (CSS scales it, pixelated). */
function seatThumb(t: Thumb, doc: SpriteDoc): void {
  const bytes = new Uint8ClampedArray(doc.width * doc.height * 4);
  t.doc = doc;
  t.buf = new Uint32Array(bytes.buffer);
  t.img = new ImageData(bytes, doc.width, doc.height);
  t.canvas.width = doc.width;
  t.canvas.height = doc.height;
  t.frame = 0;
  t.acc = 0;
  paintThumb(t);
}

function paintThumb(t: Thumb): void {
  if (!t.doc || !t.buf || !t.img) return;
  t.doc.flattenFrame(t.frame, t.buf);
  t.ctx.putImageData(t.img, 0, 0);
}

/* ── opts ─────────────────────────────────────────────────── */

export interface ArcadeOpts {
  getDoc: () => SpriteDoc;
  /** App-owned: close-side effects, confirm-if-dirty, adopt, and (on
   *  success) `setRemixParent(post)`. The overlay is already closed when
   *  this fires. */
  adoptRemix: (doc: SpriteDoc, post: ArcadePost) => void;
  /** Injectable for tests; defaults to `arcadeClient()`. */
  client?: ArcadeClient;
}

let current: ArcadeOverlay | null = null;

export function openArcade(opts: ArcadeOpts): void {
  if (current) return;
  current = new ArcadeOverlay(opts);
  current.open();
}

/* ── the overlay ──────────────────────────────────────────── */

class ArcadeOverlay {
  private readonly opts: ArcadeOpts;
  private readonly client: ArcadeClient;
  private readonly modal: Modal;
  private readonly disposers: Array<() => void> = [];
  private readonly timers = new Set<number>();

  private bodyEl!: HTMLElement;
  private wallEl!: HTMLElement;
  private crumbEl!: HTMLElement;
  private tailEl!: HTMLElement;
  private voidEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private postYoursEl!: HTMLElement;

  private publishEl!: HTMLElement;
  private pubTitleInput!: HTMLInputElement;
  private pubHandleInput!: HTMLInputElement;
  private pubDimsEl!: HTMLElement;
  private pubVerdictEl!: HTMLElement;
  private pubRemixEl!: HTMLElement;
  private pubRemixNameEl!: HTMLElement;
  private pubStatusEl!: HTMLElement;
  private pubPostBtn!: HTMLButtonElement;
  private pubVerdict: string | null = null;

  private readonly thumbs: Thumb[] = [];
  private readonly thumbByEl = new Map<Element, Thumb>();
  private pubThumb: Thumb | null = null;
  private publishOpen = false;

  private cardObserver: IntersectionObserver | null = null;
  private tailObserver: IntersectionObserver | null = null;

  private rafId: number | null = null;
  private lastTs = 0;
  private animSet = new Set<Thumb>();

  private cursor: string | null = null;
  private listGen = 0;
  private parentFilter: string | null = null;
  private loading = false;
  private done = false;
  private totalPosts: number | null = null;

  constructor(opts: ArcadeOpts) {
    this.opts = opts;
    this.client = opts.client ?? arcadeClient();
    // Warm the anon session while the user browses — the server's min-play
    // gate refuses writes from tokens younger than 10s, so a lazy first-write
    // mint would deterministically fail every fresh tab's first heart/publish.
    this.client.warm?.();
    this.modal = new Modal({
      label: 'the arcade',
      className: 'sl-arcade',
      onClose: () => this.dispose(),
    });
    this.build();
  }

  open(): void {
    this.modal.open();
    this.observe();
    this.loadStats();
    this.resetAndLoad();
  }

  /* ── skeleton ─────────────────────────────────────────── */

  private build(): void {
    const marquee = div('sl-arcade-marquee');
    const title = div('sl-arcade-title');
    title.textContent = 'the arcade';
    this.statsEl = div('sl-arcade-stats');
    this.statsEl.textContent = 'counting sprites…';
    marquee.append(title, this.statsEl);

    this.bodyEl = div('sl-arcade-body');

    this.crumbEl = div('sl-arcade-crumb');
    const crumbBack = btn('sl-arcade-crumb-back', '← the whole wall');
    crumbBack.addEventListener('click', () => this.exitParentView());
    const crumbLabel = document.createElement('span');
    crumbLabel.textContent = 'showing one remix family';
    this.crumbEl.append(crumbBack, crumbLabel);
    this.crumbEl.hidden = true;

    this.wallEl = div('sl-arcade-wall');

    this.postYoursEl = btn('sl-arcade-card sl-arcade-post-yours');
    const plus = div('sl-arcade-post-yours-glyph');
    plus.append(icon('plus', 32));
    const pyTitle = div('sl-arcade-post-yours-title');
    pyTitle.textContent = 'post yours';
    const pySub = div('sl-arcade-post-yours-sub');
    pySub.textContent = 'put a sprite on the wall';
    this.postYoursEl.append(plus, pyTitle, pySub);
    this.postYoursEl.addEventListener('click', () => this.enterPublish());
    this.wallEl.append(this.postYoursEl);

    this.tailEl = div('sl-arcade-tail');
    this.voidEl = div('sl-arcade-void');
    this.voidEl.hidden = true;

    this.bodyEl.append(this.crumbEl, this.wallEl, this.tailEl, this.voidEl);

    this.publishEl = this.buildPublish();
    this.publishEl.hidden = true;

    this.statusEl = div('sl-arcade-status');
    this.statusEl.setAttribute('role', 'status');

    this.modal.root.append(marquee, this.bodyEl, this.publishEl, this.statusEl);
  }

  private buildPublish(): HTMLElement {
    const pane = div('sl-arcade-publish');

    const back = btn('sl-arcade-back', '← back to the wall');
    back.addEventListener('click', () => this.leavePublish());

    const grid = div('sl-arcade-pub-grid');

    const thumbBox = div('sl-arcade-pub-thumb');
    this.pubDimsEl = div('sl-arcade-pub-dims');
    const thumbCol = div('sl-arcade-pub-thumbcol');
    thumbCol.append(thumbBox, this.pubDimsEl);

    const form = document.createElement('form');
    form.className = 'sl-arcade-pub-form';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.post();
    });

    this.pubRemixEl = div('sl-arcade-pub-remix');
    const remixLabel = document.createElement('span');
    remixLabel.className = 'sl-arcade-pub-remix-label';
    this.pubRemixNameEl = document.createElement('span');
    this.pubRemixNameEl.className = 'sl-arcade-pub-remix-name';
    remixLabel.append('remixing ', this.pubRemixNameEl);
    const remixClear = btn('sl-arcade-pub-remix-clear', '×');
    remixClear.title = 'post as an original instead';
    remixClear.setAttribute('aria-label', 'clear remix credit');
    remixClear.addEventListener('click', () => {
      setRemixParent(null);
      this.syncRemixBanner();
    });
    this.pubRemixEl.append(remixLabel, remixClear);

    const titleField = div('sl-arcade-pub-field');
    const titleLabel = document.createElement('label');
    titleLabel.textContent = 'title';
    titleLabel.htmlFor = 'sl-arcade-title-input';
    this.pubTitleInput = document.createElement('input');
    this.pubTitleInput.id = 'sl-arcade-title-input';
    this.pubTitleInput.maxLength = MAX_TITLE;
    this.pubTitleInput.autocomplete = 'off';
    this.pubTitleInput.spellcheck = false;
    this.pubTitleInput.addEventListener('input', () => this.syncPostButton());
    titleField.append(titleLabel, this.pubTitleInput);

    const handleField = div('sl-arcade-pub-field');
    const handleLabel = document.createElement('label');
    handleLabel.textContent = 'handle';
    handleLabel.htmlFor = 'sl-arcade-handle-input';
    const handleRow = div('sl-arcade-pub-handle-row');
    this.pubHandleInput = document.createElement('input');
    this.pubHandleInput.id = 'sl-arcade-handle-input';
    this.pubHandleInput.maxLength = MAX_HANDLE;
    this.pubHandleInput.autocomplete = 'off';
    this.pubHandleInput.spellcheck = false;
    const reroll = btn('sl-arcade-pub-reroll', 'reroll');
    reroll.title = 'a fresh pixel name';
    reroll.addEventListener('click', () => {
      this.pubHandleInput.value = generateHandle();
    });
    handleRow.append(this.pubHandleInput, reroll);
    handleField.append(handleLabel, handleRow);

    this.pubVerdictEl = div('sl-arcade-pub-verdict');

    const actions = div('sl-arcade-pub-actions');
    this.pubPostBtn = btn('sl-modal-primary sl-arcade-pub-post', 'post it');
    this.pubPostBtn.type = 'submit';
    this.pubStatusEl = div('sl-arcade-pub-status');
    this.pubStatusEl.setAttribute('role', 'status');
    actions.append(this.pubPostBtn);

    form.append(
      this.pubRemixEl, titleField, handleField,
      this.pubVerdictEl, actions, this.pubStatusEl,
    );
    grid.append(thumbCol, form);
    pane.append(back, grid);
    return pane;
  }

  /* ── observers + shared loop ──────────────────────────── */

  private observe(): void {
    this.cardObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const t = this.thumbByEl.get(entry.target);
          if (!t) continue;
          t.visible = entry.isIntersecting;
          if (t.visible && !t.doc && !t.decoding && !t.failed && t.post) this.decode(t, t.post);
        }
        this.syncLoop();
      },
      { root: this.bodyEl, rootMargin: '120px' },
    );
    this.tailObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.loadMore();
        }
      },
      { root: this.bodyEl, rootMargin: '160px' },
    );
    this.tailObserver.observe(this.tailEl);

    const onVisibility = (): void => this.syncLoop();
    document.addEventListener('visibilitychange', onVisibility);
    this.disposers.push(() => document.removeEventListener('visibilitychange', onVisibility));
  }

  private decode(t: Thumb, post: ArcadePost): void {
    t.decoding = true;
    void Promise.resolve(decodePost(post.data))
      .then((doc) => {
        t.decoding = false;
        seatThumb(t, doc);
        this.syncLoop();
      })
      .catch(() => {
        t.decoding = false;
        t.failed = true;
        const sad = div('sl-arcade-thumb-sad');
        sad.textContent = '(x_x)';
        sad.title = 'could not unpack this sprite';
        t.canvas.parentElement?.append(sad);
      });
  }

  /** Recompute who animates: publish thumb in its own slot, then the first
   *  LOOP_CAP visible multi-frame wall thumbs; everyone else parks at 0. */
  private syncLoop(): void {
    const next = new Set<Thumb>();
    if (this.publishOpen && this.pubThumb?.doc && this.pubThumb.doc.frames.length > 1) {
      next.add(this.pubThumb);
    }
    if (!this.publishOpen) {
      for (const t of this.thumbs) {
        if (next.size >= LOOP_CAP + (this.pubThumb ? 1 : 0)) break;
        if (t.visible && t.doc && t.doc.frames.length > 1) next.add(t);
      }
    }
    for (const t of this.animSet) {
      if (!next.has(t) && t.frame !== 0) {
        t.frame = 0;
        t.acc = 0;
        paintThumb(t);
      }
    }
    this.animSet = next;
    if (next.size > 0 && !document.hidden) this.startLoop();
    else this.stopLoop();
  }

  private startLoop(): void {
    if (this.rafId !== null) return;
    this.lastTs = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private readonly tick = (ts: number): void => {
    if (this.rafId === null) return;
    this.rafId = requestAnimationFrame(this.tick);
    const dt = Math.min(MAX_TICK_MS, ts - this.lastTs);
    this.lastTs = ts;
    for (const t of this.animSet) {
      const doc = t.doc;
      if (!doc) continue;
      t.acc += dt;
      const start = t.frame;
      let cur = start;
      for (;;) {
        const dur = Math.max(1, doc.frames[cur]?.durationMs ?? 100);
        if (t.acc < dur) break;
        t.acc -= dur;
        cur = (cur + 1) % Math.max(1, doc.frames.length);
      }
      if (cur !== start) {
        t.frame = cur;
        paintThumb(t);
      }
    }
  };

  /* ── wall data ────────────────────────────────────────── */

  private loadStats(): void {
    void Promise.resolve(this.client.stats())
      .then(({ totalPosts }) => {
        this.totalPosts = totalPosts;
        this.paintStats();
      })
      .catch(() => {
        this.statsEl.textContent = '';
      });
  }

  private paintStats(): void {
    if (this.totalPosts === null) return;
    this.statsEl.textContent =
      this.totalPosts === 1 ? '1 sprite on the wall' : `${this.totalPosts} sprites on the wall`;
  }

  private resetAndLoad(): void {
    // New wall context (filter change, retry, crumb-back): invalidate every
    // in-flight list response — a stale page landing after the wipe would
    // splice the OLD context's posts and cursor into the new view.
    this.listGen += 1;
    for (const t of this.thumbs) {
      const cardEl = t.canvas.closest('.sl-arcade-card');
      if (cardEl) {
        this.cardObserver?.unobserve(cardEl);
        cardEl.remove();
      }
    }
    this.thumbs.length = 0;
    this.thumbByEl.clear();
    this.animSet.clear();
    this.cursor = null;
    this.done = false;
    this.loading = false;
    this.voidEl.hidden = true;
    this.wallEl.hidden = false;
    this.postYoursEl.hidden = this.parentFilter !== null;
    this.crumbEl.hidden = this.parentFilter === null;
    this.setTail('');
    this.loadMore();
  }

  private loadMore(): void {
    if (this.loading || this.done || this.publishOpen) return;
    this.loading = true;
    this.setTail('loading the wall…');
    const gen = this.listGen;
    const req: { cursor?: string; parent?: string } = {};
    if (this.cursor !== null) req.cursor = this.cursor;
    if (this.parentFilter !== null) req.parent = this.parentFilter;
    void Promise.resolve(this.client.list(req))
      .then(({ posts, cursor }) => {
        if (gen !== this.listGen) return; // stale context — dropped
        this.loading = false;
        this.appendCards(posts);
        this.cursor = cursor ?? null;
        if (this.cursor === null) {
          this.done = true;
          if (this.thumbs.length === 0) this.showEmpty();
          else this.setTail("that's the whole wall (=^..^=)");
        } else {
          this.setTail('');
          this.maybeFill();
        }
      })
      .catch((e: unknown) => {
        if (gen !== this.listGen) return; // stale context — dropped
        this.loading = false;
        if (this.thumbs.length === 0) this.showVoid(e);
        else this.setTailRetry(wallCopy(e));
      });
  }

  /** A short wall may not overflow the scroller — the sentinel then never
   *  re-intersects, so nudge the next page manually. */
  private maybeFill(): void {
    if (this.bodyEl.scrollHeight <= this.bodyEl.clientHeight + 40) this.loadMore();
  }

  private appendCards(posts: readonly ArcadePost[]): void {
    let i = 0;
    for (const post of posts) {
      const card = this.buildCard(post);
      if (!reducedMotion()) {
        card.classList.add('sl-card-in');
        card.style.animationDelay = `${(i % 8) * STAGGER_MS}ms`;
      }
      this.wallEl.append(card);
      i += 1;
    }
  }

  private showEmpty(): void {
    if (this.parentFilter !== null) {
      this.setTail('no remixes here yet — be the first to riff on it.');
      return;
    }
    this.setTail('the wall is bare — yours could be the first.');
  }

  private showVoid(e: unknown): void {
    this.wallEl.hidden = true;
    this.setTail('');
    this.voidEl.hidden = false;
    this.voidEl.replaceChildren();
    const face = div('sl-arcade-void-face');
    face.textContent = errCode(e) === 'offline' ? '( >_< )' : '( - . - ) zZ';
    const line = div('sl-arcade-void-line');
    line.textContent = wallCopy(e);
    const retry = btn('sl-arcade-retry', 'try again');
    retry.addEventListener('click', () => this.resetAndLoad());
    this.voidEl.append(face, line, retry);
  }

  private setTail(text: string): void {
    this.tailEl.replaceChildren();
    this.tailEl.append(document.createTextNode(text));
  }

  private setTailRetry(text: string): void {
    this.tailEl.replaceChildren();
    const retry = btn('sl-arcade-retry', 'try again');
    retry.addEventListener('click', () => this.loadMore());
    this.tailEl.append(document.createTextNode(text), retry);
  }

  /* ── cards ────────────────────────────────────────────── */

  private buildCard(post: ArcadePost): HTMLElement {
    const card = div('sl-arcade-card');
    const t = makeThumb(post);

    const box = div('sl-arcade-thumb');
    box.append(t.canvas);
    if (post.parentId != null) {
      const tag = btn('sl-arcade-remixtag', 'remix');
      tag.title = 'see this remix family';
      tag.addEventListener('click', () => this.enterParentView(String(post.parentId)));
      box.append(tag);
    }

    const meta = div('sl-arcade-meta');
    const name = div('sl-arcade-name');
    name.textContent = post.title;
    name.title = post.title;
    const by = div('sl-arcade-by');
    by.textContent = post.handle;
    meta.append(name, by);

    const row = div('sl-arcade-row');
    // hearts made this session survive a filter/reset rebuild of the card
    const known = this.heartedIds.has(String(post.id));
    const heart = btn('sl-arcade-heart');
    if (known) heart.classList.add('sl-hearted');
    heart.setAttribute('aria-pressed', known ? 'true' : 'false');
    heart.setAttribute('aria-label', `heart '${post.title}'`);
    const heartGlyph = document.createElement('span');
    heartGlyph.className = 'sl-arcade-heart-glyph';
    heartGlyph.append(pxGlyph(known ? HEART_FILL : HEART_LINE));
    const heartCount = document.createElement('span');
    heartCount.className = 'sl-arcade-heart-count';
    heartCount.textContent = String(post.hearts);
    heart.append(heartGlyph, heartCount);
    heart.addEventListener('click', () => this.onHeart(post, heart, heartGlyph, heartCount));

    const remix = btn('sl-arcade-remix', 'remix');
    remix.title = 'open a copy in the editor';
    remix.addEventListener('click', () => this.onRemix(post, remix));

    const more = btn('sl-arcade-more', '…');
    more.title = 'report';
    more.setAttribute('aria-label', `report '${post.title}'`);
    more.addEventListener('click', () => this.openReport(card, post));

    row.append(heart, remix, more);
    card.append(box, meta, row);

    this.thumbs.push(t);
    this.thumbByEl.set(card, t);
    this.cardObserver?.observe(card);
    return card;
  }

  /* ── hearts ───────────────────────────────────────────── */

  private readonly heartedIds = new Set<string>();
  private readonly heartBusy = new Set<string>();

  private onHeart(
    post: ArcadePost,
    button: HTMLButtonElement,
    glyph: HTMLElement,
    count: HTMLElement,
  ): void {
    const id = String(post.id);
    if (this.heartBusy.has(id)) return;
    this.heartBusy.add(id);
    const wasHearted = this.heartedIds.has(id);
    const wasCount = Number(count.textContent) || 0;
    const paint = (hearted: boolean, n: number): void => {
      if (hearted) this.heartedIds.add(id);
      else this.heartedIds.delete(id);
      // A wall rebuild mid-request detaches this card — state above stays
      // honest (the rebuilt card reads heartedIds), the dead DOM stays dead.
      if (!button.isConnected) return;
      button.classList.toggle('sl-hearted', hearted);
      button.setAttribute('aria-pressed', hearted ? 'true' : 'false');
      glyph.replaceChildren(pxGlyph(hearted ? HEART_FILL : HEART_LINE));
      count.textContent = String(Math.max(0, n));
    };
    paint(!wasHearted, wasCount + (wasHearted ? -1 : 1));
    if (!wasHearted) this.burst(button);
    void Promise.resolve(this.client.heart(id))
      .then(({ hearted, hearts }) => {
        this.heartBusy.delete(id);
        paint(hearted, hearts);
      })
      .catch((e: unknown) => {
        this.heartBusy.delete(id);
        paint(wasHearted, wasCount);
        this.status(wallCopy(e));
      });
  }

  /** 5 tiny squares scatter from the heart — CSS keyframes carry the flight. */
  private burst(anchor: HTMLElement): void {
    if (reducedMotion()) return;
    const host = document.createElement('span');
    host.className = 'sl-arcade-burst';
    host.setAttribute('aria-hidden', 'true');
    const shots: ReadonlyArray<readonly [number, number]> = [
      [-14, -16], [12, -20], [-4, -24], [16, -8], [-18, -4],
    ];
    for (const [dx, dy] of shots) {
      const bit = document.createElement('i');
      bit.style.setProperty('--dx', `${dx}px`);
      bit.style.setProperty('--dy', `${dy}px`);
      host.append(bit);
    }
    anchor.append(host);
    const timer = window.setTimeout(() => {
      host.remove();
      this.timers.delete(timer);
    }, 700);
    this.timers.add(timer);
  }

  /* ── remix ────────────────────────────────────────────── */

  private onRemix(post: ArcadePost, button: HTMLButtonElement): void {
    button.disabled = true;
    void Promise.resolve(decodePost(post.data))
      .then((doc) => {
        this.modal.close();
        this.opts.adoptRemix(doc, post);
      })
      .catch(() => {
        button.disabled = false;
        this.status('could not unpack that sprite — try another.');
      });
  }

  private enterParentView(parentId: string): void {
    this.parentFilter = parentId;
    this.resetAndLoad();
    this.bodyEl.scrollTop = 0;
  }

  private exitParentView(): void {
    this.parentFilter = null;
    this.resetAndLoad();
    this.bodyEl.scrollTop = 0;
  }

  /* ── report ───────────────────────────────────────────── */

  private openReport(card: HTMLElement, post: ArcadePost): void {
    if (card.querySelector('.sl-arcade-report')) return;
    const pane = div('sl-arcade-report');
    const ask = div('sl-arcade-report-ask');
    ask.textContent = 'flag this for the curator?';
    const reason = document.createElement('input');
    reason.className = 'sl-arcade-report-reason';
    reason.placeholder = 'why? (optional)';
    reason.maxLength = 140;
    const row = div('sl-arcade-report-row');
    const cancel = btn('sl-arcade-report-cancel', 'never mind');
    cancel.addEventListener('click', () => pane.remove());
    const flag = btn('sl-modal-danger sl-arcade-report-flag', 'flag it');
    flag.addEventListener('click', () => {
      flag.disabled = true;
      cancel.disabled = true;
      const text = reason.value.trim();
      const call = text === '' ? this.client.report(String(post.id))
        : this.client.report(String(post.id), text);
      void Promise.resolve(call)
        .then(() => {
          pane.replaceChildren();
          const thanks = div('sl-arcade-report-thanks');
          thanks.textContent = 'flagged for the curator. thank you.';
          pane.append(thanks);
          const timer = window.setTimeout(() => {
            pane.remove();
            this.timers.delete(timer);
          }, 1800);
          this.timers.add(timer);
        })
        .catch((e: unknown) => {
          pane.remove();
          this.status(wallCopy(e));
        });
    });
    row.append(cancel, flag);
    pane.append(ask, reason, row);
    card.append(pane);
    reason.focus();
  }

  /* ── publish ──────────────────────────────────────────── */

  private enterPublish(): void {
    const doc = this.opts.getDoc();
    this.publishOpen = true;
    this.bodyEl.hidden = true;
    this.publishEl.hidden = false;

    const box = this.publishEl.querySelector('.sl-arcade-pub-thumb');
    if (box) {
      const t = makeThumb(null);
      seatThumb(t, doc);
      box.replaceChildren(t.canvas);
      this.pubThumb = t;
    }

    const n = doc.frames.length;
    this.pubDimsEl.textContent = `${doc.width}×${doc.height} · ${n} ${n === 1 ? 'frame' : 'frames'}`;

    this.pubVerdict = checkPublishable(doc);
    if (this.pubVerdict === null && !docHasInk(doc)) {
      this.pubVerdict = 'nothing to post yet — the canvas is blank';
    }
    if (this.pubVerdict === null) {
      this.pubVerdictEl.textContent = 'ready for the wall.';
      this.pubVerdictEl.classList.remove('sl-verdict-bad');
    } else {
      this.pubVerdictEl.textContent = this.pubVerdict;
      this.pubVerdictEl.classList.add('sl-verdict-bad');
    }

    if (this.pubTitleInput.value.trim() === '') {
      this.pubTitleInput.value = doc.meta.name.slice(0, MAX_TITLE);
    }
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(HANDLE_KEY);
    } catch {
      /* storage unavailable */
    }
    if (this.pubHandleInput.value.trim() === '') {
      this.pubHandleInput.value = (stored ?? generateHandle()).slice(0, MAX_HANDLE);
    }
    this.pubStatusEl.textContent = '';
    this.syncRemixBanner();
    this.syncPostButton();
    this.syncLoop();
    this.pubTitleInput.focus();
    this.pubTitleInput.select();
  }

  private leavePublish(): void {
    this.publishOpen = false;
    this.publishEl.hidden = true;
    this.bodyEl.hidden = false;
    this.pubThumb = null;
    this.syncLoop();
  }

  private syncRemixBanner(): void {
    const parent = getRemixParent();
    this.pubRemixEl.hidden = parent === null;
    this.pubRemixNameEl.textContent = parent ? `'${parent.title}'` : '';
  }

  private syncPostButton(): void {
    this.pubPostBtn.disabled =
      this.pubVerdict !== null || this.pubTitleInput.value.trim() === '';
  }

  private post(): void {
    if (this.pubPostBtn.disabled) return;
    const doc = this.opts.getDoc();
    const title = this.pubTitleInput.value.trim().slice(0, MAX_TITLE);
    let handle = this.pubHandleInput.value.trim().slice(0, MAX_HANDLE);
    if (handle === '') {
      handle = generateHandle();
      this.pubHandleInput.value = handle;
    }
    this.pubPostBtn.disabled = true;
    this.pubPostBtn.textContent = 'posting…';
    this.pubStatusEl.textContent = '';
    const parent = getRemixParent();
    const req: { title: string; handle: string; doc: SpriteDoc; parentId?: string } =
      { title, handle, doc };
    if (parent !== null) req.parentId = String(parent.id);
    void Promise.resolve(this.client.publish(req))
      .then((post) => {
        try {
          localStorage.setItem(HANDLE_KEY, handle);
        } catch {
          /* storage unavailable */
        }
        setRemixParent(null);
        this.pubPostBtn.textContent = 'post it';
        this.leavePublish();
        this.dropCard(post);
        if (this.totalPosts !== null) {
          this.totalPosts += 1;
          this.paintStats();
        }
        this.status('on the wall.');
      })
      .catch((e: unknown) => {
        this.pubPostBtn.textContent = 'post it';
        this.pubPostBtn.disabled = false;
        this.pubStatusEl.textContent = publishCopy(e);
      });
  }

  /** The fresh post drops in at the top of the wall with a little bounce. */
  private dropCard(post: ArcadePost): void {
    if (this.parentFilter !== null) this.exitParentView();
    this.voidEl.hidden = true;
    this.wallEl.hidden = false;
    if (this.done && this.thumbs.length === 0) this.setTail("that's the whole wall (=^..^=)");
    const card = this.buildCard(post);
    if (!reducedMotion()) card.classList.add('sl-card-drop');
    this.postYoursEl.after(card);
    this.bodyEl.scrollTop = 0;
  }

  /* ── status + teardown ────────────────────────────────── */

  private statusTimer: number | null = null;

  private status(text: string): void {
    this.statusEl.textContent = text;
    if (this.statusTimer !== null) {
      window.clearTimeout(this.statusTimer);
      this.timers.delete(this.statusTimer);
    }
    this.statusTimer = window.setTimeout(() => {
      this.statusEl.textContent = '';
      if (this.statusTimer !== null) this.timers.delete(this.statusTimer);
      this.statusTimer = null;
    }, STATUS_MS);
    this.timers.add(this.statusTimer);
  }

  private dispose(): void {
    this.stopLoop();
    this.cardObserver?.disconnect();
    this.tailObserver?.disconnect();
    this.cardObserver = null;
    this.tailObserver = null;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.thumbs.length = 0;
    this.thumbByEl.clear();
    this.animSet.clear();
    this.pubThumb = null;
    if (current === this) current = null;
  }
}

/* DEV-only harness: lets e2e drive the arcade with an injected client before
   (and after) app wiring. Stripped from prod builds. */
if (import.meta.env.DEV) {
  (window as unknown as { __labArcade?: object }).__labArcade = {
    openArcade,
    setRemixParent,
    getRemixParent,
    generateHandle,
  };
}
