import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import { JobName, MAIN_QUEUE } from '../infra/queue/queue.constants';

/**
 * Standalone job worker — a SEPARATE process from the API (run with
 * `pnpm dev:worker` / `pnpm start:worker`). Consumes the main BullMQ queue.
 * Only a placeholder PING handler exists in this task; real processors land as
 * features arrive.
 */
function connectionFromEnv() {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    maxRetriesPerRequest: null,
  };
}

async function handle(job: Job): Promise<unknown> {
  switch (job.name) {
    case JobName.PING:
      return { pong: true, at: new Date().toISOString() };
    default:
      throw new Error(`Unknown job: ${job.name}`);
  }
}

const worker = new Worker(MAIN_QUEUE, handle, { connection: connectionFromEnv() });

worker.on('ready', () => console.log(`[worker] ready, consuming "${MAIN_QUEUE}"`));
worker.on('completed', (job) => console.log(`[worker] completed ${job.id} (${job.name})`));
worker.on('failed', (job, err) => console.error(`[worker] failed ${job?.id}: ${err.message}`));

async function shutdown(): Promise<void> {
  console.log('[worker] shutting down…');
  await worker.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
