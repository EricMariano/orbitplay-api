/**
 * ioredis / BullMQ emit 'error' on every failed (re)connect attempt — roughly
 * every 2s while Redis is down. With no listener, ioredis prints an
 * "Unhandled error event" line each time (and BullMQ's own docs warn that a
 * worker without an error handler can stop processing); with a naive listener
 * the logs flood. This logs at most once per `intervalMs`.
 */
export function attachRedisErrorLogging(
  emitter: { on(event: 'error', listener: (error: Error) => void): unknown },
  label: string,
  log: (message: string) => void,
  intervalMs = 30_000,
): void {
  let lastLoggedAt = 0;
  emitter.on('error', (error: Error) => {
    const now = Date.now();
    if (now - lastLoggedAt < intervalMs) return;
    lastLoggedAt = now;
    log(`${label}: ${error.message}`);
  });
}
