import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.tokens';

/**
 * TTL of the studio dashboard KPI cache (M11). Invalidation by domain event
 * is what keeps the numbers fresh; the TTL is only the safety net for the
 * events that don't invalidate explicitly (e.g. a new game review).
 */
export const DASHBOARD_KPI_CACHE_TTL_SECONDS = 60;

export function dashboardKpiCacheKey(organizationId: string): string {
  return `dashboard:kpis:${organizationId}`;
}

/**
 * Plain function so the worker process (which has no Nest container) drops
 * the same key after validating a session. Never throws: a Redis hiccup must
 * not fail the write that triggered it — the TTL still bounds staleness.
 */
export async function invalidateDashboardKpis(redis: Redis, organizationId: string): Promise<void> {
  try {
    await redis.del(dashboardKpiCacheKey(organizationId));
  } catch {
    // best effort — see above
  }
}

/**
 * Cache-aside store for `GET /studio/dashboard` KPIs, one key per
 * organization. Lives in infra (not in the dashboard module) because the
 * services that emit invalidating events — tests, games, participations —
 * are the dashboard's own dependencies; importing the dashboard module from
 * them would be circular.
 */
@Injectable()
export class DashboardKpiCache {
  private readonly logger = new Logger(DashboardKpiCache.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get<T>(organizationId: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(dashboardKpiCacheKey(organizationId));
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn(`dashboard KPI cache read failed: ${String(err)}`);
      return null;
    }
  }

  async set(organizationId: string, value: unknown): Promise<void> {
    try {
      await this.redis.set(
        dashboardKpiCacheKey(organizationId),
        JSON.stringify(value),
        'EX',
        DASHBOARD_KPI_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(`dashboard KPI cache write failed: ${String(err)}`);
    }
  }

  invalidate(organizationId: string): Promise<void> {
    return invalidateDashboardKpis(this.redis, organizationId);
  }
}
