import type { Queue } from 'bullmq';

/**
 * Idempotently makes sure a job will run, keyed by a deterministic `jobId`
 * (OPS-01). Three different callers can race to call this for the same
 * resource — the original request right after its DB insert, a client
 * retrying that request, and the periodic reconciliation sweep — and none
 * of them can tell from the DB row alone whether a job is already
 * waiting/running for it. Rather than track that separately, this asks
 * BullMQ directly:
 *   - no job with this id exists yet → enqueue one;
 *   - one exists and is `failed` (e.g. the worker crashed mid-run) → retry it;
 *   - one exists and is waiting/active/delayed/completed → leave it alone.
 * Never creates a duplicate, never silently drops a resource that needs a
 * job.
 */
export async function ensureJobEnqueued(
  queue: Queue,
  name: string,
  jobId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const existing = await queue.getJob(jobId);
  if (!existing) {
    await queue.add(name, data, { jobId });
    return;
  }

  const state = await existing.getState();
  if (state === 'failed') {
    await existing.retry();
  }
}
