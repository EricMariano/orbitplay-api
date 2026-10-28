import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { newId } from '../../infra/database/schema/_helpers';
import {
  formAnswers,
  formResponses,
  participations,
  sessionConsents,
  sessionDeviceEvents,
  sessionRecordings,
  sessions,
  sessionValidations,
  type FormAnswerRow,
  type FormResponseRow,
  type NewSessionRow,
  type ParticipationRow,
  type SessionConsentRow,
  type SessionRecordingRow,
  type SessionRow,
  type SessionValidationRow,
} from '../../infra/database/schema/participations';
import {
  testAudienceCriteria,
  testFormOptions,
  testFormQuestions,
  tests,
  type TestFormOptionRow,
  type TestFormQuestionRow,
  type TestRow,
} from '../../infra/database/schema/tests';
import { xpEvents } from '../../infra/database/schema/player';
import { users } from '../../infra/database/schema/users';
import { AppException } from '../../shared/errors/app.exception';
import {
  buildPage,
  decodeCursor,
  type Page,
  type PaginationQuery,
} from '../../shared/pagination/pagination';
import { isUuid } from '../../shared/util/uuid';
import type { AnswerInput } from './dto/session.dto';
import type { ConsentKind } from './dto/consent.dto';
import type { ParticipationListQuery } from './dto/participation.dto';

export interface FormQuestionWithOptions extends TestFormQuestionRow {
  options: TestFormOptionRow[];
}

export interface ValidatedRewardRow {
  rewardCents: number | null;
  currency: string | null;
  validatedAt: Date | null;
}

/**
 * M8-03: test statuses a player sees in a game's test list. `paused` stays
 * visible (shown disabled, with a reason — Tela 14 RN-03) instead of vanishing;
 * `draft` is the studio's private wizard state and `finished`/`expired` are
 * over (a player who took part still reaches them via `/player/participations`).
 */
export const PLAYER_LISTED_TEST_STATUSES = ['published', 'paused'] as const;

/** Participation statuses that still hold a slot (mirrors `participations_active_test_user_unique`). */
export const ACTIVE_PARTICIPATION_STATUSES = [
  'reserved',
  'tutorial',
  'downloading',
  'ready',
  'playing',
  'form_pending',
  'in_review',
] as const;

const STARTABLE_PARTICIPATION_STATUSES = ['reserved', 'tutorial', 'downloading', 'ready'] as const;

/** Session statuses that count as "still running" for `currentSessionId`/the timeout sweep. */
const OPEN_SESSION_STATUSES = [
  'starting',
  'recording',
  'paused',
  'finishing',
  'processing',
] as const;

/**
 * Session statuses that haven't been finished by the player yet — narrower
 * than `OPEN_SESSION_STATUSES` on purpose: `processing` means finish already
 * ran once (queued for `session.validate`), so it must NOT count as
 * "still finishable" or a second `/finish` call would silently re-run.
 */
const UNFINISHED_SESSION_STATUSES = ['starting', 'recording', 'paused'] as const;

/**
 * Not org-scoped: a player joins tests across any studio's org, so this
 * repository talks to `tests`/`participations`/`sessions` directly instead of
 * extending `OrgScopedRepository` — same reasoning as `BuildsRepository`
 * (`hasActiveParticipation`) and `GamesRepository` (org-crossing game reads).
 */
