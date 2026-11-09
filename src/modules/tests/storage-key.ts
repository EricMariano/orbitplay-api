/**
 * The file-name segment can't contain a raw `/`: `encodeURIComponent` always
 * escapes it, so a key with one was never issued by `buildBuildStorageKey` —
 * and the worker's immutable copy (`validatedBuildStorageKey`, one segment
 * deeper) must never be confirmable as if it were a client upload.
 */
const STORAGE_KEY_RE =
  /^orgs\/([0-9a-f-]{36})\/tests\/([0-9a-f-]{36})\/builds\/([0-9a-f-]{36})\/([^/]+)$/i;

/** Key a studio PUTs to through the presigned upload URL — mutable while that URL lives. */
export function buildBuildStorageKey(
  organizationId: string,
  testId: string,
  buildId: string,
  fileName: string,
): string {
  return `orgs/${organizationId}/tests/${testId}/builds/${buildId}/${encodeURIComponent(fileName)}`;
}

/**
 * Key of the server-side copy the worker validates and players download. No
 * presigned PUT is ever issued for it (the upload key's file name is always a
 * single encoded segment), so re-PUTting through a still-valid upload URL
 * after validation can't swap the bytes behind the `validated` badge.
 */
export function validatedBuildStorageKey(
  organizationId: string,
  testId: string,
  buildId: string,
  fileName: string,
): string {
  return `orgs/${organizationId}/tests/${testId}/builds/${buildId}/validated/${encodeURIComponent(fileName)}`;
}

/**
 * Every object a build may own: whatever its row points at, the client's
 * upload (it can be re-PUT while its URL lives, even after the worker removed
 * it) and the validated copy. Removing an absent key is a no-op.
 */
export function buildObjectKeys(build: {
  id: string;
  organizationId: string;
  testId: string;
  fileName: string;
  storageKey: string;
}): string[] {
  return [
    ...new Set([
      build.storageKey,
      buildBuildStorageKey(build.organizationId, build.testId, build.id, build.fileName),
      validatedBuildStorageKey(build.organizationId, build.testId, build.id, build.fileName),
    ]),
  ];
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
