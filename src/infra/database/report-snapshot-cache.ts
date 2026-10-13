import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
 * Plain function so the worker process (which has no Nest container) drops a
 * test's report blocks after validating a session. Never throws: a failed
 * delete must not fail the write that triggered it — the TTL still bounds
 * staleness.
 */
export async function invalidateReportSnapshots(
  db: Database,
  testId: string,
  logger?: Pick<Logger, 'warn'>,
): Promise<void> {
  try {
    await db.delete(testReportSnapshots).where(eq(testReportSnapshots.testId, testId));
  } catch (err) {
    logger?.warn(`report snapshot invalidation failed for test ${testId}: ${String(err)}`);
  }
}

/**
 * Drops the cached report blocks of a test (`test_report_snapshots`), so the
 * next `GET /tests/{id}/report` recomputes them. Lives in infra (not in the
 * reports module) for the same reason as `DashboardKpiCache`: the services
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
