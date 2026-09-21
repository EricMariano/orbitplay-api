import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoragePort } from '../../shared/ports/storage.port';
import { GamificationService } from './gamification.service';
import type { GamificationRepository } from './gamification.repository';

const USER_ID = '01990000-0000-7000-8000-0000000000a1';
const OTHER_USER_ID = '01990000-0000-7000-8000-0000000000a2';

describe('GamificationService', () => {
  let repo: {
    sumXp: ReturnType<typeof vi.fn>;
    countUnlockedAchievements: ReturnType<typeof vi.fn>;
    sessionStats: ReturnType<typeof vi.fn>;
    listAchievements: ReturnType<typeof vi.fn>;
    listActiveMissions: ReturnType<typeof vi.fn>;
    findLatestSnapshot: ReturnType<typeof vi.fn>;
  };
  let storage: { createDownloadUrl: ReturnType<typeof vi.fn> };
  let service: GamificationService;

  beforeEach(() => {
    repo = {
      sumXp: vi.fn(),
      countUnlockedAchievements: vi.fn(),
      sessionStats: vi.fn(),
      listAchievements: vi.fn(),
      listActiveMissions: vi.fn(),
      findLatestSnapshot: vi.fn(),
    };
    storage = { createDownloadUrl: vi.fn().mockResolvedValue('https://minio.local/icon.png') };
    service = new GamificationService(
      repo as unknown as GamificationRepository,
      storage as unknown as StoragePort,
    );
  });

  describe('getProgress', () => {
    it('derives level/xpToNextLevel from the XP sum, and feedbackQuality stays 0 (no M10 rating yet)', async () => {
      repo.sumXp.mockResolvedValue(250);
      repo.countUnlockedAchievements.mockResolvedValue(2);
      repo.sessionStats.mockResolvedValue({ testsCompleted: 3, totalDurationMs: 7_200_000 });

      const progress = await service.getProgress(USER_ID);

      expect(progress).toMatchObject({
        level: 3,
        xp: 250,
        xpToNextLevel: 50,
        feedbackQuality: 0,
        achievementsUnlocked: 2,
        hoursPlayed: 2,
        testsCompleted: 3,
      });
    });

    it('zero XP is level 1', async () => {
      repo.sumXp.mockResolvedValue(0);
      repo.countUnlockedAchievements.mockResolvedValue(0);
      repo.sessionStats.mockResolvedValue({ testsCompleted: 0, totalDurationMs: 0 });

      const progress = await service.getProgress(USER_ID);
      expect(progress.level).toBe(1);
      expect(progress.xpToNextLevel).toBe(100);
    });
  });

  describe('listAchievements', () => {
    it('marks unlocked vs locked and resolves an icon URL when iconKey is set', async () => {
      repo.listAchievements.mockResolvedValue({
        rows: [
          {
            achievement: { key: 'a1', name: 'A1', description: 'd1', iconKey: 'icons/a1.png', rule: null },
            playerRow: { id: 'p1', userId: USER_ID, achievementKey: 'a1', progress: '1', unlockedAt: new Date('2026-01-01T00:00:00.000Z') },
          },
          {
            achievement: { key: 'a2', name: 'A2', description: null, iconKey: null, rule: null },
            playerRow: null,
          },
        ],
        nextCursor: 'cursor-1',
      });

      const page = await service.listAchievements(USER_ID, { limit: 20 });

      expect(page.nextCursor).toBe('cursor-1');
      expect(page.data[0]).toMatchObject({
        achievement: { key: 'a1', iconUrl: 'https://minio.local/icon.png' },
        unlocked: true,
        progress: 1,
      });
      expect(page.data[1]).toMatchObject({
        achievement: { key: 'a2', iconUrl: null },
        unlocked: false,
        unlockedAt: null,
        progress: null,
      });
    });
  });

  describe('listMissions', () => {
    it('defaults progress to 0 for missions with no player_missions row', async () => {
      repo.listActiveMissions.mockResolvedValue([
        { mission: { key: 'm1', name: 'M1', description: null, rewardXp: 50, expiresAt: null }, playerRow: null },
      ]);

      const { data } = await service.listMissions(USER_ID);
      expect(data).toEqual([
        { key: 'm1', name: 'M1', description: null, progress: 0, target: 1, rewardXp: 50, expiresAt: null },
      ]);
    });
  });

  describe('getRankings', () => {
    it('returns an empty page when no snapshot exists yet (no job populates ranking_snapshots)', async () => {
      repo.findLatestSnapshot.mockResolvedValue(null);
      const result = await service.getRankings(USER_ID, {
        scope: 'global',
        period: 'month',
        limit: 20,
      } as never);
      expect(result).toEqual({ data: [], nextCursor: null, currentUserEntry: null, generatedAt: null });
    });

    it('flags the requesting user and paginates the snapshot entries in memory', async () => {
      repo.findLatestSnapshot.mockResolvedValue({
        id: 's1',
        scope: 'global',
        period: 'month',
        gameId: null,
        computedAt: new Date('2026-01-01T00:00:00.000Z'),
        entries: [
          { position: 1, userId: OTHER_USER_ID, displayName: 'Other', level: 5, score: 900 },
          { position: 2, userId: USER_ID, displayName: 'Me', level: 3, score: 500 },
        ],
      });

      const result = await service.getRankings(USER_ID, {
        scope: 'global',
        period: 'month',
        limit: 1,
      } as never);

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({ userId: OTHER_USER_ID, isCurrentUser: false });
      expect(result.nextCursor).not.toBeNull();
      expect(result.currentUserEntry).toMatchObject({ userId: USER_ID, isCurrentUser: true });
      expect(result.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    });
  });
});
