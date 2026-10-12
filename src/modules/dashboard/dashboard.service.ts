import { Injectable, Logger } from '@nestjs/common';
import { DashboardKpiCache } from '../../infra/redis/dashboard-kpi-cache';
import { GamesService } from '../games/games.service';
import { TestsService } from '../tests/tests.service';
import { DashboardRepository, type DashboardKpiCounts } from './dashboard.repository';
import type {
  DashboardBlockView,
  DashboardKpiKey,
  DashboardKpiView,
  StudioDashboardView,
} from './dto/dashboard.dto';

/** How many games / tests the Home lists (most recent first). */
export const DASHBOARD_LIST_LIMIT = 5;

/** The cached part of the dashboard — games/tests carry presigned URLs and are never cached. */
export interface DashboardAggregates {
  kpis: Record<DashboardKpiKey, DashboardKpiView>;
  stats: DashboardBlockView;
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly repo: DashboardRepository,
    private readonly cache: DashboardKpiCache,
    private readonly games: GamesService,
    private readonly tests: TestsService,
  ) {}

  /**
   * RN-02 (Tela 02): KPIs consolidated here. They're served cache-aside from
   * Redis; the services that change them (tests, games, participations, the
   * session.validate worker) drop the key, and a short TTL bounds the rest.
   */
  async getDashboard(organizationId: string): Promise<StudioDashboardView> {
    const [aggregates, games, recentTests] = await Promise.all([
      this.getAggregates(organizationId),
      this.games.list(organizationId, { limit: DASHBOARD_LIST_LIMIT }),
      this.tests.listRecent(organizationId, DASHBOARD_LIST_LIMIT),
    ]);
    return { ...aggregates, games: games.data, recentTests };
  }

  /**
   * Pendência 7 (BACKEND-SPEC §9): the market benchmark's data source isn't
   * defined. The contract exists so Tela 02 can render the block's state, but
   * it is always `unavailable` — never a made-up number. See DECISIONS.md §3.
   */
  getBenchmark(): DashboardBlockView {
    return { key: 'benchmark', status: 'unavailable', payload: null, computedAt: null };
  }

  private async getAggregates(organizationId: string): Promise<DashboardAggregates> {
    const cached = await this.cache.get<DashboardAggregates>(organizationId);
    if (cached) return cached;

    const computed = await this.computeAggregates(organizationId);
    await this.cache.set(organizationId, computed);
    return computed;
  }

  private async computeAggregates(organizationId: string): Promise<DashboardAggregates> {
    const [counts, stats] = await Promise.all([
      this.repo.computeKpiCounts(organizationId),
      this.computeStatsBlock(organizationId),
    ]);
    return { kpis: toKpis(counts), stats };
  }

  /** A failing stats query is reported on the block, not as a 500 for the whole Home (§7.5). */
  private async computeStatsBlock(organizationId: string): Promise<DashboardBlockView> {
    try {
      const points = await this.repo.computeValidSessionsPerDay(organizationId);
      return {
        key: 'sessions_evolution',
        status: 'ready',
        payload: { points },
        computedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.logger.error(`dashboard stats block failed for org ${organizationId}: ${String(err)}`);
      return { key: 'sessions_evolution', status: 'failed', payload: null, computedAt: null };
    }
  }
}

function kpi(value: number | null, unit: string | null = null): DashboardKpiView {
  return { value, delta: null, unit };
}

export function toKpis(counts: DashboardKpiCounts): Record<DashboardKpiKey, DashboardKpiView> {
  return {
    gamesTotal: kpi(counts.gamesTotal),
    testsTotal: kpi(counts.testsTotal),
    testsActive: kpi(counts.testsActive),
    sessionsValid: kpi(counts.sessionsValid),
    playersTotal: kpi(counts.playersTotal),
    averageRating: kpi(counts.averageRating),
    // Same definition as M10's overview block: completed sessions / participations.
    completionRate: kpi(
      counts.participationsTotal > 0 ? counts.sessionsCompleted / counts.participationsTotal : null,
      'ratio',
    ),
  };
}
