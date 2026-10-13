import { describe, expect, it, vi } from 'vitest';
import type { Database } from './database.module';
import {
  invalidateReportSnapshots,
  isSnapshotFresh,
  REPORT_SNAPSHOT_TTL_SECONDS,
} from './report-snapshot-cache';

describe('isSnapshotFresh', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');

  it('serves a snapshot computed within the TTL', () => {
    expect(isSnapshotFresh(new Date(now.getTime() - 1000), now)).toBe(true);
  });

  it('recomputes a snapshot past the TTL or without computedAt', () => {
    const old = new Date(now.getTime() - REPORT_SNAPSHOT_TTL_SECONDS * 1000);
    expect(isSnapshotFresh(old, now)).toBe(false);
    expect(isSnapshotFresh(null, now)).toBe(false);
  });
});

describe('invalidateReportSnapshots', () => {
  it('never throws — a failed delete must not fail the triggering write', async () => {
    const where = vi.fn().mockRejectedValue(new Error('db down'));
    const db = { delete: vi.fn().mockReturnValue({ where }) } as unknown as Database;
    const logger = { warn: vi.fn() };

    await expect(invalidateReportSnapshots(db, 'test-1', logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('test-1'));
  });
});
