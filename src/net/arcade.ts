/**
 * Arcade client — the ONLY networked module in sprite-lab. Talks to the
 * cyrodiil `sl` module (anon sessions, posts, hearts, reports, stats).
 * Zero deps: fetch + CompressionStream/DecompressionStream are platform.
 *
 * Wire notes (read from cyrodiil sl/routes.ts + logic.ts):
 * - list answers `{ posts, nextCursor }` — surfaced here as `cursor`.
 * - publish answers 201 `{ post }`; heart answers `{ hearted, hearts }`
 *   (a TOGGLE — `hearted` is the state after the call); report is a bare 202.
 * - errors are problem+json with a `code` field; the two 429s
 *   (`rate_limited` per-minute vs `sl/daily_budget` rolling-24h) both carry
 *   `retryAfterSeconds`.
 * - 401 `sl/invalid_token` → re-mint the session ONCE and retry; 403
 *   `sl/min_play` means the token is under 10s old — surface it, never
 *   re-mint (re-acquiring resets the age clock).
 */
import { SpriteDoc } from '../core/doc';
import { docToSpriteFile, spriteFileToDoc } from '../io/project';

export interface ArcadePost {
  id: string;
  /** A STRANGER wrote it — render as text, never near innerHTML or a URL. */
  handle: string;
  title: string;
  width: number;
  height: number;
  frames: number;
  hearts: number;
  /** May 404 on lookup (parent purged) — render without lineage, not as an error. */
  parentId: string | null;
  createdAt: string;
  /** The whole `.sprite` doc, gzip+base64 — feed to decodePost. */
  data: string;
}

export interface ArcadeError extends Error {
  code: string;
  retryAfterS?: number;
}

