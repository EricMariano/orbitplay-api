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
