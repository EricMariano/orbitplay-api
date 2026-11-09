import { eq } from 'drizzle-orm';
import {
  participations,
  sessionRecordings,
  sessions,
  sessionValidations,
  type SessionRow,
} from '../infra/database/schema/participations';
import { tests } from '../infra/database/schema/tests';
import { invalidateReportSnapshots } from '../infra/database/report-snapshot-cache';
import { invalidateDashboardKpis } from '../infra/redis/dashboard-kpi-cache';
import { RECORDING_UPLOAD_WINDOW_MS } from '../modules/media/dto/media.dto';
import {
  creditSessionXp,
  holdsSlot,
  releaseTestSlot,
} from '../modules/participations/session-outcome';
import { tutorialForModel } from '../modules/participations/tutorial.catalog';
import type { WorkerDeps } from './deps';

/** A session shorter than this is not a playtest (product decision, Tela 19). */
export const MIN_VALID_SESSION_MS = 60_000;

/**
 * Backstop for a recording stuck in `processing` (its transcode normally
 * settles it, or the reconcile sweep marks it `failed` once its job is
 * exhausted): past this long after the session ended the verdict stops
 * waiting for it, so no session stays unvalidated forever.
 */
export const RECORDING_PROCESSING_DEADLINE_MS = 24 * 60 * 60 * 1000;

/** Session statuses a verdict can be given on: finished (`processing`) or timed out. */
const CLOSED_SESSION_STATUSES: readonly SessionRow['status'][] = ['processing', 'invalidated'];

export const INVALID_REASONS = {
  timeout: 'Sessão encerrada por timeout de heartbeat',
  noDuration: 'Sessão sem duração registrada',
  tooShort: 'Sessão mais curta que o mínimo de 1 minuto',
  recordingFailed: 'Gravação da sessão falhou no processamento',
  recordingMissing: 'Gravação obrigatória ausente',
  recordingNotProcessed: 'Gravação obrigatória não processada a tempo',
} as const;

/** What a run did: wrote the verdict, found one already there, or had to wait. */
export type SessionValidateOutcome = 'validated' | 'already-validated' | 'deferred';

export type Verdict = { valid: boolean; reason: string | null } | 'deferred';

/**
 * Tela 19 RN-03: the insert into `session_validations` is the single
 * transactional gate for XP — its primary key is `session_id`, so a retry
 * (client reload, BullMQ redelivery) that reaches this processor twice for
 * the same session hits the same row and is a no-op the second time, never
 * double-crediting XP. `xp_events`' own composite UNIQUE
 * (`user_id, source_type, source_id`) is the second, independent guard.
 *
 * Validity (product decision): the session was finished by the player (not a
 * heartbeat timeout), lasted at least `MIN_VALID_SESSION_MS`, none of its
 * recordings failed, and — when the test model requires `screen_recording` —
 * a screen recording of it is `ready`. There is no content-quality/anti-fraud
 * heuristic here; that's still a deferred product decision.
 *
 * The verdict waits for media processing instead of being given at `finish`:
 * while a recording is still `processing`, or a required one hasn't arrived
 * within the upload window (`RECORDING_UPLOAD_WINDOW_MS` after `endedAt`),
 * nothing is written (`deferred`). It is re-run when a recording settles
 * (`processMediaTranscode`) and by the reconcile sweep, which is what turns
 * "no recording arrived in time" into a verdict.
 */
