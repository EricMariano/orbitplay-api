const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for any RFC-4122 UUID (any version, including v7). */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
