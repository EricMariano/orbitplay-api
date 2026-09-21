import { Inject, Injectable } from '@nestjs/common';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.port';
import type { PaginationQuery } from '../../shared/pagination/pagination';
import {
  levelFromXp,
  rankingEntrySchema,
  xpToNextLevelFromXp,
  type PlayerAchievementView,
  type PlayerMissionView,
  type PlayerProgress,
  type RankingEntryView,
  type RankingList,
  type RankingsQuery,
} from './dto/gamification.dto';
import { GamificationRepository } from './gamification.repository';

@Injectable()
export class GamificationService {
  constructor(
    private readonly repo: GamificationRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  /**
   * `feedbackQuality` stays `0` — it's derived from a studio's session rating
   * (M10's `POST /sessions/{id}/rate`) and response completeness, neither of
   * which exist yet. `hoursPlayed`/`testsCompleted` are real pre-M8 reads
   * (see `GamificationRepository.sessionStats`): 0 today, populate on their
   * own once M8 exists.
   */
  async getProgress(userId: string): Promise<PlayerProgress> {
    const [xp, achievementsUnlocked, stats] = await Promise.all([
      this.repo.sumXp(userId),
      this.repo.countUnlockedAchievements(userId),
      this.repo.sessionStats(userId),
    ]);

    return {
      level: levelFromXp(xp),
      xp,
      xpToNextLevel: xpToNextLevelFromXp(xp),
      feedbackQuality: 0,
      achievementsUnlocked,
      hoursPlayed: stats.totalDurationMs / 3_600_000,
      testsCompleted: stats.testsCompleted,
    };
  }

  async listAchievements(
    userId: string,
    query: PaginationQuery,
  ): Promise<{ data: PlayerAchievementView[]; nextCursor: string | null }> {
    const page = await this.repo.listAchievements(userId, query);
    const data = await Promise.all(
      page.rows.map(async ({ achievement, playerRow }) => ({
        achievement: {
          key: achievement.key,
          name: achievement.name,
          description: achievement.description,
          iconUrl: achievement.iconKey ? await this.signedOrNull(achievement.iconKey) : null,
        },
        unlocked: playerRow?.unlockedAt != null,
        unlockedAt: playerRow?.unlockedAt?.toISOString() ?? null,
        progress: playerRow ? Number(playerRow.progress) : null,
      })),
    );
    return { data, nextCursor: page.nextCursor };
  }

  async listMissions(userId: string): Promise<{ data: PlayerMissionView[] }> {
    const rows = await this.repo.listActiveMissions(userId);
    return {
      data: rows.map(({ mission, playerRow }) => ({
        key: mission.key,
        name: mission.name,
        description: mission.description,
        progress: playerRow ? Number(playerRow.progress) : 0,
        target: 1,
        rewardXp: mission.rewardXp,
        expiresAt: mission.expiresAt?.toISOString() ?? null,
      })),
    };
  }

  async getRankings(userId: string, query: RankingsQuery): Promise<RankingList> {
    const snapshot = await this.repo.findLatestSnapshot(query.scope, query.period, query.gameId);
    if (!snapshot) {
      return { data: [], nextCursor: null, currentUserEntry: null, generatedAt: null };
    }

    const entries = parseEntries(snapshot.entries).map((entry) => ({
      ...entry,
      isCurrentUser: entry.userId === userId,
    }));

    const offset = decodeOffsetCursor(query.cursor);
    const page = entries.slice(offset, offset + query.limit);
    const nextCursor = offset + query.limit < entries.length ? encodeOffsetCursor(offset + query.limit) : null;

    return {
      data: page,
      nextCursor,
      currentUserEntry: entries.find((e) => e.isCurrentUser) ?? null,
      generatedAt: snapshot.computedAt.toISOString(),
    };
  }

  private async signedOrNull(key: string): Promise<string | null> {
    try {
      return await this.storage.createDownloadUrl(key);
    } catch {
      return null;
    }
  }
}

/** Defensive parse — `ranking_snapshots.entries` is a plain jsonb column, not schema-checked by Postgres. */
function parseEntries(raw: unknown): Omit<RankingEntryView, 'isCurrentUser'>[] {
  if (!Array.isArray(raw)) return [];
  const result: Omit<RankingEntryView, 'isCurrentUser'>[] = [];
  for (const item of raw) {
    const parsed = rankingEntrySchema.omit({ isCurrentUser: true }).safeParse(item);
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeOffsetCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}
