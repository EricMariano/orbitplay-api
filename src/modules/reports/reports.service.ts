import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import type {
  TestReportExportRow,
  TestReportSnapshotRow,
} from '../../infra/database/schema/community';
import { newId } from '../../infra/database/schema/_helpers';
import { JobName, reportExportJobId } from '../../infra/queue/queue.constants';
import { recordAudit } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import { QUEUE_PORT, type QueuePort } from '../../shared/ports/queue.port';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.port';
import {
  reportBlockKeyValues,
  type CreateReportExportRequest,
  type ReportBlockKey,
  type ReportBlockView,
  type ReportExportView,
  type ReportSessionQuery,
  type ReportSessionView,
  type SessionEvaluationView,
  type TestReportView,
} from './dto/report.dto';
import {
  ReportsRepository,
  type ReportSessionRow,
  type SessionEvaluationRow,
} from './reports.repository';

/** Download links for a finished export stay valid for 15 minutes. */
export const REPORT_DOWNLOAD_TTL_SECONDS = 900;

type BlockComputer = () => Promise<Record<string, unknown>>;

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly repo: ReportsRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
  ) {}

  /* ------------------------------ M10-02: blocks ----------------------------- */

  /**
   * Returns every report block. Blocks are computed on demand and cached as
   * `test_report_snapshots` rows; each block is computed on its own, so one
   * failing block is reported as `failed` without hiding the others.
   */
  async getReport(organizationId: string, testId: string): Promise<TestReportView> {
    await this.assertTestInOrg(organizationId, testId);

    const stored = new Map<string, TestReportSnapshotRow>(
      (await this.repo.findSnapshots(testId)).map((s) => [s.blockKey, s]),
    );

    const blocks = await Promise.all(
      reportBlockKeyValues.map(async (key): Promise<ReportBlockView> => {
        const existing = stored.get(key);
        if (existing && existing.status === 'ready') return this.toBlockView(existing);
        return this.computeBlock(testId, key);
      }),
    );
    return { testId, blocks };
  }

  private async computeBlock(testId: string, key: ReportBlockKey): Promise<ReportBlockView> {
    try {
      const payload = await this.blockComputers(testId)[key]();
      await this.repo.upsertSnapshot(testId, key, { status: 'ready', payload });
      return { key, status: 'ready', payload, computedAt: new Date().toISOString() };
    } catch (err) {
      this.logger.error(`report block "${key}" failed for test ${testId}: ${String(err)}`);
      await this.repo.upsertSnapshot(testId, key, { status: 'failed' }).catch(() => undefined);
      return { key, status: 'failed', payload: null, computedAt: null };
    }
  }

  private blockComputers(testId: string): Record<ReportBlockKey, BlockComputer> {
    return {
      overview: () => this.repo.computeOverview(testId),
      evolution: () => this.repo.computeEvolution(testId),
      rating_distribution: () => this.repo.computeRatingDistribution(testId),
      tester_profile: () => this.repo.computeTesterProfile(testId),
    };
  }

  private toBlockView(row: TestReportSnapshotRow): ReportBlockView {
    return {
      key: row.blockKey as ReportBlockKey,
      status: row.status,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      computedAt: row.computedAt?.toISOString() ?? null,
    };
  }

  /* ------------------------ M10-03: sessions & evaluation --------------------- */

  async listSessions(
    organizationId: string,
    testId: string,
    query: ReportSessionQuery,
  ): Promise<{ data: ReportSessionView[]; nextCursor: string | null }> {
    await this.assertTestInOrg(organizationId, testId);
    const page = await this.repo.listSessions(organizationId, testId, query);
    return { data: page.data.map(toSessionView), nextCursor: page.nextCursor };
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
  };
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