@Injectable()
export class ParticipationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findTestById(testId: string): Promise<TestRow | null> {
    if (!isUuid(testId)) return null;
    const rows = await this.db.select().from(tests).where(eq(tests.id, testId)).limit(1);
    return rows[0] ?? null;
  }

  /** `null` when the test defined no age bracket (nothing to enforce). */
  async findAudienceAgeRange(
    testId: string,
  ): Promise<{ ageMin: number | null; ageMax: number | null } | null> {
    const rows = await this.db
      .select({ ageMin: testAudienceCriteria.ageMin, ageMax: testAudienceCriteria.ageMax })
      .from(testAudienceCriteria)
      .where(eq(testAudienceCriteria.testId, testId))
      .limit(1);
    return rows[0] ?? null;
  }

  async findUserBirthdate(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ birthdate: users.birthdate })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.birthdate ?? null;
  }

  /**
   * Reserves a slot and creates the participation row in one transaction:
   * the `slots_taken` CAS and the insert either both land or both roll back.
   * A concurrent duplicate-active-participation insert (23505 on the partial
   * unique index) rolls the slot increment back too — no compensating write
   * needed. Throws `AppException.conflict` when no slot is free.
   */
  async reserveParticipation(testId: string, userId: string): Promise<ParticipationRow> {
    return this.db.transaction(async (tx) => {
      const reserved = await tx
        .update(tests)
        .set({ slotsTaken: sql`${tests.slotsTaken} + 1` })
        .where(and(eq(tests.id, testId), sql`${tests.slotsTaken} < ${tests.slotsTotal}`))
        .returning({ id: tests.id });

      if (reserved.length === 0) {
        throw AppException.conflict('Vagas esgotadas');
      }

      const rows = await tx
        .insert(participations)
        .values({ id: newId(), testId, userId, status: 'reserved' })
        .returning();
      return rows[0];
    });
  }

  async findById(id: string): Promise<ParticipationRow | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select()
      .from(participations)
      .where(eq(participations.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Scoped to the caller — another player's participation reads as 404, never 403. */
  async getByIdForUserOrThrow(id: string, userId: string): Promise<ParticipationRow> {
    const row = await this.findById(id);
    if (!row || row.userId !== userId) throw AppException.notFound();
    return row;
  }

  /** The caller's own participations, newest first (UUIDv7 ⇒ chronological), optionally by status. */
  async listForUser(
    userId: string,
    query: ParticipationListQuery,
  ): Promise<Page<ParticipationRow>> {
    const cursorId = decodeCursor(query.cursor);
    const filters = [eq(participations.userId, userId)];
    if (cursorId) filters.push(lt(participations.id, cursorId));
    if (query.status) filters.push(eq(participations.status, query.status));

    const rows = await this.db
      .select()
      .from(participations)
      .where(and(...filters))
      .orderBy(desc(participations.id))
      .limit(query.limit + 1);
    return buildPage(rows, query.limit);
  }

  async findTestsByIds(testIds: string[]): Promise<Map<string, TestRow>> {
    if (testIds.length === 0) return new Map();
    const rows = await this.db.select().from(tests).where(inArray(tests.id, testIds));
    return new Map(rows.map((t) => [t.id, t]));
  }

  /** Rewards become real only when the player's session validation is positive. */
  async listValidatedRewardsForUser(userId: string): Promise<ValidatedRewardRow[]> {
    return this.db
      .select({
        rewardCents: tests.rewardAmountCents,
        currency: tests.rewardCurrency,
        validatedAt: sessionValidations.validatedAt,
      })
      .from(sessionValidations)
      .innerJoin(sessions, eq(sessions.id, sessionValidations.sessionId))
      .innerJoin(participations, eq(participations.id, sessions.participationId))
      .innerJoin(tests, eq(tests.id, sessions.testId))
      .where(and(eq(participations.userId, userId), eq(sessionValidations.valid, true)));
  }

  /** Batch `findConsent` for a page — keyed by participation id. */
  async findConsentsByParticipationIds(ids: string[]): Promise<Map<string, SessionConsentRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(sessionConsents)
      .where(inArray(sessionConsents.participationId, ids));
    return new Map(rows.map((c) => [c.participationId, c]));
  }

  /** Batch `findOpenSessionId`: most recent still-open session per participation. */
  async findOpenSessionIdsByParticipationIds(ids: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (ids.length === 0) return result;
    const rows = await this.db
      .select({ id: sessions.id, participationId: sessions.participationId })
      .from(sessions)
      .where(
        and(
          inArray(sessions.participationId, ids),
          inArray(sessions.status, OPEN_SESSION_STATUSES),
        ),
      )
      .orderBy(desc(sessions.startedAt));
    for (const row of rows) {
      if (!result.has(row.participationId)) result.set(row.participationId, row.id);
    }
    return result;
  }

  /** Batch first-start / last-end per participation, in one aggregate query. */
  async findSessionBoundsByParticipationIds(
    ids: string[],
  ): Promise<Map<string, { startedAt: Date | null; endedAt: Date | null }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({
        participationId: sessions.participationId,
        startedAt: sql<Date | null>`min(${sessions.startedAt})`.mapWith(sessions.startedAt),
        endedAt: sql<Date | null>`max(${sessions.endedAt})`.mapWith(sessions.endedAt),
      })
      .from(sessions)
      .where(inArray(sessions.participationId, ids))
      .groupBy(sessions.participationId);
    return new Map(
      rows.map((r) => [r.participationId, { startedAt: r.startedAt, endedAt: r.endedAt }]),
    );
  }

  async findConsent(participationId: string): Promise<SessionConsentRow | null> {
    const rows = await this.db
      .select()
      .from(sessionConsents)
      .where(eq(sessionConsents.participationId, participationId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Most recent still-open session for this participation, if any (empty until M7-04 exists). */
  async findOpenSessionId(participationId: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.participationId, participationId),
          inArray(sessions.status, OPEN_SESSION_STATUSES),
        ),
      )
      .orderBy(desc(sessions.startedAt))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /** First session ever started for this participation — `startedAt` on the API view. */
  async findFirstSessionStartedAt(participationId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ startedAt: sessions.startedAt })
      .from(sessions)
      .where(eq(sessions.participationId, participationId))
      .orderBy(sessions.startedAt)
      .limit(1);
    return rows[0]?.startedAt ?? null;
  }

  /** Last session to end — `completedAt` on the API view, only meaningful once status is `completed`. */
  async findLastSessionEndedAt(participationId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ endedAt: sessions.endedAt })
      .from(sessions)
      .where(and(eq(sessions.participationId, participationId), isNotNull(sessions.endedAt)))
      .orderBy(desc(sessions.endedAt))
      .limit(1);
    return rows[0]?.endedAt ?? null;
  }

  /** Append-only proof (RN-02, Tela 16/17) — re-consenting replaces the row, timestamp included. */
  async upsertConsent(
    participationId: string,
    consents: { kind: ConsentKind; granted: boolean }[],
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<SessionConsentRow> {
    const byKind = Object.fromEntries(consents.map((c) => [c.kind, c.granted]));
    const values = {
      participationId,
      screenRecording: byKind.screen_recording ?? false,
      audio: byKind.audio ?? false,
      microphone: byKind.microphone ?? false,
      webcam: byKind.webcam ?? false,
      acceptedAt: new Date(),
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
    const rows = await this.db
      .insert(sessionConsents)
      .values(values)
      .onConflictDoUpdate({ target: sessionConsents.participationId, set: values })
      .returning();
    return rows[0];
  }

  async findFormQuestions(testId: string): Promise<FormQuestionWithOptions[]> {
    const questions = await this.db
      .select()
      .from(testFormQuestions)
      .where(eq(testFormQuestions.testId, testId))
      .orderBy(testFormQuestions.position);
    const options = await this.db
      .select()
      .from(testFormOptions)
      .where(
        inArray(
          testFormOptions.questionId,
          questions.map((q) => q.id),
        ),
      );
    return questions.map((q) => ({
      ...q,
      options: options.filter((o) => o.questionId === q.id).sort((a, b) => a.position - b.position),
    }));
  }

  /**
   * Starts a session in one transaction: build-validated + consents-granted
   * were already checked by the caller, but the "no session already open for
   * this participation" race is closed here, under the same transaction that
   * inserts — a second concurrent start sees the first one's row and 409s
   * instead of creating a duplicate `sessions` row.
   */
  async startSession(
    participationId: string,
    testId: string,
    organizationId: string,
  ): Promise<SessionRow> {
    return this.db.transaction(async (tx) => {
      const open = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.participationId, participationId),
            inArray(sessions.status, OPEN_SESSION_STATUSES),
          ),
        )
        .limit(1);
      if (open.length > 0) {
        throw AppException.conflict('Já existe uma sessão ativa para esta participação');
      }

      const claimed = await tx
        .update(participations)
        .set({ status: 'playing' })
        .where(
          and(
            eq(participations.id, participationId),
            inArray(participations.status, STARTABLE_PARTICIPATION_STATUSES),
          ),
        )
        .returning({ id: participations.id });
      if (claimed.length === 0) {
        throw AppException.conflict('Esta participação já foi jogada');
      }

      const values: NewSessionRow = {
        id: newId(),
        participationId,
        testId,
        organizationId,
        status: 'starting',
        // Same clock as `endedAt` in `SessionsService.finish`, which caps the
        // duration at `endedAt - startedAt`: the column default (`now()`) is
        // the database's clock, and any skew ahead of the API would eat into
        // (or zero) a short session's duration and invalidate it.
        startedAt: new Date(),
      };
      const rows = await tx.insert(sessions).values(values).returning();

      return rows[0];
    });
  }

  async findSessionForUser(sessionId: string, userId: string): Promise<SessionRow | null> {
    if (!isUuid(sessionId)) return null;
    const rows = await this.db
      .select({ session: sessions })
      .from(sessions)
      .innerJoin(participations, eq(sessions.participationId, participations.id))
      .where(and(eq(sessions.id, sessionId), eq(participations.userId, userId)))
      .limit(1);
    return rows[0]?.session ?? null;
  }

  async getSessionForUserOrThrow(sessionId: string, userId: string): Promise<SessionRow> {
    const row = await this.findSessionForUser(sessionId, userId);
    if (!row) throw AppException.notFound();
    return row;
  }

  async insertDeviceEvent(
    sessionId: string,
    kind: string,
    tMs: number,
    value: boolean,
  ): Promise<void> {
    await this.db.insert(sessionDeviceEvents).values({ id: newId(), sessionId, tMs, kind, value });
  }

  async updateSession(sessionId: string, patch: Partial<NewSessionRow>): Promise<SessionRow> {
    const rows = await this.db
      .update(sessions)
      .set(patch)
      .where(eq(sessions.id, sessionId))
      .returning();
    if (!rows[0]) throw AppException.notFound();
    return rows[0];
  }

  /**
   * Finishes the session and hands the participation to `in_review` in one
   * transaction. The `WHERE status IN (open)` on the update is the actual
   * dedup guard (a CAS, not a UNIQUE column — `finish_idempotency_key` has no
   * unique index in this schema): a second finish call for an already-closed
   * session updates zero rows, and the caller 409s instead of re-finishing.
   * `Idempotency-Key` replay for an identical retry is handled generically by
   * the global `IdempotencyInterceptor`; this CAS is what stops a genuinely
   * second, different finish call after the first one already landed.
   */
  async finishSession(
    sessionId: string,
    participationId: string,
    patch: Partial<NewSessionRow>,
  ): Promise<SessionRow> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(sessions)
        .set(patch)
        .where(
          and(eq(sessions.id, sessionId), inArray(sessions.status, UNFINISHED_SESSION_STATUSES)),
        )
        .returning();
      if (!rows[0]) throw AppException.conflict('Sessão já encerrada');
      await tx
        .update(participations)
        .set({ status: 'in_review' })
        .where(eq(participations.id, participationId));
      return rows[0];
    });
  }

  async findPrimaryRecording(sessionId: string): Promise<SessionRecordingRow | null> {
    const rows = await this.db
      .select()
      .from(sessionRecordings)
      .where(eq(sessionRecordings.sessionId, sessionId))
      .orderBy(sessionRecordings.id)
      .limit(1);
    return rows[0] ?? null;
  }

  async findFormResponse(sessionId: string): Promise<FormResponseRow | null> {
    const rows = await this.db
      .select()
      .from(formResponses)
      .where(eq(formResponses.sessionId, sessionId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Inserts the response + its answers in one transaction. The UNIQUE on
   * `form_responses.session_id` is what makes a second submit without an
   * `Idempotency-Key` bounce with 409 instead of silently overwriting.
   */
  async insertFormResponse(
    sessionId: string,
    idempotencyKey: string | undefined,
    answers: AnswerInput[],
  ): Promise<FormResponseRow> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(formResponses)
        .values({ id: newId(), sessionId, idempotencyKey: idempotencyKey ?? null })
        .returning();
      const response = rows[0];

      if (answers.length > 0) {
        await tx.insert(formAnswers).values(
          answers.map((a) => ({
            id: newId(),
            responseId: response.id,
            questionId: a.questionId,
            valueText: typeof a.value === 'string' ? a.value : null,
            valueNumber: typeof a.value === 'number' ? String(a.value) : null,
            valueBoolean: typeof a.value === 'boolean' ? a.value : null,
            optionIds: Array.isArray(a.value) ? a.value : null,
          })),
        );
      }
      return response;
    });
  }

  async findFormAnswers(responseId: string): Promise<FormAnswerRow[]> {
    return this.db.select().from(formAnswers).where(eq(formAnswers.responseId, responseId));
  }

  async findSessionValidation(sessionId: string): Promise<SessionValidationRow | null> {
    const rows = await this.db
      .select()
      .from(sessionValidations)
      .where(eq(sessionValidations.sessionId, sessionId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** The session `GET /participations/:id/result` reports on — open one first, else the most recent. */
  async findOpenOrLastSessionId(participationId: string): Promise<string | null> {
    const open = await this.findOpenSessionId(participationId);
    if (open) return open;
    const rows = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.participationId, participationId))
      .orderBy(desc(sessions.startedAt))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async sumXpForSession(sessionId: string): Promise<number> {
    const rows = await this.db
      .select({ xp: xpEvents.xp })
      .from(xpEvents)
      .where(and(eq(xpEvents.sourceType, 'session'), eq(xpEvents.sourceId, sessionId)));
    return rows.reduce((sum, r) => sum + r.xp, 0);
  }

  /** M8-03 — cursor page of a game's tests as listed to players (newest first). */
  async listPlayerTestsForGame(gameId: string, query: PaginationQuery): Promise<Page<TestRow>> {
    if (!isUuid(gameId)) return { data: [], nextCursor: null };
    const cursorId = decodeCursor(query.cursor);
    const filters = [eq(tests.gameId, gameId), inArray(tests.status, PLAYER_LISTED_TEST_STATUSES)];
    if (cursorId) filters.push(lt(tests.id, cursorId));

    const rows = await this.db
      .select()
      .from(tests)
      .where(and(...filters))
      .orderBy(desc(tests.id))
      .limit(query.limit + 1);
    return buildPage(rows, query.limit);
  }

  /**
   * Tela 15 header: tests a player can join right now — mirrors the "open"
   * branch of `testUnavailableReason` (published, within the deadline, with a
   * free slot). Keep both in sync.
   */
  async findOpenTestStats(
    gameId: string,
    now: Date,
  ): Promise<{ openTests: number; maxRewardCents: number | null }> {
    const rows = await this.db
      .select({
        openTests: sql<number>`count(*)::int`,
        maxRewardCents: sql<number | null>`max(${tests.rewardAmountCents})`,
      })
      .from(tests)
      .where(
        and(
          eq(tests.gameId, gameId),
          eq(tests.status, 'published'),
          or(isNull(tests.endsAt), gt(tests.endsAt, now)),
          lt(tests.slotsTaken, tests.slotsTotal),
        ),
      );
    return {
      openTests: rows[0]?.openTests ?? 0,
      maxRewardCents: rows[0]?.maxRewardCents ?? null,
    };
  }

  /** Audience platforms (`test_audience_criteria.platforms`) per test; tests without criteria are absent. */
  async findAudiencePlatforms(testIds: string[]): Promise<Map<string, string[]>> {
    if (testIds.length === 0) return new Map();
    const rows = await this.db
      .select({ testId: testAudienceCriteria.testId, platforms: testAudienceCriteria.platforms })
      .from(testAudienceCriteria)
      .where(inArray(testAudienceCriteria.testId, testIds));
    return new Map(rows.map((row) => [row.testId, row.platforms ?? []]));
  }

  /**
   * The caller's most recent participation in each of these tests (newest id
   * wins — ids are UUIDv7). An `abandoned`/`rejected` one is still returned:
   * the service decides what it means for the CTA.
   */
  async findLatestParticipations(
    userId: string,
    testIds: string[],
  ): Promise<Map<string, ParticipationRow>> {
    if (testIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(participations)
      .where(and(eq(participations.userId, userId), inArray(participations.testId, testIds)))
      .orderBy(desc(participations.id));

    const latest = new Map<string, ParticipationRow>();
    for (const row of rows) if (!latest.has(row.testId)) latest.set(row.testId, row);
    return latest;
  }
}

export type { ParticipationRow, SessionRow };
