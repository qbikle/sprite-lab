/** io/palettes — lospec import: slug normalization, response parse, typed failures. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLospecPalette, isLospecError, lospecSlug } from '../../src/io/palettes';
import { hexToRgba } from '../../src/core/pixels';

type FetchLike = typeof globalThis.fetch;

function fakeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(JSON.parse(body) as unknown),
  } as unknown as Response;
}

/** Install a fetch stub; returns the URLs it was called with. */
function stubFetch(impl: (url: string) => Promise<Response>): string[] {
  const calls: string[] = [];
  const fake: FetchLike = (input) => {
    const url = String(input);
    calls.push(url);
    return impl(url);
  };
  vi.stubGlobal('fetch', fake);
  return calls;
}

async function failure(input: string): Promise<{ code: string; message: string }> {
  try {
    await fetchLospecPalette(input);
  } catch (err) {
    if (!isLospecError(err)) throw new Error('not a LospecError');
    return { code: err.code, message: err.message };
  }
  throw new Error('expected a rejection');
}

afterEach(() => vi.unstubAllGlobals());

describe('lospecSlug', () => {
  it('normalizes slugs and lospec URLs to the bare slug', () => {
    const cases: Array<[string, string | null]> = [
      ['sweetie-16', 'sweetie-16'],
      ['  sweetie-16  ', 'sweetie-16'],
      ['Sweetie-16', 'sweetie-16'],
      ['sweetie-16.json', 'sweetie-16'],
      ['/sweetie-16/', 'sweetie-16'],
      ['https://lospec.com/palette-list/sweetie-16', 'sweetie-16'],
      ['https://lospec.com/palette-list/sweetie-16.json', 'sweetie-16'],
      ['https://lospec.com/palette-list/sweetie-16/', 'sweetie-16'],
      ['https://lospec.com/palette-list/sweetie-16?utm=x#top', 'sweetie-16'],
      ['http://lospec.com/palette-list/pico-8', 'pico-8'],
      ['lospec.com/palette-list/apollo', 'apollo'],
      ['HTTPS://LOSPEC.COM/PALETTE-LIST/AAP-64', 'aap-64'],
      // refusals
      ['', null],
      ['   ', null],
      ['not a slug', null],
      ['under_score', null],
      ['https://example.com/palette-list/foo', null],
      ['https://lospec.com/palettes', null],
      ['.json', null],
    ];
    for (const [input, want] of cases) {
      expect(lospecSlug(input), JSON.stringify(input)).toBe(want);
    }
  });
});

describe('fetchLospecPalette', () => {
  it('fetches <slug>.json and packs the colors via core/pixels', async () => {
    const calls = stubFetch(() =>
      Promise.resolve(fakeResponse(200, JSON.stringify({
        name: 'Sweetie 16',
        colors: ['1a1c2c', '5d275d', 'f4f4f4'],
      }))),
    );
    const p = await fetchLospecPalette('https://lospec.com/palette-list/sweetie-16');
    expect(calls).toEqual(['https://lospec.com/palette-list/sweetie-16.json']);
    expect(p.name).toBe('Sweetie 16');
    expect(p.colors).toEqual([
      hexToRgba('#1a1c2c'), hexToRgba('#5d275d'), hexToRgba('#f4f4f4'),
    ]);
  });

  it('tolerates #-prefixed entries, skips junk, falls back to the slug name', async () => {
    stubFetch(() =>
      Promise.resolve(fakeResponse(200, JSON.stringify({
        name: '   ',
        colors: ['#ff0000', 'zzz', 42, '00ff00'],
      }))),
    );
    const p = await fetchLospecPalette('apollo');
    expect(p.name).toBe('apollo');
    expect(p.colors).toEqual([hexToRgba('#ff0000'), hexToRgba('#00ff00')]);
  });

  it('bad input → bad_input, without touching the network', async () => {
    const calls = stubFetch(() => Promise.reject(new TypeError('no')));
    const f = await failure('not a slug');
    expect(f.code).toBe('bad_input');
    expect(calls).toHaveLength(0);
  });

  it('404 → not_found naming the slug', async () => {
    stubFetch(() => Promise.resolve(fakeResponse(404, '{"error":"palette not found"}')));
    const f = await failure('no-such-palette');
    expect(f.code).toBe('not_found');
    expect(f.message).toContain('no-such-palette');
  });

  it('other HTTP errors → http with the status, never the raw body', async () => {
    stubFetch(() => Promise.resolve(fakeResponse(503, '<html>gateway</html>')));
    const f = await failure('sweetie-16');
    expect(f.code).toBe('http');
    expect(f.message).toContain('503');
    expect(f.message).not.toContain('html');
  });

  it('network/CORS failure → network with the .gpl fallback hint, raw error hidden', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const f = await failure('sweetie-16');
    expect(f.code).toBe('network');
    expect(f.message).toContain('.gpl');
    expect(f.message).not.toContain('Failed to fetch');
  });

  it('unparseable JSON → bad_data', async () => {
    stubFetch(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('bad json')),
      } as unknown as Response),
    );
    const f = await failure('sweetie-16');
    expect(f.code).toBe('bad_data');
  });

  it('missing colors field / no usable colors → bad_data', async () => {
    stubFetch(() => Promise.resolve(fakeResponse(200, '{"name":"x"}')));
    expect((await failure('sweetie-16')).code).toBe('bad_data');
    stubFetch(() => Promise.resolve(fakeResponse(200, '{"colors":["zzz"]}')));
    expect((await failure('sweetie-16')).code).toBe('bad_data');
    stubFetch(() => Promise.resolve(fakeResponse(200, '"just a string"')));
    expect((await failure('sweetie-16')).code).toBe('bad_data');
  });
});
