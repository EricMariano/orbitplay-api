import { and, eq } from 'drizzle-orm';
import { newId } from '../infra/database/schema/_helpers';
import {
  participations,
  sessionRecordings,
  sessions,
  sessionValidations,
  type SessionRow,
} from '../infra/database/schema/participations';
import { xpEvents } from '../infra/database/schema/player';
import { invalidateReportSnapshots } from '../infra/database/report-snapshot-cache';
import { invalidateDashboardKpis } from '../infra/redis/dashboard-kpi-cache';
import type { WorkerDeps } from './deps';

/**
 * Placeholder XP reward for a validated session (Tela 19 RN-03) — pending the
 * real formula from product (duration/quality-based, per DECISIONS.md's
 * "placeholder pending final content handoff" pattern, same as
 * `TEST_MODEL_CATALOG`'s copy). A flat amount per valid session is honest
 * about being a stand-in without inventing a scoring model nobody asked for.
 */
const SESSION_COMPLETION_XP = 50;

/**
 * Tela 19 RN-03: the insert into `session_validations` is the single
 * transactional gate for XP — its primary key is `session_id`, so a retry
 * (client reload, BullMQ redelivery) that reaches this processor twice for
 * the same session hits the same row and is a no-op the second time, never
 * double-crediting XP. `xp_events`' own composite UNIQUE
 * (`user_id, source_type, source_id`) is the second, independent guard.
 *
 * Validity is intentionally simple and honest about what's actually
 * checked, mirroring `processBuildValidate`'s "fail closed, don't invent a
 * check that doesn't exist" stance: a session is valid when it was actually
 * finished by the player (has a `durationMs`) and wasn't invalidated by a
 * heartbeat timeout. There is no content-quality/anti-fraud heuristic here —
 * that's a deferred, real product decision, not something to fake.
 */
export async function processSessionValidate(deps: WorkerDeps, sessionId: string): Promise<void> {
  const already = await deps.db
    .select({ sessionId: sessionValidations.sessionId })
    .from(sessionValidations)
    .where(eq(sessionValidations.sessionId, sessionId))
    .limit(1);
  if (already.length > 0) return;

  const rows = await deps.db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const session = rows[0];
  if (!session) throw new Error(`session ${sessionId} not found`);

  let valid: boolean;
  let reason: string | null;

  if (session.status === 'invalidated') {
    valid = false;
    reason = 'Sessão encerrada por timeout de heartbeat';
  } else if (!session.durationMs || session.durationMs <= 0) {
    valid = false;
    reason = 'Sessão sem duração registrada';
  } else {
    const failedRecordings = await deps.db
      .select({ id: sessionRecordings.id })
      .from(sessionRecordings)
      .where(
        and(eq(sessionRecordings.sessionId, sessionId), eq(sessionRecordings.status, 'failed')),
      );
    if (failedRecordings.length > 0) {
      valid = false;
      reason = 'Gravação da sessão falhou no processamento';
    } else {
      valid = true;
      reason = null;
    }
  }

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

    await tx
      .update(participations)
      .set({ status: valid ? 'completed' : 'rejected' })
      .where(eq(participations.id, session.participationId));

    if (valid) await creditSessionXp(tx, session);
    return true;
  });
  if (!applied) return;

  // M11: the studio dashboard's session/completion KPIs just changed.
  await invalidateDashboardKpis(deps.redis, session.organizationId);
  // M10: valid/completed sessions of the report just changed.
  await invalidateReportSnapshots(deps.db, session.testId);

  // `tests.reward_amount_cents` (a real, persisted amount) is what a future
  // reward formula reads instead of a hardcoded XP constant — payment itself
  // is deferred (DECISIONS.md §1.2), so it isn't touched here yet.
}

type Tx = Parameters<Parameters<WorkerDeps['db']['transaction']>[0]>[0];

/** Session XP, at most once per player and test (the same test can't be farmed by rejoining). */
async function creditSessionXp(tx: Tx, session: SessionRow): Promise<void> {
  const testRows = await tx
    .select({ userId: participations.userId })
    .from(participations)
    .where(eq(participations.id, session.participationId))
    .limit(1);
  const userId = testRows[0]?.userId;
  if (!userId) return;

  const rewarded = await tx
    .select({ id: xpEvents.id })
    .from(xpEvents)
    .innerJoin(sessions, eq(sessions.id, xpEvents.sourceId))
    .where(
      and(
        eq(xpEvents.userId, userId),
        eq(xpEvents.sourceType, 'session'),
        eq(sessions.testId, session.testId),
      ),
    )
    .limit(1);
  if (rewarded.length > 0) return;

  await tx
    .insert(xpEvents)
    .values({
      id: newId(),
      userId,
      sourceType: 'session',
      sourceId: session.id,
      xp: SESSION_COMPLETION_XP,
    })
    .onConflictDoNothing();
}
