import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.port';

export type CheckStatus = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'error';
  checks: {
    database: CheckStatus;
    redis: CheckStatus;
    storage: CheckStatus;
  };
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
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

  private async safe(fn: () => Promise<unknown>): Promise<CheckStatus> {
    try {
      await fn();
      return 'up';
    } catch {
      return 'down';
    }
  }
}
