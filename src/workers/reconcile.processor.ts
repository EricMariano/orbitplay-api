import { and, eq, inArray, lt } from 'drizzle-orm';
import {
  buildValidateJobId,
  JobName,
  mediaExtractAudioJobId,
  mediaTranscodeJobId,
  sessionValidateJobId,
} from '../infra/queue/queue.constants';
import { ensureJobEnqueued } from '../infra/queue/ensure-enqueued';
import { builds } from '../infra/database/schema/tests';
import { sessionRecordings, sessions } from '../infra/database/schema/participations';
import { heartbeatKey } from '../modules/participations/heartbeat.store';
import { createdAtFromUuidV7 } from '../shared/util/uuid';
import type { WorkerDeps } from './deps';

/** Open-ended session statuses (mirrors `ParticipationsRepository`'s own list). */
const OPEN_SESSION_STATUSES = ['starting', 'recording', 'paused'] as const;

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

  await reconcileTimedOutSessions(deps);
}

/**
 * Design's RN: "sem heartbeat dentro da janela configurada, a sessão é
 * encerrada por timeout e entra na validação como incompleta." The heartbeat
 * itself lives in Redis (`heartbeat.store.ts`) with a TTL — its key simply
 * expiring IS the timeout signal, so this sweep only has to notice a key is
 * gone for a session still open in the DB, mark it `invalidated`, and let
 * `session.validate` do what it already does for any other invalid session
 * (no separate "incomplete" code path to maintain).
 */
async function reconcileTimedOutSessions(deps: WorkerDeps): Promise<void> {
  const open = await deps.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.status, OPEN_SESSION_STATUSES));

  for (const { id } of open) {
    const alive = await deps.redis.exists(heartbeatKey(id));
    if (alive) continue;

    await deps.db
      .update(sessions)
      .set({ status: 'invalidated', endedAt: new Date() })
      .where(and(eq(sessions.id, id), inArray(sessions.status, OPEN_SESSION_STATUSES)));

    await ensureJobEnqueued(deps.queue, JobName.SESSION_VALIDATE, sessionValidateJobId(id), {
      sessionId: id,
    });
  }
}
