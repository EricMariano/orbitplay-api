import { v7 as uuidv7 } from 'uuid';

/**
 * What a client may send as `X-Request-Id` for us to adopt. The id is echoed
 * back, written to every log line and persisted in `audit_log.request_id`, so
 * it must not carry control characters, log-forging payloads or megabytes of
 * text: anything outside this short, plain alphabet is replaced by our own.
 */
const ACCEPTED_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The incoming `X-Request-Id` when it is well-formed, otherwise a fresh UUIDv7. */
export function resolveRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && ACCEPTED_REQUEST_ID.test(candidate) ? candidate : uuidv7();
}
