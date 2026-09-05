import type { Job } from 'bullmq';
import { JobName } from '../infra/queue/queue.constants';
import type { WorkerDeps } from './deps';
import { processMediaExtractAudio, processMediaTranscode } from './media.processor';

export async function handleJob(job: Job, deps: WorkerDeps): Promise<unknown> {
  switch (job.name) {
    case JobName.PING:
      return { pong: true, at: new Date().toISOString() };
    case JobName.MEDIA_TRANSCODE:
      await processMediaTranscode(deps, job.data.recordingId as string);
      return { recordingId: job.data.recordingId };
    case JobName.MEDIA_EXTRACT_AUDIO:
      await processMediaExtractAudio(deps, job.data.recordingId as string);
      return { recordingId: job.data.recordingId };
    default:
      throw new Error(`Unknown job: ${job.name}`);
  }
}
