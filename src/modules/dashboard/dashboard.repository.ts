import { Inject, Injectable } from '@nestjs/common';
import { and, count, countDistinct, eq, gte, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { OrgScopedRepository } from '../../infra/database/base.repository';
import { gameReviews } from '../../infra/database/schema/community';
import { games, type GameRow, type NewGameRow } from '../../infra/database/schema/games';
import {
  participations,
  sessions,
  sessionValidations,
} from '../../infra/database/schema/participations';
import { tests } from '../../infra/database/schema/tests';
import type { DashboardStatsPoint } from './dto/dashboard.dto';

/** Window of the `stats` block (valid sessions per day). */
export const DASHBOARD_STATS_DAYS = 30;

export interface DashboardKpiCounts {
  gamesTotal: number;
  testsTotal: number;
  testsActive: number;
  sessionsValid: number;
  sessionsCompleted: number;
  participationsTotal: number;
  playersTotal: number;
  averageRating: number | null;
}

/**
 * Org-wide aggregates for the studio dashboard (M11). Every query is filtered
 * by the caller's organization (RN-01) and runs in SQL — no rows are pulled
 * into memory to be summed in JS. Definitions mirror the ones already exposed
 * elsewhere (`GamesRepository.metricsByGameIds` for M3's cards,
 * `ReportsRepository.computeOverview` for M10) so the Home never disagrees
 * with the game and report screens.
 */
@Injectable()
export class DashboardRepository extends OrgScopedRepository<GameRow, NewGameRow> {
  constructor(@Inject(DRIZZLE) db: Database) {
    super(db, games);
  }

  async computeKpiCounts(organizationId: string): Promise<DashboardKpiCounts> {
    const [gameRows, testRows, sessionRows, participationRows, ratingRows] = await Promise.all([
      this.db.select({ gamesTotal: count() }).from(games).where(this.orgScope(organizationId)),
      this.db
        .select({
          testsTotal: count(),
          testsActive: sql<number>`count(*) filter (where ${tests.status} = 'published')`.mapWith(
            Number,
          ),
        })
        .from(tests)
        .where(eq(tests.organizationId, organizationId)),
      this.db
        .select({
          sessionsValid:
            sql<number>`count(*) filter (where ${sessionValidations.valid} = true)`.mapWith(Number),
          sessionsCompleted:
            sql<number>`count(*) filter (where ${sessions.status} = 'completed')`.mapWith(Number),
        })
        .from(sessions)
        .leftJoin(sessionValidations, eq(sessionValidations.sessionId, sessions.id))
        .where(eq(sessions.organizationId, organizationId)),
      this.db
        .select({
          participationsTotal: count(),
          playersTotal: countDistinct(participations.userId),
        })
        .from(participations)
        .innerJoin(tests, eq(tests.id, participations.testId))
        .where(eq(tests.organizationId, organizationId)),
      this.db
        .select({
          averageRating: sql<number | null>`avg(${gameReviews.rating})::float`,
        })
        .from(gameReviews)
        .innerJoin(games, eq(games.id, gameReviews.gameId))
        .where(and(eq(games.organizationId, organizationId), isNull(games.deletedAt))),
    ]);

    const averageRating = ratingRows[0]?.averageRating;
    return {
      gamesTotal: Number(gameRows[0]?.gamesTotal ?? 0),
      testsTotal: Number(testRows[0]?.testsTotal ?? 0),
      testsActive: Number(testRows[0]?.testsActive ?? 0),
      sessionsValid: Number(sessionRows[0]?.sessionsValid ?? 0),
      sessionsCompleted: Number(sessionRows[0]?.sessionsCompleted ?? 0),
      participationsTotal: Number(participationRows[0]?.participationsTotal ?? 0),
      playersTotal: Number(participationRows[0]?.playersTotal ?? 0),
      averageRating:
        averageRating === null || averageRating === undefined || Number.isNaN(averageRating)
          ? null
          : Number(averageRating),
    };
  }

  /** Valid sessions per day over the last `DASHBOARD_STATS_DAYS` days (days with none are omitted). */
  async computeValidSessionsPerDay(organizationId: string): Promise<DashboardStatsPoint[]> {
    const since = new Date(Date.now() - DASHBOARD_STATS_DAYS * 24 * 60 * 60 * 1000);
    const day = sql<string>`to_char(date_trunc('day', ${sessions.startedAt}), 'YYYY-MM-DD')`;
    return this.db
      .select({ date: day, sessions: sql<number>`count(*)::int` })
      .from(sessions)
      .innerJoin(sessionValidations, eq(sessionValidations.sessionId, sessions.id))
      .where(
        and(
          eq(sessions.organizationId, organizationId),
          eq(sessionValidations.valid, true),
          gte(sessions.startedAt, since),
        ),
      )
      .groupBy(day)
      .orderBy(day);
  }
}
