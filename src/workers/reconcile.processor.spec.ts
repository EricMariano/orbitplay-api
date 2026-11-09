import type { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';
import { createdAtFromUuidV7 } from '../shared/util/uuid';
import {
  PURGE_BATCH_SIZE,
  PURGE_MAX_BATCHES,
  purgeInBatches,
  SWEEP_BATCH_SIZE,
  SWEEP_MAX_BATCHES,
  sweepInBatches,
  uuidV7Floor,
} from './reconcile.processor';

describe('uuidV7Floor', () => {
  it('sorts below every UUIDv7 created at or after the instant, above every earlier one', () => {
    const at = new Date('2026-11-09T12:00:00.000Z');
    const floor = uuidV7Floor(at);

    expect(createdAtFromUuidV7(floor).getTime()).toBe(at.getTime());
    const before = uuidv7({ msecs: at.getTime() - 1 });
    const same = uuidv7({ msecs: at.getTime() });
    const after = uuidv7({ msecs: at.getTime() + 1 });
    // Postgres compares uuid bytewise — same order as the lowercase hex string.
    expect(before < floor).toBe(true);
    expect(same >= floor).toBe(true);
    expect(after > floor).toBe(true);
  });
});

function fakeRedis(saved: string | null = null) {
  return {
    get: vi.fn().mockResolvedValue(saved),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };
}

const ids = (n: number) => Array.from({ length: n }, () => ({ id: uuidv7() }));

describe('sweepInBatches', () => {
  it('pages by id until a short page, then clears the saved cursor', async () => {
    const redis = fakeRedis(uuidv7());
    const pages = [ids(SWEEP_BATCH_SIZE), ids(3)];
    const fetchBatch = vi.fn((_afterId: string | null, _limit: number) =>
      Promise.resolve(pages.shift() ?? []),
    );
    const handled: number[] = [];

    await sweepInBatches({ redis: redis as unknown as Redis }, 'scan', fetchBatch, (rows) =>
      Promise.resolve(void handled.push(rows.length)),
    );

    expect(handled).toEqual([SWEEP_BATCH_SIZE, 3]);
    expect(fetchBatch).toHaveBeenCalledTimes(2);
    // The second page starts after the last id of the first.
    expect(fetchBatch.mock.calls[1][0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(redis.del).toHaveBeenCalledWith('reconcile:cursor:scan');
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('stops after the batch budget and saves where it stopped for the next sweep', async () => {
    const redis = fakeRedis();
    let last = '';
    const fetchBatch = vi.fn(() => {
      const page = ids(SWEEP_BATCH_SIZE);
      last = page[page.length - 1].id;
      return Promise.resolve(page);
    });

    await sweepInBatches({ redis: redis as unknown as Redis }, 'scan', fetchBatch, () =>
      Promise.resolve(),
    );

    expect(fetchBatch).toHaveBeenCalledTimes(SWEEP_MAX_BATCHES);
    expect(redis.set).toHaveBeenCalledWith('reconcile:cursor:scan', last, 'EX', expect.any(Number));
  });

  it('resumes from the saved cursor, ignoring one that is not a uuid', async () => {
    const cursor = uuidv7();
    const resumed = vi.fn(() => Promise.resolve([]));
    await sweepInBatches({ redis: fakeRedis(cursor) as unknown as Redis }, 'scan', resumed, () =>
      Promise.resolve(),
    );
    expect(resumed).toHaveBeenCalledWith(cursor, SWEEP_BATCH_SIZE);

    const garbage = vi.fn(() => Promise.resolve([]));
    await sweepInBatches(
      { redis: fakeRedis('not-a-uuid') as unknown as Redis },
      'scan',
      garbage,
      () => Promise.resolve(),
    );
    expect(garbage).toHaveBeenCalledWith(null, SWEEP_BATCH_SIZE);
  });
});

describe('purgeInBatches', () => {
  it('deletes batch after batch until one comes back short', async () => {
    const sizes = [PURGE_BATCH_SIZE, PURGE_BATCH_SIZE, 7];
    const deleteBatch = vi.fn(() => Promise.resolve(sizes.shift() ?? 0));

    await expect(purgeInBatches(deleteBatch)).resolves.toBe(2 * PURGE_BATCH_SIZE + 7);
    expect(deleteBatch).toHaveBeenCalledTimes(3);
    expect(deleteBatch).toHaveBeenCalledWith(PURGE_BATCH_SIZE);
  });

  it('never runs more than the per-sweep budget', async () => {
    const deleteBatch = vi.fn(() => Promise.resolve(PURGE_BATCH_SIZE));
    await purgeInBatches(deleteBatch);
    expect(deleteBatch).toHaveBeenCalledTimes(PURGE_MAX_BATCHES);
  });
});
