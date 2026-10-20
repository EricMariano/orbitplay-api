import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import {
  testReportExports,
  testReportSnapshots,
  type NewTestReportExportRow,
  type TestReportExportRow,
  type TestReportSnapshotRow,
} from '../../infra/database/schema/community';
import {
  formAnswers,
  formResponses,
  participations,
  sessionRatings,
  sessionRecordings,
  sessions,
  sessionValidations,
  type SessionRatingRow,
  type SessionRecordingRow,
} from '../../infra/database/schema/participations';
import { playerPreferences } from '../../infra/database/schema/player';
import {
  pluginManifests,
  sessionTokens,
  triggerDefinitions,
} from '../../infra/database/schema/plugin';
import {
  builds,
  testFormOptions,
  testFormQuestions,
  tests,
} from '../../infra/database/schema/tests';
import { users } from '../../infra/database/schema/users';
import { AppException } from '../../shared/errors/app.exception';
import { buildPage, decodeCursor, type Page } from '../../shared/pagination/pagination';
import { isUuid } from '../../shared/util/uuid';
import {
  playerArchetypeValues,
  playerProfileTierValues,
  type EvaluationQuestionSummary,
  type EvaluationsPayload,
  type EvolutionPayload,
  type OverviewPayload,
  type RatingDistributionPayload,
  type ReportBlockKey,
  type ReportSessionQuery,
  type TesterProfilePayload,
} from './dto/report.dto';
import { groupEvolutionByWeek } from './report-weeks';

/** `session_validations.reason` written when the studio marks a session invalid. */
export const STUDIO_INVALID_REASON = 'Marcada como inválida pelo estúdio';

/** Question types whose numeric answer counts as a "nota" (rating). */
const RATING_QUESTION_TYPES = ['scale', 'nps'] as const;

/** Open-text answers shown per question in the `evaluations` block. */
const EVALUATION_SAMPLE_SIZE = 3;

type PlayerArchetype = (typeof playerArchetypeValues)[number];
type PlayerProfileTier = (typeof playerProfileTierValues)[number];

export interface ReportSessionRow {
  id: string;
  sessionId: string;
  participationId: string;
  testerId: string;
  testerName: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  valid: boolean | null;
  averageRating: number | null;
  archetype: PlayerArchetype | null;
  playerTier: PlayerProfileTier | null;
  telemetryConnected: boolean;
}

/** What the `telemetry` block needs from the test's build (null = no plug-in). */
export interface PluginSummaryRow {
  activeTriggers: number;
}

export interface EvaluationAnswerRow {
  questionId: string;
  prompt: string;
  type: string;
  position: number;
  valueText: string | null;
  valueNumber: number | null;
  valueBoolean: boolean | null;
  optionIds: string[] | null;
}

export interface SessionEvaluationRow {
  session: ReportSessionRow;
  submittedAt: Date | null;
  answers: EvaluationAnswerRow[];
  optionLabels: Map<string, string>;
}

/**
 * Persistence for M10. Every read is scoped through `tests.organization_id`
 * (cross-org access reads as "not found", same as the rest of the studio API).
 * Aggregates run in SQL — no session/answer rows are pulled into memory to be
 * summed in JS.
 */
