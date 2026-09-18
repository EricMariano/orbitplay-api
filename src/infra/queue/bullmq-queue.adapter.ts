import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { QueuePort } from '../../shared/ports/queue.port';
import { ensureJobEnqueued } from './ensure-enqueued';
import { MAIN_QUEUE } from './queue.constants';

@Injectable()
export class BullMqQueueAdapter implements QueuePort {
  constructor(@InjectQueue(MAIN_QUEUE) private readonly queue: Queue) {}

  async ensureEnqueued(name: string, jobId: string, data: Record<string, unknown>): Promise<void> {
    await ensureJobEnqueued(this.queue, name, jobId, data);
  }

  async healthCheck(): Promise<void> {
    await this.queue.getJobCounts();
  }
}
