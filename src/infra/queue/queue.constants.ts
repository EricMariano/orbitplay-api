/** Names of the BullMQ queues. Keep in sync with the worker process. */
export const MAIN_QUEUE = 'main';

/** Job names handled on the main queue (extended as features land). */
export const JobName = {
  /** Placeholder job proving the queue wiring end-to-end. */
  PING: 'ping',
  /** Turn the uploaded recording into a playable object + thumbnail. */
  MEDIA_TRANSCODE: 'media.transcode',
  /** Extract an audio sidecar so ASR can plug in later (deferred). */
  MEDIA_EXTRACT_AUDIO: 'media.extract-audio',
  /** Run the build validation pipeline (checksum, malware scan, metadata). */
  BUILD_VALIDATE: 'build.validate',
  /** Periodic sweep that re-enqueues builds/recordings stuck in `processing` (OPS-01). */
  RECONCILE_STUCK_JOBS: 'ops.reconcile-stuck-jobs',
  /** Validates a finished session and, if valid, credits XP (Tela 19 RN-03). */
  SESSION_VALIDATE: 'session.validate',
} as const;

export type JobNameValue = (typeof JobName)[keyof typeof JobName];

/**
 * Deterministic BullMQ job ids, one per (job type, resource). The DB insert
 * and the enqueue are two separate operations with no shared transaction
 * (OPS-01) — a request can commit the row and then die before the job is
 * queued. Because the id is a pure function of the resource id, the SAME
 * job id is computed independently by the original request, a client retry,
 * and the reconciliation sweep; BullMQ treats `add()` with an id that's
 * already in flight as a no-op, so all three can call `ensureJobEnqueued`
 * freely without ever double-processing or racing each other.
 */
export function buildValidateJobId(buildId: string): string {
  return `${JobName.BUILD_VALIDATE}:${buildId}`;
}

export function mediaTranscodeJobId(recordingId: string): string {
  return `${JobName.MEDIA_TRANSCODE}:${recordingId}`;
}

export function mediaExtractAudioJobId(recordingId: string): string {
  return `${JobName.MEDIA_EXTRACT_AUDIO}:${recordingId}`;
}

/**
 * No `:` separator on purpose (unlike the other `*JobId` helpers above,
 * which do use one): BullMQ's `Job.create` rejects a custom `jobId` that
 * contains `:` unless splitting on it yields exactly 3 parts (reserved for
 * its own repeatable-job id format) — `session.validate:<uuid>` only splits
 * into 2 and throws `Custom Id cannot contain :`. The existing `:`-based
 * helpers happen to never surface this because their one call site
 * (`TestsService.confirmBuild`) wraps the enqueue in a try/catch that
 * silently marks the build `failed` on ANY error, this one included.
 */
export function sessionValidateJobId(sessionId: string): string {
  return `session-validate-${sessionId}`;
}
