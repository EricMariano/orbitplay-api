import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { DashboardKpiCache } from './dashboard-kpi-cache';
import { REDIS_CLIENT } from './redis.tokens';

// Token lives in its own file so providers declared here (DashboardKpiCache)
// can inject it without a circular import back into this module.
export { REDIS_CLIENT };

/**
 * Global Redis client (ioredis) used by the idempotency store and available to
 * any module. BullMQ manages its own connections from REDIS_URL separately.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('redis.url')!;
        return new Redis(url, { maxRetriesPerRequest: null });
      },
    },
    DashboardKpiCache,
  ],
  exports: [REDIS_CLIENT, DashboardKpiCache],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
