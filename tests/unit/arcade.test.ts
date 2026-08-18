/** net/arcade — encode/decode round-trip, publish gates, error mapping, 401 re-mint. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpriteDoc } from '../../src/core/doc';
import {
  ARCADE_LIMITS,
  type ArcadeError,
  type ArcadePost,
  arcadeClient,
  checkPublishable,
  decodePost,
  encodeDoc,
  isArcadeError,
} from '../../src/net/arcade';

/** The server's own charset rule (sl/logic.ts BASE64_PATTERN), verbatim. */
const SERVER_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * gzip+base64 of a known 2×2 DocJson, produced by node:zlib gzipSync at
 * authoring time — proves DecompressionStream interops with the zlib
 * family the server writes/reads. Cel `l1:f1` pixels (u32 LE):
 * [0xffff0000, 0xff00ff00, 0xff0000ff, 0x80ffffff].
 */
const ZLIB_FIXTURE =
  'H4sIAAAAAAAAE02OwWrDQAxEf6XMeWG9SUPahRwMuRZ6Lz1sbNkWbGyzlpMG43+P1lCIToPezEgLbpQmHnp4Z3DnWjr4nUFH3HayyRgeaoH/WcA1PKKDQR+ulHVmb3kxjKFieWw1N574EpVLmmn9NWiS2l8qmpyo5xREL38pcEWRfRLa7FI1hkgiWrH8n5rGxLowqIY4bP+8744f7rPY7w8aSFRRLzm8GlxJwku04T+ZE0FJRXHKJDqvT3iU5dna+9mW39ZuWqctTyes6xM/xhnPGwEAAA==';

