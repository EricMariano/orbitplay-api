/**
 * Alignment between the SQL enum `recording_kind` (`screen | webcam |
 * microphone`) and the OpenAPI names (`screen_recording | audio | microphone |
 * webcam`). There is no third enum — `audio` is a consent flag and the
 * extracted sidecar for future ASR, never a `session_recordings.kind` value.
 */

export const recordingKindDbValues = ['screen', 'webcam', 'microphone'] as const;
export type RecordingKindDb = (typeof recordingKindDbValues)[number];

/** OpenAPI `ConsentKind` minus `audio`, which is not a stored recording. */
export const recordingKindApiValues = ['screen_recording', 'webcam', 'microphone'] as const;
export type RecordingKindApi = (typeof recordingKindApiValues)[number];

export const API_TO_DB_RECORDING_KIND: Record<RecordingKindApi, RecordingKindDb> = {
  screen_recording: 'screen',
  webcam: 'webcam',
  microphone: 'microphone',
};

export const DB_TO_API_RECORDING_KIND: Record<RecordingKindDb, RecordingKindApi> = {
  screen: 'screen_recording',
  webcam: 'webcam',
  microphone: 'microphone',
};

export function toDbRecordingKind(kind: RecordingKindApi): RecordingKindDb {
  return API_TO_DB_RECORDING_KIND[kind];
}

export function toApiRecordingKind(kind: RecordingKindDb): RecordingKindApi {
  return DB_TO_API_RECORDING_KIND[kind];
}