export async function processSessionValidate(
  deps: WorkerDeps,
  sessionId: string,
  now: Date = new Date(),
): Promise<SessionValidateOutcome> {
  const already = await deps.db
    .select({ sessionId: sessionValidations.sessionId })
    .from(sessionValidations)
    .where(eq(sessionValidations.sessionId, sessionId))
    .limit(1);
  if (already.length > 0) return 'already-validated';

  const rows = await deps.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const session = rows[0];
  if (!session) throw new Error(`session ${sessionId} not found`);
  // A recording can settle while its session is still being played: that run
  // must not judge an unfinished session.
  if (!CLOSED_SESSION_STATUSES.includes(session.status)) return 'deferred';

  const verdict = await decideSessionVerdict(deps, session, now);
  if (verdict === 'deferred') return 'deferred';
  const { valid, reason } = verdict;

  // One transaction from the validation row to the XP: a crash between them
  // used to leave the row in place, so the retry returned early above and the
  // statuses or the XP were never written. The insert is the gate — a run that
  // finds the row already there (a concurrent redelivery) changes nothing.
  const applied = await deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(sessionValidations)
      .values({ sessionId, valid, reason, validatorVersion: 'v1', validatedAt: new Date() })
      .onConflictDoNothing()
      .returning({ sessionId: sessionValidations.sessionId });
    if (inserted.length === 0) return false;

    await tx
      .update(sessions)
      .set({ status: valid ? 'completed' : 'invalidated' })
      .where(eq(sessions.id, sessionId));

    // Locked read of the status this run is replacing: whether a slot is
    // given back depends on the transition, not on the new status alone.
    const [before] = await tx
      .select({ status: participations.status })
      .from(participations)
      .where(eq(participations.id, session.participationId))
      .for('update');

    await tx
      .update(participations)
      .set({ status: valid ? 'completed' : 'rejected' })
      .where(eq(participations.id, session.participationId));

    // M8-03: `rejected` doesn't hold a slot — give back the one the join took
    // (once: the insert above is the gate; never below zero).
    if (valid) await creditSessionXp(tx, session);
    else if (before && holdsSlot(before.status)) await releaseTestSlot(tx, session.testId);
    return true;
  });
  if (!applied) return 'already-validated';

  // M11: the studio dashboard's session/completion KPIs just changed.
  await invalidateDashboardKpis(deps.redis, session.organizationId);
  // M10: valid/completed sessions of the report just changed.
  await invalidateReportSnapshots(deps.db, session.testId);

  // `tests.reward_amount_cents` (a real, persisted amount) is what a future
  // reward formula reads instead of a hardcoded XP constant — payment itself
  // is deferred (DECISIONS.md §1.2), so it isn't touched here yet.
  return 'validated';
}

/** The rule itself (no writes) — `deferred` when the verdict must wait for media. */
export async function decideSessionVerdict(
  deps: Pick<WorkerDeps, 'db'>,
  session: SessionRow,
  now: Date,
): Promise<Verdict> {
  if (session.status === 'invalidated') return invalid(INVALID_REASONS.timeout);
  if (!session.durationMs || session.durationMs <= 0) return invalid(INVALID_REASONS.noDuration);
  if (session.durationMs < MIN_VALID_SESSION_MS) return invalid(INVALID_REASONS.tooShort);

  const recordings = await deps.db
    .select({ kind: sessionRecordings.kind, status: sessionRecordings.status })
    .from(sessionRecordings)
    .where(eq(sessionRecordings.sessionId, session.id));
  if (recordings.some((r) => r.status === 'failed'))
    return invalid(INVALID_REASONS.recordingFailed);

  const sinceEndMs = now.getTime() - (session.endedAt ?? session.startedAt).getTime();
  // A recording still being processed may yet fail: wait for it.
  const processing = recordings.some((r) => r.status === 'processing');
  if (processing && sinceEndMs <= RECORDING_PROCESSING_DEADLINE_MS) return 'deferred';

  if (!(await requiresScreenRecording(deps, session.testId))) return { valid: true, reason: null };

  const screen = recordings.filter((r) => r.kind === 'screen');
  if (screen.some((r) => r.status === 'ready')) return { valid: true, reason: null };
  if (screen.some((r) => r.status === 'processing')) {
    return invalid(INVALID_REASONS.recordingNotProcessed);
  }
  if (sinceEndMs <= RECORDING_UPLOAD_WINDOW_MS) return 'deferred';
  return invalid(INVALID_REASONS.recordingMissing);
}

/** Tela 16: the test model's tutorial says whether screen recording is mandatory. */
async function requiresScreenRecording(
  deps: Pick<WorkerDeps, 'db'>,
  testId: string,
): Promise<boolean> {
  const rows = await deps.db
    .select({ modelKey: tests.modelKey })
    .from(tests)
    .where(eq(tests.id, testId))
    .limit(1);
  const modelKey = rows[0]?.modelKey;
  return (
    modelKey != null && tutorialForModel(modelKey).requiredConsents.includes('screen_recording')
  );
}

function invalid(reason: string): Verdict {
  return { valid: false, reason };
}
