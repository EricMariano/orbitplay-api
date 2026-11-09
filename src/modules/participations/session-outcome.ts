import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../infra/database/database.module';
import { newId } from '../../infra/database/schema/_helpers';
import { participations, sessions } from '../../infra/database/schema/participations';
import { xpEvents } from '../../infra/database/schema/player';
import { tests } from '../../infra/database/schema/tests';
import { ACTIVE_PARTICIPATION_STATUSES } from './participations.repository';

/**
 * Transactional pieces of a session's outcome (slot, XP) shared by the two
 * writers of a verdict: the `session.validate` worker and the studio's
 * "marcar inválida" (`ReportsRepository.rateSession`). Plain functions over a
 * transaction — not a repository — so both can run them inside their own.
 */

/**
 * Placeholder XP reward for a validated session (Tela 19 RN-03) — pending the
 * real formula from product (duration/quality-based, per DECISIONS.md's
 * "placeholder pending final content handoff" pattern, same as
 * `TEST_MODEL_CATALOG`'s copy). A flat amount per valid session is honest
 * about being a stand-in without inventing a scoring model nobody asked for.
 */
export const SESSION_COMPLETION_XP = 50;

/**
 * Participation statuses that occupy one of the test's `slots_taken` (M8-03):
 * every active one plus `completed`. Only `abandoned`/`rejected` don't.
 */
export const SLOT_HOLDING_PARTICIPATION_STATUSES = [
  ...ACTIVE_PARTICIPATION_STATUSES,
  'completed',
] as const;

export function holdsSlot(status: string): boolean {
  return (SLOT_HOLDING_PARTICIPATION_STATUSES as readonly string[]).includes(status);
}

/** Gives one slot back — never below zero. Call it only on an actual slot-holding → not-holding transition. */
export async function releaseTestSlot(tx: DbExecutor, testId: string): Promise<void> {
  await tx
    .update(tests)
    .set({ slotsTaken: sql`greatest(${tests.slotsTaken} - 1, 0)` })
    .where(and(eq(tests.id, testId), gt(tests.slotsTaken, 0)));
}

/** Takes one slot back if one is free (same CAS as joining); `false` when the test is full. */
export async function reclaimTestSlot(tx: DbExecutor, testId: string): Promise<boolean> {
  const rows = await tx
    .update(tests)
    .set({ slotsTaken: sql`${tests.slotsTaken} + 1` })
    .where(and(eq(tests.id, testId), sql`${tests.slotsTaken} < ${tests.slotsTotal}`))
    .returning({ id: tests.id });
  return rows.length > 0;
}

/** Whether this player holds another slot-holding participation in the test. */
export async function hasOtherSlotHoldingParticipation(
  tx: DbExecutor,
  participation: { id: string; testId: string; userId: string },
): Promise<boolean> {
  const rows = await tx
    .select({ id: participations.id })
    .from(participations)
    .where(
      and(
        eq(participations.testId, participation.testId),
        eq(participations.userId, participation.userId),
        ne(participations.id, participation.id),
        inArray(participations.status, SLOT_HOLDING_PARTICIPATION_STATUSES),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Session XP, at most once per player and test (the same test can't be farmed
 * by rejoining): skipped when any session of this test already paid this
 * player. `xp_events`' own UNIQUE (`user_id, source_type, source_id`) is the
 * second guard.
 */
export async function creditSessionXp(
  tx: DbExecutor,
  session: { id: string; participationId: string; testId: string },
): Promise<void> {
  const owner = await tx
    .select({ userId: participations.userId })
    .from(participations)
    .where(eq(participations.id, session.participationId))
    .limit(1);
  const userId = owner[0]?.userId;
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

/** Removes the XP a session credited (a no-op when it credited none). */
export async function revokeSessionXp(tx: DbExecutor, sessionId: string): Promise<void> {
  await tx
    .delete(xpEvents)
    .where(and(eq(xpEvents.sourceType, 'session'), eq(xpEvents.sourceId, sessionId)));
}
