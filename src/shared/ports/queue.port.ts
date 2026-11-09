/**
 * Background job queue capability. Implemented by the BullMQ adapter in
 * every environment — services depend on this port instead of importing
 * `bullmq`/`@nestjs/bullmq` directly (mirrors `StoragePort`).
 */
export interface QueuePort {
  /**
   * Idempotently ensures a job will run, keyed by a deterministic `jobId`
   * (OPS-01). Multiple callers — the original request, a client retry, the
   * periodic reconciliation sweep — can race to call this for the same
   * resource:
   *   - no job with this id exists yet → enqueue one;
   *   - one exists and is `failed` (e.g. the worker crashed mid-run) → retry it;
   *   - one exists and is waiting/active/delayed/completed → leave it alone.
   * Never creates a duplicate, never silently drops a resource that needs a
   * job.
   */
  ensureEnqueued(
    name: string,
    jobId: string,
    data: Record<string, unknown>,
    options?: EnsureJobOptions,
  ): Promise<void>;
  /** Liveness/readiness check for /health. */
  healthCheck(): Promise<void>;
}

export interface EnsureJobOptions {
  /**
   * The resource behind `jobId` was recreated (e.g. a failed build confirmed
   * again with the same id): a `completed` job belongs to its previous life and
   * must run again. Without this, the new row waited on a job that would never
   * run, and the sweep kept answering `exists` — `processing` forever.
   */
  rerunCompleted?: boolean;
}

export const QUEUE_PORT = Symbol('QUEUE_PORT');
