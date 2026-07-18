/** Worker protocol — request/response over transferables. Additive-only. */

export interface EncodeFramePayload {
  pixels: ArrayBuffer; // Uint32Array LE-ABGR backing buffer (transferred)
  durationMs: number;
}

/** id is assigned by the client on send — callers never set it. */
export type EncodeRequest =
  | { id?: number; kind: 'gif'; w: number; h: number; frames: EncodeFramePayload[] }
  | { id?: number; kind: 'webp-mux'; w: number; h: number;
      frames: { payload: ArrayBuffer; durationMs: number }[] };

/** Request as delivered to the worker — the client always stamps the id. */
export type EncodeRequestWire = EncodeRequest & { id: number };

export type EncodeResponse =
  | { id: number; kind: 'done'; bytes: ArrayBuffer; mime: string }
  | { id: number; kind: 'progress'; done: number; total: number }
  | { id: number; kind: 'error'; message: string };

/** Main-thread client: one call per export, resolves with a Blob. */
export class EncoderClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (blob: Blob) => void;
    reject: (err: Error) => void;
    onProgress: ((done: number, total: number) => void) | undefined;
  }>();

  request(req: EncodeRequest, transfer: Transferable[], onProgress?: (done: number, total: number) => void): Promise<Blob> {
    const id = this.nextId++;
    return new Promise<Blob>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      try {
        this.ensureWorker().postMessage({ ...req, id }, transfer);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.failAll(new Error('EncoderClient disposed'));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./encoder.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<EncodeResponse>) => {
      const res = e.data;
      const entry = this.pending.get(res.id);
      if (!entry) return;
      if (res.kind === 'progress') {
        entry.onProgress?.(res.done, res.total);
        return;
      }
      this.pending.delete(res.id);
      if (res.kind === 'error') entry.reject(new Error(res.message));
      else entry.resolve(new Blob([res.bytes], { type: res.mime }));
    };
    worker.onerror = (e: ErrorEvent) => {
      this.discard(worker, new Error(e.message || 'encoder worker crashed'));
    };
    worker.onmessageerror = () => {
      this.discard(worker, new Error('encoder worker message deserialization failed'));
    };
    this.worker = worker;
    return worker;
  }

  /** A dead Worker never answers again — terminate and drop it so the next
   *  request respawns a fresh one instead of hanging forever. */
  private discard(worker: Worker, err: Error): void {
    worker.terminate();
    if (this.worker === worker) this.worker = null;
    this.failAll(err);
  }

  private failAll(err: Error): void {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }
}