export interface ArcadeClient {
  list(opts?: {
    cursor?: string;
    parent?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<{ posts: ArcadePost[]; cursor: string | null }>;
  publish(input: {
    title: string;
    handle: string;
    doc: SpriteDoc;
    parentId?: string;
  }): Promise<ArcadePost>;
  heart(id: string): Promise<{ hearted: boolean; hearts: number }>;
  report(id: string, reason?: string): Promise<void>;
  stats(): Promise<{ totalPosts: number; flags: Record<string, boolean> }>;
}

/** Server caps, mirrored from sl/logic.ts (SPRITE_DIMENSION_MAX / SPRITE_FRAMES_MAX / DATA_ENCODED_MAX). */
export const ARCADE_LIMITS: { side: 64; frames: 64; encodedChars: number } = {
  side: 64,
  frames: 64,
  encodedChars: 110_000,
};

const PROD_BASE = 'https://cyrodiil.onrender.com/v1/sl';
const DEV_BASE = 'http://localhost:8080/v1/sl';
const API_KEY = 'sprite-lab:v2:arcade-api';
const ANON_KEY = 'sprite-lab:v2:arcade-anon';
const TOKEN_KEY = 'sprite-lab:v2:arcade-token';
/** Server's decompression ceiling — enforced here too, so a lying payload dies unread. */
const DECODED_MAX = 2 * 1024 * 1024;

export function isArcadeError(err: unknown): err is ArcadeError {
  return err instanceof Error && typeof (err as { code?: unknown }).code === 'string';
}

function arcadeError(code: string, message: string, retryAfterS?: number): ArcadeError {
  const err = new Error(message) as ArcadeError;
  err.name = 'ArcadeError';
  err.code = code;
  if (retryAfterS !== undefined) err.retryAfterS = retryAfterS;
  return err;
}

/** Pre-flight before encoding. Null = publishable, else the human reason. */
export function checkPublishable(doc: SpriteDoc): string | null {
  if (doc.width < 1 || doc.height < 1) return 'nothing to post — the canvas is empty';
  if (doc.width > ARCADE_LIMITS.side || doc.height > ARCADE_LIMITS.side) {
    return `too big — arcade sprites max ${ARCADE_LIMITS.side}×${ARCADE_LIMITS.side}`;
  }
  if (doc.frames.length < 1) return 'nothing to post — the sprite has no frames';
  if (doc.frames.length > ARCADE_LIMITS.frames) {
    return `too many frames — arcade sprites max ${ARCADE_LIMITS.frames}`;
  }
  return null;
}

/**
 * `.sprite` JSON (the exact docToSpriteFile serialization) → gzip → base64.
 * Throws `too_large` past the server's encoded cap.
 */
export async function encodeDoc(
  doc: SpriteDoc,
): Promise<{ data: string; width: number; height: number; frames: number }> {
  const bytes = new Uint8Array(await docToSpriteFile(doc).arrayBuffer());
  const data = bytesToBase64(await gzipBytes(bytes));
  if (data.length > ARCADE_LIMITS.encodedChars) {
    throw arcadeError(
      'too_large',
      `too heavy — this sprite encodes to ${data.length} characters (arcade max ${ARCADE_LIMITS.encodedChars})`,
    );
  }
  return { data, width: doc.width, height: doc.height, frames: doc.frames.length };
}

/** base64 → gunzip (capped) → SpriteDoc via the existing fromJSON path. */
export async function decodePost(data: string): Promise<SpriteDoc> {
  let doc: SpriteDoc;
  try {
    const bytes = await gunzipCapped(base64ToBytes(data), DECODED_MAX);
    doc = await spriteFileToDoc(new Blob([bytes]));
  } catch {
    throw arcadeError('bad_data', 'could not decode this post — not a valid .sprite document');
  }
  if (checkPublishable(doc) !== null) {
    throw arcadeError('bad_data', 'could not decode this post — it breaks the arcade size limits');
  }
  return doc;
}

export function arcadeClient(base?: string): ArcadeClient {
  const root = trimSlash(
    base ?? storageGet('local', API_KEY) ?? (import.meta.env.DEV ? DEV_BASE : PROD_BASE),
  );
  let token = storageGet('session', TOKEN_KEY);

  function anonId(): string {
    const existing = storageGet('local', ANON_KEY);
    if (existing !== null) return existing;
    const fresh = crypto.randomUUID();
    storageSet('local', ANON_KEY, fresh);
    return fresh;
  }

  function dropToken(): void {
    token = null;
    storageRemove('session', TOKEN_KEY);
  }

  async function mint(): Promise<string> {
    const minted = await call<{ token: string }>(root, 'POST', '/session', {
      body: { anonId: anonId() },
    });
    token = minted.token;
    storageSet('session', TOKEN_KEY, minted.token);
    return minted.token;
  }

  /**
   * A call that may carry the session token. `required` mints lazily
   * (writes); reads attach an existing token only, so the viewer keeps
   * seeing their own hidden rows. One 401 re-mint, one retry, no loop —
   * and `sl/min_play` passes straight through untouched.
   */
  async function withToken<T>(
    method: string,
    path: string,
    opts: CallOpts,
    required: boolean,
  ): Promise<T> {
    let bearer = token;
    if (bearer === null) {
      if (!required) return call<T>(root, method, path, opts);
      bearer = await mint();
    }
    try {
      return await call<T>(root, method, path, { ...opts, bearer });
    } catch (err) {
      if (!isArcadeError(err) || err.code !== 'sl/invalid_token') throw err;
      dropToken();
      const fresh = await mint();
      return call<T>(root, method, path, { ...opts, bearer: fresh });
    }
  }

  return {
    async list(opts = {}) {
      const q = new URLSearchParams();
      if (opts.limit !== undefined) q.set('limit', String(opts.limit));
      if (opts.cursor !== undefined) q.set('cursor', opts.cursor);
      if (opts.parent !== undefined) q.set('parent', opts.parent);
      const qs = q.toString();
      const page = await withToken<{ posts: ArcadePost[]; nextCursor: string | null }>(
        'GET',
        qs === '' ? '/posts' : `/posts?${qs}`,
        opts.signal !== undefined ? { signal: opts.signal } : {},
        false,
      );
      return { posts: page.posts, cursor: page.nextCursor };
    },

    async publish(input) {
      const reason = checkPublishable(input.doc);
      if (reason !== null) throw arcadeError('unpublishable', reason);
      const encoded = await encodeDoc(input.doc);
      const body: Record<string, unknown> = {
        title: input.title,
        handle: input.handle,
        ...encoded,
      };
      if (input.parentId !== undefined) body.parentId = input.parentId;
      const res = await withToken<{ post: ArcadePost }>('POST', '/posts', { body }, true);
      return res.post;
    },

    async heart(id) {
      return withToken<{ hearted: boolean; hearts: number }>(
        'POST',
        `/posts/${encodeURIComponent(id)}/heart`,
        {},
        true,
      );
    },

    async report(id, reason) {
      const body: Record<string, unknown> = { kind: 'post', targetId: id };
      if (reason !== undefined) body.reason = reason;
      await withToken<void>('POST', '/report', { body, empty: true }, true);
    },

    async stats() {
      // Deliberately tokenless: the kill switch's transport must never 401.
      return call<{ totalPosts: number; flags: Record<string, boolean> }>(
        root,
        'GET',
        '/stats',
        {},
      );
    },
  };
}

/* ── transport ────────────────────────────────────────────────────────── */

interface CallOpts {
  body?: unknown;
  bearer?: string;
  signal?: AbortSignal;
  /** 202-style responses with no body to parse. */
  empty?: boolean;
}

async function call<T>(root: string, method: string, path: string, opts: CallOpts): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  let res: Response;
  try {
    res = await fetch(`${root}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw arcadeError('aborted', 'the request was cancelled');
    }
    throw arcadeError('offline', 'could not reach the arcade — check your connection');
  }
  if (!res.ok) {
    const raw: unknown = await res.json().catch(() => null);
    throw problemError(raw, res.status, res.headers.get('retry-after'));
  }
  if (opts.empty === true) return undefined as T;
  return (await res.json()) as T;
}

/** problem+json → ArcadeError: server `code` verbatim, `http_<status>` fallback. */
function problemError(raw: unknown, status: number, retryHeader: string | null): ArcadeError {
  const body =
    typeof raw === 'object' && raw !== null
      ? (raw as { code?: unknown; detail?: unknown; title?: unknown; retryAfterSeconds?: unknown })
      : {};
  const code = typeof body.code === 'string' && body.code !== '' ? body.code : `http_${status}`;
  const message =
    typeof body.detail === 'string' && body.detail !== ''
      ? body.detail
      : typeof body.title === 'string' && body.title !== ''
        ? body.title
        : `the arcade answered ${status}`;
  let retryAfterS: number | undefined;
  if (typeof body.retryAfterSeconds === 'number' && Number.isFinite(body.retryAfterSeconds)) {
    retryAfterS = body.retryAfterSeconds;
  } else if (retryHeader !== null && /^\d+$/.test(retryHeader)) {
    retryAfterS = Number(retryHeader);
  }
  return arcadeError(code, message, retryAfterS);
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/* ── storage (best-effort; node/private-mode safe) ────────────────────── */

function storageArea(area: 'local' | 'session'): Storage {
  return area === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
}

function storageGet(area: 'local' | 'session', key: string): string | null {
  try {
    return storageArea(area).getItem(key);
  } catch {
    return null;
  }
}

function storageSet(area: 'local' | 'session', key: string, value: string): void {
  try {
    storageArea(area).setItem(key, value);
  } catch {
    /* best-effort */
  }
}

function storageRemove(area: 'local' | 'session', key: string): void {
  try {
    storageArea(area).removeItem(key);
  } catch {
    /* best-effort */
  }
}

/* ── gzip + base64 (platform streams; standard alphabet, padded) ──────── */

async function gzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough<Uint8Array<ArrayBuffer>>(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Gunzip with a hard output cap, read incrementally — a bomb dies at cap+one-chunk. */
async function gunzipCapped(
  bytes: Uint8Array<ArrayBuffer>,
  cap: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough<Uint8Array<ArrayBuffer>>(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new Error(`decompresses past ${cap} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
