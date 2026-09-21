import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import {
  achievements,
  missions,
  playerAchievements,
  playerMissions,
  rankingSnapshots,
  xpEvents,
  type AchievementRow,
  type MissionRow,
  type PlayerAchievementRow,
  type PlayerMissionRow,
  type RankingSnapshotRow,
} from '../../infra/database/schema/player';
import { participations, sessions, sessionValidations } from '../../infra/database/schema/participations';
import { tests } from '../../infra/database/schema/tests';
import type { PaginationQuery } from '../../shared/pagination/pagination';

export interface SessionStats {
  testsCompleted: number;
  totalDurationMs: number;
}

export interface AchievementPage {
  rows: Array<{ achievement: AchievementRow; playerRow: PlayerAchievementRow | null }>;
  nextCursor: string | null;
}

@Injectable()
export class GamificationRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async sumXp(userId: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`coalesce(sum(${xpEvents.xp}), 0)::int` })
      .from(xpEvents)
      .where(eq(xpEvents.userId, userId));
    return rows[0]?.total ?? 0;
  }

  async countUnlockedAchievements(userId: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(playerAchievements)
      .where(and(eq(playerAchievements.userId, userId), sql`${playerAchievements.unlockedAt} is not null`));
    return rows[0]?.total ?? 0;
  }

  /**
   * Real query over M8's tables (`sessions`/`participations`/`session_validations`),
   * same pre-M8 pattern as `CommunityRepository.hasValidSessionForGame`: always
   * 0 today (no session exists), starts reporting real numbers the moment M8's
   * application layer writes rows — no revisit needed here.
   */
  async sessionStats(userId: string): Promise<SessionStats> {
    const rows = await this.db
      .select({
        testsCompleted: sql<number>`count(distinct ${tests.id})::int`,
        totalDurationMs: sql<number>`coalesce(sum(${sessions.durationMs}), 0)::int`,
      })
      .from(sessions)
      .innerJoin(sessionValidations, eq(sessionValidations.sessionId, sessions.id))
      .innerJoin(participations, eq(participations.id, sessions.participationId))
      .innerJoin(tests, eq(tests.id, sessions.testId))
      .where(
        and(
          eq(participations.userId, userId),
          eq(sessions.status, 'completed'),
          eq(sessionValidations.valid, true),
        ),
      );
    return rows[0] ?? { testsCompleted: 0, totalDurationMs: 0 };
  }

  /** Cursor is the last row's `achievements.key` (text PK, not a UUID — own opaque cursor, not the shared UUID one). */
  async listAchievements(userId: string, query: PaginationQuery): Promise<AchievementPage> {
    const cursorKey = decodeTextCursor(query.cursor);
    const filters = cursorKey ? [gt(achievements.key, cursorKey)] : [];

    const rows = await this.db
      .select({ achievement: achievements, playerRow: playerAchievements })
      .from(achievements)
      .leftJoin(
        playerAchievements,
        and(eq(playerAchievements.achievementKey, achievements.key), eq(playerAchievements.userId, userId)),
      )
      .where(and(...filters))
      .orderBy(achievements.key)
      .limit(query.limit + 1);

    if (rows.length > query.limit) {
      const page = rows.slice(0, query.limit);
      return { rows: page, nextCursor: encodeTextCursor(page[page.length - 1].achievement.key) };
    }
    return { rows, nextCursor: null };
  }

  /** Active = not expired. No pagination in the design contract for this route. */
  async listActiveMissions(
    userId: string,
  ): Promise<Array<{ mission: MissionRow; playerRow: PlayerMissionRow | null }>> {
    return this.db
      .select({ mission: missions, playerRow: playerMissions })
      .from(missions)
      .leftJoin(
        playerMissions,
        and(eq(playerMissions.missionKey, missions.key), eq(playerMissions.userId, userId)),
      )
      .where(or(isNull(missions.expiresAt), gt(missions.expiresAt, new Date())))
      .orderBy(missions.key);
  }

  /**
   * Latest materialized snapshot for a scope/period/gameId. Nothing computes
   * `ranking_snapshots` yet (BACKEND-SPEC.md §9 pendência #5 is still open,
   * no scheduled job exists) — this returns `null` until a future job seeds
   * the table, same pre-job pattern as the pre-M8 reads above.
   */
  async findLatestSnapshot(
    scope: string,
    period: string,
    gameId: string | undefined,
  ): Promise<RankingSnapshotRow | null> {
    const filters = [eq(rankingSnapshots.scope, scope), eq(rankingSnapshots.period, period)];
    filters.push(gameId ? eq(rankingSnapshots.gameId, gameId) : isNull(rankingSnapshots.gameId));

    const rows = await this.db
      .select()
      .from(rankingSnapshots)
      .where(and(...filters))
      .orderBy(sql`${rankingSnapshots.computedAt} desc`)
      .limit(1);
    return rows[0] ?? null;
  }
}

function encodeTextCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeTextCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}
