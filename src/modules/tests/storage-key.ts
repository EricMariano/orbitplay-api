const STORAGE_KEY_RE =
  /^orgs\/([0-9a-f-]{36})\/tests\/([0-9a-f-]{36})\/builds\/([0-9a-f-]{36})\/(.+)$/i;

export function buildBuildStorageKey(
  organizationId: string,
  testId: string,
  buildId: string,
  fileName: string,
): string {
  return `orgs/${organizationId}/tests/${testId}/builds/${buildId}/${encodeURIComponent(fileName)}`;
}

export function parseBuildStorageKey(storageKey: string): {
  organizationId: string;
  testId: string;
  buildId: string;
  fileName: string;
} | null {
  const match = storageKey.match(STORAGE_KEY_RE);
  if (!match) return null;
  let fileName: string;
  try {
    fileName = decodeURIComponent(match[4]);
  } catch {
    // A stray `%` (e.g. `.../builds/<id>/%`) is a key this API never issued:
    // the same "not ours" as a key that doesn't match, not a URIError → 500.
    return null;
  }
  return { organizationId: match[1], testId: match[2], buildId: match[3], fileName };
}
