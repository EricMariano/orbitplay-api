import { and, eq, lt } from 'drizzle-orm';
import {
  buildValidateJobId,
  JobName,
  mediaExtractAudioJobId,
  mediaTranscodeJobId,
} from '../infra/queue/queue.constants';
import { ensureJobEnqueued } from '../infra/queue/ensure-enqueued';
import { builds } from '../infra/database/schema/tests';
import { sessionRecordings } from '../infra/database/schema/participations';
import { createdAtFromUuidV7 } from '../shared/util/uuid';
import type { WorkerDeps } from './deps';

/**
 * A build/recording insert and its job enqueue are two separate operations
 * with no shared transaction (OPS-01) — the process can die in between,
 * leaving a row stuck in `processing` with no job ever queued for it. The
 * request-path retry/idempotent-return branches already re-attempt the
 * enqueue when the client comes back, but nothing catches the case where it
 * never does (or where the crash happens before a response goes out at
 * all). This sweep is that backstop: anything still `processing` past a
 * grace period — long enough that a build/recording still being actively
 * worked by a live job is never mistaken for abandoned — gets its job
 * re-ensured via the same deterministic id the request path uses, so a
 * genuinely in-flight job is left alone and only a truly missing/failed one
 * is (re)started.
 */
const STUCK_GRACE_MS = 15 * 60 * 1000;

export async function processReconcileStuckJobs(deps: WorkerDeps): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_GRACE_MS);

  const stuckBuilds = await deps.db
    .select({ id: builds.id })
    .from(builds)
    .where(and(eq(builds.status, 'processing'), lt(builds.createdAt, cutoff)));

  for (const { id } of stuckBuilds) {
    await ensureJobEnqueued(deps.queue, JobName.BUILD_VALIDATE, buildValidateJobId(id), {
      buildId: id,
    });
  }

  // No createdAt column on session_recordings — its id is a UUIDv7, so the
  // creation time is recovered from the id itself instead of a raw query.
  const stuckRecordings = await deps.db
    .select({ id: sessionRecordings.id })
    .from(sessionRecordings)
    .where(eq(sessionRecordings.status, 'processing'));

  for (const { id } of stuckRecordings) {
    if (createdAtFromUuidV7(id).getTime() > cutoff.getTime()) continue;
    await ensureJobEnqueued(deps.queue, JobName.MEDIA_TRANSCODE, mediaTranscodeJobId(id), {
      recordingId: id,
    });
    await ensureJobEnqueued(deps.queue, JobName.MEDIA_EXTRACT_AUDIO, mediaExtractAudioJobId(id), {
      recordingId: id,
    });
  }
}
