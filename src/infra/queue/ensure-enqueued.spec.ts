import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { ensureJobEnqueued, MAX_JOB_RUNS } from './ensure-enqueued';
import { JobName } from './queue.constants';

function fakeQueue(job: { state: string; attemptsMade: number } | null) {
  const retry = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const add = vi.fn(async () => undefined);
  const queue = {
    getJob: async () =>
      job && { attemptsMade: job.attemptsMade, getState: async () => job.state, retry, remove },
    add,
  };
  return { queue: queue as unknown as Queue, add, retry, remove };
}

describe('ensureJobEnqueued', () => {
  it('enqueues a job that does not exist yet', async () => {
    const { queue, add } = fakeQueue(null);
    await expect(ensureJobEnqueued(queue, 'job', 'id', {})).resolves.toBe('enqueued');
    expect(add).toHaveBeenCalledWith('job', {}, { jobId: 'id' });
  });

  it('adds the per-job retry options (report.export retries on its own)', async () => {
    const { queue, add } = fakeQueue(null);
    await ensureJobEnqueued(queue, JobName.REPORT_EXPORT, 'report-export-1', { exportId: '1' });
    expect(add).toHaveBeenCalledWith(
      JobName.REPORT_EXPORT,
      { exportId: '1' },
      expect.objectContaining({ jobId: 'report-export-1', attempts: 3 }),
    );
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

  it('re-runs a completed job when the resource was recreated (rerunCompleted)', async () => {
    const { queue, add, remove } = fakeQueue({ state: 'completed', attemptsMade: 1 });
    await expect(
      ensureJobEnqueued(queue, 'job', 'id', { a: 1 }, { rerunCompleted: true }),
    ).resolves.toBe('enqueued');
    expect(remove).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith('job', { a: 1 }, { jobId: 'id' });
  });

  it.each(['waiting', 'active', 'delayed'])(
    'never replaces a %s job, even with rerunCompleted',
    async (state) => {
      const { queue, add, remove } = fakeQueue({ state, attemptsMade: 0 });
      await expect(
        ensureJobEnqueued(queue, 'job', 'id', {}, { rerunCompleted: true }),
      ).resolves.toBe('exists');
      expect(remove).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
    },
  );

  it('leaves a completed job alone by default', async () => {
    const { queue, add, remove } = fakeQueue({ state: 'completed', attemptsMade: 1 });
    await expect(ensureJobEnqueued(queue, 'job', 'id', {})).resolves.toBe('exists');
    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
