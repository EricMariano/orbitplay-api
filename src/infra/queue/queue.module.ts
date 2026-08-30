import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
      useFactory: (config: ConfigService) => {
        const url = new URL(config.get<string>('redis.url')!);
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            // Required by BullMQ blocking commands.
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    BullModule.registerQueue({ name: MAIN_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
