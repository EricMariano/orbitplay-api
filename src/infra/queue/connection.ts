/**
 * BullMQ/ioredis connection options from a full Redis URL (OPS-02).
 *
 * Hand-parsing `new URL(url)` down to `{ host, port }` — the previous shape
 * here, and still duplicated inline in `queue.module.ts` — silently drops
 * everything else the URL can carry: `rediss://` (TLS), HTTP-Basic-style
 * `username:password@`, and the `/N` path segment selecting a DB index. A
 * REDIS_URL pointing at a managed/secured Redis (auth required, TLS-only,
 * non-default DB) would connect to a *different, unauthenticated, plaintext*
 * server instead — wrong host entirely, or a bare connection an operator
 * assumed was encrypted and credentialed.
 *
 * `url` is a first-class field on BullMQ's own `RedisOptions` (and ioredis'
 * own constructor): passing it through verbatim hands the parsing to
 * ioredis' own URL parser instead of reimplementing a partial one — the same
 * pattern `RedisModule` already uses for the plain ioredis client
 * (`new Redis(url, opts)`).
 */
export function redisConnectionOptions(url: string): {
  url: string;
  maxRetriesPerRequest: null;
} {
  return {
    url,
    // Required by BullMQ's blocking commands.
    maxRetriesPerRequest: null,
  };
}
