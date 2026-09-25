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
    case JobName.SESSION_VALIDATE:
      await processSessionValidate(deps, job.data.sessionId as string);
      return { sessionId: job.data.sessionId };
    case JobName.REPORT_EXPORT:
      await processReportExport(deps, job.data.exportId as string);
      return { exportId: job.data.exportId };
    default:
      throw new Error(`Unknown job: ${job.name}`);
  }
}
