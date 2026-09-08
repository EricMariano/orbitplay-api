const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for any RFC-4122 UUID (any version, including v7). */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Timestamp encoded in a UUID v7 (unix ms in the first 48 bits). */
export function createdAtFromUuidV7(id: string): Date {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return new Date(parseInt(hex, 16));
}