@Injectable()
export class ReportsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Test ids are only ever handed out for the caller's own org. */
  async testExistsInOrg(organizationId: string, testId: string): Promise<boolean> {
    if (!isUuid(testId)) return false;
    const rows = await this.db
      .select({ id: tests.id })
      .from(tests)
      .where(and(eq(tests.id, testId), eq(tests.organizationId, organizationId)))
      .limit(1);
    return rows.length > 0;
  }

  /* ------------------------------ Block reads ------------------------------ */

  async findSnapshots(testId: string): Promise<TestReportSnapshotRow[]> {
    return this.db.select().from(testReportSnapshots).where(eq(testReportSnapshots.testId, testId));
  }

  /**
   * One row per (test, block): the UNIQUE index is what makes recomputing a
   * block an overwrite instead of a duplicate.
   */
  async upsertSnapshot(
    testId: string,
    blockKey: ReportBlockKey,
    result: { status: 'ready'; payload: object } | { status: 'failed' },
  ): Promise<void> {
    const values = {
      testId,
      blockKey,
      status: result.status,
      payload: result.status === 'ready' ? result.payload : null,
      computedAt: new Date(),
    };
    await this.db
      .insert(testReportSnapshots)
      .values(values)
      .onConflictDoUpdate({
        target: [testReportSnapshots.testId, testReportSnapshots.blockKey],
        set: { status: values.status, payload: values.payload, computedAt: values.computedAt },
      });
  }

  /* ------------------------------ Aggregations ----------------------------- */

  async computeOverview(testId: string): Promise<OverviewPayload> {
    const [counts] = await this.db
      .select({
        totalParticipations: sql<number>`count(distinct ${participations.id})::int`,
        testersCount: sql<number>`count(distinct ${participations.userId})::int`,
        completedSessions: sql<number>`count(distinct ${sessions.id}) filter (where ${sessions.status} = 'completed')::int`,
        validSessions: sql<number>`count(distinct ${sessions.id}) filter (where ${sessionValidations.valid} = true)::int`,
        averageDurationMs: sql<
          number | null
        >`avg(${sessions.durationMs}) filter (where ${sessions.status} = 'completed')::float8`,
      })
      .from(participations)
      .leftJoin(sessions, eq(sessions.participationId, participations.id))
      .leftJoin(sessionValidations, eq(sessionValidations.sessionId, sessions.id))
      .where(eq(participations.testId, testId));

    const averageRating = await this.averageRating(testId);
    const total = counts?.totalParticipations ?? 0;
    const completed = counts?.completedSessions ?? 0;

    return {
      totalParticipations: total,
      completedSessions: completed,
      validSessions: counts?.validSessions ?? 0,
      completionRate: total > 0 ? completed / total : null,
      averageDurationMs: counts?.averageDurationMs ?? null,
      averageRating,
      testersCount: counts?.testersCount ?? 0,
      // Derived from AI insights — deferred (BACKEND-SPEC §10).
      aiScore: null,
      funFactor: null,
      bugsCount: null,
    };
  }

  async computeEvolution(testId: string): Promise<EvolutionPayload> {
    const day = sql<string>`to_char(date_trunc('day', ${sessions.startedAt}), 'YYYY-MM-DD')`;
    const rows = await this.db
      .select({ date: day, sessions: sql<number>`count(*)::int` })
      .from(sessions)
      .where(eq(sessions.testId, testId))
      .groupBy(day)
      .orderBy(day);

    const [test] = await this.db
      .select({
        startDate: sql<
          string | null
        >`to_char(coalesce(${tests.startsAt}, ${tests.publishedAt}), 'YYYY-MM-DD')`,
      })
      .from(tests)
      .where(eq(tests.id, testId))
      .limit(1);
    return { points: rows, weeks: groupEvolutionByWeek(rows, test?.startDate ?? null) };
  }

  async computeRatingDistribution(testId: string): Promise<RatingDistributionPayload> {
    const bucket = sql<number>`round(${formAnswers.valueNumber})::int`;
    const rows = await this.db
      .select({ rating: bucket, count: sql<number>`count(*)::int` })
      .from(formAnswers)
      .innerJoin(formResponses, eq(formResponses.id, formAnswers.responseId))
      .innerJoin(sessions, eq(sessions.id, formResponses.sessionId))
      .innerJoin(testFormQuestions, eq(testFormQuestions.id, formAnswers.questionId))
      .where(
        and(
          eq(sessions.testId, testId),
          inArray(testFormQuestions.type, RATING_QUESTION_TYPES),
          sql`${formAnswers.valueNumber} is not null`,
        ),
      )
      .groupBy(bucket)
      .orderBy(bucket);
    return { buckets: rows };
  }

  /**
   * Age brackets from `users.birthdate`; archetype and player tier from the
   * player's profile (`player_preferences`) — a player who hasn't filled it in
   * counts as `unknown`. Every known key is returned (zeros included) in a
   * fixed order, so the chart legend doesn't reshuffle between tests.
   */
  async computeTesterProfile(testId: string): Promise<TesterProfilePayload> {
    const age = sql`date_part('year', age(${users.birthdate}))`;
    const bracket = sql<string>`case
      when ${users.birthdate} is null then 'unknown'
      when ${age} < 25 then '18-24'
      when ${age} < 35 then '25-34'
      when ${age} < 45 then '35-44'
      else '45+'
    end`;
    const rows = await this.db
      .select({ bracket, count: sql<number>`count(distinct ${users.id})::int` })
      .from(participations)
      .innerJoin(users, eq(users.id, participations.userId))
      .where(eq(participations.testId, testId))
      .groupBy(bracket)
      .orderBy(bracket);

    const archetype = sql<string>`coalesce(${playerPreferences.archetype}::text, 'unknown')`;
    const tier = sql<string>`coalesce(${playerPreferences.playerTier}::text, 'unknown')`;
    const profileRows = await this.db
      .select({
        archetype,
        tier,
        count: sql<number>`count(distinct ${participations.userId})::int`,
      })
      .from(participations)
      .leftJoin(playerPreferences, eq(playerPreferences.userId, participations.userId))
      .where(eq(participations.testId, testId))
      .groupBy(archetype, tier);

    const tally = <K extends string>(
      keys: readonly K[],
      pick: (r: (typeof profileRows)[number]) => string,
    ) =>
      [...keys, 'unknown' as const].map((key) => ({
        key,
        count: profileRows.filter((r) => pick(r) === key).reduce((sum, r) => sum + r.count, 0),
      }));

    return {
      ageBrackets: rows,
      archetypes: tally(playerArchetypeValues, (r) => r.archetype),
      playerTiers: tally(playerProfileTierValues, (r) => r.tier),
    };
  }

  /**
   * Form summary for the "Avaliações" card: global numbers plus one summary
   * per question (distribution for scale/NPS, counts per option for choices,
   * latest answers for open text). Every aggregate runs in SQL, grouped by
   * question — answers are never pulled in bulk.
   */
  async computeEvaluations(testId: string): Promise<EvaluationsPayload> {
    const questions = await this.db
      .select({
        id: testFormQuestions.id,
        position: testFormQuestions.position,
        label: testFormQuestions.label,
        type: testFormQuestions.type,
        scaleMin: testFormQuestions.scaleMin,
        scaleMax: testFormQuestions.scaleMax,
      })
      .from(testFormQuestions)
      .where(eq(testFormQuestions.testId, testId))
      .orderBy(testFormQuestions.position);

    const [responses] = await this.db
      .select({
        responsesCount: sql<number>`count(*)::int`,
        averageResponseTimeMs: sql<
          number | null
        >`(avg(extract(epoch from (${formResponses.submittedAt} - ${sessions.endedAt})) * 1000) filter (where ${sessions.endedAt} is not null and ${formResponses.submittedAt} >= ${sessions.endedAt}))::float8`,
      })
      .from(formResponses)
      .innerJoin(sessions, eq(sessions.id, formResponses.sessionId))
      .where(eq(sessions.testId, testId));

    const [ended] = await this.db
      .select({
        ended: sql<number>`count(*)::int`,
        withoutForm: sql<number>`count(*) filter (where ${formResponses.id} is null)::int`,
      })
      .from(sessions)
      .leftJoin(formResponses, eq(formResponses.sessionId, sessions.id))
      .where(and(eq(sessions.testId, testId), isNotNull(sessions.endedAt)));

    const answerScope = and(eq(sessions.testId, testId), eq(testFormQuestions.testId, testId));
    const answersBase = () =>
      this.db
        .select({
          questionId: formAnswers.questionId,
          count: count(),
          average: sql<number | null>`avg(${formAnswers.valueNumber})::float8`,
        })
        .from(formAnswers)
        .innerJoin(formResponses, eq(formResponses.id, formAnswers.responseId))
        .innerJoin(sessions, eq(sessions.id, formResponses.sessionId))
        .innerJoin(testFormQuestions, eq(testFormQuestions.id, formAnswers.questionId));

    const totals = await answersBase().where(answerScope).groupBy(formAnswers.questionId);

    const value = sql<number>`round(${formAnswers.valueNumber})::int`;
    const distribution = await this.db
      .select({ questionId: formAnswers.questionId, value, count: count() })
      .from(formAnswers)
      .innerJoin(formResponses, eq(formResponses.id, formAnswers.responseId))
      .innerJoin(sessions, eq(sessions.id, formResponses.sessionId))
      .innerJoin(testFormQuestions, eq(testFormQuestions.id, formAnswers.questionId))
      .where(
        and(
          answerScope,
          inArray(testFormQuestions.type, RATING_QUESTION_TYPES),
          isNotNull(formAnswers.valueNumber),
        ),
      )
      .groupBy(formAnswers.questionId, value);

    const optionId = sql<string>`unnest(${formAnswers.optionIds})`;
    const chosen = this.db
      .select({ questionId: formAnswers.questionId, optionId: optionId.as('option_id') })
      .from(formAnswers)
      .innerJoin(formResponses, eq(formResponses.id, formAnswers.responseId))
      .innerJoin(sessions, eq(sessions.id, formResponses.sessionId))
      .innerJoin(testFormQuestions, eq(testFormQuestions.id, formAnswers.questionId))
      .where(answerScope)
      .as('chosen');
    const optionCounts = await this.db
      .select({
        questionId: testFormOptions.questionId,
        label: testFormOptions.label,
        position: testFormOptions.position,
        count: sql<number>`count(${chosen.optionId})::int`,
      })
      .from(testFormOptions)
      .innerJoin(testFormQuestions, eq(testFormQuestions.id, testFormOptions.questionId))
      .leftJoin(chosen, sql`${chosen.optionId} = ${testFormOptions.id}`)
      .where(eq(testFormQuestions.testId, testId))
      .groupBy(testFormOptions.questionId, testFormOptions.label, testFormOptions.position)
      .orderBy(testFormOptions.questionId, testFormOptions.position);

    const ranked = this.db
      .select({
        questionId: formAnswers.questionId,
        valueText: formAnswers.valueText,
        rank: sql<number>`row_number() over (partition by ${formAnswers.questionId} order by ${formResponses.submittedAt} desc, ${formAnswers.id} desc)`.as(
          'rank',
        ),
      })
      .from(formAnswers)
      .innerJoin(formResponses, eq(formResponses.id, formAnswers.responseId))
      .innerJoin(sessions, eq(sessions.id, formResponses.sessionId))
      .innerJoin(testFormQuestions, eq(testFormQuestions.id, formAnswers.questionId))
      .where(
        and(
          answerScope,
          eq(testFormQuestions.type, 'open_text'),
          sql`nullif(trim(${formAnswers.valueText}), '') is not null`,
        ),
      )
      .as('ranked');
    const samples = await this.db
      .select({ questionId: ranked.questionId, valueText: ranked.valueText })
      .from(ranked)
      .where(sql`${ranked.rank} <= ${EVALUATION_SAMPLE_SIZE}`)
      .orderBy(ranked.questionId, ranked.rank);

    const summaries: EvaluationQuestionSummary[] = questions.map((q) => {
      const total = totals.find((t) => t.questionId === q.id);
      const isRating = (RATING_QUESTION_TYPES as readonly string[]).includes(q.type);
      const values = distribution.filter((d) => d.questionId === q.id);
      const min = q.scaleMin ?? Math.min(...values.map((d) => d.value));
      const max = q.scaleMax ?? Math.max(...values.map((d) => d.value));
      return {
        questionId: q.id,
        position: q.position,
        label: q.label,
        type: q.type,
        responsesCount: total?.count ?? 0,
        average: isRating ? (total?.average ?? null) : null,
        distribution:
          isRating && Number.isFinite(min) && Number.isFinite(max)
            ? Array.from({ length: max - min + 1 }, (_, i) => min + i).map((v) => ({
                value: v,
                count: values.find((d) => d.value === v)?.count ?? 0,
              }))
            : [],
        options: optionCounts
          .filter((o) => o.questionId === q.id)
          .map((o) => ({ label: o.label, count: o.count })),
        samples: samples
          .filter((s) => s.questionId === q.id)
          .map((s) => s.valueText)
          .filter((t): t is string => t !== null),
      };
    });

    const endedCount = ended?.ended ?? 0;
    return {
      questionsCount: questions.length,
      responsesCount: responses?.responsesCount ?? 0,
      averageResponseTimeMs: responses?.averageResponseTimeMs ?? null,
      dropoutRate: endedCount > 0 ? (ended?.withoutForm ?? 0) / endedCount : null,
      questions: summaries,
    };
  }

  /**
   * Plug-in data of the test's build: `null` when the build has no plug-in
   * manifest (telemetry block is then `unavailable`).
   */
  async findPluginSummary(testId: string): Promise<PluginSummaryRow | null> {
    const manifests = await this.db
      .select({ id: pluginManifests.id })
      .from(pluginManifests)
      .innerJoin(builds, eq(builds.id, pluginManifests.buildId))
      .where(eq(builds.testId, testId));
    if (manifests.length === 0) return null;

    const [triggers] = await this.db
      .select({ count: count() })
      .from(triggerDefinitions)
      .where(
        inArray(
          triggerDefinitions.manifestId,
          manifests.map((m) => m.id),
        ),
      );
    return { activeTriggers: triggers?.count ?? 0 };
  }

  private async averageRating(testId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ avg: sql<number | null>`avg(${formAnswers.valueNumber})::float8` })
      .from(formAnswers)
      .innerJoin(formResponses, eq(formResponses.id, formAnswers.responseId))
      .innerJoin(sessions, eq(sessions.id, formResponses.sessionId))
      .innerJoin(testFormQuestions, eq(testFormQuestions.id, formAnswers.questionId))
      .where(
        and(
          eq(sessions.testId, testId),
          inArray(testFormQuestions.type, RATING_QUESTION_TYPES),
          sql`${formAnswers.valueNumber} is not null`,
        ),
      );
    return row?.avg ?? null;
  }

  /* ------------------------------- Sessions -------------------------------- */

  /**
   * Shape shared by the list and the detail: one JOIN across
   * `sessions` → `participations` → `users` (+ optional validation and the
   * per-session average rating as a correlated aggregate, so listing N
   * sessions is still a single round trip).
   */
  private sessionSelect() {
    const averageRating = sql<number | null>`(
      select avg(${formAnswers.valueNumber})::float8
      from ${formAnswers}
      inner join ${formResponses} on ${formResponses.id} = ${formAnswers.responseId}
      inner join ${testFormQuestions} on ${testFormQuestions.id} = ${formAnswers.questionId}
      where ${formResponses.sessionId} = ${sessions.id}
        and ${testFormQuestions.type} in ('scale', 'nps')
        and ${formAnswers.valueNumber} is not null
    )`;
    return {
      id: sessions.id,
      sessionId: sessions.id,
      participationId: participations.id,
      testerId: users.id,
      testerName: users.displayName,
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      durationMs: sessions.durationMs,
      valid: sessionValidations.valid,
      averageRating,
      archetype: playerPreferences.archetype,
      playerTier: sql<PlayerProfileTier | null>`nullif(${playerPreferences.playerTier}::text, 'all')`,
      telemetryConnected: sql<boolean>`exists (
        select 1 from ${sessionTokens} where ${sessionTokens.sessionId} = ${sessions.id}
      )`,
    };
  }

  async listSessions(
    organizationId: string,
    testId: string,
    query: ReportSessionQuery,
  ): Promise<Page<ReportSessionRow>> {
    const cursorId = decodeCursor(query.cursor);
    const filters = [eq(sessions.testId, testId), eq(sessions.organizationId, organizationId)];
    if (cursorId) filters.push(lt(sessions.id, cursorId));

    const rows = await this.db
      .select(this.sessionSelect())
      .from(sessions)
      .innerJoin(participations, eq(participations.id, sessions.participationId))
      .innerJoin(users, eq(users.id, participations.userId))
      .leftJoin(playerPreferences, eq(playerPreferences.userId, users.id))
      .leftJoin(sessionValidations, eq(sessionValidations.sessionId, sessions.id))
      .where(and(...filters))
      .orderBy(desc(sessions.id))
      .limit(query.limit + 1);

    return buildPage(rows, query.limit);
  }

  async countSessions(organizationId: string, testId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(sessions)
      .where(and(eq(sessions.testId, testId), eq(sessions.organizationId, organizationId)));
    return row?.count ?? 0;
  }

  /** Every session of a test, unpaginated — used by the export worker only. */
  async findAllSessions(organizationId: string, testId: string): Promise<ReportSessionRow[]> {
    return this.db
      .select(this.sessionSelect())
      .from(sessions)
      .innerJoin(participations, eq(participations.id, sessions.participationId))
      .innerJoin(users, eq(users.id, participations.userId))
      .leftJoin(playerPreferences, eq(playerPreferences.userId, users.id))
      .leftJoin(sessionValidations, eq(sessionValidations.sessionId, sessions.id))
      .where(and(eq(sessions.testId, testId), eq(sessions.organizationId, organizationId)))
      .orderBy(sessions.startedAt);
  }

  async findSessionEvaluation(
    organizationId: string,
    testId: string,
    sessionId: string,
  ): Promise<SessionEvaluationRow | null> {
    if (!isUuid(sessionId)) return null;

    const sessionRows = await this.db
      .select(this.sessionSelect())
      .from(sessions)
      .innerJoin(participations, eq(participations.id, sessions.participationId))
      .innerJoin(users, eq(users.id, participations.userId))
      .leftJoin(playerPreferences, eq(playerPreferences.userId, users.id))
      .leftJoin(sessionValidations, eq(sessionValidations.sessionId, sessions.id))
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.testId, testId),
          eq(sessions.organizationId, organizationId),
        ),
      )
      .limit(1);
    const session = sessionRows[0];
    if (!session) return null;

    const [response] = await this.db
      .select({ id: formResponses.id, submittedAt: formResponses.submittedAt })
      .from(formResponses)
      .where(eq(formResponses.sessionId, sessionId))
      .limit(1);
    if (!response) return { session, submittedAt: null, answers: [], optionLabels: new Map() };

    const answers = await this.db
      .select({
        questionId: formAnswers.questionId,
        prompt: testFormQuestions.label,
        type: testFormQuestions.type,
        position: testFormQuestions.position,
        valueText: formAnswers.valueText,
        valueNumber: sql<number | null>`${formAnswers.valueNumber}::float8`,
        valueBoolean: formAnswers.valueBoolean,
        optionIds: formAnswers.optionIds,
      })
      .from(formAnswers)
      .innerJoin(testFormQuestions, eq(testFormQuestions.id, formAnswers.questionId))
      .where(eq(formAnswers.responseId, response.id))
      .orderBy(testFormQuestions.position);

    const optionIds = [...new Set(answers.flatMap((a) => a.optionIds ?? []))];
    const optionLabels = new Map<string, string>();
    if (optionIds.length > 0) {
      const options = await this.db
        .select({ id: testFormOptions.id, label: testFormOptions.label })
        .from(testFormOptions)
        .where(inArray(testFormOptions.id, optionIds));
      for (const o of options) optionLabels.set(o.id, o.label);
    }

    return { session, submittedAt: response.submittedAt, answers, optionLabels };
  }

  async listRecordings(sessionId: string): Promise<SessionRecordingRow[]> {
    if (!isUuid(sessionId)) return [];
    return this.db
      .select()
      .from(sessionRecordings)
      .where(eq(sessionRecordings.sessionId, sessionId))
      .orderBy(sessionRecordings.kind);
  }

  async findSessionRating(sessionId: string): Promise<SessionRatingRow | null> {
    if (!isUuid(sessionId)) return null;
    const rows = await this.db
      .select()
      .from(sessionRatings)
      .where(eq(sessionRatings.sessionId, sessionId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Upserts the studio's rating and keeps `session_validations` in step: a
   * session marked invalid leaves the metrics (they filter on `valid = true`);
   * un-marking only reverts a validation this studio flow wrote itself.
   * Cached report blocks are dropped so the next read recomputes them.
   * Returns `null` when the session is not in the caller's organization.
   *
   * Marking invalid only overrides a worker verdict of `valid = true` — a
   * session the worker already rejected keeps its own reason, so un-marking
   * can never turn it valid. A session the worker hasn't validated yet can't
   * be marked (409): writing the row first would make the `session.validate`
   * job skip it for good (it no-ops when a validation row exists).
   */
  async rateSession(
    organizationId: string,
    userId: string,
    sessionId: string,
    input: { rating: number; comment: string | null; markedInvalid: boolean },
  ): Promise<SessionRatingRow | null> {
    if (!isUuid(sessionId)) return null;

    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select({ id: sessions.id, testId: sessions.testId })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.organizationId, organizationId)))
        .limit(1);
      if (!session) return null;

      const [rating] = await tx
        .insert(sessionRatings)
        .values({ sessionId, organizationId, ratedByUserId: userId, ...input })
        .onConflictDoUpdate({
          target: sessionRatings.sessionId,
          set: {
            ratedByUserId: userId,
            rating: input.rating,
            comment: input.comment,
            markedInvalid: input.markedInvalid,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (input.markedInvalid) {
        const [validation] = await tx
          .select({ valid: sessionValidations.valid })
          .from(sessionValidations)
          .where(eq(sessionValidations.sessionId, sessionId))
          .limit(1);
        if (!validation) {
          throw AppException.conflict(
            'A sessão ainda não foi validada — aguarde a validação antes de marcá-la como inválida',
          );
        }
        await tx
          .update(sessionValidations)
          .set({ valid: false, reason: STUDIO_INVALID_REASON, validatedAt: new Date() })
          .where(
            and(eq(sessionValidations.sessionId, sessionId), eq(sessionValidations.valid, true)),
          );
      } else {
        await tx
          .update(sessionValidations)
          .set({ valid: true, reason: null, validatedAt: new Date() })
          .where(
            and(
              eq(sessionValidations.sessionId, sessionId),
              eq(sessionValidations.reason, STUDIO_INVALID_REASON),
            ),
          );
      }

      await tx.delete(testReportSnapshots).where(eq(testReportSnapshots.testId, session.testId));
      return rating;
    });
  }

  /* -------------------------------- Exports -------------------------------- */

  async createExport(values: NewTestReportExportRow): Promise<TestReportExportRow> {
    const rows = await this.db.insert(testReportExports).values(values).returning();
    return rows[0];
  }

  async findExportInOrg(
    organizationId: string,
    testId: string,
    exportId: string,
  ): Promise<TestReportExportRow | null> {
    if (!isUuid(exportId)) return null;
    const rows = await this.db
      .select()
      .from(testReportExports)
      .where(
        and(
          eq(testReportExports.id, exportId),
          eq(testReportExports.testId, testId),
          eq(testReportExports.organizationId, organizationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findExportById(exportId: string): Promise<TestReportExportRow | null> {
    if (!isUuid(exportId)) return null;
    const rows = await this.db
      .select()
      .from(testReportExports)
      .where(eq(testReportExports.id, exportId))
      .limit(1);
    return rows[0] ?? null;
  }

  async markExportFailed(exportId: string, reason: string): Promise<void> {
    await this.db
      .update(testReportExports)
      .set({ status: 'failed', failureReason: reason, completedAt: new Date() })
      .where(eq(testReportExports.id, exportId));
  }
}
