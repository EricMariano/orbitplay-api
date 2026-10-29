import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { ensureJobEnqueued, MAX_JOB_RUNS } from './ensure-enqueued';

function fakeQueue(job: { state: string; attemptsMade: number } | null) {
  const retry = vi.fn(async () => undefined);
  const add = vi.fn(async () => undefined);
  const queue = {
    getJob: async () =>
      job && { attemptsMade: job.attemptsMade, getState: async () => job.state, retry },
    add,
  };
  return { queue: queue as unknown as Queue, add, retry };
}

describe('ensureJobEnqueued', () => {
  it('enqueues a job that does not exist yet', async () => {
    const { queue, add } = fakeQueue(null);
    await expect(ensureJobEnqueued(queue, 'job', 'id', {})).resolves.toBe('enqueued');
    expect(add).toHaveBeenCalledWith('job', {}, { jobId: 'id' });
  });

  it('leaves a waiting, running or completed job alone', async () => {
    for (const state of ['waiting', 'active', 'completed']) {
      const { queue, retry, add } = fakeQueue({ state, attemptsMade: 0 });
      await expect(ensureJobEnqueued(queue, 'job', 'id', {})).resolves.toBe('exists');
      expect(retry).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
    }
  });

  it('retries a failed job while it has runs left', async () => {
    const { queue, retry } = fakeQueue({ state: 'failed', attemptsMade: MAX_JOB_RUNS - 1 });
    await expect(ensureJobEnqueued(queue, 'job', 'id', {})).resolves.toBe('retried');
    expect(retry).toHaveBeenCalledOnce();
  });

  it('gives up on a job that failed every run, instead of retrying it forever', async () => {
    const { queue, retry } = fakeQueue({ state: 'failed', attemptsMade: MAX_JOB_RUNS });
    await expect(ensureJobEnqueued(queue, 'job', 'id', {})).resolves.toBe('exhausted');
    expect(retry).not.toHaveBeenCalled();
  });
});
