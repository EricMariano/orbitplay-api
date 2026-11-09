import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestReportExportRow } from '../infra/database/schema/community';
import type { StoragePort } from '../shared/ports/storage.port';
import type { WorkerDeps } from './deps';
import { isFinalAttempt } from './handle-job';
import { processReportExport } from './report-export.processor';

vi.mock('../modules/reports/reports.repository', () => ({
  ReportsRepository: class {
    findAllSessions = vi.fn().mockResolvedValue([]);
  },
}));

const EXPORT_ID = '01990000-0000-7000-8000-0000000000e1';

function makeExport(overrides: Partial<TestReportExportRow> = {}): TestReportExportRow {
  return {
    id: EXPORT_ID,
    organizationId: '01990000-0000-7000-8000-0000000000a1',
    testId: '01990000-0000-7000-8000-0000000000c1',
    requestedByUserId: '01990000-0000-7000-8000-0000000000b1',
    format: 'csv',
    status: 'processing',
    storageKey: null,
    failureReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: null,
    ...overrides,
  };
}

/** Fake `WorkerDeps.db`: the export row first, then the test name; records every update. */
function makeDeps(row: TestReportExportRow, putObject: ReturnType<typeof vi.fn>) {
  const updates: Record<string, unknown>[] = [];
  const reads = [[row], [{ name: 'Teste' }]];
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => reads.shift() ?? [] }) }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return { where: async () => undefined };
      },
    }),
  };
  const deps = {
    db: db as unknown as WorkerDeps['db'],
    storage: { putObject } as unknown as StoragePort,
  } as WorkerDeps;
  return { deps, updates };
}

describe('processReportExport', () => {
  let putObject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    putObject = vi.fn().mockRejectedValue(new Error('storage blip'));
  });

  it('keeps the export processing (and rethrows) while BullMQ has attempts left', async () => {
    const { deps, updates } = makeDeps(makeExport(), putObject);

    await expect(processReportExport(deps, EXPORT_ID, { finalAttempt: false })).rejects.toThrow(
      'storage blip',
    );
    expect(updates).toEqual([]);
  });

  it('marks the export failed on the last attempt', async () => {
    const { deps, updates } = makeDeps(makeExport(), putObject);

    await expect(processReportExport(deps, EXPORT_ID, { finalAttempt: true })).rejects.toThrow(
      'storage blip',
    );
    expect(updates).toEqual([expect.objectContaining({ status: 'failed' })]);
  });

  it('a retry after a transient failure still renders the export', async () => {
    putObject.mockResolvedValue(undefined);
    const { deps, updates } = makeDeps(makeExport(), putObject);

    await processReportExport(deps, EXPORT_ID, { finalAttempt: false });

    expect(putObject).toHaveBeenCalledOnce();
    expect(updates).toEqual([expect.objectContaining({ status: 'ready' })]);
  });

  it('leaves an export that is no longer processing alone', async () => {
    const { deps, updates } = makeDeps(makeExport({ status: 'failed' }), putObject);

    await processReportExport(deps, EXPORT_ID, { finalAttempt: false });

    expect(putObject).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});

describe('isFinalAttempt', () => {
  it('follows BullMQ: retried while attemptsMade + 1 < attempts', () => {
    expect(isFinalAttempt({ attemptsMade: 0, opts: { attempts: 3 } })).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 3 } })).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 2, opts: { attempts: 3 } })).toBe(true);
  });

  it('treats a job added without attempts as single-run', () => {
    expect(isFinalAttempt({ attemptsMade: 0, opts: {} })).toBe(true);
  });
});
