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
  ensureEnqueued(name: string, jobId: string, data: Record<string, unknown>): Promise<void>;
  /** Liveness/readiness check for /health. */
  healthCheck(): Promise<void>;
}

export const QUEUE_PORT = Symbol('QUEUE_PORT');