function makeDoc(w: number, h: number, frameCount: number, layerCount = 1): SpriteDoc {
  const doc = SpriteDoc.blank(w, h, 'arcade-test');
  for (let l = 1; l < layerCount; l++) {
    doc.layers.push({ id: doc.allocLayerId(), name: `layer ${l + 1}`, opacity: 1, visible: true });
  }
  for (let f = 1; f < frameCount; f++) {
    doc.frames.push({ id: doc.allocFrameId(), durationMs: 80 });
  }
  for (let li = 0; li < doc.layers.length; li++) {
    for (let fi = 0; fi < doc.frames.length; fi++) {
      const cel = doc.ensureCel(doc.celKeyAt(li, fi));
      for (let i = 0; i < cel.length; i++) {
        cel[i] = ((li * 0x1f003 + fi * 0x0d1 + i * 0x9e37) >>> 0) | 0xff000000;
      }
    }
  }
  return doc;
}

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function gzipBase64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough<Uint8Array<ArrayBuffer>>(new CompressionStream('gzip'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (const b of out) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function rejection(p: Promise<unknown>): Promise<ArcadeError> {
  try {
    await p;
  } catch (err) {
    if (isArcadeError(err)) return err;
    throw new Error(`not an ArcadeError: ${String(err)}`);
  }
  throw new Error('expected a rejection');
}

describe('encodeDoc / decodePost', () => {
  it('round-trips a multi-layer multi-frame doc with byte-identical cels', async () => {
    const doc = makeDoc(9, 7, 3, 2);
    const encoded = await encodeDoc(doc);
    expect(encoded.width).toBe(9);
    expect(encoded.height).toBe(7);
    expect(encoded.frames).toBe(3);

    const back = await decodePost(encoded.data);
    expect(back.width).toBe(doc.width);
    expect(back.height).toBe(doc.height);
    expect(back.meta).toEqual(doc.meta);
    expect(back.layers).toEqual(doc.layers);
    expect(back.frames).toEqual(doc.frames);
    expect(back.palette).toEqual(doc.palette);
    for (let li = 0; li < doc.layers.length; li++) {
      for (let fi = 0; fi < doc.frames.length; fi++) {
        const key = doc.celKeyAt(li, fi);
        const before = doc.getCel(key);
        const after = back.getCel(key);
        expect(after).toBeDefined();
        expect(Array.from(after ?? [])).toEqual(Array.from(before ?? []));
      }
    }
  });

  it('emits server-acceptable data: padded standard base64 wrapping a gzip stream', async () => {
    const { data } = await encodeDoc(makeDoc(5, 5, 2));
    expect(SERVER_BASE64.test(data)).toBe(true);
    const bytes = base64Bytes(data);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(bytes[2]).toBe(0x08);
  });

  it('decodes a fixture gzipped by node:zlib (cross-implementation gzip)', async () => {
    const doc = await decodePost(ZLIB_FIXTURE);
    expect(doc.width).toBe(2);
    expect(doc.height).toBe(2);
    expect(doc.meta.name).toBe('fixture');
    expect(doc.frames).toEqual([{ id: 'f1', durationMs: 100 }]);
    expect(doc.palette.colors).toEqual([4278190335]);
    const cel = doc.getCel(doc.celKey('l1', 'f1'));
    expect(Array.from(cel ?? [])).toEqual([0xffff0000, 0xff00ff00, 0xff0000ff, 0x80ffffff]);
  });

  it('refuses garbage: bad base64, non-gzip bytes, gzip of non-doc JSON', async () => {
    expect((await rejection(decodePost('not base64!!'))).code).toBe('bad_data');
    expect((await rejection(decodePost(btoa('plain text, no gzip')))).code).toBe('bad_data');
    const notADoc = await gzipBase64('{"version":9,"nope":true}');
    expect((await rejection(decodePost(notADoc))).code).toBe('bad_data');
  });

  it('refuses a decoded doc past the arcade caps even when well-formed', async () => {
    const big = makeDoc(65, 4, 1);
    const oversized = await gzipBase64(JSON.stringify(big.toJSON()));
    expect((await rejection(decodePost(oversized))).code).toBe('bad_data');
  });

  it('refuses an encode past the 110000-char cap', async () => {
    const doc = makeDoc(64, 64, ARCADE_LIMITS.frames);
    let seed = 0x2f6e2b1;
    for (let fi = 0; fi < doc.frames.length; fi++) {
      const cel = doc.ensureCel(doc.celKeyAt(0, fi));
      for (let i = 0; i < cel.length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        cel[i] = seed;
      }
    }
    const err = await rejection(encodeDoc(doc));
    expect(err.code).toBe('too_large');
    expect(err.message).toContain(String(ARCADE_LIMITS.encodedChars));
  });
});

describe('checkPublishable', () => {
  it('accepts the exact caps: 64×64, 64 frames', () => {
    expect(checkPublishable(makeDoc(64, 64, 64))).toBeNull();
    expect(checkPublishable(makeDoc(1, 1, 1))).toBeNull();
  });

  it('refuses 65 on either side with a human reason', () => {
    expect(checkPublishable(makeDoc(65, 64, 1))).toContain('64×64');
    expect(checkPublishable(makeDoc(64, 65, 1))).toContain('64×64');
  });

  it('refuses 65 frames and a frameless doc', () => {
    expect(checkPublishable(makeDoc(8, 8, 65))).toContain('64');
    const doc = makeDoc(8, 8, 1);
    doc.frames = [];
    expect(checkPublishable(doc)).not.toBeNull();
  });
});

/* ── the client, against a scripted fetch ─────────────────────────────── */

type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Handler = () => Response | Promise<Response>;

let recorded: Recorded[] = [];

function scriptFetch(...handlers: Handler[]): void {
  recorded = [];
  const queue = [...handlers];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    recorded.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const handler = queue.shift();
    if (handler === undefined) throw new Error(`unscripted fetch: ${String(input)}`);
    return Promise.resolve(handler());
  });
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function problemRes(status: number, code: string, ext: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ type: `e/${code}`, title: 'refused', status, detail: `detail for ${code}`, code, ...ext }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function callAt(i: number): Recorded {
  const call = recorded[i];
  if (call === undefined) throw new Error(`no fetch call at index ${i}`);
  return call;
}

const BASE = 'https://arcade.test/v1/sl';

const POST: ArcadePost = {
  id: '5f2b1c3e-8d4a-4b6f-9e7c-2a1d3f5b7c9e',
  handle: 'mochi',
  title: 'cat at the arcade',
  width: 8,
  height: 8,
  frames: 2,
  hearts: 3,
  parentId: null,
  createdAt: '2026-08-18T12:00:00.000Z',
  data: ZLIB_FIXTURE,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('arcadeClient', () => {
  it('list maps nextCursor → cursor and forwards query params tokenless', async () => {
    scriptFetch(() => jsonRes(200, { posts: [POST], nextCursor: 'tok-next' }));
    const page = await arcadeClient(BASE).list({ limit: 5, cursor: 'cur1', parent: POST.id });
    expect(page.posts).toEqual([POST]);
    expect(page.cursor).toBe('tok-next');
    const call = callAt(0);
    expect(call.url).toBe(`${BASE}/posts?limit=5&cursor=cur1&parent=${POST.id}`);
    expect(call.headers.authorization).toBeUndefined();
    expect(recorded.length).toBe(1);
  });

  it('publish pre-flights, encodes, and posts declared dims that match the doc', async () => {
    scriptFetch(
      () => jsonRes(200, { token: 'tok-a' }),
      () => jsonRes(201, { post: POST }),
    );
    const doc = makeDoc(8, 8, 2);
    const post = await arcadeClient(BASE).publish({ title: 't', handle: 'h', doc });
    expect(post).toEqual(POST);
    const mint = callAt(0);
    expect(mint.url).toBe(`${BASE}/session`);
    expect((mint.body as { anonId: string }).anonId).toMatch(/^[0-9a-f-]{36}$/);
    const create = callAt(1);
    expect(create.url).toBe(`${BASE}/posts`);
    expect(create.headers.authorization).toBe('Bearer tok-a');
    const body = create.body as { title: string; handle: string; data: string; width: number; height: number; frames: number; parentId?: string };
    expect(body.title).toBe('t');
    expect(body.width).toBe(8);
    expect(body.height).toBe(8);
    expect(body.frames).toBe(2);
    expect(SERVER_BASE64.test(body.data)).toBe(true);
    expect(body.parentId).toBeUndefined();
    const back = await decodePost(body.data);
    expect(back.meta).toEqual(doc.meta);
  });

  it('publish refuses an unpublishable doc before any network call', async () => {
    scriptFetch();
    const err = await rejection(
      arcadeClient(BASE).publish({ title: 't', handle: 'h', doc: makeDoc(65, 8, 1) }),
    );
    expect(err.code).toBe('unpublishable');
    expect(err.message).toContain('64×64');
    expect(recorded.length).toBe(0);
  });

  it('maps problem+json onto ArcadeError: code and retryAfterS survive', async () => {
    scriptFetch(
      () => jsonRes(200, { token: 'tok-a' }),
      () => problemRes(429, 'sl/daily_budget', { retryAfterSeconds: 3600 }),
    );
    const err = await rejection(arcadeClient(BASE).heart(POST.id));
    expect(err.code).toBe('sl/daily_budget');
    expect(err.retryAfterS).toBe(3600);
    expect(err.message).toBe('detail for sl/daily_budget');
  });

  it('falls back to the Retry-After header when the body has no seconds', async () => {
    scriptFetch(() => {
      const res = problemRes(429, 'rate_limited');
      res.headers.set('retry-after', '42');
      return res;
    });
    const err = await rejection(arcadeClient(BASE).stats());
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterS).toBe(42);
  });

  it('surfaces sl/min_play without re-minting (403 is not 401)', async () => {
    scriptFetch(
      () => jsonRes(200, { token: 'tok-a' }),
      () => problemRes(403, 'sl/min_play'),
    );
    const err = await rejection(arcadeClient(BASE).heart(POST.id));
    expect(err.code).toBe('sl/min_play');
    expect(recorded.length).toBe(2);
  });

  it('re-mints ONCE on 401 sl/invalid_token and retries with the fresh token', async () => {
    scriptFetch(
      () => jsonRes(200, { token: 'tok-a' }),
      () => problemRes(401, 'sl/invalid_token'),
      () => jsonRes(200, { token: 'tok-b' }),
      () => jsonRes(200, { hearted: true, hearts: 4 }),
    );
    const result = await arcadeClient(BASE).heart(POST.id);
    expect(result).toEqual({ hearted: true, hearts: 4 });
    expect(recorded.length).toBe(4);
    expect(callAt(1).headers.authorization).toBe('Bearer tok-a');
    expect(callAt(2).url).toBe(`${BASE}/session`);
    expect(callAt(3).headers.authorization).toBe('Bearer tok-b');
  });

  it('a second 401 surfaces the error — no re-mint loop', async () => {
    scriptFetch(
      () => jsonRes(200, { token: 'tok-a' }),
      () => problemRes(401, 'sl/invalid_token'),
      () => jsonRes(200, { token: 'tok-b' }),
      () => problemRes(401, 'sl/invalid_token'),
    );
    const err = await rejection(arcadeClient(BASE).heart(POST.id));
    expect(err.code).toBe('sl/invalid_token');
    expect(recorded.length).toBe(4);
  });

  it('report sends kind post + targetId and swallows the bare 202', async () => {
    scriptFetch(
      () => jsonRes(200, { token: 'tok-a' }),
      () => new Response(null, { status: 202 }),
    );
    await expect(arcadeClient(BASE).report(POST.id, 'rude')).resolves.toBeUndefined();
    expect(callAt(1).body).toEqual({ kind: 'post', targetId: POST.id, reason: 'rude' });
  });

  it('stats passes through tokenless and never mints', async () => {
    scriptFetch(() => jsonRes(200, { totalPosts: 7, flags: { posts: true } }));
    const stats = await arcadeClient(BASE).stats();
    expect(stats).toEqual({ totalPosts: 7, flags: { posts: true } });
    expect(recorded.length).toBe(1);
    expect(callAt(0).headers.authorization).toBeUndefined();
  });

  it('a dead fetch is ArcadeError offline', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const err = await rejection(arcadeClient(BASE).stats());
    expect(err.code).toBe('offline');
  });

  it('a non-problem error body still yields a coded error', async () => {
    scriptFetch(() => new Response('<html>nope</html>', { status: 502 }));
    const err = await rejection(arcadeClient(BASE).stats());
    expect(err.code).toBe('http_502');
  });
});
