import { and, eq } from 'drizzle-orm';
import { testReportExports } from '../infra/database/schema/community';
import { tests } from '../infra/database/schema/tests';
import { ReportsRepository } from '../modules/reports/reports.repository';
import type { WorkerDeps } from './deps';
import { renderCsv, renderPdf } from './report-render';

const CONTENT_TYPES = { csv: 'text/csv; charset=utf-8', pdf: 'application/pdf' } as const;

/** `orgs/<org>/tests/<test>/reports/<export>.<ext>` — same `orgs/…` layout as builds/recordings. */
export function buildReportStorageKey(
  organizationId: string,
  testId: string,
  exportId: string,
  format: 'csv' | 'pdf',
): string {
  return `orgs/${organizationId}/tests/${testId}/reports/${exportId}.${format}`;
}

/**
 * Renders one report export end to end: load the sessions, render the file,
 * upload it through `StoragePort`, then flip the row to `ready`.
 *
 * - Idempotent: BullMQ can redeliver a job, so an export that is already
 *   `ready`/`failed` is left alone.
 * - The row only becomes `ready` AFTER the upload succeeded, so a `ready`
 *   row always points at a real object.
 * - On error the row is marked `failed` (never left `processing` forever)
 *   and the error is rethrown so BullMQ's own retry/failed bookkeeping runs.
 */
export async function processReportExport(deps: WorkerDeps, exportId: string): Promise<void> {
  const rows = await deps.db
    .select()
    .from(testReportExports)
    .where(eq(testReportExports.id, exportId))
    .limit(1);
  const job = rows[0];
  if (!job) throw new Error(`report export ${exportId} not found`);
  if (job.status !== 'processing') return;

  try {
    const repo = new ReportsRepository(deps.db);
    const sessions = await repo.findAllSessions(job.organizationId, job.testId);
    const title = await reportTitle(deps, job.testId);

    const body = job.format === 'csv' ? renderCsv(sessions) : renderPdf(title, sessions);
    const key = buildReportStorageKey(job.organizationId, job.testId, job.id, job.format);
    await deps.storage.putObject(key, body, CONTENT_TYPES[job.format]);

    await deps.db
      .update(testReportExports)
      .set({ status: 'ready', storageKey: key, failureReason: null, completedAt: new Date() })
      .where(and(eq(testReportExports.id, job.id), eq(testReportExports.status, 'processing')));
  } catch (err) {
    await deps.db
      .update(testReportExports)
      .set({ status: 'failed', failureReason: 'Falha ao gerar o arquivo', completedAt: new Date() })
      .where(and(eq(testReportExports.id, job.id), eq(testReportExports.status, 'processing')));
    throw err;
  }
}

async function reportTitle(deps: WorkerDeps, testId: string): Promise<string> {
  const rows = await deps.db
    .select({ name: tests.name })
    .from(tests)
    .where(eq(tests.id, testId))
    .limit(1);
  return `Relatório — ${rows[0]?.name ?? 'Teste sem título'}`;
}
