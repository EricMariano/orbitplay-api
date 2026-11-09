/**
 * Shape a client-supplied correlation id must have to be reused: printable
 * token characters only, 8–128 long (covers UUIDs, ULIDs, trace ids).
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Picks the request id for a call. The `x-request-id` header is attacker
 * controlled and lands in every log line, the error envelope and the response
 * header, so it is only echoed back when it looks like a real id; anything
 * else (empty, oversized, spaces, control or log-forging characters) is
 * replaced by a freshly generated one.
 */
export function resolveRequestId(
  header: string | string[] | undefined,
  generate: () => string,
): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && SAFE_REQUEST_ID.test(candidate) ? candidate : generate();
}
