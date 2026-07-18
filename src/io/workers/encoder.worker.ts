/** Encode worker: heavy gif/webp work off the UI thread. Transferable-based. */
import { encodeGif } from '../exporters/gif';
import { muxAnimatedWebp } from '../exporters/webp';
import type { EncodeRequestWire, EncodeResponse } from './protocol';

const post = (res: EncodeResponse, transfer: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(res, transfer);
};

self.onmessage = (e: MessageEvent<EncodeRequestWire>) => {
  const req = e.data;
  try {
    if (req.kind === 'gif') {
      const frames = req.frames.map((f) => ({
        pixels: new Uint32Array(f.pixels),
        durationMs: f.durationMs,
      }));
      const bytes = encodeGif(frames, req.w, req.h, (done, total) => {
        post({ id: req.id, kind: 'progress', done, total });
      });
      post({ id: req.id, kind: 'done', bytes: bytes.buffer, mime: 'image/gif' }, [bytes.buffer]);
    } else {
      const frames = req.frames.map((f) => ({
        payload: new Uint8Array(f.payload),
        durationMs: f.durationMs,
      }));
      const bytes = muxAnimatedWebp(frames, req.w, req.h);
      post({ id: req.id, kind: 'done', bytes: bytes.buffer, mime: 'image/webp' }, [bytes.buffer]);
    }
  } catch (err) {
    post({ id: req.id, kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
