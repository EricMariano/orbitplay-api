import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPORT_SNAPSHOT_TTL_SECONDS } from '../../infra/database/report-snapshot-cache';
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
  let service: ReportsService;

  beforeEach(() => {
    repo = makeReportRepo();
    telemetry = { countSessionsWithEvents: vi.fn().mockResolvedValue(3) };
    service = new ReportsService(
      repo as unknown as ReportsRepository,
      {} as StoragePort,
      {} as QueuePort,
      { invalidate: vi.fn() } as unknown as DashboardKpiCache,
      telemetry as unknown as TelemetryStorePort,
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

describe('ReportsService.listInsights', () => {
  it('answers unavailable with no insights until the AI generation exists', async () => {
    const repo = makeReportRepo();
    const service = new ReportsService(
      repo as unknown as ReportsRepository,
      {} as StoragePort,
      {} as QueuePort,
      { invalidate: vi.fn() } as unknown as DashboardKpiCache,
      {} as TelemetryStorePort,
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
    );

    await expect(service.listInsights(ORG_ID, TEST_ID, {})).rejects.toBeInstanceOf(AppException);
  });
});
