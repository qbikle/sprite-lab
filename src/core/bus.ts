/** Typed event bus over the frozen EventMap. */
import type { EventMap } from './contracts';

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void;
type AnyHandler = (payload: unknown) => void;

export class Bus {
  private readonly handlers = new Map<keyof EventMap, Set<AnyHandler>>();

  /** Returns an unsubscribe function. */
  on<K extends keyof EventMap>(key: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    const h = fn as AnyHandler;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  emit<K extends keyof EventMap>(
    key: K,
    ...payload: EventMap[K] extends undefined ? [] : [EventMap[K]]
  ): void {
    const set = this.handlers.get(key);
    if (!set || set.size === 0) return;
    const arg = (payload as readonly unknown[])[0];
    for (const fn of [...set]) {
      try {
        fn(arg);
      } catch (err) {
        console.error(`bus: handler for "${key}" threw`, err);
      }
    }
  }
}
