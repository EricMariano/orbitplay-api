/**
 * Detects "a dependency (Postgres/Redis) is unreachable" errors, so the global
 * filter can answer 503 + Retry-After instead of an opaque 500.
 *
 * Errors are inspected along their `cause` chain: Drizzle wraps driver errors
 * in a `DrizzleQueryError` whose `cause` is the original postgres-js error.
 */
const CONNECTIVITY_CODES = new Set([
  // postgres-js
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  // Node sockets
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  // Postgres server: admin_shutdown, crash_shutdown, cannot_connect_now
  '57P01',
  '57P02',
  '57P03',
]);

/** SQLSTATE class 08 — connection_exception. */
const PG_CONNECTION_CLASS = /^08[0-9A-Z]{3}$/;

const MAX_CAUSE_DEPTH = 5;

function isConnectivityLeaf(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };

  if (
    typeof code === 'string' &&
    (CONNECTIVITY_CODES.has(code) || PG_CONNECTION_CLASS.test(code))
  ) {
    return true;
  }
  // ioredis: gave up after `maxRetriesPerRequest` reconnects / per-command timeout / closed link.
  if (name === 'MaxRetriesPerRequestError') return true;
  // `withTimeout` (health probes, BullMQ enqueue) or an AbortSignal timeout: the dependency didn't answer.
  if (name === 'TimeoutError') return true;
  if (typeof message === 'string') {
    return message.includes('Command timed out') || message.includes('Connection is closed');
  }
  return false;
}

export function isConnectivityError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    if (isConnectivityLeaf(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
