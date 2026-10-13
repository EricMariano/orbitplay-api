import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import type {
  TestReportExportRow,
  TestReportSnapshotRow,
} from '../../infra/database/schema/community';
import { isSnapshotFresh } from '../../infra/database/report-snapshot-cache';
import { newId } from '../../infra/database/schema/_helpers';
import { JobName, reportExportJobId } from '../../infra/queue/queue.constants';
import { DashboardKpiCache } from '../../infra/redis/dashboard-kpi-cache';
import { recordAudit } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import { QUEUE_PORT, type QueuePort } from '../../shared/ports/queue.port';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.port';
import {
  TELEMETRY_STORE_PORT,
  type TelemetryStorePort,
} from '../../shared/ports/telemetry-store.port';
import {
  reportBlockKeyValues,
  reportBlockPayloadSchemas,
  type CreateReportExportRequest,
  type RateSessionRequest,
  type ReportBlockKey,
  type ReportBlockView,
  type ReportExportView,
  type ReportSessionQuery,
  type ReportSessionView,
  type SessionEvaluationView,
  type SessionRatingView,
  type TestInsightsQuery,
  type TestInsightsView,
  type TestReportView,
} from './dto/report.dto';
import {
  ReportsRepository,
  type ReportSessionRow,
  type SessionEvaluationRow,
} from './reports.repository';

/** Download links for a finished export stay valid for 15 minutes. */
export const REPORT_DOWNLOAD_TTL_SECONDS = 900;

