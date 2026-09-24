import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
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
  sessions,
  sessionValidations,
} from '../../infra/database/schema/participations';
import { testFormOptions, testFormQuestions, tests } from '../../infra/database/schema/tests';
import { users } from '../../infra/database/schema/users';
import { buildPage, decodeCursor, type Page } from '../../shared/pagination/pagination';
import { isUuid } from '../../shared/util/uuid';
import type {
  EvolutionPayload,
  OverviewPayload,
  RatingDistributionPayload,
  ReportBlockKey,
  ReportSessionQuery,
  TesterProfilePayload,
} from './dto/report.dto';

/** Question types whose numeric answer counts as a "nota" (rating). */
const RATING_QUESTION_TYPES = ['scale', 'nps'] as const;

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
    result: { status: 'ready'; payload: Record<string, unknown> } | { status: 'failed' },
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
    return { points: rows };
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
   * Age brackets computed from `users.birthdate` — the only demographic the
   * schema stores about a tester today. Country/archetype/device are not
   * columns on `users`, so they are not reported.
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
    return { ageBrackets: rows };
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
      .leftJoin(sessionValidations, eq(sessionValidations.sessionId, sessions.id))
      .where(and(...filters))
      .orderBy(desc(sessions.id))
      .limit(query.limit + 1);

    return buildPage(rows, query.limit);
  }

  /** Every session of a test, unpaginated — used by the export worker only. */
  async findAllSessions(organizationId: string, testId: string): Promise<ReportSessionRow[]> {
    return this.db
      .select(this.sessionSelect())
      .from(sessions)
      .innerJoin(participations, eq(participations.id, sessions.participationId))
      .innerJoin(users, eq(users.id, participations.userId))
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
