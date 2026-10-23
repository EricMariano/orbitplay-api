export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Rejects with a {@link TimeoutError} if `promise` doesn't settle within `ms`.
 *
 * Used where a dependency that hangs (e.g. an ioredis command queued while Redis
 * is down) must turn into a fast, explicit failure — health probes and boot-time
 * connection checks. The timer is always cleared, so it never keeps the process
 * alive; the original promise keeps running but its late rejection is handled.
 */
export async function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
