import type { Queue } from 'bullmq';

/**
 * A job that already failed this many runs is failing deterministically (a
 * poison input, a row that can't be saved): retrying it on every sweep would
 * loop forever, re-downloading and re-processing the same object each time.
 */
export const MAX_JOB_RUNS = 5;

/** What `ensureJobEnqueued` did — `exhausted` means it gave up on a failed job. */
export type EnsureJobOutcome = 'enqueued' | 'retried' | 'exists' | 'exhausted';

/**
 * Idempotently makes sure a job will run, keyed by a deterministic `jobId`
 * (OPS-01). Three different callers can race to call this for the same
 * resource — the original request right after its DB insert, a client
 * retrying that request, and the periodic reconciliation sweep — and none
 * of them can tell from the DB row alone whether a job is already
 * waiting/running for it. Rather than track that separately, this asks
 * BullMQ directly:
 *   - no job with this id exists yet → enqueue one;
 *   - one exists and is `failed` (e.g. the worker crashed mid-run) → retry it,
 *     until it has failed `MAX_JOB_RUNS` times (BullMQ keeps `attemptsMade`
 *     across retries) — then leave it failed and report `exhausted`;
 *   - one exists and is waiting/active/delayed/completed → leave it alone.
 * Never creates a duplicate, never silently drops a resource that needs a
 * job.
 */
export async function ensureJobEnqueued(
  queue: Queue,
  name: string,
  jobId: string,
  data: Record<string, unknown>,
): Promise<EnsureJobOutcome> {
  const existing = await queue.getJob(jobId);
  if (!existing) {
    await queue.add(name, data, { jobId });
    return 'enqueued';
  }

  const state = await existing.getState();
  if (state !== 'failed') return 'exists';
  if (existing.attemptsMade >= MAX_JOB_RUNS) return 'exhausted';

  await existing.retry();
  return 'retried';
}
