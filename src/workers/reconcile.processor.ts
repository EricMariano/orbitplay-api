import { and, asc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import {
  buildValidateJobId,
  JobName,
  mediaExtractAudioJobId,
  mediaTranscodeJobId,
  sessionValidateJobId,
} from '../infra/queue/queue.constants';
import { ensureJobEnqueued } from '../infra/queue/ensure-enqueued';
import { passwordResetTokens } from '../infra/database/schema/password-reset-tokens';
import { feedRankingSnapshots } from '../infra/database/schema/player';
import { refreshTokens } from '../infra/database/schema/refresh-tokens';
import { builds } from '../infra/database/schema/tests';
import {
  sessionRecordings,
  sessions,
  sessionValidations,
} from '../infra/database/schema/participations';
import { heartbeatKey } from '../modules/participations/heartbeat.store';
import { isUuid } from '../shared/util/uuid';
import type { WorkerDeps } from './deps';
import { processSessionValidate } from './session.processor';

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

/** Left on a build whose job kept failing until `ensureJobEnqueued` gave up on it. */
const EXHAUSTED_BUILD_REASON = 'Validação interrompida após falhas repetidas no processamento';

/**
 * One sweep is bounded: each scan reads keyset pages of `SWEEP_BATCH_SIZE`
 * rows (by id) and stops after `SWEEP_MAX_BATCHES`, leaving a cursor in Redis
 * so the next sweep resumes there instead of re-reading the same head — every
 * row is still visited, just over several sweeps when there are many.
 */
export const SWEEP_BATCH_SIZE = 500;
export const SWEEP_MAX_BATCHES = 20;
const SWEEP_CURSOR_TTL_SECONDS = 24 * 60 * 60;

/** Housekeeping deletes go in batches too, so one sweep never holds a huge delete. */
export const PURGE_BATCH_SIZE = 1000;
export const PURGE_MAX_BATCHES = 10;
/** A used reset token is kept this long (a second click explains itself), then purged. */
const USED_RESET_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;

export async function processReconcileStuckJobs(deps: WorkerDeps): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_GRACE_MS);

  await reconcileStuckBuilds(deps, cutoff);
  await reconcileStuckRecordings(deps, cutoff);
  await reconcileTimedOutSessions(deps);
  await reconcileUnvalidatedSessions(deps, cutoff);
  await purgeExpiredRows(deps);
}

