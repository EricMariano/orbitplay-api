import { Global, Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { redisFailFastOptions } from '../queue/connection';
import { DashboardKpiCache } from './dashboard-kpi-cache';
import { attachRedisErrorLogging } from './redis-error-logging';
import { REDIS_CLIENT } from './redis.tokens';

// Token lives in its own file so providers declared here (DashboardKpiCache)
// can inject it without a circular import back into this module.
export { REDIS_CLIENT };

/**
 * Global Redis client (ioredis) used by the idempotency store, the rate
 * limiters and the heartbeat/upload-session keys. BullMQ manages its own
 * connections from REDIS_URL separately.
 *
 * Request-path client: during an outage a command is rejected after
 * `commandTimeout` (see `redisFailFastOptions`) instead of being queued until
 * Redis returns — otherwise every request that touches Redis hangs until the
 * HTTP client gives up. ioredis still reconnects in the background, so the
 * client heals by itself when Redis comes back.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('redis.url')!;
        const client = new Redis(url, redisFailFastOptions());
        const logger = new Logger('Redis');
        attachRedisErrorLogging(client, 'REDIS_CLIENT', (message) => logger.warn(message));
        return client;
      },
    },
    DashboardKpiCache,
  ],
  exports: [REDIS_CLIENT, DashboardKpiCache],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // Redis already unreachable: QUIT can't complete, drop the socket instead.
      this.redis.disconnect();
    }
  }
}
