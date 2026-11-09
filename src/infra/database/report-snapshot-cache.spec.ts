import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './database.module';
import {
  invalidateReportSnapshots,
  isSnapshotFresh,
  REPORT_RECOMPUTE_LOCK_TTL_MS,
  REPORT_SNAPSHOT_TTL_SECONDS,
  ReportRecomputeLock,
  reportRecomputeLockKey,
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
  it('marks the blocks stale instead of deleting them (the payload stays servable)', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    const db = { update: vi.fn().mockReturnValue({ set }), delete: vi.fn() };

    await invalidateReportSnapshots(db as unknown as Database, 'test-1');

    expect(set).toHaveBeenCalledWith({ computedAt: null });
    expect(where).toHaveBeenCalledOnce();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('never throws — a failed write must not fail the triggering write', async () => {
    const where = vi.fn().mockRejectedValue(new Error('db down'));
    const db = {
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where }) }),
    } as unknown as Database;
    const logger = { warn: vi.fn() };

    await expect(invalidateReportSnapshots(db, 'test-1', logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('test-1'));
  });
});

describe('ReportRecomputeLock', () => {
  function makeRedis(
    overrides: Partial<Record<'set' | 'eval' | 'exists', ReturnType<typeof vi.fn>>> = {},
  ) {
    return {
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn().mockResolvedValue(1),
      exists: vi.fn().mockResolvedValue(0),
      ...overrides,
    };
  }

  it('takes the lock with SET NX and a short TTL, and releases only its own token', async () => {
    const redis = makeRedis();
    const lock = new ReportRecomputeLock(redis as unknown as Redis);

    const lease = await lock.tryAcquire('test-1');
    expect(lease).not.toBeNull();
    const [key, token, px, ttl, nx] = redis.set.mock.calls[0] as unknown[];
    expect([key, px, ttl, nx]).toEqual([
      reportRecomputeLockKey('test-1'),
      'PX',
      REPORT_RECOMPUTE_LOCK_TTL_MS,
      'NX',
    ]);

    await lease?.release();
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1]) == ARGV[1]"),
      1,
      reportRecomputeLockKey('test-1'),
      token,
    );
  });

  it('answers null while another request holds it', async () => {
    const lock = new ReportRecomputeLock(
      makeRedis({ set: vi.fn().mockResolvedValue(null) }) as unknown as Redis,
    );
    await expect(lock.tryAcquire('test-1')).resolves.toBeNull();
  });

  it('hands out a no-op lease when Redis is down (recompute inline, as before)', async () => {
    const redis = makeRedis({ set: vi.fn().mockRejectedValue(new Error('redis down')) });
    const lock = new ReportRecomputeLock(redis as unknown as Redis);

    const lease = await lock.tryAcquire('test-1');
    expect(lease).not.toBeNull();
    await expect(lease?.release()).resolves.toBeUndefined();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('stops waiting as soon as the lock is gone, and never waits past the bound', async () => {
    const exists = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const lock = new ReportRecomputeLock(makeRedis({ exists }) as unknown as Redis);
    await lock.waitForRelease('test-1', 1_000);
    expect(exists).toHaveBeenCalledTimes(2);

    const stuck = new ReportRecomputeLock(
      makeRedis({ exists: vi.fn().mockResolvedValue(1) }) as unknown as Redis,
    );
    const started = Date.now();
    await stuck.waitForRelease('test-1', 150);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
