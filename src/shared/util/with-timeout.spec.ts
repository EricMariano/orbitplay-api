import { describe, expect, it, vi } from 'vitest';
import { TimeoutError, withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 100, 'x')).resolves.toBe(42);
  });

  it('propagates the original rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 100, 'x')).rejects.toThrow('boom');
  });

  it('rejects with TimeoutError when the promise never settles', async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(new Promise<never>(() => undefined), 50, 'redis ping');
      const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leave a pending timer behind after resolving', async () => {
    vi.useFakeTimers();
    try {
      await withTimeout(Promise.resolve('ok'), 1_000, 'x');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
