import type { Job } from 'bullmq';
import { JobName } from '../infra/queue/queue.constants';
import { processBuildValidate } from './build.processor';
import type { WorkerDeps } from './deps';
import { processMediaExtractAudio, processMediaTranscode } from './media.processor';
import { processReconcileStuckJobs } from './reconcile.processor';
import { processReportExport } from './report-export.processor';
import { processSessionValidate } from './session.processor';

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
    case JobName.BUILD_VALIDATE:
      await processBuildValidate(deps, job.data.buildId as string);
      return { buildId: job.data.buildId };
    case JobName.RECONCILE_STUCK_JOBS:
      await processReconcileStuckJobs(deps);
      return { reconciledAt: new Date().toISOString() };
    case JobName.SESSION_VALIDATE: {
      const outcome = await processSessionValidate(deps, job.data.sessionId as string);
      return { sessionId: job.data.sessionId, outcome };
    }
    case JobName.REPORT_EXPORT:
      await processReportExport(deps, job.data.exportId as string, {
        finalAttempt: isFinalAttempt(job),
      });
      return { exportId: job.data.exportId };
    default:
      throw new Error(`Unknown job: ${job.name}`);
  }
}

/**
 * Whether a failure of this run is the job's last: BullMQ retries while
 * `attemptsMade + 1 < attempts` (`Job.shouldRetryJob`), `attemptsMade`
 * counting the runs that already ended. A job added without `attempts` runs once.
 */
export function isFinalAttempt(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
  return job.attemptsMade + 1 >= Math.max(1, job.opts.attempts ?? 1);
}
