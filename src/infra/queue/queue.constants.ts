import type { JobsOptions } from 'bullmq';

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
  /** Renders a test report to CSV/PDF, uploads it and marks the export ready (M10-04). */
  REPORT_EXPORT: 'report.export',
} as const;

export type JobNameValue = (typeof JobName)[keyof typeof JobName];

/**
 * BullMQ options per job name, applied when `ensureJobEnqueued` first adds
 * the job. A job absent here runs once (BullMQ's default `attempts: 1`): its
 * retry is the reconciliation sweep re-ensuring it from the DB row's state.
 * `report.export` has no sweep behind it, so it retries on its own — a
 * transient storage error must not settle the export as `failed` (the
 * processor only marks it on the last attempt, see `processReportExport`).
 */
export const JOB_OPTIONS: Partial<Record<string, Pick<JobsOptions, 'attempts' | 'backoff'>>> = {
  [JobName.REPORT_EXPORT]: { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
};

/**
 * Deterministic BullMQ job ids, one per (job type, resource). The DB insert
 * and the enqueue are two separate operations with no shared transaction
 * (OPS-01) — a request can commit the row and then die before the job is
 * queued. Because the id is a pure function of the resource id, the SAME
 * job id is computed independently by the original request, a client retry,
 * and the reconciliation sweep; BullMQ treats `add()` with an id that's
 * already in flight as a no-op, so all three can call `ensureJobEnqueued`
 * freely without ever double-processing or racing each other.
 *
 * No `:` separator: BullMQ's `Job.create` rejects a custom `jobId` that
 * contains `:` unless splitting on it yields exactly 3 parts (reserved for
 * its own repeatable-job id format) — `<job>:<uuid>` only splits into 2 and
 * throws `Custom Id cannot contain :`.
 */
export function buildValidateJobId(buildId: string): string {
  return `build-validate-${buildId}`;
}

export function mediaTranscodeJobId(recordingId: string): string {
  return `media-transcode-${recordingId}`;
}

export function mediaExtractAudioJobId(recordingId: string): string {
  return `media-extract-audio-${recordingId}`;
}

export function sessionValidateJobId(sessionId: string): string {
  return `session-validate-${sessionId}`;
}

/**
 * `session.validate` re-run once one of the session's recordings settles
 * (`ready`/`failed`). Its own id per recording: the run `finish` enqueued
 * under `sessionValidateJobId` may have completed without a verdict (waiting
 * for the recording), and BullMQ keeps a completed job's id taken.
 */
export function sessionValidateAfterRecordingJobId(sessionId: string, recordingId: string): string {
  return `session-validate-${sessionId}-after-${recordingId}`;
}

export function reportExportJobId(exportId: string): string {
  return `report-export-${exportId}`;
}
