import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.tokens';
import { DRIZZLE, type Database } from './database.module';
import { testReportSnapshots } from './schema/community';

/**
 * Max age of a cached report block (M10). Invalidation on the writes that feed
 * the report is what keeps it fresh; the TTL is only the safety net for data
 * that changes without an explicit invalidation (e.g. a player editing their
 * profile, a form edited while still a draft, future telemetry ingestion).
 */
export const REPORT_SNAPSHOT_TTL_SECONDS = 300;

/** A `ready` snapshot older than the TTL (or without `computedAt`) is recomputed. */
export function isSnapshotFresh(computedAt: Date | null, now: Date = new Date()): boolean {
  if (!computedAt) return false;
  return now.getTime() - computedAt.getTime() < REPORT_SNAPSHOT_TTL_SECONDS * 1000;
}

/**
 * Plain function so the worker process (which has no Nest container) can
 * invalidate a test's report blocks after validating a session. Marks them
 * stale (`computed_at = null`) instead of deleting them: the payload stays, so
 * while one request recomputes the report the others keep serving the
 * previous blocks (`ReportsService.getReport`) instead of all recomputing at
 * once. Never throws: a failed write must not fail the write that triggered
 * it — the TTL still bounds staleness.
 */
export async function invalidateReportSnapshots(
  db: Database,
  testId: string,
  logger?: Pick<Logger, 'warn'>,
): Promise<void> {
  try {
    await db
      .update(testReportSnapshots)
      .set({ computedAt: null })
      .where(eq(testReportSnapshots.testId, testId));
  } catch (err) {
    logger?.warn(`report snapshot invalidation failed for test ${testId}: ${String(err)}`);
  }
}

/**
 * Marks the cached report blocks of a test (`test_report_snapshots`) stale,
 * so the next `GET /tests/{id}/report` recomputes them. Lives in infra (not in
 * the reports module) for the same reason as `DashboardKpiCache`: the services
 * that write report data (participations, sessions) would otherwise have to
 * import the reports module.
 */
@Injectable()
export class ReportSnapshotCache {
  private readonly logger = new Logger(ReportSnapshotCache.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  invalidate(testId: string): Promise<void> {
    return invalidateReportSnapshots(this.db, testId, this.logger);
  }
}

/**
 * Upper bound on one recompute. Short on purpose: a holder that dies leaves
 * the others serving the stale blocks (and the ones without any computing
 * them inline) for at most this long.
 */
export const REPORT_RECOMPUTE_LOCK_TTL_MS = 30_000;

/** How long a request without a stale block to serve waits for the holder. */
export const REPORT_RECOMPUTE_WAIT_MS = 3_000;
const REPORT_RECOMPUTE_POLL_MS = 100;

/** Deletes the lock only if this holder still owns it (its TTL may have run out mid-recompute). */
const RELEASE_IF_OWNER = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export function reportRecomputeLockKey(testId: string): string {
  return `report:recompute-lock:${testId}`;
}

export interface ReportRecomputeLease {
  release(): Promise<void>;
}

/**
 * Per-test single flight for recomputing report blocks (`SET NX` with a short
 * TTL): the request that gets it recomputes, the others serve the stale
 * snapshot. Redis failing never fails the report — the caller then gets a
 * no-op lease and recomputes inline, as before the lock existed.
 */
@Injectable()
export class ReportRecomputeLock {
  private readonly logger = new Logger(ReportRecomputeLock.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** `null` when another request is recomputing this test's report right now. */
  async tryAcquire(testId: string): Promise<ReportRecomputeLease | null> {
    const key = reportRecomputeLockKey(testId);
    const token = randomUUID();
    try {
      const acquired = await this.redis.set(key, token, 'PX', REPORT_RECOMPUTE_LOCK_TTL_MS, 'NX');
      if (acquired !== 'OK') return null;
    } catch (err) {
      this.logger.warn(`report recompute lock unavailable for test ${testId}: ${String(err)}`);
      return { release: () => Promise.resolve() };
    }
    return {
      release: async () => {
        try {
          await this.redis.eval(RELEASE_IF_OWNER, 1, key, token);
        } catch (err) {
          // The TTL frees it anyway.
          this.logger.warn(
            `report recompute lock release failed for test ${testId}: ${String(err)}`,
          );
        }
      },
    };
  }

  /** Resolves once the lock is free, or after `maxWaitMs`. Never throws. */
  async waitForRelease(testId: string, maxWaitMs = REPORT_RECOMPUTE_WAIT_MS): Promise<void> {
    const key = reportRecomputeLockKey(testId);
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      try {
        if ((await this.redis.exists(key)) === 0) return;
      } catch {
        return;
      }
      await sleep(REPORT_RECOMPUTE_POLL_MS);
    }
  }
}
