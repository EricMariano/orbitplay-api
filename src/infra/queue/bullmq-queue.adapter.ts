import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { QueuePort } from '../../shared/ports/queue.port';
import { withTimeout } from '../../shared/util/with-timeout';
import { attachRedisErrorLogging } from '../redis/redis-error-logging';
import { ensureJobEnqueued } from './ensure-enqueued';
import { MAIN_QUEUE } from './queue.constants';

/**
 * BullMQ producers wait for the Redis connection to be ready, so with Redis down
 * `queue.add()` would hang the request. Bound it: the timeout surfaces as a 503.
 */
const ENQUEUE_TIMEOUT_MS = 5_000;

@Injectable()
export class BullMqQueueAdapter implements QueuePort {
  private readonly logger = new Logger(BullMqQueueAdapter.name);

  constructor(@InjectQueue(MAIN_QUEUE) private readonly queue: Queue) {
    // Without an 'error' listener a Redis outage surfaces as unhandled error events.
    attachRedisErrorLogging(queue, 'bullmq queue', (message) => this.logger.warn(message));
  }

  async ensureEnqueued(name: string, jobId: string, data: Record<string, unknown>): Promise<void> {
    await withTimeout(
      ensureJobEnqueued(this.queue, name, jobId, data),
      ENQUEUE_TIMEOUT_MS,
      'BullMQ enqueue',
    );
  }

  async healthCheck(): Promise<void> {
    await this.queue.getJobCounts();
  }
}
