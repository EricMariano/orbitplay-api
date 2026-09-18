import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { buildConfig } from '../config/configuration';
import { validateEnv } from '../config/env.schema';
import type { Database } from '../infra/database/database.module';
import * as schema from '../infra/database/schema';
import { redisConnectionOptions } from '../infra/queue/connection';
import { MAIN_QUEUE } from '../infra/queue/queue.constants';
import { MinioStorageAdapter } from '../infra/storage/minio-storage.adapter';
import type { StoragePort } from '../shared/ports/storage.port';

export interface WorkerDeps {
  db: Database;
  storage: StoragePort;
  sql: postgres.Sql;
  /** Lets a processor re-enqueue work (the reconciliation sweep, OPS-01). */
  queue: Queue;
}

export async function createWorkerDeps(): Promise<WorkerDeps> {
  const config = buildConfig(validateEnv(process.env));
  const sql = postgres(config.database.url, { max: 2, onnotice: () => {} });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  const storage = new MinioStorageAdapter(
    new ConfigService({ storage: config.storage }) as ConfigService,
  );
  const queue = new Queue(MAIN_QUEUE, { connection: redisConnectionOptions(config.redis.url) });
  return { db, storage, sql, queue };
}

export async function closeWorkerDeps(deps: WorkerDeps): Promise<void> {
  await deps.queue.close();
  await deps.sql.end({ timeout: 5 });
}