/** A computer resolves `null` when the block has no data source yet (`unavailable`). */
type BlockComputer = () => Promise<object | null>;

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly repo: ReportsRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    private readonly dashboardKpis: DashboardKpiCache,
    @Inject(TELEMETRY_STORE_PORT) private readonly telemetry: TelemetryStorePort,
  ) {}

  /* ------------------------------ M10-02: blocks ----------------------------- */

  /**
   * Returns every report block. Blocks are computed on demand and cached as
   * `test_report_snapshots` rows; each block is computed on its own, so one
   * failing block is reported as `failed` without hiding the others. Writes
   * that feed the report drop the cache (`ReportSnapshotCache`); a snapshot
   * past the TTL, or whose payload no longer matches the block's schema
   * (written before the contract grew), is recomputed instead of served.
   */
  async getReport(organizationId: string, testId: string): Promise<TestReportView> {
    await this.assertTestInOrg(organizationId, testId);

    const stored = new Map<string, TestReportSnapshotRow>(
      (await this.repo.findSnapshots(testId)).map((s) => [s.blockKey, s]),
    );

    const blocks = await Promise.all(
      reportBlockKeyValues.map(async (key): Promise<ReportBlockView> => {
        const existing = stored.get(key);
        if (
          existing?.status === 'ready' &&
          isSnapshotFresh(existing.computedAt) &&
          isCurrentPayload(key, existing.payload)
        ) {
          return this.toBlockView(existing);
        }
        return this.computeBlock(testId, key);
      }),
    );
    return { testId, blocks };
  }

  private async computeBlock(testId: string, key: ReportBlockKey): Promise<ReportBlockView> {
    try {
      const payload = await this.blockComputers(testId)[key]();
      // Not cached: the source may appear later (e.g. a build with the plug-in).
      if (payload === null) return blockView(key, 'unavailable', null, null);
      await this.repo.upsertSnapshot(testId, key, { status: 'ready', payload });
      return blockView(key, 'ready', payload, new Date().toISOString());
    } catch (err) {
      this.logger.error(`report block "${key}" failed for test ${testId}: ${String(err)}`);
      await this.repo.upsertSnapshot(testId, key, { status: 'failed' }).catch(() => undefined);
      return blockView(key, 'failed', null, null);
    }
  }

  private blockComputers(testId: string): Record<ReportBlockKey, BlockComputer> {
    return {
      overview: () => this.repo.computeOverview(testId),
      evolution: () => this.repo.computeEvolution(testId),
      rating_distribution: () => this.repo.computeRatingDistribution(testId),
      tester_profile: () => this.repo.computeTesterProfile(testId),
      evaluations: () => this.repo.computeEvaluations(testId),
      telemetry: () => this.computeTelemetry(testId),
    };
  }

  /** Orbit Plug-in block — only when the test's build ships the plug-in manifest. */
  private async computeTelemetry(testId: string) {
    const plugin = await this.repo.findPluginSummary(testId);
    if (!plugin) return null;
    return {
      sessionsAnalyzed: await this.telemetry.countSessionsWithEvents(testId),
      activeTriggers: plugin.activeTriggers,
      // Generated by the AI (deferred, BACKEND-SPEC §10).
      discoveries: null,
      aiSuggestions: null,
    };
  }

  private toBlockView(row: TestReportSnapshotRow): ReportBlockView {
    return blockView(
      row.blockKey as ReportBlockKey,
      row.status,
      row.payload as object | null,
      row.computedAt?.toISOString() ?? null,
    );
  }

  /* ------------------------------ AI insights ------------------------------ */

  /**
   * Tela 11 "Insights de IA". Generation through `AiPort` is deferred
   * (BACKEND-SPEC §10): until it exists the list is empty and flagged
   * `unavailable` — never placeholder insights. `q`/`category` are already part
   * of the contract so the screen's search/filter won't change when it lands.
   */
  async listInsights(
    organizationId: string,
    testId: string,
    _query: TestInsightsQuery,
  ): Promise<TestInsightsView> {
    await this.assertTestInOrg(organizationId, testId);
    return { status: 'unavailable', model: null, data: [] };
  }

  /* ------------------------ M10-03: sessions & evaluation --------------------- */

  async listSessions(
    organizationId: string,
    testId: string,
    query: ReportSessionQuery,
  ): Promise<{ data: ReportSessionView[]; nextCursor: string | null; total: number }> {
    await this.assertTestInOrg(organizationId, testId);
    const [page, total] = await Promise.all([
      this.repo.listSessions(organizationId, testId, query),
      this.repo.countSessions(organizationId, testId),
    ]);
    return { data: page.data.map(toSessionView), nextCursor: page.nextCursor, total };
  }

  async getSessionEvaluation(
    organizationId: string,
    testId: string,
    sessionId: string,
  ): Promise<SessionEvaluationView> {
    await this.assertTestInOrg(organizationId, testId);
    const row = await this.repo.findSessionEvaluation(organizationId, testId, sessionId);
    if (!row) throw AppException.notFound('Sessão não encontrada');
    return toEvaluationView(row);
  }

  async rateSession(
    organizationId: string,
    userId: string,
    sessionId: string,
    dto: RateSessionRequest,
    req: Request,
  ): Promise<SessionRatingView> {
    const row = await this.repo.rateSession(organizationId, userId, sessionId, {
      rating: dto.rating,
      comment: dto.comment || null,
      markedInvalid: dto.markedInvalid,
    });
    if (!row) throw AppException.notFound('Sessão não encontrada');
    // M11: `sessionsValid` on the studio dashboard may have just changed.
    await this.dashboardKpis.invalidate(organizationId);

    recordAudit(req, {
      action: 'session.rated',
      entity: 'session_ratings',
      entityId: row.sessionId,
      before: null,
      after: { rating: row.rating, markedInvalid: row.markedInvalid },
    });
    return {
      sessionId: row.sessionId,
      rating: row.rating,
      comment: row.comment,
      markedInvalid: row.markedInvalid,
      ratedByUserId: row.ratedByUserId,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /* --------------------------- M10-04: async export --------------------------- */

  async requestExport(
    organizationId: string,
    userId: string,
    testId: string,
    dto: CreateReportExportRequest,
    req: Request,
  ): Promise<ReportExportView> {
    await this.assertTestInOrg(organizationId, testId);

    const row = await this.repo.createExport({
      id: newId(),
      organizationId,
      testId,
      requestedByUserId: userId,
      format: dto.format,
      status: 'processing',
    });

    // The insert and the enqueue share no transaction (OPS-01): if the enqueue
    // fails, mark the row failed now so the client sees it instead of polling a
    // `processing` row that no job will ever pick up.
    let current = row;
    try {
      await this.queue.ensureEnqueued(JobName.REPORT_EXPORT, reportExportJobId(row.id), {
        exportId: row.id,
      });
    } catch (err) {
      this.logger.error(`failed to enqueue report.export for ${row.id}: ${String(err)}`);
      await this.repo.markExportFailed(row.id, 'Falha ao agendar a exportação — tente novamente');
      current = {
        ...row,
        status: 'failed',
        failureReason: 'Falha ao agendar a exportação — tente novamente',
      };
    }

    recordAudit(req, {
      action: 'report.export.requested',
      entity: 'test_report_exports',
      entityId: row.id,
      before: null,
      after: { testId, format: dto.format },
    });
    return this.toExportView(current);
  }

  async getExport(
    organizationId: string,
    testId: string,
    exportId: string,
  ): Promise<ReportExportView> {
    const row = await this.repo.findExportInOrg(organizationId, testId, exportId);
    if (!row) throw AppException.notFound('Exportação não encontrada');
    return this.toExportView(row);
  }

  /** `downloadUrl` is presigned on every read — it is never persisted. */
  private async toExportView(row: TestReportExportRow): Promise<ReportExportView> {
    const downloadUrl =
      row.status === 'ready' && row.storageKey
        ? await this.storage.createDownloadUrl(row.storageKey, REPORT_DOWNLOAD_TTL_SECONDS)
        : null;
    return {
      id: row.id,
      testId: row.testId,
      format: row.format,
      status: row.status,
      downloadUrl,
      failureReason: row.failureReason,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  private async assertTestInOrg(organizationId: string, testId: string): Promise<void> {
    const exists = await this.repo.testExistsInOrg(organizationId, testId);
    if (!exists) throw AppException.notFound('Teste não encontrado');
  }
}

function toSessionView(row: ReportSessionRow): ReportSessionView {
  return {
    sessionId: row.sessionId,
    participationId: row.participationId,
    testerId: row.testerId,
    testerName: row.testerName,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    valid: row.valid,
    averageRating: row.averageRating,
    archetype: row.archetype,
    playerTier: row.playerTier,
    // AI session quality — deferred (BACKEND-SPEC §10).
    aiQualityScore: null,
    telemetryConnected: row.telemetryConnected,
  };
}

function isCurrentPayload(key: ReportBlockKey, payload: unknown): boolean {
  return reportBlockPayloadSchemas[key].safeParse(payload).success;
}

/**
 * The block union is discriminated by `key`; the payload is produced by the
 * computer registered for that same key (or validated by `isCurrentPayload`),
 * which is what makes this cast sound.
 */
function blockView(
  key: ReportBlockKey,
  status: ReportBlockView['status'],
  payload: object | null,
  computedAt: string | null,
): ReportBlockView {
  return { key, status, payload, computedAt } as ReportBlockView;
}

function toEvaluationView(row: SessionEvaluationRow): SessionEvaluationView {
  return {
    session: toSessionView(row.session),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    answers: row.answers.map((a) => ({
      questionId: a.questionId,
      prompt: a.prompt,
      type: a.type,
      valueText: a.valueText,
      valueNumber: a.valueNumber,
      valueBoolean: a.valueBoolean,
      optionLabels: (a.optionIds ?? []).map((id) => row.optionLabels.get(id) ?? id),
    })),
  };
}
