import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import { redisConnectionOptions } from '../infra/queue/connection';
import { JobName, MAIN_QUEUE } from '../infra/queue/queue.constants';
import { closeWorkerDeps, createWorkerDeps } from './deps';
import { handleJob } from './handle-job';

/**
 * Standalone job worker — a SEPARATE process from the API (run with
 * `pnpm dev:worker` / `pnpm start:worker`). Consumes the main BullMQ queue.
 */
function connectionFromEnv() {
  return redisConnectionOptions(process.env.REDIS_URL ?? 'redis://localhost:6379');
}

const RECONCILE_JOB_ID = 'reconcile-stuck-jobs';
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const deps = await createWorkerDeps();
  const worker = new Worker(MAIN_QUEUE, (job: Job) => handleJob(job, deps), {
    connection: connectionFromEnv(),
  });

  worker.on('ready', () => console.log(`[worker] ready, consuming "${MAIN_QUEUE}"`));
  worker.on('completed', (job) => console.log(`[worker] completed ${job.id} (${job.name})`));
  worker.on('failed', (job, err) => console.error(`[worker] failed ${job?.id}: ${err.message}`));

  // OPS-01: the reconciliation sweep is itself just a repeatable job on the
  // same queue — `upsertJobScheduler` makes registering it on every worker
  // boot idempotent (update, not duplicate) once it's already scheduled.
  await deps.queue.upsertJobScheduler(
    RECONCILE_JOB_ID,
    { every: RECONCILE_INTERVAL_MS },
    { name: JobName.RECONCILE_STUCK_JOBS, data: {} },
  );

  async function shutdown(): Promise<void> {
    console.log('[worker] shutting down…');
    await worker.close();
    await closeWorkerDeps(deps);
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
