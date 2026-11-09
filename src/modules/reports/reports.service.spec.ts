import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REPORT_SNAPSHOT_TTL_SECONDS,
  type ReportRecomputeLock,
} from '../../infra/database/report-snapshot-cache';
import type { TestReportSnapshotRow } from '../../infra/database/schema/community';
import type { SessionRatingRow } from '../../infra/database/schema/participations';
import type { DashboardKpiCache } from '../../infra/redis/dashboard-kpi-cache';
import type { QueuePort } from '../../shared/ports/queue.port';
import type { StoragePort } from '../../shared/ports/storage.port';
import type { TelemetryStorePort } from '../../shared/ports/telemetry-store.port';
import { drainAuditDrafts } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import type { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

const ORG_ID = '01990000-0000-7000-8000-0000000000a1';

/** Lock that is always free (this request recomputes) unless a test says otherwise. */
function makeLock() {
  const release = vi.fn().mockResolvedValue(undefined);
  return {
    release,
    tryAcquire: vi.fn().mockResolvedValue({ release }),
    waitForRelease: vi.fn().mockResolvedValue(undefined),
  };
}
const USER_ID = '01990000-0000-7000-8000-0000000000b1';
const SESSION_ID = '01990000-0000-7000-8000-0000000000c1';

function makeRatingRow(overrides: Partial<SessionRatingRow> = {}): SessionRatingRow {
  return {
    sessionId: SESSION_ID,
    organizationId: ORG_ID,
    ratedByUserId: USER_ID,
    rating: 4,
    comment: null,
    markedInvalid: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ReportsService.rateSession', () => {
  let repo: { rateSession: ReturnType<typeof vi.fn> };
  let service: ReportsService;
  let req: Request;

  beforeEach(() => {
    repo = { rateSession: vi.fn() };
    service = new ReportsService(
      repo as unknown as ReportsRepository,
      {} as StoragePort,
      {} as QueuePort,
      { invalidate: vi.fn() } as unknown as DashboardKpiCache,
      {} as TelemetryStorePort,
      makeLock() as unknown as ReportRecomputeLock,
    );
    req = {} as Request;
  });

  it('persists the rating and returns the view', async () => {
    repo.rateSession.mockResolvedValue(makeRatingRow({ comment: 'Ótimo feedback' }));

    const view = await service.rateSession(
      ORG_ID,
      USER_ID,
      SESSION_ID,
      { rating: 4, comment: 'Ótimo feedback', markedInvalid: false },
      req,
    );

    expect(repo.rateSession).toHaveBeenCalledWith(ORG_ID, USER_ID, SESSION_ID, {
      rating: 4,
      comment: 'Ótimo feedback',
      markedInvalid: false,
    });
    expect(view).toEqual({
      sessionId: SESSION_ID,
      rating: 4,
      comment: 'Ótimo feedback',
      markedInvalid: false,
      ratedByUserId: USER_ID,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('normalizes an empty or missing comment to null', async () => {
    repo.rateSession.mockResolvedValue(makeRatingRow());

    await service.rateSession(
      ORG_ID,
      USER_ID,
      SESSION_ID,
      { rating: 3, comment: '', markedInvalid: false },
      req,
    );
    await service.rateSession(
      ORG_ID,
      USER_ID,
      SESSION_ID,
      { rating: 3, markedInvalid: false },
      req,
    );

    expect(repo.rateSession.mock.calls[0][3].comment).toBeNull();
    expect(repo.rateSession.mock.calls[1][3].comment).toBeNull();
  });

  it('records an audit entry', async () => {
    repo.rateSession.mockResolvedValue(makeRatingRow({ rating: 2, markedInvalid: true }));

    await service.rateSession(ORG_ID, USER_ID, SESSION_ID, { rating: 2, markedInvalid: true }, req);

    expect(drainAuditDrafts(req)).toEqual([
      expect.objectContaining({
        action: 'session.rated',
        entity: 'session_ratings',
        entityId: SESSION_ID,
        after: { rating: 2, markedInvalid: true },
      }),
    ]);
  });

  it('answers 404 when the session is not in the caller organization', async () => {
    repo.rateSession.mockResolvedValue(null);

    await expect(
      service.rateSession(ORG_ID, USER_ID, SESSION_ID, { rating: 5, markedInvalid: false }, req),
    ).rejects.toBeInstanceOf(AppException);
    expect(drainAuditDrafts(req)).toEqual([]);
  });
});

const TEST_ID = '01990000-0000-7000-8000-0000000000d1';

const OVERVIEW = {
  totalParticipations: 2,
  completedSessions: 1,
  validSessions: 1,
  completionRate: 0.5,
  averageDurationMs: 1000,
  averageRating: 4,
  testersCount: 2,
  aiScore: null,
  funFactor: null,
  bugsCount: null,
};

function makeReportRepo() {
  return {
    testExistsInOrg: vi.fn().mockResolvedValue(true),
    findSnapshots: vi.fn().mockResolvedValue([]),
    upsertSnapshot: vi.fn().mockResolvedValue(undefined),
    computeOverview: vi.fn().mockResolvedValue(OVERVIEW),
    computeEvolution: vi.fn().mockResolvedValue({ points: [], weeks: [] }),
    computeRatingDistribution: vi.fn().mockResolvedValue({ buckets: [] }),
    computeTesterProfile: vi
      .fn()
      .mockResolvedValue({ ageBrackets: [], archetypes: [], playerTiers: [] }),
    computeEvaluations: vi.fn().mockResolvedValue({
      questionsCount: 0,
      responsesCount: 0,
      averageResponseTimeMs: null,
      dropoutRate: null,
      questions: [],
    }),
    findPluginSummary: vi.fn().mockResolvedValue(null),
  };
}

describe('ReportsService.getReport', () => {
  let repo: ReturnType<typeof makeReportRepo>;
  let telemetry: { countSessionsWithEvents: ReturnType<typeof vi.fn> };
  let lock: ReturnType<typeof makeLock>;
  let service: ReportsService;

  beforeEach(() => {
    repo = makeReportRepo();
    telemetry = { countSessionsWithEvents: vi.fn().mockResolvedValue(3) };
    lock = makeLock();
    service = new ReportsService(
      repo as unknown as ReportsRepository,
      {} as StoragePort,
      {} as QueuePort,
      { invalidate: vi.fn() } as unknown as DashboardKpiCache,
      telemetry as unknown as TelemetryStorePort,
      lock as unknown as ReportRecomputeLock,
    );
  });

  const block = (report: Awaited<ReturnType<ReportsService['getReport']>>, key: string) =>
    report.blocks.find((b) => b.key === key);

  it('serves a fresh cached snapshot whose payload matches the current schema', async () => {
    const computedAt = new Date(Date.now() - 1000);
    repo.findSnapshots.mockResolvedValue([
      {
        blockKey: 'overview',
        status: 'ready',
        payload: OVERVIEW,
        computedAt,
      } as TestReportSnapshotRow,
    ]);

    const report = await service.getReport(ORG_ID, TEST_ID);

    expect(repo.computeOverview).not.toHaveBeenCalled();
    expect(block(report, 'overview')).toEqual({
      key: 'overview',
      status: 'ready',
      payload: OVERVIEW,
      computedAt: computedAt.toISOString(),
    });
  });

  it('recomputes a cached snapshot older than the TTL', async () => {
    repo.findSnapshots.mockResolvedValue([
      {
        blockKey: 'overview',
        status: 'ready',
        payload: OVERVIEW,
        computedAt: new Date(Date.now() - (REPORT_SNAPSHOT_TTL_SECONDS + 1) * 1000),
      } as TestReportSnapshotRow,
    ]);

    await service.getReport(ORG_ID, TEST_ID);

    expect(repo.computeOverview).toHaveBeenCalledWith(TEST_ID);
  });

  it('recomputes a cached snapshot written in an older payload format', async () => {
    const legacy: Partial<typeof OVERVIEW> = { ...OVERVIEW };
    delete legacy.testersCount;
    repo.findSnapshots.mockResolvedValue([
      {
        blockKey: 'overview',
        status: 'ready',
        payload: legacy,
        computedAt: new Date(),
      } as TestReportSnapshotRow,
    ]);

    const report = await service.getReport(ORG_ID, TEST_ID);

    expect(repo.computeOverview).toHaveBeenCalledWith(TEST_ID);
    expect(block(report, 'overview')?.payload).toEqual(OVERVIEW);
  });

  it('reports telemetry as unavailable (and does not cache it) without the plug-in', async () => {
    const report = await service.getReport(ORG_ID, TEST_ID);

    expect(block(report, 'telemetry')).toEqual({
      key: 'telemetry',
      status: 'unavailable',
      payload: null,
      computedAt: null,
    });
    expect(repo.upsertSnapshot).not.toHaveBeenCalledWith(TEST_ID, 'telemetry', expect.anything());
  });

  it('computes telemetry from the plug-in manifest and the telemetry store', async () => {
    repo.findPluginSummary.mockResolvedValue({ activeTriggers: 5 });

    const report = await service.getReport(ORG_ID, TEST_ID);

    expect(telemetry.countSessionsWithEvents).toHaveBeenCalledWith(TEST_ID);
    expect(block(report, 'telemetry')).toMatchObject({
      status: 'ready',
      payload: { sessionsAnalyzed: 3, activeTriggers: 5, discoveries: null, aiSuggestions: null },
    });
  });

  it('isolates a failing block', async () => {
    repo.computeEvaluations.mockRejectedValue(new Error('boom'));

    const report = await service.getReport(ORG_ID, TEST_ID);

    expect(block(report, 'evaluations')).toMatchObject({ status: 'failed', payload: null });
    expect(block(report, 'overview')).toMatchObject({ status: 'ready' });
  });
});

describe('ReportsService.getReport — single flight per test', () => {
  const PAYLOADS = {
    overview: OVERVIEW,
    evolution: { points: [], weeks: [] },
    rating_distribution: { buckets: [] },
    tester_profile: { ageBrackets: [], archetypes: [], playerTiers: [] },
    evaluations: {
      questionsCount: 0,
      responsesCount: 0,
      averageResponseTimeMs: null,
      dropoutRate: null,
      questions: [],
    },
    telemetry: { sessionsAnalyzed: 1, activeTriggers: 2, discoveries: null, aiSuggestions: null },
  };
  const snapshot = (
    blockKey: keyof typeof PAYLOADS,
    computedAt: Date | null,
    overrides: Partial<TestReportSnapshotRow> = {},
  ) =>
    ({
      blockKey,
      status: 'ready',
      payload: PAYLOADS[blockKey],
      computedAt,
      ...overrides,
    }) as TestReportSnapshotRow;
  const allBlocks = (computedAt: Date | null) =>
    (Object.keys(PAYLOADS) as (keyof typeof PAYLOADS)[]).map((key) => snapshot(key, computedAt));

  let repo: ReturnType<typeof makeReportRepo>;
  let lock: ReturnType<typeof makeLock>;
  let service: ReportsService;

  beforeEach(() => {
    repo = makeReportRepo();
    repo.findPluginSummary.mockResolvedValue({ activeTriggers: 2 });
    lock = makeLock();
    service = new ReportsService(
      repo as unknown as ReportsRepository,
      {} as StoragePort,
      {} as QueuePort,
      { invalidate: vi.fn() } as unknown as DashboardKpiCache,
      { countSessionsWithEvents: vi.fn().mockResolvedValue(1) } as unknown as TelemetryStorePort,
      lock as unknown as ReportRecomputeLock,
    );
  });

  const block = (report: Awaited<ReturnType<ReportsService['getReport']>>, key: string) =>
    report.blocks.find((b) => b.key === key);

  it('serves an all-fresh report without touching the lock', async () => {
    repo.findSnapshots.mockResolvedValue(allBlocks(new Date()));

    await service.getReport(ORG_ID, TEST_ID);

    expect(lock.tryAcquire).not.toHaveBeenCalled();
    expect(repo.computeOverview).not.toHaveBeenCalled();
  });

  it('recomputes the stale blocks under the lock and releases it', async () => {
    repo.findSnapshots.mockResolvedValue(allBlocks(null));

    const report = await service.getReport(ORG_ID, TEST_ID);

    expect(lock.tryAcquire).toHaveBeenCalledWith(TEST_ID);
    expect(repo.computeOverview).toHaveBeenCalledOnce();
    expect(repo.upsertSnapshot).toHaveBeenCalledWith(TEST_ID, 'overview', {
      status: 'ready',
      payload: OVERVIEW,
    });
    expect(block(report, 'overview')?.computedAt).not.toBeNull();
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it('releases the lock even when recomputing throws', async () => {
    repo.findSnapshots
      .mockResolvedValueOnce(allBlocks(null))
      .mockRejectedValueOnce(new Error('db down'));

    await expect(service.getReport(ORG_ID, TEST_ID)).rejects.toThrow('db down');
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it('serves what the previous holder just refreshed instead of recomputing it', async () => {
    repo.findSnapshots
      .mockResolvedValueOnce(allBlocks(null))
      .mockResolvedValueOnce(allBlocks(new Date()));

    await service.getReport(ORG_ID, TEST_ID);

    expect(repo.computeOverview).not.toHaveBeenCalled();
  });

  it('serves the stale payloads while another request recomputes', async () => {
    lock.tryAcquire.mockResolvedValue(null);
    repo.findSnapshots.mockResolvedValue(allBlocks(null));

    const report = await service.getReport(ORG_ID, TEST_ID);

    expect(lock.waitForRelease).not.toHaveBeenCalled();
    expect(repo.computeOverview).not.toHaveBeenCalled();
    expect(repo.upsertSnapshot).not.toHaveBeenCalled();
    // Same contract: a stale block is still `ready`, just without `computedAt`.
    expect(block(report, 'overview')).toEqual({
      key: 'overview',
      status: 'ready',
      payload: OVERVIEW,
      computedAt: null,
    });
  });

  it('waits for the holder when a block has nothing to serve, and takes what it wrote', async () => {
    lock.tryAcquire.mockResolvedValue(null);
    const others = allBlocks(null).filter((row) => row.blockKey !== 'overview');
    repo.findSnapshots
      .mockResolvedValueOnce(others)
      .mockResolvedValueOnce([...others, snapshot('overview', new Date())]);

    const report = await service.getReport(ORG_ID, TEST_ID);

    expect(lock.waitForRelease).toHaveBeenCalledWith(TEST_ID);
    expect(repo.computeOverview).not.toHaveBeenCalled();
    expect(block(report, 'overview')).toMatchObject({ status: 'ready', payload: OVERVIEW });
  });

  it('serves the failure the holder just recorded instead of retrying the block', async () => {
    lock.tryAcquire.mockResolvedValue(null);
    const others = allBlocks(null).filter((row) => row.blockKey !== 'overview');
    repo.findSnapshots
      .mockResolvedValueOnce(others)
      .mockResolvedValueOnce([
        ...others,
        snapshot('overview', new Date(), { status: 'failed', payload: null }),
      ]);

    const report = await service.getReport(ORG_ID, TEST_ID);

    expect(repo.computeOverview).not.toHaveBeenCalled();
    expect(block(report, 'overview')).toMatchObject({ status: 'failed', payload: null });
  });

  it('computes inline what the holder did not write in time', async () => {
    lock.tryAcquire.mockResolvedValue(null);
    const others = allBlocks(null).filter((row) => row.blockKey !== 'overview');
    repo.findSnapshots.mockResolvedValue(others);

    const report = await service.getReport(ORG_ID, TEST_ID);

    expect(lock.waitForRelease).toHaveBeenCalledOnce();
    expect(repo.computeOverview).toHaveBeenCalledOnce();
    expect(block(report, 'overview')).toMatchObject({ status: 'ready', payload: OVERVIEW });
  });

  it('does not wait just because telemetry is uncached (unavailable is never stored)', async () => {
    lock.tryAcquire.mockResolvedValue(null);
    repo.findPluginSummary.mockResolvedValue(null);
    repo.findSnapshots.mockResolvedValue(
      allBlocks(null).filter((row) => row.blockKey !== 'telemetry'),
    );

    const report = await service.getReport(ORG_ID, TEST_ID);

    expect(lock.waitForRelease).not.toHaveBeenCalled();
    expect(block(report, 'telemetry')).toMatchObject({ status: 'unavailable' });
  });
});

describe('ReportsService.listInsights', () => {
  it('answers unavailable with no insights until the AI generation exists', async () => {
    const repo = makeReportRepo();
    const service = new ReportsService(
      repo as unknown as ReportsRepository,
      {} as StoragePort,
      {} as QueuePort,
      { invalidate: vi.fn() } as unknown as DashboardKpiCache,
      {} as TelemetryStorePort,
      makeLock() as unknown as ReportRecomputeLock,
    );

    await expect(service.listInsights(ORG_ID, TEST_ID, { q: 'menu' })).resolves.toEqual({
      status: 'unavailable',
      model: null,
      data: [],
    });
  });

  it('answers 404 for a test outside the caller organization', async () => {
    const repo = makeReportRepo();
    repo.testExistsInOrg.mockResolvedValue(false);
    const service = new ReportsService(
      repo as unknown as ReportsRepository,
      {} as StoragePort,
      {} as QueuePort,
      { invalidate: vi.fn() } as unknown as DashboardKpiCache,
      {} as TelemetryStorePort,
      makeLock() as unknown as ReportRecomputeLock,
    );

    await expect(service.listInsights(ORG_ID, TEST_ID, {})).rejects.toBeInstanceOf(AppException);
  });
});
