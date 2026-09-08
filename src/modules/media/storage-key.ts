import type { RecordingKindDb } from './recording-kind';

const STORAGE_KEY_RE =
  /^orgs\/([0-9a-f-]{36})\/sessions\/([0-9a-f-]{36})\/recordings\/(screen|webcam|microphone)\/([0-9a-f-]{36})$/i;

export function buildRecordingStorageKey(
  organizationId: string,
  sessionId: string,
  kind: RecordingKindDb,
  objectId: string,
): string {
  return `orgs/${organizationId}/sessions/${sessionId}/recordings/${kind}/${objectId}`;
}

export function extractedAudioKey(storageKey: string): string {
  return `${storageKey}.audio`;
}

export function parseRecordingStorageKey(storageKey: string): {
  organizationId: string;
  sessionId: string;
  kind: RecordingKindDb;
  objectId: string;
} | null {
  const match = storageKey.match(STORAGE_KEY_RE);
  if (!match) return null;
  return {
    organizationId: match[1],
    sessionId: match[2],
    kind: match[3] as RecordingKindDb,
    objectId: match[4],
  };
}
