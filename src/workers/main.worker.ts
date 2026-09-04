import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import { MAIN_QUEUE } from '../infra/queue/queue.constants';
import { closeWorkerDeps, createWorkerDeps } from './deps';
import { handleJob } from './handle-job';

/**
 * Standalone job worker — a SEPARATE process from the API (run with
 * `pnpm dev:worker` / `pnpm start:worker`). Consumes the main BullMQ queue.
 */
function connectionFromEnv() {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    maxRetriesPerRequest: null,
  };
}

async function main(): Promise<void> {
  const deps = await createWorkerDeps();
  const worker = new Worker(MAIN_QUEUE, (job: Job) => handleJob(job, deps), {
    connection: connectionFromEnv(),
  });

  worker.on('ready', () => console.log(`[worker] ready, consuming "${MAIN_QUEUE}"`));
  worker.on('completed', (job) => console.log(`[worker] completed ${job.id} (${job.name})`));
  worker.on('failed', (job, err) => console.error(`[worker] failed ${job?.id}: ${err.message}`));

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
