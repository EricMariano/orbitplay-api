import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QUEUE_PORT } from '../../shared/ports/queue.port';
import { BullMqQueueAdapter } from './bullmq-queue.adapter';
import { redisConnectionOptions } from './connection';
import { MAIN_QUEUE } from './queue.constants';

/**
 * BullMQ wiring. The API enqueues jobs; the separate worker process
 * (src/workers/main.worker.ts) consumes them. Both point at the same Redis.
 * Feature services depend on `QUEUE_PORT`, not BullMQ directly (mirrors
 * `StorageModule`/`STORAGE_PORT`) — `BullModule` stays exported only for
 * health checks and other infra that legitimately needs the raw queue.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnectionOptions(config.get<string>('redis.url')!),
      }),
    }),
    BullModule.registerQueue({ name: MAIN_QUEUE }),
  ],
  providers: [{ provide: QUEUE_PORT, useClass: BullMqQueueAdapter }],
  exports: [BullModule, QUEUE_PORT],
})
export class QueueModule {}
