import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DASHBOARD_KPI_CACHE_TTL_SECONDS,
  DashboardKpiCache,
  dashboardKpiCacheKey,
  invalidateDashboardKpis,
} from '../../infra/redis/dashboard-kpi-cache';
import type { GamesService } from '../games/games.service';
import type { TestsService } from '../tests/tests.service';
import type { DashboardKpiCounts, DashboardRepository } from './dashboard.repository';
import { DASHBOARD_LIST_LIMIT, DashboardService, toKpis } from './dashboard.service';

const ORG = '01920000-0000-7000-8000-0000000000a1';

const COUNTS: DashboardKpiCounts = {
  gamesTotal: 2,
  testsTotal: 5,
  testsActive: 1,
  sessionsValid: 3,
  sessionsCompleted: 4,
  participationsTotal: 8,
  playersTotal: 6,
  averageRating: 4.5,
};

describe('DashboardService', () => {
  let store: Map<string, string>;
  let redis: Record<string, ReturnType<typeof vi.fn>>;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let games: Record<string, ReturnType<typeof vi.fn>>;
  let tests: Record<string, ReturnType<typeof vi.fn>>;
  let service: DashboardService;

  beforeEach(() => {
    store = new Map();
    redis = {
      get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: vi.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve('OK');
      }),
      del: vi.fn((key: string) => Promise.resolve(store.delete(key) ? 1 : 0)),
    };
    repo = {
      computeKpiCounts: vi.fn().mockResolvedValue(COUNTS),
      computeValidSessionsPerDay: vi.fn().mockResolvedValue([{ date: '2026-09-24', sessions: 3 }]),
    };
    games = { list: vi.fn().mockResolvedValue({ data: [], nextCursor: null }) };
    tests = { listRecent: vi.fn().mockResolvedValue([]) };
    service = new DashboardService(
      repo as unknown as DashboardRepository,
      new DashboardKpiCache(redis as unknown as Redis),
      games as unknown as GamesService,
      tests as unknown as TestsService,
    );
  });

  describe('getDashboard', () => {
    it('computes on a cache miss and stores the aggregates with a TTL', async () => {
      const result = await service.getDashboard(ORG);

      expect(result.kpis.testsTotal).toEqual({ value: 5, delta: null, unit: null });
      expect(result.stats).toMatchObject({
        key: 'sessions_evolution',
        status: 'ready',
        payload: { points: [{ date: '2026-09-24', sessions: 3 }] },
      });
      expect(redis.set).toHaveBeenCalledWith(
        dashboardKpiCacheKey(ORG),
        expect.any(String),
        'EX',
        DASHBOARD_KPI_CACHE_TTL_SECONDS,
      );
      expect(games.list).toHaveBeenCalledWith(ORG, { limit: DASHBOARD_LIST_LIMIT });
      expect(tests.listRecent).toHaveBeenCalledWith(ORG, DASHBOARD_LIST_LIMIT);
    });

    it('serves KPIs from the cache on a hit, without querying the database again', async () => {
      await service.getDashboard(ORG);
      repo.computeKpiCounts.mockResolvedValue({ ...COUNTS, testsTotal: 99 });

      const second = await service.getDashboard(ORG);

      expect(repo.computeKpiCounts).toHaveBeenCalledTimes(1);
      expect(second.kpis.testsTotal.value).toBe(5);
      // games/tests carry presigned URLs — always fresh, never cached.
      expect(games.list).toHaveBeenCalledTimes(2);
      expect(tests.listRecent).toHaveBeenCalledTimes(2);
    });

    it('recomputes after the org key is invalidated', async () => {
      await service.getDashboard(ORG);
      repo.computeKpiCounts.mockResolvedValue({ ...COUNTS, testsTotal: 6 });

      await invalidateDashboardKpis(redis as unknown as Redis, ORG);
      const result = await service.getDashboard(ORG);

      expect(result.kpis.testsTotal.value).toBe(6);
    });

    it('still answers when Redis is down (falls back to computing)', async () => {
      redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
      redis.set.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.getDashboard(ORG);

      expect(result.kpis.gamesTotal.value).toBe(2);
    });

    it('reports a failing stats query on the block instead of failing the whole Home', async () => {
      repo.computeValidSessionsPerDay.mockRejectedValue(new Error('boom'));

      const result = await service.getDashboard(ORG);

      expect(result.stats).toEqual({
        key: 'sessions_evolution',
        status: 'failed',
        payload: null,
        computedAt: null,
      });
      expect(result.kpis.sessionsValid.value).toBe(3);
    });
  });

  describe('toKpis', () => {
    it('completionRate is completed sessions / participations (same as the M10 overview)', () => {
      expect(toKpis(COUNTS).completionRate).toEqual({ value: 0.5, delta: null, unit: 'ratio' });
    });

    it('completionRate is null — not 0 — when there are no participations', () => {
      expect(
        toKpis({ ...COUNTS, participationsTotal: 0, sessionsCompleted: 0 }).completionRate.value,
      ).toBeNull();
    });
  });

  it('benchmark is always unavailable (pendência 7) — never a made-up number', () => {
    expect(service.getBenchmark()).toEqual({
      key: 'benchmark',
      status: 'unavailable',
      payload: null,
      computedAt: null,
    });
  });

  it('invalidation never throws, even when Redis is down', async () => {
    redis.del.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(invalidateDashboardKpis(redis as unknown as Redis, ORG)).resolves.toBeUndefined();
  });
});
