/** core/bus — typed emitter semantics. */
import { describe, expect, it, vi } from 'vitest';
import { Bus } from '../../src/core/bus';

describe('Bus', () => {
  it('delivers payloads to subscribers', () => {
    const bus = new Bus();
    const got: number[] = [];
    bus.on('frame:active', ({ index }) => got.push(index));
    bus.emit('frame:active', { index: 3 });
    bus.emit('frame:active', { index: 5 });
    expect(got).toEqual([3, 5]);
  });

  it('unsubscribe stops delivery', () => {
    const bus = new Bus();
    let calls = 0;
    const off = bus.on('palette:changed', () => {
      calls += 1;
    });
    bus.emit('palette:changed');
    off();
    bus.emit('palette:changed');
    expect(calls).toBe(1);
  });

  it('a handler unsubscribing during emit does not skip others', () => {
    const bus = new Bus();
    const calls: string[] = [];
    const off1 = bus.on('palette:changed', () => {
      calls.push('h1');
      off1();
    });
    bus.on('palette:changed', () => calls.push('h2'));
    bus.emit('palette:changed');
    expect(calls).toEqual(['h1', 'h2']);
    bus.emit('palette:changed');
    expect(calls).toEqual(['h1', 'h2', 'h2']);
  });

  it('a throwing handler does not break others', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = new Bus();
    const calls: string[] = [];
    bus.on('palette:changed', () => {
      throw new Error('boom');
    });
    bus.on('palette:changed', () => calls.push('h2'));
    bus.emit('palette:changed');
    expect(calls).toEqual(['h2']);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('emit with no subscribers is a no-op', () => {
    expect(() => new Bus().emit('doc:replaced')).not.toThrow();
  });
});
