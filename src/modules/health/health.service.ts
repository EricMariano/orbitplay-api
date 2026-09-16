import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { MAIN_QUEUE } from '../../infra/queue/queue.constants';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.port';

export type CheckStatus = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'error';
  checks: {
    database: CheckStatus;
    redis: CheckStatus;
    storage: CheckStatus;
    queue?: CheckStatus;
  };
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @InjectQueue(MAIN_QUEUE) private readonly queue: Queue,
  ) {}

  async check(): Promise<HealthReport> {
    const [database, redis, storage] = await Promise.all([
      this.safe(() => this.db.execute(sql`SELECT 1`)),
      this.safe(() => this.redis.ping()),
      this.safe(() => this.storage.healthCheck()),
    ]);

    const checks = { database, redis, storage };
    const allUp = Object.values(checks).every((c) => c === 'up');
    return { status: allUp ? 'ok' : 'error', checks };
  }

  /**
   * Readiness (M15): same three checks as liveness, plus the BullMQ queue —
   * an instance that can't enqueue a job shouldn't take traffic, but a
   * transient queue blip also shouldn't get the instance restarted (that's
   * what `/health` liveness is for).
   */
  async checkReady(): Promise<HealthReport> {
    const [database, redis, storage, queue] = await Promise.all([
      this.safe(() => this.db.execute(sql`SELECT 1`)),
      this.safe(() => this.redis.ping()),
      this.safe(() => this.storage.healthCheck()),
      this.safe(() => this.queue.getJobCounts()),
    ]);

    const checks = { database, redis, storage, queue };
    const allUp = Object.values(checks).every((c) => c === 'up');
    return { status: allUp ? 'ok' : 'error', checks };
  }

  private async safe(fn: () => Promise<unknown>): Promise<CheckStatus> {
    try {
      await fn();
      return 'up';
    } catch {
      return 'down';
    }
  }
}