async function reconcileStuckBuilds(deps: WorkerDeps, cutoff: Date): Promise<void> {
  await sweepInBatches(
    deps,
    'builds',
    (afterId, limit) =>
      deps.db
        .select({ id: builds.id })
        .from(builds)
        .where(
          and(
            eq(builds.status, 'processing'),
            lt(builds.createdAt, cutoff),
            afterId ? gt(builds.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(builds.id))
        .limit(limit),
    async (rows) => {
      for (const { id } of rows) {
        const outcome = await ensureJobEnqueued(
          deps.queue,
          JobName.BUILD_VALIDATE,
          buildValidateJobId(id),
          { buildId: id },
        );
        // Its job failed every retry: settle the build as failed instead of
        // leaving it `processing` (and re-checked by every sweep) forever.
        if (outcome === 'exhausted') {
          await deps.db
            .update(builds)
            .set({ status: 'failed', failureReason: EXHAUSTED_BUILD_REASON })
            .where(and(eq(builds.id, id), eq(builds.status, 'processing')));
        }
      }
    },
  );
}

async function reconcileStuckRecordings(deps: WorkerDeps, cutoff: Date): Promise<void> {
  // No createdAt column on session_recordings — its id is a UUIDv7 (time
  // ordered), so "created before the cutoff" is `id <` the smallest UUIDv7 of
  // that instant, filtered in SQL instead of loading every `processing` row.
  const createdBefore = uuidV7Floor(cutoff);
  await sweepInBatches(
    deps,
    'recordings',
    (afterId, limit) =>
      deps.db
        .select({ id: sessionRecordings.id })
        .from(sessionRecordings)
        .where(
          and(
            eq(sessionRecordings.status, 'processing'),
            lt(sessionRecordings.id, createdBefore),
            afterId ? gt(sessionRecordings.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(sessionRecordings.id))
        .limit(limit),
    async (rows) => {
      for (const { id } of rows) {
        const transcode = await ensureJobEnqueued(
          deps.queue,
          JobName.MEDIA_TRANSCODE,
          mediaTranscodeJobId(id),
          { recordingId: id },
        );
        if (transcode === 'exhausted') {
          // Settled as failed: the session waiting on it is validated by
          // `reconcileUnvalidatedSessions` below.
          await deps.db
            .update(sessionRecordings)
            .set({ status: 'failed' })
            .where(and(eq(sessionRecordings.id, id), eq(sessionRecordings.status, 'processing')));
          continue;
        }
        await ensureJobEnqueued(
          deps.queue,
          JobName.MEDIA_EXTRACT_AUDIO,
          mediaExtractAudioJobId(id),
          { recordingId: id },
        );
      }
    },
  );
}

/**
 * Closed sessions still without a validation. `finish` (and the timeout sweep
 * below) close a session and then enqueue `session.validate` — two steps with
 * no shared transaction: a lost enqueue or a failed job left the session
 * there for good, without result nor XP. And a validation that had to wait
 * for the session's recording (`processSessionValidate` defers while it is
 * uploading/processing) completes its job without a verdict, so its
 * deterministic job id can't be re-ensured — the sweep runs the validation
 * itself instead. It is idempotent (the `session_validations` insert is the
 * gate), and it is what eventually turns "no recording arrived" into a
 * verdict, so no session stays unvalidated forever.
 */
async function reconcileUnvalidatedSessions(deps: WorkerDeps, cutoff: Date): Promise<void> {
  await sweepInBatches(
    deps,
    'unvalidated-sessions',
    (afterId, limit) =>
      deps.db
        .select({ id: sessions.id })
        .from(sessions)
        .leftJoin(sessionValidations, eq(sessionValidations.sessionId, sessions.id))
        .where(
          and(
            inArray(sessions.status, ['processing', 'invalidated']),
            lt(sessions.endedAt, cutoff),
            isNull(sessionValidations.sessionId),
            afterId ? gt(sessions.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(sessions.id))
        .limit(limit),
    async (rows) => {
      for (const { id } of rows) {
        try {
          await processSessionValidate(deps, id);
        } catch (err) {
          console.error(`[reconcile] session.validate failed for ${id}: ${String(err)}`);
        }
      }
    },
  );
}

/**
 * Design's RN: "sem heartbeat dentro da janela configurada, a sessão é
 * encerrada por timeout e entra na validação como incompleta." The heartbeat
 * itself lives in Redis (`heartbeat.store.ts`) with a TTL — its key simply
 * expiring IS the timeout signal, so this sweep only has to notice a key is
 * gone for a session still open in the DB, mark it `invalidated`, and let
 * `session.validate` do what it already does for any other invalid session
 * (no separate "incomplete" code path to maintain). One pipelined EXISTS per
 * page instead of one round trip per session.
 */
async function reconcileTimedOutSessions(deps: WorkerDeps): Promise<void> {
  await sweepInBatches(
    deps,
    'open-sessions',
    (afterId, limit) =>
      deps.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            inArray(sessions.status, OPEN_SESSION_STATUSES),
            afterId ? gt(sessions.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(sessions.id))
        .limit(limit),
    async (rows) => {
      const pipeline = deps.redis.pipeline();
      for (const { id } of rows) pipeline.exists(heartbeatKey(id));
      const replies = (await pipeline.exec()) ?? [];

      for (const [i, { id }] of rows.entries()) {
        const [err, alive] = replies[i] ?? [new Error('no reply'), 0];
        // Unknown is not "timed out": never close a session on a Redis error.
        if (err || Number(alive) > 0) continue;

        await deps.db
          .update(sessions)
          .set({ status: 'invalidated', endedAt: new Date() })
          .where(and(eq(sessions.id, id), inArray(sessions.status, OPEN_SESSION_STATUSES)));

        await ensureJobEnqueued(deps.queue, JobName.SESSION_VALIDATE, sessionValidateJobId(id), {
          sessionId: id,
        });
      }
    },
  );
}

/**
 * Tables that only grow otherwise. `refresh_tokens`: only past expiry — a
 * revoked token that hasn't expired yet is what reuse detection matches a
 * replayed token against. `password_reset_tokens`: expired, or used more than
 * a day ago. `feed_ranking_snapshots`: past `expires_at`. A failing purge is
 * logged and never fails the sweep around it.
 */
async function purgeExpiredRows(deps: WorkerDeps): Promise<void> {
  const now = new Date();
  const usedBefore = new Date(now.getTime() - USED_RESET_TOKEN_RETENTION_MS);

  const purges: [string, (limit: number) => Promise<number>][] = [
    [
      'refresh_tokens',
      async (limit) =>
        (
          await deps.db
            .delete(refreshTokens)
            .where(
              inArray(
                refreshTokens.id,
                deps.db
                  .select({ id: refreshTokens.id })
                  .from(refreshTokens)
                  .where(lt(refreshTokens.expiresAt, now))
                  .limit(limit),
              ),
            )
            .returning({ id: refreshTokens.id })
        ).length,
    ],
    [
      'password_reset_tokens',
      async (limit) =>
        (
          await deps.db
            .delete(passwordResetTokens)
            .where(
              inArray(
                passwordResetTokens.id,
                deps.db
                  .select({ id: passwordResetTokens.id })
                  .from(passwordResetTokens)
                  .where(
                    or(
                      lt(passwordResetTokens.expiresAt, now),
                      lt(passwordResetTokens.usedAt, usedBefore),
                    ),
                  )
                  .limit(limit),
              ),
            )
            .returning({ id: passwordResetTokens.id })
        ).length,
    ],
    [
      'feed_ranking_snapshots',
      async (limit) =>
        (
          await deps.db
            .delete(feedRankingSnapshots)
            .where(
              inArray(
                feedRankingSnapshots.seed,
                deps.db
                  .select({ seed: feedRankingSnapshots.seed })
                  .from(feedRankingSnapshots)
                  .where(lt(feedRankingSnapshots.expiresAt, now))
                  .limit(limit),
              ),
            )
            .returning({ seed: feedRankingSnapshots.seed })
        ).length,
    ],
  ];

  for (const [table, deleteBatch] of purges) {
    try {
      await purgeInBatches(deleteBatch);
    } catch (err) {
      console.error(`[reconcile] purge of ${table} failed: ${String(err)}`);
    }
  }
}

/** Runs `deleteBatch` until a batch comes back short, at most `PURGE_MAX_BATCHES` times. */
export async function purgeInBatches(
  deleteBatch: (limit: number) => Promise<number>,
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
    const deleted = await deleteBatch(PURGE_BATCH_SIZE);
    total += deleted;
    if (deleted < PURGE_BATCH_SIZE) break;
  }
  return total;
}

/**
 * Keyset scan bounded per sweep (see `SWEEP_BATCH_SIZE`). `fetchBatch` must
 * return rows ordered by id, after `afterId` when given. A scan that reaches
 * the end clears its cursor (the next sweep starts over); one that runs out of
 * batches saves where it stopped.
 */
export async function sweepInBatches<T extends { id: string }>(
  deps: Pick<WorkerDeps, 'redis'>,
  scan: string,
  fetchBatch: (afterId: string | null, limit: number) => Promise<T[]>,
  handleBatch: (rows: T[]) => Promise<void>,
): Promise<void> {
  const cursorKey = `reconcile:cursor:${scan}`;
  const saved = await deps.redis.get(cursorKey);
  let afterId = saved && isUuid(saved) ? saved : null;

  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch += 1) {
    const rows = await fetchBatch(afterId, SWEEP_BATCH_SIZE);
    if (rows.length > 0) await handleBatch(rows);
    if (rows.length < SWEEP_BATCH_SIZE) {
      if (saved) await deps.redis.del(cursorKey);
      return;
    }
    afterId = rows[rows.length - 1].id;
  }
  if (afterId) await deps.redis.set(cursorKey, afterId, 'EX', SWEEP_CURSOR_TTL_SECONDS);
}

/**
 * The smallest UUIDv7 carrying this timestamp (rand bits zero, variant `10`):
 * for time-ordered v7 ids, `id < uuidV7Floor(t)` ⇔ created before `t`.
 */
export function uuidV7Floor(at: Date): string {
  const hex = Math.max(0, Math.floor(at.getTime())).toString(16).padStart(12, '0').slice(-12);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}
