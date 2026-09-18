import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { redisConnectionOptions } from './connection';
import { MAIN_QUEUE } from './queue.constants';

/**
 * BullMQ wiring. The API enqueues jobs; the separate worker process
 * (src/workers/main.worker.ts) consumes them. Both point at the same Redis.
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
  exports: [BullModule],
})
export class QueueModule {}
